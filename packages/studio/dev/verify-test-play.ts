/**
 * テストプレイと制作画面の往復を、lim studio と同じ開発サーバーをブラウザで開いて確かめる（制作アプリの口は packages/studio-desktop の単体テスト）。
 *   npx tsx packages/studio/dev/verify-test-play.ts [スクリーンショットの置き場所]
 * - シナリオを直すとテストプレイに「シナリオが変わりました」と「この場所から読み直す」が出て、⇧R とボタンで今のページから読み直す（直した文が出る）
 * - ⇧E とメニューの「このページをシナリオで開く」で、制作画面がその行を開く（BroadcastChannel）。制作画面が無ければそう知らせる
 * - 実行時の問題をテストプレイの右上に数で出し、制作画面のチェックの「テストプレイで出たもの」にも並べる
 * - タイトルにいるときはシナリオが変わっても知らせない
 * ひな形（templates/default）を一時フォルダに写して使う。結果は一行ずつ「OK」か「NG」で出す（NG でも終了コードは 0）。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadProject } from "@liminalia/project";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { startPlayerServer } from "../../cli/src/web.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-verify-test-play"));
mkdirSync(shots, { recursive: true });
const project = mkdtempSync(join(tmpdir(), "liminalia-verify-test-play-"));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
const tp = join(project, "scenario", "tp.lim");
const SCRIPT = ["# tp", "@bg hill_dusk.webp", "　一ページ目。", "@open-screen nowhere_screen", "　二ページ目。もとの文。", "　三ページ目。"].join("\n");
writeFileSync(tp, SCRIPT);

const { server, url: playerUrl } = await startPlayerServer(loadProject(project), 0, true);
const base = playerUrl.replace(/\/$/, "");
const results: string[] = [];
const ok = (name: string, cond: boolean, detail: unknown = "") => {
  const line = `${cond ? "OK  " : "NG  "} ${name}${!cond && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`;
  results.push(line);
  console.log(line);
};
const errors: string[] = [];
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });

const watch = (page: Page) => {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|404|409|autoplay|ERR_FAILED/i.test(m.text()) && errors.push(m.text()));
};
const shown = (page: Page) => page.evaluate(() => document.querySelector(".message .text")?.textContent ?? "");
/** 本文に needle が出るまで送る（文字送りの途中なら、一度目は出し切るだけ）。 */
const advanceTo = async (page: Page, needle: string) => {
  for (let i = 0; i < 6; i++) {
    if ((await shown(page)).includes(needle)) return true;
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
  }
  return (await shown(page)).includes(needle);
};
const waitText = async (page: Page, needle: string, ms = 15_000) => {
  try {
    await page.waitForFunction((n) => (document.querySelector(".message .text")?.textContent ?? "").includes(n), needle, { timeout: ms });
    return true;
  } catch {
    return false;
  }
};

