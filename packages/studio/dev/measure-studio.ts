/**
 * 制作画面の重さを、いくつかの形の作品で測る（画面の開発用。作品には何も書かない）。
 *   npx tsx packages/studio/dev/measure-studio.ts [--out 結果.json] [--project <作品> --file <ファイル> [--edit <行>] [--reach-file <ファイル> --unreachable <行>]] [形…]
 * 形は dev/shapes.ts の long・many・branchy（省くと全部）。--project を渡すとその作品も測る（写してから渡す。作品のフォルダは読むだけ）。
 *
 * 測るもの（ミリ秒）:
 * - sweep: そのファイルの現在地（GET /sweep）を作る時間
 * - reach / saveDuringReach: 届かない行の探索（GET /sweep/reach）と、探し始めて 300ms 後に送った保存（PUT /file）が返るまで
 * - blocksOpen / blocksEdit / codeEdit: ブロック表示に切り替える時間と、本文の行に一字足したときの時間（5 回の中央値）。
 *   codeEdit は同じことをコード表示で行った時間（ブロック表示の描き直しを含まない分）
 *   blocksFilled / blocksFillBusy: 切り替えてから残りのまとまりを作り終えるまでの時間と、そのあいだの長い処理の合計（切り替えの分を含む）。
 * - toc: シーン一覧（すべてのファイルを開いた状態）の並べ方を替えたときの描き直し
 * - variables / check / assets: それぞれの画面を開いたときに、画面が止まっていた時間（長い処理の合計）。…Ready は一覧の行が出るまで、…Rows は描いた行の数
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { STUDIO_API, STUDIO_PAGE } from "../src/protocol.ts";
import { makeShape, SHAPES, type Shape, type ShapeInfo } from "./shapes.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1] ?? null;
  args.splice(i, 2);
  return v;
};
const out = opt("--out");
const extra = opt("--project");
const extraFile = opt("--file");
const extraUnreachable = opt("--unreachable");
const extraEdit = opt("--edit");
const extraReachFile = opt("--reach-file");
const shapes = (args.length > 0 ? args : [...SHAPES]) as Shape[];
const lim = resolve(import.meta.dirname, "../../cli/bin/lim.mjs");
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
const results: Record<string, Record<string, number | string | null>> = {};

let port = 5390;
for (const target of [...shapes, ...(extra ? ["project"] : [])]) {
  const dir = target === "project" ? resolve(extra!) : mkdtempSync(join(tmpdir(), `liminalia-measure-${target}-`));
  const info: ShapeInfo = target === "project" ? { file: extraFile ?? "", editLine: extraEdit ? Number(extraEdit) : 0, unreachable: extraUnreachable ? Number(extraUnreachable) : null, ...(extraReachFile ? { reachFile: extraReachFile } : {}) } : makeShape(target as Shape, dir);
  const p = port++;
  const server = spawn(process.execPath, [lim, "studio", dir, "--port", String(p)], { stdio: "ignore", env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
  const base = `http://localhost:${p}`;
  try {
    for (let i = 0; ; i++) {
      if (await fetch(`${base}${STUDIO_PAGE}`).then((r) => r.ok).catch(() => false)) break;
      if (i > 120) throw new Error("lim studio が起動しません");
      await new Promise((r) => setTimeout(r, 500));
    }
    results[target] = await measure(base, info);
    console.log(target, JSON.stringify(results[target]));
  } finally {
    server.kill();
    if (target !== "project") rmSync(dir, { recursive: true, force: true });
  }
}
await browser.close();
if (out) writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);

/** 開発サーバーが止まっている間に、使い回す接続が切れていることがあるので、一度だけやり直す。 */
async function fetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await globalThis.fetch(url, init);
  } catch {
    return globalThis.fetch(url, init);
  }
}

