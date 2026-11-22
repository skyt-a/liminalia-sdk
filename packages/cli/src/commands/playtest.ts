import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadProject } from "@liminalia/project";
import { findChromium } from "../chromium.ts";
import { serveFolder } from "../serve-folder.ts";
export { serveFolder } from "../serve-folder.ts";
import { runBuild } from "./build.ts";
import { countEn } from "../english.ts";
import { BEGIN_SOURCE, DRIVE_SOURCE } from "../playtest-drive.ts";
import { playtestWatch, type PlaytestWatchOptions, type WatchResult } from "../playtest-watch.ts";

export { DRIVE_SOURCE } from "../playtest-drive.ts";

/**
 * lim playtest [プロジェクト] [書き出したブラウザ版] [--rebuild] [--runs 1] [--choose 0,1] [--max-pages 5000] [--timeout 600] [--stuck 20] [--json] [--lang en]
 *              [--fast] [--log] [--shots] [--avoid-choice 文,…] [--avoid-ending [種類,…]]
 *
 * 書き出したブラウザ版を Chromium（Playwright）で開き、「はじめから」で始めて送り続け、最後まで流して確かめる。
 * 選択肢は --choose の番号を順に、使い切ったら実行ごとに選び方を変える（k 回目は、同じ選択肢に戻るたびに k + 回数 番目）。
 * 終わり（プレイが終わる・タイトル画面に戻る）まで流せたか、ページが進まなくなった所（止まった所）、ページのエラー・読めなかった素材を出す。
 * 止まったときとエラーのときは画面を <out>/playtest/ に撮る。--rebuild なら先にブラウザ版を書き出す（確かめは省く）。
 * --lang en なら結果を英語で出す（--json の中身は変わらない）。
 * --fast・--log・--shots・--avoid-choice・--avoid-ending は playtest-watch.ts（待ち時間を詰める、ページのログ、変わるたびのスクリーンショット、選択肢の避け方）。
 */
export interface PlaytestOptions {
  target?: string;
  build?: boolean;
  runs: number;
  choose: number[];
  maxPages: number;
  timeoutSeconds: number;
  stuckSeconds: number;
  json?: boolean;
  /** 結果の文の言語（既定は日本語）。 */
  language?: "ja" | "en";
  /** 付け足し（--fast、--log、--shots、--avoid-choice、--avoid-ending。playtest-watch.ts）。 */
  watch?: PlaytestWatchOptions;
}

export interface PlaytestRun {
  run: number;
  outcome: "ended" | "title" | "stuck" | "max-pages" | "timeout" | "no-start";
  pages: number;
  choices: string[];
  at: string | null;
  errors: string[];
  seconds: number;
  shot?: string;
  /** ページのログ（--log・--shots）。 */
  log?: WatchResult["log"];
  /** 変わるたびに撮ったスクリーンショット（--shots）。 */
  shots?: WatchResult["shots"];
  /** 避けた選択肢の数（--avoid-choice・--avoid-ending）。 */
  avoided?: number;
}

/** <out>/browser/ の一番新しい書き出し（index.html のあるフォルダ）。 */
export function latestBrowserBuild(out: string): string | null {
  const dir = join(out, "browser");
  if (!existsSync(dir)) return null;
  const found = readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "index.html")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0] ?? null;
}

/** ページの中で送り続ける（Playwright と行き来せずに速く進める）。結果の形は PlaytestRun の一部。 */
interface DriveResult {
  outcome: PlaytestRun["outcome"];
  pages: number;
  choices: string[];
  at: string | null;
}

