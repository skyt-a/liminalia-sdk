import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectFlow, type Project } from "@liminalia/project";
import type { RegressEvent, RegressResult } from "../protocol.ts";
import type { BrowserPage, BrowserProvider } from "./browser.ts";
import { StudioError } from "./workspace.ts";

/**
 * 制作画面の「見た目の確かめ」（POST /regress。lim regress と同じ置き場と決まり）。フローチャートのシーンごとに、
 * そのシーンの頭から始めて一ページ目を出し切ったところで撮り（演出を弱め、動きを止める）、基準（.liminalia/regress/baseline）と比べる。
 * 違う画素が threshold % を超えたものを知らせ、違うところを赤くした画像を .liminalia/regress/diff に置く。
 * 基準の無いシーンは基準にし、update なら今のものを基準にする。ページは開発サーバーのプレイヤーを browser.ts の開き方で開く。
 */

export const REGRESS_DIR = ".liminalia/regress";
const KINDS = ["baseline", "current", "diff"] as const;

/** シーンの id から画像の名前（lim regress と同じ）。 */
export const regressFileOf = (id: string) => `${id.replace(/[#/\\:*?"<>|]/g, "_")}.png`;

/** 置き場の画像（kind は baseline・current・diff）。無い・置き場の外は 404。 */
export function readRegressImage(project: Project, kind: string, name: string): Buffer {
  if (!(KINDS as readonly string[]).includes(kind) || !/^[^/\\]+\.png$/.test(name)) throw new StudioError(404, "画像がありません");
  const path = join(project.root, REGRESS_DIR, kind, name);
  if (!existsSync(path)) throw new StudioError(404, "画像がありません");
  return readFileSync(path);
}

export async function* regressEvents(o: { provider: BrowserProvider; base: string; project: Project; update: boolean; threshold: number; signal: AbortSignal }): AsyncGenerator<RegressEvent> {
  const queue: RegressEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown = null;
  const push = (e: RegressEvent) => {
    queue.push(e);
    wake?.();
  };
  const job = run(o, push)
    .catch((e: unknown) => {
      if (!o.signal.aborted) failure = e;
    })
    .finally(() => {
      finished = true;
      wake?.();
    });
  try {
    for (;;) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (finished) break;
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
    if (failure) throw failure;
  } finally {
    await job;
  }
}

async function run(o: { provider: BrowserProvider; base: string; project: Project; update: boolean; threshold: number; signal: AbortSignal }, push: (e: RegressEvent) => void): Promise<void> {
  const { project } = o;
  const flow = await projectFlow(project);
  const scenes = flow.scenes.filter((s) => s.anchor);
  const root = resolve(project.root, REGRESS_DIR);
  const [baseline, current, diff] = [join(root, "baseline"), join(root, "current"), join(root, "diff")];
  rmSync(current, { recursive: true, force: true });
  rmSync(diff, { recursive: true, force: true });
  for (const d of [current, baseline, diff]) mkdirSync(d, { recursive: true });
  const result: RegressResult = { scenes: scenes.length, changed: [], added: [], failed: [], updated: o.update };
  const names = new Set<string>();
  for (const [i, scene] of scenes.entries()) {
    if (o.signal.aborted) return;
    push({ type: "progress", done: i, total: scenes.length, scene: scene.id });
    const name = regressFileOf(scene.id);
    const base = join(baseline, name);
    let page: BrowserPage | null = null;
    try {
      page = await o.provider.open(`${o.base.replace(/\/$/, "")}/?start=${encodeURIComponent(scene.id)}&autostart=1`, project.screen);
      const shot = await shoot(page);
      names.add(name);
      writeFileSync(join(current, name), shot);
      if (o.update || !existsSync(base)) {
        if (!existsSync(base)) result.added.push(scene.id);
        copyFileSync(join(current, name), base);
        continue;
      }
      // 比べるのも、撮ったページの canvas で（デスクトップ版の開き方は開発サーバーのページしか開かないため）
      const r = await compareImages(page, readFileSync(base), shot);
      if (r.ratio * 100 > o.threshold) {
        result.changed.push({ scene: scene.id, file: name, ratio: r.ratio });
        writeFileSync(join(diff, name), r.diff);
      }
    } catch (e) {
      result.failed.push({ scene: scene.id, error: e instanceof Error ? e.message.split("\n")[0]! : String(e) });
    } finally {
      await page?.close().catch(() => undefined);
    }
  }
  // 今のシナリオに無いシーンの基準は消す
  if (result.failed.length === 0) for (const f of readdirSync(baseline)) if (!names.has(f)) rmSync(join(baseline, f));
  result.changed.sort((a, b) => b.ratio - a.ratio);
  push({ type: "done", result });
}

