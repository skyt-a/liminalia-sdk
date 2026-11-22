/**
 * 元に戻す操作を、lim studio と同じ開発サーバーをブラウザで開いて確かめる。
 *   npx tsx packages/studio/dev/verify-undo.ts [スクリーンショットの置き場所]
 * - 全ファイルの置換と「まとめて修正」を一つの操作として、お知らせと置換の欄の「元に戻す」でまとめて戻す（開いていないファイルも）
 * - ゲームの設定・プロジェクト・変数の初期値・コマンドの既定値の変更を ⌘Z で戻し、⇧⌘Z でやり直す
 * - テーマの適用と「すべて既定に戻す」と変数の初期値の保存は、お知らせの「元に戻す」で戻す
 * - liminalia.json の変更履歴（ゲームの設定・プロジェクト・変数の「変更履歴」）から前の版に戻し、それも ⌘Z で戻せる
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
import { openGameField, openGameSection } from "../test/game-section.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-verify-undo"));
mkdirSync(shots, { recursive: true });
const project = mkdtempSync(join(tmpdir(), "liminalia-verify-undo-"));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
const scenario = join(project, "scenario");
const A = ["# ra", "　ほしぞらの一行目。", "　句読点が重なる。。", "　ほしぞら。"].join("\n");
const B = ["# rb", "　遠くのほしぞら。", "　ここも重なる。。"].join("\n");
writeFileSync(join(scenario, "ra.lim"), A);
writeFileSync(join(scenario, "rb.lim"), B);
const disk = (file: string) => readFileSync(join(scenario, `${file}.lim`), "utf8");
const config = () => JSON.parse(readFileSync(join(project, "liminalia.json"), "utf8")) as Record<string, unknown> & { ui?: Record<string, unknown>; commandDefaults?: unknown; variables?: Record<string, unknown>; author?: string };

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
const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** 条件がそろうまで待つ（そろえば true）。 */
async function until(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}
/** いちばん新しいお知らせの「元に戻す」を押す。 */
async function noticeUndo(page: Page): Promise<string> {
  const notice = page.locator(".notice:not([hidden])");
  await notice.waitFor({ timeout: 8000 });
  const text = (await notice.textContent()) ?? "";
  await notice.locator(".notice-action").click();
  return text;
}
/** 入力欄の外を押して、画面の ⌘Z を効かせる。 */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(100);
}

