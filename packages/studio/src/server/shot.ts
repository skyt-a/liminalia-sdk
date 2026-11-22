import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Project } from "@liminalia/project";
import type { ShotRequest, ShotResult, StageReply } from "../protocol.ts";
import { describePage, type BrowserPage, type BrowserProvider } from "./browser.ts";
import { StudioError } from "./workspace.ts";

/**
 * 画面写真（POST /shot）。舞台に頼んだ画面（stage-show・stage-still）を、作品の画面の大きさで開いたプレイヤー（/?studio=1。
 * 制作画面の舞台と同じ口）に同じく頼んで撮り、exports/shots に PNG で書く。制作画面の飾り（舞台の帯・一時停止中の札）は入らず、
 * プレイヤーも ?studio=1 では右上の位置表示・計測の表示を出さない。
 */

/** 書く先（作品のフォルダから）。 */
export const SHOTS_DIR = "exports/shots";

/** ファイルの名前のもと（"part1/chapter2" の 12 行目 → "part1_chapter2-12"）。ファイルの名前に使えない文字は _ にする。 */
export function shotBaseName(file: string, line: number): string {
  const name = file.replace(/[\\/]+/g, "_").replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "_") || "shot";
  return `${name}-${line}`;
}

/** 書いていない名前（base.png、あれば base-2.png・base-3.png …）。上書きしない。 */
export function uniqueShotName(dir: string, base: string): string {
  if (!existsSync(join(dir, `${base}.png`))) return `${base}.png`;
  for (let n = 2; ; n++) if (!existsSync(join(dir, `${base}-${n}.png`))) return `${base}-${n}.png`;
}

