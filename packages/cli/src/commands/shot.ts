import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { loadProject } from "@liminalia/project";
import { resolveShotTarget } from "@liminalia/studio/target";
import { findChromium } from "../chromium.ts";
import { startPlayerServer } from "../web.ts";
import { requireFfmpeg, runShotVideo, type VideoOptions } from "./shot-video.ts";

export interface ShotOptions {
  /** 開始位置。title が true なら使わない。 */
  target: string;
  skip: number;
  out: string;
  waitMs: number;
  settle: boolean;
  evalJs?: string;
  /** タイトル画面を撮る。 */
  title: boolean;
  /** タイトル画面を、開始の演出（boot）から通して撮る。 */
  intro: boolean;
  /** 遊ぶ言語（プレイヤーの ?lang= と同じ。liminalia.json の languages にあるもの）。省くと端末の言語に合うものか原文の言語。 */
  language?: string;
  /** 撮る代わりに、そこから録画する（--video。shot-video.ts）。 */
  video?: VideoOptions;
}

/**
 * lim shot [プロジェクト] <ファイル[#ラベル]> [--skip N] [--out shot.png] [--settle] [--wait ms] [--eval JS] [--lang en]
 * lim shot [プロジェクト] --title [--intro] ...
 * 指定した位置（そこから 1 で数えた N ページ目のクリック待ち。lim trace の [N]）か、タイトル画面の画面写真を撮る。開発サーバーは中で立てて止める。
 * N ページ目より前の、遊ぶ人の操作を待つ画面と動画は命令の autoplay で進める。--skip が 1 以下なら、開始位置から最初のページまでに出た
 * 選択肢か操作待ちの画面（作品の命令の画面、@investigate など）で止めて、その画面を撮る。撮る所より前の選択肢で止まったら、待たずに失敗する。
 * --lang はその言語で撮る（プレイヤーの ?lang= と同じ。作品の languages に無い言語は使えない）。
 * --video は、その位置から実際の速さで送りながら録画する（shot-video.ts。ffmpeg が要る）。最後まで録れなければ false。
 */
export async function runShot(dir: string, o: ShotOptions): Promise<boolean> {
  const project = loadProject(dir);
  // 開始位置は撮る前に確かめる（無いファイルを渡すと、開発サーバーが返す HTML を本文として読んで撮ってしまう）
  const target = o.title ? "" : resolveShotTarget(project, o.target);
  // languages を書いていない作品は日本語だけ
  const languages = project.config.languages?.length ? project.config.languages : ["ja"];
  if (o.language !== undefined && !languages.includes(o.language)) throw new Error(`${o.language} はこの作品の言語ではありません（liminalia.json の languages: ${languages.join("、")}）`);
  if (o.video) {
    requireFfmpeg();
    return runShotVideo(project, { target, skip: o.skip, ...(o.language !== undefined ? { language: o.language } : {}), video: o.video });
  }
  /** 言語の指定（?lang=。URL の後ろに付ける）。 */
  const lang = o.language !== undefined ? `lang=${encodeURIComponent(o.language)}` : "";
  const { server, url } = await startPlayerServer(project, 0, true);
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
  try {
    const page = await browser.newPage({ viewport: { width: project.screen.width, height: project.screen.height } });
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    if (o.title) {
      await page.goto(o.intro ? (lang ? `${url}?${lang}` : url) : `${url}?autostart=1${lang ? `&${lang}` : ""}`);
      if (o.intro) {
        await page.waitForFunction(() => !!window.__liminalia, null, { timeout: 30_000 });
        await page.evaluate(() => void window.__liminalia!.system.boot());
      }
      await page.waitForFunction(() => window.__liminalia?.screen().mode === "title", null, { timeout: 90_000 });
    } else {
      // 撮影（?autoplay=shot）: 撮る所までの、遊ぶ人の操作を待つ画面と動画は命令の autoplay で進め、撮る所の選択肢と操作待ちの画面は描かせて撮る
      await page.goto(`${url}?start=${encodeURIComponent(target)}&skip=${o.skip}&autostart=1&autoplay=shot${lang ? `&${lang}` : ""}`);
      const state = await page
        .waitForFunction((skip) => window.__liminalia?.shotState?.(skip) ?? null, o.skip, { timeout: SHOT_TIMEOUT_MS })
        .then((h) => h.jsonValue())
        .catch(async (e: unknown) => {
          if (!(e instanceof Error && e.name === "TimeoutError")) throw e;
          throw new Error(await stuckMessage(page, o.skip));
        });
      if (state && "blocked" in state) throw new Error(shotBlockedMessage(o.skip, state.pages, await lastPage(page)));
      // 操作待ちの画面と選択肢は、出したばかりの絵の読み込みを待つ
      if (state && (state.ready === "input" || state.ready === "choice")) await page.evaluate(settleImages);
    }
    // 作品が撮影を止めていれば（host.holdShot）離すまで待つ
    await page.waitForFunction(() => window.__liminalia?.shotReady?.() !== false, null, { timeout: 60_000 }).catch(() => undefined);
    if (o.waitMs > 0) await page.waitForTimeout(o.waitMs);
    if (o.evalJs) console.log("eval:", JSON.stringify(await page.evaluate(o.evalJs)));
    if (o.settle) {
      await page.evaluate(() =>
        document.getAnimations().forEach((a) => {
          try {
            a.finish();
          } catch {
            // 無限に繰り返すアニメーションは終わらせない
          }
        }),
      );
    }
    const where = await page.evaluate(() => document.querySelector(".status")?.textContent ?? "");
    const out = resolve(o.out);
    await page.screenshot({ path: out });
    console.log(`撮影: ${out}（${where.replace(/\n/g, " ")}）`);
    for (const e of errors) console.log(e);
    return true;
  } finally {
    await browser.close();
    await server.close();
  }
}

