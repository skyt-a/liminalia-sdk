import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { loadProject, projectFlow } from "@liminalia/project";
import { findChromium } from "../chromium.ts";
import { writeProgress } from "../english-output.ts";
import { startPlayerServer } from "../web.ts";

export interface RegressOptions {
  /** 今の画面写真を基準にする（比べずに置き換える）。 */
  update: boolean;
  /** 変わったとみなす、違う画素の割合（%）。 */
  threshold: number;
  /** 場面の id にこの文字を含むものだけ撮る。 */
  only?: string;
  /** 画面写真を置くフォルダ（既定 .liminalia/regress）。 */
  dir?: string;
  /** 場面ごとに撮るページの数（頭から。既定 1）。 */
  pages?: number;
}

/**
 * lim regress [プロジェクト] [--update] [--threshold 0.05] [--pages 1] [--only 文字] [--dir フォルダ]
 * 全分岐の見た目の確かめ。フローチャートの場面（台本から作る。選択肢の先・合流するところ）ごとに、その場面の頭から始めて
 * 頭から pages ページを撮り（演出を弱め、動きを止めて。同じ台本なら同じ画面になる）、基準（<dir>/baseline）と比べる。違う画素が threshold % を超えた場面を知らせ、
 * 違うところを赤くした画像を <dir>/diff に置く。基準が無い場面は新しい場面として基準にする。--update で今のものを基準にする。
 * 変わった場面があれば終了コード 1（CI で止めるため）。
 */
export async function runRegress(dirArg: string, o: RegressOptions): Promise<boolean> {
  const project = loadProject(dirArg);
  const flow = await projectFlow(project);
  const scenes = flow.scenes.filter((s) => s.anchor && (!o.only || s.id.includes(o.only)));
  const root = resolve(project.root, o.dir ?? ".liminalia/regress");
  const current = join(root, "current");
  const baseline = join(root, "baseline");
  const diff = join(root, "diff");
  rmSync(current, { recursive: true, force: true });
  rmSync(diff, { recursive: true, force: true });
  for (const d of [current, baseline, diff]) mkdirSync(d, { recursive: true });
  const fileOf = (id: string) => `${id.replace(/[#/\\:*?"<>|]/g, "_")}.png`;

  const { server, url } = await startPlayerServer(project, 0, true);
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
  const changed: { id: string; ratio: number }[] = [];
  const added: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const names = new Set<string>();
  try {
    const page = await browser.newPage({ viewport: { width: project.screen.width, height: project.screen.height } });
    for (const [i, scene] of scenes.entries()) {
      writeProgress(`撮影 ${i + 1} / ${scenes.length} ${scene.id.slice(0, 40).padEnd(40)}`);
      let shots: string[];
      try {
        shots = await shoot(page, url, scene.id, Math.max(1, o.pages ?? 1), (n) => join(current, n === 1 ? fileOf(scene.id) : fileOf(`${scene.id}~${n}`)));
      } catch (e) {
        failed.push({ id: scene.id, error: e instanceof Error ? e.message.split("\n")[0]! : String(e) });
        continue;
      }
      for (const shot of shots) {
        const name = shot.slice(current.length + 1);
        names.add(name);
        const label = name.replace(/\.png$/, "");
        const base = join(baseline, name);
        if (o.update || !existsSync(base)) {
          if (!existsSync(base)) added.push(label);
          copyFileSync(shot, base);
          continue;
        }
        const r = await compare(page, readFileSync(base), readFileSync(shot));
        if (r.ratio * 100 > o.threshold) {
          changed.push({ id: label, ratio: r.ratio });
          writeFileSync(join(diff, name), r.diff);
        }
      }
    }
    process.stdout.write("\n");
  } finally {
    await browser.close();
    await server.close();
  }
  // 今の台本に無い場面の基準は消す
  if (!o.only && failed.length === 0) for (const f of readdirSync(baseline)) if (!names.has(f)) rmSync(join(baseline, f));

  const where = relative(process.cwd(), root) || ".";
  console.log(`${scenes.length} シーンを撮影しました（${where}）`);
  if (o.update) console.log("現在のスクリーンショットを基準にしました");
  if (added.length) console.log(`新しいシーン（基準に追加）: ${added.length}`);
  for (const f of failed) console.log(`撮影できなかったシーン: ${f.id}（${f.error}）`);
  if (changed.length) {
    console.log(`見た目が変わったシーン: ${changed.length}（差分を赤で示した画像は ${relative(process.cwd(), diff)}）`);
    for (const c of changed.sort((a, b) => b.ratio - a.ratio)) console.log(`  ${c.id}  ${(c.ratio * 100).toFixed(2)}%`);
  } else if (!o.update) console.log("見た目が変わったシーンはありません");
  return changed.length === 0 && failed.length === 0;
}