try {
  const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem("liminalia.studio.tourDone", "1");
    localStorage.setItem("liminalia.studio.blocks", "0");
  });
  // 制作画面
  const studio = await context.newPage();
  watch(studio);
  await studio.goto(`${base}${STUDIO_PAGE}`);
  await studio.waitForSelector(".cm-content", { state: "attached" });
  await studio.waitForTimeout(1500);
  const studioApp = <T>(code: string) => studio.evaluate(`(() => { const s = window.__liminaliaStudioApp; const ed = s.debug.editor; ${code} })()`) as Promise<T>;

  // テストプレイ（制作画面の「テストプレイ」と同じ ?play=1。始める位置を決める）
  const play = await context.newPage();
  await play.setViewportSize({ width: 1280, height: 720 });
  watch(play);
  await play.goto(`${base}/?play=1&start=tp`);
  await play.locator(".layer.start").click();
  ok("テストプレイ: 一ページ目が出る", await waitText(play, "一ページ目"));
  ok("テストプレイ: 二ページ目へ進む", await advanceTo(play, "もとの文"));

  // 実行時の問題（@open-screen の無い画面）を右上と制作画面のチェックに
  await play.waitForTimeout(500);
  const entry = (await play.locator(".lm-play-dev-entry").textContent()) ?? "";
  ok("実行時の問題をテストプレイの右上に数で出す", entry === "警告 1", entry);
  await play.screenshot({ path: join(shots, "play-warning.png") });
  await studio.locator(".tabs-main .tab", { hasText: "チェック" }).first().click();
  await studio.waitForTimeout(800);
  const pill = studio.locator('.check-pill[data-category="testplay"]');
  ok("制作画面のチェックに「テストプレイで出たもの」の分類が出る", (await pill.count()) === 1 && ((await pill.textContent()) ?? "").includes("テストプレイで出たもの"), (await pill.textContent().catch(() => "")) ?? "");
  await pill.click();
  await studio.waitForTimeout(300);
  const rows = await studio.locator(".check-problems .diag").allTextContents();
  ok("分類で絞ると、テストプレイで出た問題だけが並ぶ", rows.length === 1 && rows[0]!.includes("nowhere_screen") && rows[0]!.includes("tp.lim 4"), rows);
  await studio.screenshot({ path: join(shots, "studio-check-testplay.png") });
  const badge = (await studio.locator(".tabs-main .badge").textContent()) ?? "";
  ok("点検のタブの数にも入る", Number(badge) >= 1, badge);
  await pill.click();

  // シナリオを直す → 知らせ → ⇧R で今のページから読み直す
  writeFileSync(tp, SCRIPT.replace("もとの文", "直した文"));
  let banner = false;
  try {
    await play.waitForSelector(".lm-play-dev-banner", { timeout: 10_000 });
    banner = true;
  } catch {
    // 出なかった
  }
  ok("シナリオを直すと、テストプレイに「シナリオが変わりました」と「この場所から読み直す」が出る", banner && ((await play.locator(".lm-play-dev-banner").textContent()) ?? "").includes("この場所から読み直す"));
  await play.screenshot({ path: join(shots, "play-changed.png") });
  ok("読み直す前は、前の台本のまま", (await shown(play)).includes("もとの文"));
  const logBefore = await play.evaluate(() => window.__liminalia!.system.backlog?.length ?? 0);
  await play.keyboard.press("Shift+R");
  ok("⇧R で今のページから読み直し、直した文が出る", await waitText(play, "直した文"));
  ok("読み直したあとは知らせを閉じる", (await play.locator(".lm-play-dev-banner").count()) === 0);
  const logAfter = await play.evaluate(() => window.__liminalia!.system.backlog?.length ?? 0);
  ok("履歴（バックログ）は引き継ぐ", logAfter >= logBefore && logAfter >= 1, { logBefore, logAfter });
  await play.screenshot({ path: join(shots, "play-reloaded.png") });

  // ボタンでも読み直す
  writeFileSync(tp, SCRIPT.replace("もとの文", "二度目に直した文"));
  await play.waitForSelector(".lm-play-dev-banner", { timeout: 10_000 }).catch(() => undefined);
  await play.locator(".lm-play-dev-banner button.is-primary").click();
  ok("知らせの「この場所から読み直す」でも読み直す", await waitText(play, "二度目に直した文"));

  // ⇧E でこのページを制作画面で開く
  await studio.locator(".tab", { hasText: "シナリオ" }).first().click();
  await studio.waitForTimeout(500);
  await play.bringToFront();
  await play.keyboard.press("Shift+E");
  await studio.waitForTimeout(1500);
  const at = await studioApp<{ file: string | null; line: number }>("return { file: s.debug.file, line: ed.cursorLine() }");
  ok("⇧E で今のページの行を制作画面で開く", at.file === "tp" && at.line === 5, at);
  await studio.screenshot({ path: join(shots, "studio-opened.png") });

  // メニュー（右上）から開く・問題の行を開く
  await studioApp("ed.gotoLine(1)");
  await play.locator(".lm-play-dev-entry").click();
  await play.waitForTimeout(200);
  await play.screenshot({ path: join(shots, "play-menu.png") });
  const items = await play.locator(".lm-play-dev-menu > button").allTextContents();
  ok("右上のメニューに「この場所から読み直す」と「このページをシナリオで開く」と問題の一覧", items.join("|") === "この場所から読み直す|このページをシナリオで開く" && (await play.locator(".lm-play-dev-problems button").count()) === 1, items);
  await play.locator(".lm-play-dev-menu > button", { hasText: "このページをシナリオで開く" }).click();
  await studio.waitForTimeout(1200);
  ok("メニューの「このページをシナリオで開く」でも開く", (await studioApp<number>("return ed.cursorLine()")) === 5);
  await play.locator(".lm-play-dev-entry").click();
  await play.locator(".lm-play-dev-problems button").click();
  await studio.waitForTimeout(1200);
  ok("問題の行を押すと、その行を制作画面で開く", (await studioApp<number>("return ed.cursorLine()")) === 4);

  // 制作画面が無ければそう知らせる
  await studio.close();
  await play.keyboard.press("Shift+E");
  let missing = "";
  try {
    await play.waitForSelector(".lm-play-dev-banner", { timeout: 4000 });
    missing = (await play.locator(".lm-play-dev-banner").textContent()) ?? "";
  } catch {
    // 出なかった
  }
  ok("制作画面が開いていなければ、テストプレイにそう知らせる", missing.includes("制作画面が開いていません"), missing);

  // タイトルにいるときは知らせない（次に始めるプレイは新しい台本を読む）
  const title = await context.newPage();
  watch(title);
  await title.goto(`${base}/?play=1`);
  await title.locator(".layer.start").click().catch(() => undefined);
  await title.waitForTimeout(1500);
  writeFileSync(tp, SCRIPT);
  await title.waitForTimeout(2500);
  ok("タイトルではシナリオが変わっても知らせない", (await title.locator(".lm-play-dev-banner").count()) === 0);

  // 書き出したゲームには入らない（開発サーバーのときだけ読む）
  const main = readFileSync(resolve(import.meta.dirname, "../../web/src/main.ts"), "utf8");
  ok("テストプレイの道具は開発サーバーのときだけ読む", /if \(import\.meta\.hot && !studio && !uiPreview\) \{\s*const hot = import\.meta\.hot;\s*void import\("\.\/play-dev\.ts"\)/.test(main));
} catch (e) {
  results.push(`NG  例外: ${e instanceof Error ? e.stack : String(e)}`);
  console.log(results.at(-1));
} finally {
  await browser.close();
  await server.close();
  rmSync(project, { recursive: true, force: true });
}
if (errors.length) console.log(`画面のエラー:\n${errors.join("\n")}`);
console.log(`スクリーンショット: ${shots}`);
process.exit(0);