/** 撮る所に着くのを待つ長さ。 */
const SHOT_TIMEOUT_MS = 90_000;

/** 撮る所より前の選択肢で止まったときの文。 */
export function shotBlockedMessage(skip: number, pages: number, where: string): string {
  return `${skip} ページ目より前の選択肢で止まりました（${afterPages(pages, where)}）。撮影は選択肢を選ばないので、その先は撮れません。選択肢を撮るなら、その前のラベルから --skip を付けずに撮り、選んだ先を撮るなら、選んだ先のラベルから撮ってください`;
}

/** 止まった所（何ページ目のあとか。最後に出したページの位置）。 */
function afterPages(pages: number, where: string): string {
  return pages === 0 ? "最初のページより前" : `${pages} ページ目のあと${where ? `。最後のページは ${where}` : ""}`;
}

/** 時間切れのときの文（今どこで止まっているか）。 */
async function stuckMessage(page: Page, skip: number): Promise<string> {
  const s = await page
    .evaluate(() => {
      const l = window.__liminalia;
      return l ? { pages: l.pages(), waiting: l.host.waiting, input: l.host.interactiveFor() } : null;
    })
    // 止まった理由を添えるための読み取り。ページが閉じていれば添えずに知らせる
    .catch(() => null);
  const where = await lastPage(page);
  const seconds = SHOT_TIMEOUT_MS / 1000;
  if (!s) return `${seconds} 秒たってもプレイヤーが始まりませんでした`;
  const at = afterPages(s.pages, where);
  if (s.input !== null) return `${seconds} 秒たっても撮る所（${skip} ページ目）に着きません。操作待ちの画面で止まっています（${at}）。autoplay を持つ命令の画面は、その前のラベルから --skip を付けずに撮れます`;
  return `${seconds} 秒たっても撮る所（${skip} ページ目）に着きません（${at}）。autoplay を持たない命令の画面か、終わらない演出で止まっているかもしれません`;
}

/** 最後に出したページの位置（ファイル:行。開発サーバーの右下の表示）。 */
async function lastPage(page: Page): Promise<string> {
  // 知らせる文に添える位置。読めなければ位置なしで知らせる
  return page.evaluate(() => (document.querySelector(".status")?.textContent ?? "").split("\n")[0] ?? "").catch(() => "");
}

/** フォントと画像の読み込みを待つ（出したばかりの画面を撮る前）。 */
async function settleImages(): Promise<void> {
  await document.fonts.ready;
  // 壊れた画像は待たずに撮る（壊れていることは撮った画面に出る）
  await Promise.all([...document.images].map((img) => (img.complete ? null : img.decode().catch(() => null))));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

export { resolveShotTarget } from "@liminalia/studio/target";