/** 場面の頭から始め、頭から count ページを、出し切ったところで撮る（演出を弱め、動きを止める）。撮ったファイルを返す。 */
async function shoot(page: Page, url: string, target: string, count: number, out: (n: number) => string): Promise<string[]> {
  await page.goto(`${url}?start=${encodeURIComponent(target)}&autostart=1`);
  await page.waitForFunction(() => !!window.__liminalia?.system, null, { timeout: 60_000 });
  await page.evaluate(() => window.__liminalia!.system.updateSettings?.({ reduceShake: true, reduceFlash: true, textSpeed: 0 }));
  const files: string[] = [];
  for (let n = 1; n <= count; n++) {
    if (n > 1) {
      const done = await page.evaluate(() => window.__liminalia!.ended || window.__liminalia!.system.status?.choosing === true);
      if (done) break;
      await page.evaluate(() => window.__liminalia!.host.advance());
    }
    await page.waitForFunction(
      (want) => {
        const l = window.__liminalia;
        return !!l && (l.ended || (l.pages() >= want && l.host.waiting) || l.system.status?.choosing === true);
      },
      n,
      { timeout: 30_000 },
    );
    await settle(page);
    const file = out(n);
    await page.screenshot({ path: file });
    files.push(file);
  }
  return files;
}

/** 撮る前に、作品が撮影を止めていれば待ち、動きを止め、開発用の表示を隠す。 */
async function settle(page: Page): Promise<void> {
  // 撮影を止める作品が待ちの時間を過ぎても止めたままなら、そのまま撮る
  await page.waitForFunction(() => window.__liminalia?.shotReady?.() !== false, null, { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  await page.evaluate(() =>
    document.getAnimations().forEach((a) => {
      try {
        a.finish();
      } catch {
        // 終われない動き（無限に続くもの）は止める
        a.pause();
      }
    }),
  );
  // 開発用の位置の表示は写さない
  await page.evaluate(() => document.querySelector<HTMLElement>(".status")?.style.setProperty("visibility", "hidden"));
}

/** 二枚の画像を比べ、違う画素の割合と、違うところを赤くした画像を返す（ブラウザの canvas で比べる）。 */
async function compare(page: Page, a: Buffer, b: Buffer): Promise<{ ratio: number; diff: Buffer }> {
  // tsx が関数に名前を付ける補助（__name）をブラウザへ持ち込まないよう、比べる処理は文字で渡す
  const r = (await page.evaluate(`(async () => {
    const load = (src) => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
    const [ia, ib] = await Promise.all([load(${JSON.stringify(`data:image/png;base64,${a.toString("base64")}`)}), load(${JSON.stringify(`data:image/png;base64,${b.toString("base64")}`)})]);
    const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
    const read = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0); return { c, g, d: g.getImageData(0, 0, w, h) }; };
    const A = read(ia), B = read(ib);
    const out = B.g.createImageData(w, h);
    let differ = 0;
    for (let i = 0; i < A.d.data.length; i += 4) {
      const delta = Math.abs(A.d.data[i] - B.d.data[i]) + Math.abs(A.d.data[i + 1] - B.d.data[i + 1]) + Math.abs(A.d.data[i + 2] - B.d.data[i + 2]);
      const hit = delta > 48;
      if (hit) differ++;
      out.data[i] = hit ? 255 : B.d.data[i] * 0.3;
      out.data[i + 1] = hit ? 0 : B.d.data[i + 1] * 0.3;
      out.data[i + 2] = hit ? 0 : B.d.data[i + 2] * 0.3;
      out.data[i + 3] = 255;
    }
    B.g.putImageData(out, 0, 0);
    return { ratio: differ / (w * h), diff: B.c.toDataURL("image/png") };
  })()`)) as { ratio: number; diff: string };
  return { ratio: r.ratio, diff: Buffer.from(r.diff.replace(/^data:image\/png;base64,/, ""), "base64") };
}