/** 撮って書く。base は開発サーバーの URL（http://127.0.0.1:5180 など）。 */
export async function takeShot(project: Project, provider: BrowserProvider, base: string, req: ShotRequest): Promise<ShotResult> {
  const size = project.screen;
  const page = await provider.open(`${base.replace(/\/$/, "")}/?studio=1`, size);
  let png: Buffer;
  try {
    // 舞台の役を引き受けたら（stage-ready）、返事を控える受け口を置いてから頼む
    await untilReady(page, page.waitFor(() => !!window.__liminalia?.system, null, 60_000), 60);
    await page.evaluate((m) => {
      const w = window as unknown as { __shotReplies?: string[] };
      w.__shotReplies = [];
      window.addEventListener("message", (e: MessageEvent<{ type?: string }>) => {
        if (typeof e.data?.type === "string") w.__shotReplies!.push(e.data.type);
      });
      if (m.cast) window.postMessage({ type: "liminalia:stage-cast", cast: m.cast }, location.origin);
      window.postMessage(m.show, location.origin);
    }, req);
    const done: StageReply["type"] = req.show.type === "liminalia:stage-show" ? "liminalia:stage-shown" : "liminalia:stage-still-shown";
    await page.waitFor((d) => ((window as unknown as { __shotReplies?: string[] }).__shotReplies ?? []).includes(d), done, 30_000);
    if (req.show.type === "liminalia:stage-show") {
      // 文字送りが終わってページを出し切る（クリック待ち）か、選択肢か、終わりまで待つ
      await page
        .waitFor(
          () => {
            const l = window.__liminalia;
            return !!l && (l.ended || l.host.waiting || l.system.status?.choosing === true);
          },
          null,
          30_000,
        )
        .catch(() => undefined);
    }
    // 作品が撮影を止めていれば（host.holdShot）離すまで待ち、動いている演出は終わらせる（繰り返すものはそのまま）
    await page.waitFor(() => window.__liminalia?.shotReady?.() !== false, null, 10_000).catch(() => undefined);
    await page.evaluate(async () => {
      await document.fonts.ready;
      for (const a of document.getAnimations()) {
        try {
          a.finish();
        } catch {
          // 無限に繰り返すアニメーションは終わらせない
        }
      }
      // 画像の読み込みと、描き終わりを待つ
      await Promise.all([...document.images].map((img) => (img.complete ? null : img.decode().catch(() => null))));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, null);
    png = await page.screenshot();
  } finally {
    await page.close().catch(() => undefined);
  }
  return { ...saveShot(project.root, req.file, req.line, png), width: size.width, height: size.height };
}

/** exports/shots/<ファイル>-<行>.png に書く（あれば数を付ける）。作品のフォルダからの相対パスを返す。 */
export function saveShot(root: string, file: string, line: number, png: Buffer): { path: string } {
  const dir = join(root, SHOTS_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, uniqueShotName(dir, shotBaseName(file, line)));
  writeFileSync(path, png, { flag: "wx" });
  return { path: relative(root, path).split(sep).join("/") };
}

/** 書いた画面写真を読む（GET /shots/file。ブラウザの「ダウンロード」）。exports/shots の直下の .png だけ。 */
export function readShot(root: string, name: string): Buffer {
  if (!/^[^\\/]+\.png$/.test(name) || name.startsWith(".")) throw new StudioError(400, "スクリーンショットの名前として使えません");
  const path = join(root, SHOTS_DIR, name);
  if (!existsSync(path)) throw new StudioError(404, "スクリーンショットが見つかりません");
  return readFileSync(path);
}

/** POST /shot/play の頼み（lim shot と同じ撮り方。AI の MCP の screenshot が、開いている制作画面に頼む）。 */
export interface PlayShotRequest {
  /** 始める位置（ファイル[#ラベル]）。title なら使わない。 */
  start?: string;
  /** 撮るページの番号（start から 1 で数える。lim trace の [N]。0 と省略は最初のページ）。 */
  skip?: number;
  /** タイトル画面を撮る。 */
  title?: boolean;
  /** 遊ぶ言語（プレイヤーの ?lang=。lim shot の --lang）。 */
  lang?: string;
}

/**
 * プレイヤーを作品の画面の大きさで開き、target から数えて skip 番目のページのクリック待ち（か、タイトル画面）を撮って PNG を返す（ファイルには書かない）。
 * 開き方と待ち方は lim shot（packages/cli の commands/shot.ts）と同じ。開くのは開発サーバーの開き方（制作アプリでは見えないウィンドウ）。
 */
export async function takePlayShot(project: Project, provider: BrowserProvider, base: string, req: PlayShotRequest, target: string): Promise<Buffer> {
  const root = base.replace(/\/$/, "");
  const skip = Math.max(0, Math.floor(req.skip ?? 0));
  const lang = req.lang ? `&lang=${encodeURIComponent(req.lang)}` : "";
  // 撮る所までの、遊ぶ人の操作を待つ画面と動画は命令の autoplay で進め、撮る所の選択肢と操作待ちの画面は描かせる（?autoplay=shot。lim shot と同じ）
  const url = req.title ? `${root}/?autostart=1${lang}` : `${root}/?start=${encodeURIComponent(target)}&skip=${skip}&autostart=1&autoplay=shot${lang}`;
  const page = await provider.open(url, project.screen);
  try {
    if (req.title) await untilReady(page, page.waitFor(() => window.__liminalia?.screen().mode === "title", null, 90_000), 90);
    else {
      await untilReady(page, page.waitFor((n) => !!window.__liminalia?.shotState?.(n), skip, 90_000), 90);
      const state = await page.evaluate((n) => window.__liminalia?.shotState?.(n) ?? null, skip);
      if (state && "blocked" in state) throw new StudioError(422, `${skip} ページ目より前の選択肢で止まりました（撮影は選択肢を選びません）。選択肢はその前のラベルから skip なしで、選んだ先はそのラベルから撮ってください`);
    }
    await page.waitFor(() => window.__liminalia?.shotReady?.() !== false, null, 60_000).catch(() => undefined);
    await page.evaluate(async () => {
      await document.fonts.ready;
      for (const a of document.getAnimations()) {
        try {
          a.finish();
        } catch {
          // 無限に繰り返すアニメーションは終わらせない
        }
      }
      await Promise.all([...document.images].map((img) => (img.complete ? null : img.decode().catch(() => null))));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, null);
    return await page.screenshot();
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** ページの用意を待つ。待ちが切れたら、ページの様子（describePage）を添えて投げる（開き方によって切れたときの文が違うので、ここでそろえる）。 */
async function untilReady(page: BrowserPage, wait: Promise<void>, seconds: number): Promise<void> {
  try {
    await wait;
  } catch {
    throw new Error(`${seconds} 秒待っても、ページが用意できません（${await describePage(page)}）`);
  }
}