try {
  const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem("liminalia.studio.tourDone", "1");
    localStorage.setItem("liminalia.studio.blocks", "0");
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|404|409|autoplay|ERR_FAILED/i.test(m.text()) && errors.push(m.text()));
  await page.goto(`${base}${STUDIO_PAGE}`);
  await page.waitForSelector(".cm-content", { state: "attached" });
  await page.waitForTimeout(1500);
  const app = <T>(code: string) => page.evaluate(`(() => { const s = window.__liminaliaStudioApp; const ed = s.debug.editor; ${code} })()`) as Promise<T>;
  const tab = (name: string) => page.locator(".topbar .tab, .topbar .proj, .tabs-main .tab", { hasText: name }).first().click();

  // ---- 全ファイルの置換（開いているファイルと開いていないファイル） ----
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.type("ra.lim");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  await page.keyboard.press(`${MOD}+Shift+f`);
  await page.locator(".toc-search").first().fill("ほしぞら");
  await page.locator(".toc-replace-toggle").click();
  await page.locator(".toc-replace").fill("流星");
  await page.waitForSelector(".replace-line");
  await page.locator(".replace-run").click();
  await until(() => disk("rb").includes("流星"));
  ok("置換: 開いているファイルと開いていないファイルを書き換える", disk("rb").includes("流星") && (await app<string>("return ed.text()")).includes("流星"));
  await page.screenshot({ path: join(shots, "replace-notice.png") });
  const replaced = await noticeUndo(page);
  ok("置換: お知らせに「元に戻す」が付く", replaced.includes("置換しました"), replaced);
  ok("置換: お知らせの「元に戻す」で、開いていないファイルも含めてまとめて戻す", await until(async () => disk("rb") === B && (await app<string>("return ed.text()")) === A), { rb: disk("rb"), ra: await app<string>("return ed.text()") });
  await until(async () => disk("ra") === A);
  ok("置換: 戻した開いているファイルも保存する", disk("ra") === A, disk("ra"));
  // 置換の欄に残る「元に戻す」
  await page.waitForSelector(".replace-line");
  await page.locator(".replace-run").click();
  await until(() => disk("rb").includes("流星"));
  await page.locator(".replace-undo").click();
  ok("置換: 置換の欄の「元に戻す」でもまとめて戻す", await until(async () => disk("rb") === B && (await app<string>("return ed.text()")) === A));
  ok("置換: 戻したら欄にそう出す", ((await page.locator(".replace-report").textContent()) ?? "").includes("置換を元に戻しました"), (await page.locator(".replace-report").textContent()) ?? "");
  await page.screenshot({ path: join(shots, "replace-undone.png") });
  await page.locator(".toc-replace-toggle").click();
  await page.locator(".toc-search").first().fill("");
  await page.waitForTimeout(500);

  // ---- 「まとめて修正」（句読点の重なり） ----
  await app("ed.gotoLine(1)");
  await page.waitForTimeout(1500);
  await tab("チェック");
  await page.waitForTimeout(800);
  const fixRow = page.locator(".check-fix", { hasText: "句読点の重なり" });
  ok("まとめて修正: 二つのファイルの句読点の重なりが並ぶ", ((await fixRow.textContent()) ?? "").includes("2"), (await fixRow.textContent().catch(() => "")) ?? "");
  await fixRow.locator(".check-fix-run").click();
  await page.locator(".confirm-dialog .primary").click();
  await until(() => !disk("rb").includes("。。"));
  ok("まとめて修正: 開いていないファイルも直す", !disk("rb").includes("。。") && !(await app<string>("return ed.text()")).includes("。。"));
  const fixed = await noticeUndo(page);
  ok("まとめて修正: お知らせに「元に戻す」が付く", fixed.length > 0, fixed);
  ok("まとめて修正: 「元に戻す」で、すべてのファイルをまとめて戻す", await until(async () => disk("rb") === B && (await app<string>("return ed.text()")) === A));

  // ---- ゲームの設定: ⌘Z・⇧⌘Z ----
  // 欄は見出しで開いたカテゴリの分だけ出る。文字のカテゴリを開く
  await tab("ゲームの設定");
  await openGameField(page, "text.color");
  await page.waitForTimeout(800);
  const colorText = page.locator('[data-field="text.color"] .game-color-text');
  await colorText.fill("#112233");
  await colorText.press("Enter");
  await colorText.dispatchEvent("change");
  ok("ゲームの設定: 直すとすぐ書く", await until(() => (config().ui as { text?: { color?: string } } | undefined)?.text?.color === "#112233"));
  await blur(page);
  await page.keyboard.press(`${MOD}+z`);
  ok("ゲームの設定: ⌘Z で元に戻す", await until(() => (config().ui as { text?: { color?: string } } | undefined)?.text?.color === undefined), config().ui);
  ok("ゲームの設定: 戻したら欄も読み直す", await until(async () => (await colorText.inputValue()) === ""));
  await blur(page);
  await page.keyboard.press(`${MOD}+Shift+z`);
  ok("ゲームの設定: ⇧⌘Z でやり直す", await until(() => (config().ui as { text?: { color?: string } } | undefined)?.text?.color === "#112233"));

  // テーマの適用 → お知らせの「元に戻す」
  const beforeTheme = JSON.stringify(config().ui ?? {});
  await openGameSection(page, "theme");
  await page.locator(".game-theme-current button").click();
  await page.waitForSelector(".game-theme-dialog[open]");
  const card = page.locator(".game-theme-dialog .game-theme:not([aria-pressed=true])").nth(1);
  const themeId = await card.getAttribute("data-theme-id");
  await card.click();
  await page.locator(".game-theme-dialog footer .primary").click();
  await page.locator(".confirm-dialog .primary").click({ timeout: 3000 }).catch(() => undefined);
  ok("テーマの適用: liminalia.json の ui が替わる", await until(() => (config().ui as { system?: { preset?: string } } | undefined)?.system?.preset === themeId), { themeId, ui: config().ui });
  await page.screenshot({ path: join(shots, "theme-notice.png") });
  const themeNotice = await noticeUndo(page);
  ok("テーマの適用: お知らせに「元に戻す」が付く", themeNotice.includes("適用しました"), themeNotice);
  ok("テーマの適用: 「元に戻す」で当てる前の設定に戻る", await until(() => JSON.stringify(config().ui ?? {}) === beforeTheme), config().ui);

  // すべて既定に戻す（ui とコマンドの既定値）→ お知らせの「元に戻す」
  const beforeReset = { ui: JSON.stringify(config().ui ?? {}), defaults: JSON.stringify(config().commandDefaults ?? null) };
  await page.locator(".game-reset button").click();
  await page.locator(".confirm-dialog .primary").click();
  ok("すべて既定に戻す: ui とコマンドの既定値を外す", await until(() => config().ui === undefined && config().commandDefaults === undefined), { ui: config().ui, d: config().commandDefaults });
  const resetNotice = await noticeUndo(page);
  ok("すべて既定に戻す: お知らせに「元に戻す」が付く", resetNotice.includes("既定に戻しました"), resetNotice);
  ok("すべて既定に戻す: 「元に戻す」で ui もコマンドの既定値も一度に戻る", await until(() => JSON.stringify(config().ui ?? {}) === beforeReset.ui && JSON.stringify(config().commandDefaults ?? null) === beforeReset.defaults), { ui: config().ui, d: config().commandDefaults });

  // ---- 変数の初期値: お知らせの「元に戻す」と ⌘Z ----
  await tab("変数");
  await page.waitForTimeout(1200);
  const initial = page.locator('input.vars-initial[aria-label^="game.looked "]');
  await initial.fill("5");
  await initial.press("Enter");
  ok("変数: 初期値を保存する", await until(() => config().variables?.["game.looked"] === 5 || (config().variables as { game?: { looked?: number } } | undefined)?.game?.looked === 5), config().variables);
  const varNotice = await noticeUndo(page);
  ok("変数: お知らせに「元に戻す」が付く", varNotice.includes("初期値を保存しました"), varNotice);
  ok("変数: 「元に戻す」で初期値を外す", await until(() => config().variables === undefined), config().variables);
  await initial.fill("7");
  await initial.press("Enter");
  await until(() => config().variables !== undefined);
  await blur(page);
  await page.keyboard.press(`${MOD}+z`);
  ok("変数: ⌘Z でも戻す", await until(() => config().variables === undefined), config().variables);

  // ---- プロジェクトの設定: ⌘Z ----
  await page.locator(".topbar .proj").click();
  await page.waitForTimeout(1200);
  const author = page.locator('[data-path="author"] input').first();
  await author.fill("わたし");
  await author.dispatchEvent("change");
  ok("プロジェクト: 作者を書く", await until(() => config().author === "わたし"), config().author);
  ok("プロジェクト: 起動し直さないと効かない項目を変えたら「再起動すると反映されます」の帯を出す", await until(async () => (await page.locator(".proj-banner").count()) === 1));
  await blur(page);
  await page.keyboard.press(`${MOD}+z`);
  ok("プロジェクト: ⌘Z で元に戻す", await until(() => config().author === undefined), config().author);
  ok("プロジェクト: 戻したら欄も読み直す", await until(async () => (await author.inputValue().catch(() => "x")) === ""));
  ok("プロジェクト: 起動したときの値に戻したら帯を消す", await until(async () => (await page.locator(".proj-banner").count()) === 0));

  // ---- liminalia.json の変更履歴から戻す ----
  const beforeHistory = readFileSync(join(project, "liminalia.json"), "utf8");
  await page.locator(".proj-bar .view-history").click();
  await page.waitForSelector(".dialog.history .history-item");
  ok("変更履歴: liminalia.json の変更履歴が並ぶ", (await page.locator(".dialog.history .history-item").count()) >= 3 && ((await page.locator(".dialog.history .history-head").textContent()) ?? "").includes("liminalia.json"));
  // 今の内容と違う版を選ぶ
  let pick = 1;
  for (; pick < (await page.locator(".dialog.history .history-item").count()); pick++) {
    await page.locator(".dialog.history .history-item").nth(pick).click();
    await page.waitForTimeout(400);
    if (await page.locator(".dialog.history .history-foot .primary").isEnabled()) break;
  }
  await page.screenshot({ path: join(shots, "config-history.png") });
  const wanted = await page.evaluate((i) => fetch(`/__liminalia/studio/api/part-file/history?part=%40config`).then((r) => r.json()).then((list: { id: string }[]) => fetch(`/__liminalia/studio/api/part-file/history/item?part=%40config&id=${list[i]!.id}`)).then((r) => r.json()).then((f: { text: string }) => f.text), pick);
  await page.locator(".dialog.history .history-foot .primary").click();
  ok("変更履歴: 選んだ版の内容に戻す", await until(() => readFileSync(join(project, "liminalia.json"), "utf8") === wanted));
  await page.locator(".dialog.history .history-head button").click();
  await blur(page);
  await page.keyboard.press(`${MOD}+z`);
  ok("変更履歴: 戻したことも ⌘Z で元に戻せる", await until(() => readFileSync(join(project, "liminalia.json"), "utf8") === beforeHistory));
  // ゲームの設定と変数の画面にも「変更履歴」
  await tab("ゲームの設定");
  await page.waitForTimeout(500);
  ok("変更履歴: ゲームの設定の画面にもある", (await page.locator(".game-bar .view-history").count()) === 1);
  await page.screenshot({ path: join(shots, "game-history-button.png") });
  await tab("変数");
  await page.waitForTimeout(500);
  ok("変更履歴: 変数の画面にもある", (await page.locator(".vars-bar .view-history").count()) === 1);
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