async function measure(base: string, info: ShapeInfo): Promise<Record<string, number | string | null>> {
  const api = `${base}${STUDIO_API}`;
  const r: Record<string, number | string | null> = {};
  const project = (await (await fetch(`${api}/project`)).json()) as { files: { file: string }[] };
  const file = info.file || project.files[0]!.file;
  r.file = file;
  r.files = project.files.length;

  let t = performance.now();
  await (await fetch(`${api}/sweep?file=${encodeURIComponent(file)}&from=1&to=200`)).text();
  r.sweep = Math.round(performance.now() - t);

  if (info.unreachable !== null) {
    // 届かない行を探している間に、別のファイルを保存する
    const reachFile = info.reachFile ?? file;
    const other = project.files.find((f) => f.file !== reachFile)!.file;
    const text = (await (await fetch(`${api}/file?file=${encodeURIComponent(other)}`)).json()) as { text: string; hash: string };
    t = performance.now();
    const reach = fetch(`${api}/sweep/reach?file=${encodeURIComponent(reachFile)}&line=${info.unreachable}&from=1&to=50`).then((x) => x.json()).then((x: { reason?: string }) => ({ ms: performance.now() - t, reason: x.reason ?? "reached" }));
    await new Promise((res) => setTimeout(res, 300));
    const s0 = performance.now();
    await fetch(`${api}/file`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: other, text: `${text.text}`, baseHash: text.hash, check: false }) });
    r.saveDuringReach = Math.round(performance.now() - s0);
    const done = await reach;
    r.reach = Math.round(done.ms);
    r.reachResult = done.reason;
  }

  const page = await browser.newPage({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
  const files = project.files.map((f) => f.file);
  await page.addInitScript(
    ([files]) => {
      localStorage.setItem("liminalia.studio.tourDone", "1");
      localStorage.setItem("liminalia.studio.blocks", "0");
      localStorage.setItem("liminalia.studio.tocOpen", JSON.stringify(files));
    },
    [files] as const,
  );
  await page.goto(`${base}${STUDIO_PAGE}`);
  await page.waitForSelector(".cm-content");
  const app = <T>(code: string) => page.evaluate(`(async () => { const s = window.__liminaliaStudioApp; const ed = s.debug.editor; ${code} })()`) as Promise<T>;
  await app(`await s.open(${JSON.stringify(file)}, 1)`);
  await page.waitForTimeout(2500);
  await installBusy(page);

  if (info.editLine > 0) {
    // 比べるために、コード表示で同じように一字足す（ブロック表示の描き直しを含まない分）
    const codeEdits: number[] = [];
    for (let i = 0; i < 5; i++) {
      codeEdits.push(await app<number>(`const line = ed.view.state.doc.line(${info.editLine}); const t = performance.now(); ed.view.dispatch({ changes: { from: line.to, insert: "あ" } }); return performance.now() - t`));
      await page.waitForTimeout(400);
    }
    r.codeEdit = Math.round(codeEdits.sort((a, b) => a - b)[2]!);
    const t0 = await page.evaluate(() => performance.now());
    r.blocksOpen = await app<number>(`const t = performance.now(); s.debug.setBlockMode(true); return Math.round(performance.now() - t)`);
    // 残りのまとまりを作り終えるまで（見せる所のあとから少しずつ作る）と、そのあいだ画面が止まっていた時間
    r.blocksFilled = await page.evaluate(async (t0) => {
      for (let i = 0; i < 600 && document.querySelector(".blk-pending"); i++) await new Promise((res) => setTimeout(res, 25));
      return Math.round(performance.now() - t0);
    }, t0);
    r.blocksFillBusy = await page.evaluate((t0) => Math.round((window as unknown as { __longTasks: { start: number; duration: number }[] }).__longTasks.filter((x) => x.start >= t0).reduce((s, x) => s + x.duration, 0)), t0);
    await page.waitForTimeout(1500);
    const edits: number[] = [];
    for (let i = 0; i < 5; i++) {
      edits.push(await app<number>(`const line = ed.view.state.doc.line(${info.editLine}); const t = performance.now(); ed.view.dispatch({ changes: { from: line.to, insert: "あ" } }); return performance.now() - t`));
      await page.waitForTimeout(400);
    }
    r.blocksEdit = Math.round(edits.sort((a, b) => a - b)[2]!);
    await app(`s.debug.setBlockMode(false)`);
    await page.waitForTimeout(800);
  }

  r.toc = await busy(page, async () => {
    await page.locator(".toc-order button[aria-pressed=false]").first().click();
  });
  // 画面を開いて、一覧の行が出るまでの時間と、そのあいだ画面が止まっていた時間
  for (const [name, id, row] of [["variables", "variables", ".vars-row:not(.vars-head)"], ["check", "check", ".check-problems > li"], ["assets", "assets", ".asset-tile"]] as const) {
    const t0 = Date.now();
    r[name] = await busy(page, async () => {
      await app(`s.setSurface(${JSON.stringify(id)})`);
      await page.waitForSelector(row, { timeout: 20000 }).catch(() => null);
      r[`${name}Ready`] = Date.now() - t0;
    }, 1500);
    r[`${name}Rows`] = await page.locator(row).count();
  }
  await page.close();
  return r;
}

/** 長い処理（50ms を超えるもの）を集め始める。 */
async function installBusy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __longTasks: { start: number; duration: number }[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: false });
  });
}

/** action のあと wait ミリ秒のあいだに、画面が止まっていた時間（長い処理の長さの合計）。 */
async function busy(page: Page, action: () => Promise<unknown>, wait = 2000): Promise<number> {
  const t0 = await page.evaluate(() => performance.now());
  await action();
  await page.waitForTimeout(wait);
  return page.evaluate((t0) => Math.round((window as unknown as { __longTasks: { start: number; duration: number }[] }).__longTasks.filter((x) => x.start >= t0).reduce((s, x) => s + x.duration, 0)), t0);
}