export async function runPlaytest(dir: string, o: PlaytestOptions): Promise<boolean> {
  const project = loadProject(dir);
  const en = o.language === "en";
  if (o.build) {
    if (!(await runBuild(dir, { targets: ["browser"], import: true, verify: false }))) return false;
  }
  const target = o.target ? resolve(o.target) : latestBrowserBuild(project.paths.out);
  if (!target || !existsSync(join(target, "index.html"))) {
    if (en) throw new Error(o.target ? `${o.target} has no index.html (give the folder of an exported browser version)` : "There's no exported browser version (run lim build browser, or add --rebuild)");
    throw new Error(o.target ? `${o.target} に index.html がありません（書き出したブラウザ版のフォルダを指定します）` : "書き出したブラウザ版がありません（lim build browser か、--rebuild を付けて）");
  }
  const shots = join(project.paths.out, "playtest");
  const watch = await playtestWatch(project, o.watch);
  if (watch && !o.json) for (const line of watch.notes) console.log(line);
  const { chromium } = await import("playwright-core");
  let browser: import("playwright-core").Browser | undefined;
  const results: PlaytestRun[] = [];
  const { server, url } = await serveFolder(target);
  try {
    browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
    for (let run = 0; run < o.runs; run++) {
      const started = Date.now();
      const page = await browser.newPage({ viewport: project.screen });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
      });
      page.on("response", (r) => {
        if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`);
      });
      let result: DriveResult;
      const watching = await watch?.attach(page, run);
      try {
        await page.goto(url);
        await page.waitForFunction(() => !!window.__liminalia, null, { timeout: 60_000 });
        await page.evaluate(() => void window.__liminalia!.system.boot());
        await page.waitForFunction(() => ["title", "game"].includes(window.__liminalia!.screen().mode ?? ""), null, { timeout: 90_000 });
        // 「はじめから」（標準のシステム画面の newGame。差し替えた画面なら「はじめから」の押しボタン）
        const began = (await page.evaluate(BEGIN_SOURCE)) as boolean;
        if (!began) result = { outcome: "no-start", pages: 0, choices: [], at: null };
        else {
          await page.waitForFunction(() => window.__liminalia!.screen().mode === "game", null, { timeout: 60_000 });
          await watching?.install();
          result = (await page.evaluate(`(${DRIVE_SOURCE})(${JSON.stringify({ run, choose: o.choose, maxPages: o.maxPages, timeout: o.timeoutSeconds * 1000, stuck: o.stuckSeconds * 1000 })})`)) as DriveResult;
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message.split("\n")[0]! : String(e));
        result = { outcome: "no-start", pages: 0, choices: [], at: null };
      }
      const r: PlaytestRun = { run, ...result, errors: [...new Set(errors)], seconds: Math.round((Date.now() - started) / 100) / 10 };
      if (watching) Object.assign(r, await watching.finish({ outcome: r.outcome, pages: r.pages, at: r.at, seconds: r.seconds }));
      if (r.outcome !== "ended" && r.outcome !== "title") {
        mkdirSync(shots, { recursive: true });
        r.shot = join(shots, `run-${run + 1}.png`);
        // 撮れなかったら写真の場所を書かない（結果の表に出さない）
        await page.screenshot({ path: r.shot }).catch(() => delete r.shot);
      }
      results.push(r);
      await page.close();
      if (!o.json) printRun(r, target, en);
    }
  } finally {
    server.close();
    await browser?.close();
  }
  const ok = results.every((r) => (r.outcome === "ended" || r.outcome === "title") && r.errors.length === 0);
  if (o.json) console.log(JSON.stringify({ build: target, ok, runs: results }, null, 2));
  else if (en) console.log(ok ? `\n${results.length === 1 ? "The run" : `All ${results.length} runs`} played to the end` : `\nSome runs didn't reach the end or had errors${existsSync(shots) ? ` (screenshots in ${shown(shots)})` : ""}`);
  else console.log(ok ? `\n${results.length} 通り、どれも最後まで流せました` : existsSync(shots) ? `\n最後まで流せなかったか、エラーの出たものがあります（画面は ${shown(shots)}）` : "\n最後まで流せなかったか、エラーの出たものがあります");
  return ok;
}

/** 今のフォルダからのパス（外なら絶対パス）。 */
function shown(p: string): string {
  const r = relative(process.cwd(), p);
  return r.startsWith("..") || r === "" ? p : r;
}

/** 一通りの結果を出す（en なら英語）。 */
export function printRun(r: PlaytestRun, build: string, en = false): void {
  if (en) {
    const outcome = { ended: "played to the end", title: "returned to the title screen (ending)", stuck: "pages stopped advancing", "max-pages": "reached the page limit (--max-pages)", timeout: "reached the time limit (--timeout)", "no-start": "couldn't start" }[r.outcome];
    console.log(`${r.run === 0 ? `${shown(build)}\n` : ""}Run ${r.run + 1}: ${outcome} (${countEn(r.pages, "page")}, ${countEn(r.choices.length, "choice")}, ${r.seconds} s)`);
    if (r.at && r.outcome !== "ended" && r.outcome !== "title") console.log(`  Stopped at: ${r.at}`);
    if (r.choices.length > 0) console.log(`  Chose: ${r.choices.slice(0, 12).join(" → ")}${r.choices.length > 12 ? ` and ${r.choices.length - 12} more` : ""}`);
    for (const e of r.errors.slice(0, 20)) console.log(`  Error: ${e}`);
    if (r.shot) console.log(`  Screenshot: ${r.shot}`);
    if (r.avoided !== undefined) console.log(`  Avoided: ${countEn(r.avoided, "choice")}`);
    if (r.log) console.log(`  Page log: ${shown(r.log)}`);
    if (r.shots) console.log(`  Screenshots on changes: ${countEn(r.shots.count, "image")} in ${shown(r.shots.dir)}`);
    return;
  }
  const outcome = { ended: "最後まで流せました", title: "タイトル画面に戻りました（エンディング）", stuck: "ページが進まなくなりました", "max-pages": "ページの数の上限に達しました（--max-pages）", timeout: "時間の上限に達しました（--timeout）", "no-start": "始められませんでした" }[r.outcome];
  if (r.run === 0) console.log(shown(build));
  console.log(`${r.run + 1} 通り目: ${outcome}（${r.pages} ページ、選択肢 ${r.choices.length} 回、${r.seconds} 秒）`);
  if (r.at && r.outcome !== "ended" && r.outcome !== "title") console.log(`  止まった所: ${r.at}`);
  if (r.choices.length > 0) console.log(r.choices.length > 12 ? `  選んだもの: ${r.choices.slice(0, 12).join(" → ")} ほか ${r.choices.length - 12} 回` : `  選んだもの: ${r.choices.join(" → ")}`);
  for (const e of r.errors.slice(0, 20)) console.log(`  エラー: ${e}`);
  if (r.shot) console.log(`  画面: ${r.shot}`);
  if (r.avoided !== undefined) console.log(`  避けた選択肢: ${r.avoided} 回`);
  if (r.log) console.log(`  ページのログ: ${shown(r.log)}`);
  if (r.shots) console.log(`  変わるたびのスクリーンショット: ${r.shots.count} 枚（${shown(r.shots.dir)}）`);
}