/** 一ページ目を出し切ったところで撮る（演出を弱め、動きを止め、開発用の表示を隠す）。 */
async function shoot(page: BrowserPage): Promise<Buffer> {
  await page.waitFor(() => !!window.__liminalia?.system, null, 60_000);
  await page.evaluate(() => window.__liminalia!.system.updateSettings?.({ reduceShake: true, reduceFlash: true, textSpeed: 0 }), null);
  await page.waitFor(
    () => {
      const l = window.__liminalia;
      return !!l && (l.ended || (l.pages() >= 1 && l.host.waiting) || l.system.status?.choosing === true);
    },
    null,
    30_000,
  );
  await page.waitFor(() => window.__liminalia?.shotReady?.() !== false, null, 30_000).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      try {
        a.finish();
      } catch {
        a.pause();
      }
    }
    document.querySelector<HTMLElement>(".status")?.style.setProperty("visibility", "hidden");
  }, null);
  return page.screenshot();
}

/**
 * 二枚の画像を比べ、違う画素の割合と、違うところを赤くした画像を返す（空のページの canvas で比べる。lim regress と同じ決まり）。
 * ページの中で動く関数は、名前の付いた関数を中に書かない（束ねたときに名前を付ける補助がページへ持ち込まれないように）。
 */
async function compareImages(page: BrowserPage, a: Buffer, b: Buffer): Promise<{ ratio: number; diff: Buffer }> {
  {
    const r = await page.evaluate(
      async (src: { a: string; b: string }) => {
        const loaded = await Promise.all(
          [src.a, src.b].map(
            (url) =>
              new Promise<HTMLImageElement>((ok, ng) => {
                const img = new Image();
                img.onload = () => ok(img);
                img.onerror = ng;
                img.src = url;
              }),
          ),
        );
        const w = Math.max(loaded[0]!.width, loaded[1]!.width);
        const h = Math.max(loaded[0]!.height, loaded[1]!.height);
        const pixels = loaded.map((img) => {
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          const g = c.getContext("2d", { willReadFrequently: true })!;
          g.drawImage(img, 0, 0);
          return { c, g, d: g.getImageData(0, 0, w, h) };
        });
        const A = pixels[0]!;
        const B = pixels[1]!;
        const out = B.g.createImageData(w, h);
        let differ = 0;
        for (let i = 0; i < A.d.data.length; i += 4) {
          const delta = Math.abs(A.d.data[i]! - B.d.data[i]!) + Math.abs(A.d.data[i + 1]! - B.d.data[i + 1]!) + Math.abs(A.d.data[i + 2]! - B.d.data[i + 2]!);
          const hit = delta > 48;
          if (hit) differ++;
          out.data[i] = hit ? 255 : B.d.data[i]! * 0.3;
          out.data[i + 1] = hit ? 0 : B.d.data[i + 1]! * 0.3;
          out.data[i + 2] = hit ? 0 : B.d.data[i + 2]! * 0.3;
          out.data[i + 3] = 255;
        }
        B.g.putImageData(out, 0, 0);
        return { ratio: differ / (w * h), diff: B.c.toDataURL("image/png") };
      },
      { a: `data:image/png;base64,${a.toString("base64")}`, b: `data:image/png;base64,${b.toString("base64")}` },
    );
    return { ratio: r.ratio, diff: Buffer.from(r.diff.replace(/^data:image\/png;base64,/, ""), "base64") };
  }
}
