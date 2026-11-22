/**
 * 検査を黙らせる、下書き、シーンの情報、整える、校正用の台本、プロジェクトの設定の「チェック」を、制作画面で操作して確かめる。
 *   npx tsx packages/studio/dev/verify-check-tools.ts [スクリーンショットの置き場所]
 * ひな形を一時フォルダに写し、黙らせる診断・まとめられる暗転・既定値と同じパラメータ・下書きのファイルを足して開く。終わったらサーバーを止める。
 * NG の行があっても終了の値は 0（ほかの verify と同じ。NG の行を見る）。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadProject } from "@liminalia/project";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { startPlayerServer } from "../../cli/src/web.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";

const shots = resolve(process.argv[2] ?? join(import.meta.dirname, "../../../../studio-check-tools-shots"));
mkdirSync(shots, { recursive: true });
const project = mkdtempSync(join(tmpdir(), "liminalia-check-tools-"));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
const scenario = join(project, "scenario");
const configPath = join(project, "liminalia.json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
config.commandDefaults = { ...((config.commandDefaults as Record<string, unknown>) ?? {}), bg: { time: "1s" } };
writeFileSync(configPath, JSON.stringify(config, null, 2));
writeFileSync(
  join(scenario, "extra.lim"),
  ["# extra", "@bg hill_night.webp time=1s", "それは…", "@mask time=1s", "@chara-hide-all", "@bg hill_dusk.webp time=0ms", "@mask-off time=1s", "@if game.a==1", "地の文", "@end", "@jump side"].join("\n"),
);
writeFileSync(join(scenario, "side.lim"), "// lim: draft\n# side\n書きかけ\n");

const { server, url: playerUrl } = await startPlayerServer(loadProject(project), 0, true);
const url = `${playerUrl.replace(/\/$/, "")}${STUDIO_PAGE}`;
const results: string[] = [];
const ok = (name: string, cond: boolean, detail: unknown = "") => {
  const line = `${cond ? "OK  " : "NG  "} ${name}${!cond && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`;
  results.push(line);
  console.log(line);
};
const errors: string[] = [];
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
const disk = (file: string) => readFileSync(join(scenario, `${file}.lim`), "utf8");
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8")) as { check?: { severity?: Record<string, string> }; scenes?: Record<string, Record<string, string>> };
async function until(cond: () => boolean, ms = 8000): Promise<boolean> {
  for (let t = 0; t < ms; t += 200) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return cond();
}
const app = <T>(page: Page, code: string) => page.evaluate(`(() => { const s = window.__liminaliaStudioApp; const ed = s.debug.editor; ${code} })()`) as Promise<T>;

try {
  const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
  await context.addInitScript(`localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "0");`);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|404|409|autoplay|ERR_FAILED/i.test(m.text()) && errors.push(m.text()));
  // 確かめのダイアログは「はい」で進める
  page.on("dialog", (d) => void d.accept());
  await page.goto(url);
  await page.waitForSelector(".cm-content", { state: "attached" });
  await page.waitForTimeout(1500);

  // ---- 下書きの印（シーン一覧） ----
  const draftChip = page.locator('.toc-file[data-file="side"] .toc-draft');
  ok("下書きのファイルに「下書き」の印が出る", (await draftChip.count()) === 1 && (await draftChip.textContent()) === "下書き");
  ok("下書きでないファイルには印が無い", (await page.locator('.toc-file[data-file="extra"] .toc-draft').count()) === 0);
  await page.locator(".toc").screenshot({ path: join(shots, "toc-draft.png") }).catch(() => page.screenshot({ path: join(shots, "toc-draft.png") }));
  // ファイルのメニューから下書きにする・戻す
  await page.locator('.toc-file[data-file="extra"]').click({ button: "right" });
  const labels = await page.locator(".ctx-menu .ctx-item").allTextContents();
  ok("ファイルのメニューに「下書きにする」", labels.some((l) => l.includes("下書きにする")), labels);
  await page.locator(".ctx-menu .ctx-item", { hasText: "下書きにする" }).click();
  ok("「下書きにする」でファイルの先頭に // lim: draft を書く", await until(() => disk("extra").startsWith("// lim: draft\n")), disk("extra").slice(0, 40));
  await page.waitForSelector('.toc-file[data-file="extra"] .toc-draft', { timeout: 8000 }).catch(() => undefined);
  await page.locator('.toc-file[data-file="extra"]').click({ button: "right" });
  await page.locator(".ctx-menu .ctx-item", { hasText: "下書きから戻す" }).click();
  ok("「下書きから戻す」で印を消す", await until(() => disk("extra").startsWith("# extra")), disk("extra").slice(0, 40));

  // ---- チェック: まとめて修正、この行では出さない、この種類を出さない ----
  await page.keyboard.press("Control+3");
  await page.waitForSelector(".check-surface:not([hidden])", { timeout: 10000 });
  await page.locator(".check-rerun, .check-clear-actions button").first().click();
  await page.waitForTimeout(2500);
  const fixRows = await page.locator(".check-fix").allTextContents();
  ok("既定値と同じパラメータの「まとめて修正」", fixRows.some((t) => t.includes("既定値と同じパラメータ")), fixRows);
  ok("@scene-change にまとめられる暗転の「まとめて修正」", fixRows.some((t) => t.includes("@scene-change にまとめられる暗転")), fixRows);
  ok("下書きへ移る行の警告が出る", ((await page.locator(".check-problems").textContent()) ?? "").includes("下書きのファイル side"));
  const defaultFilter = page.locator(".check-fix", { hasText: "既定値と同じパラメータ" }).locator(".check-fix-filter");
  await defaultFilter.click();
  const filteredText = (await page.locator(".check-problems").textContent()) ?? "";
  ok("既定値と同じパラメータだけに絞る", filteredText.includes("既定値（commandDefaults）と同じ") && !filteredText.includes("下書きのファイル side") && (await defaultFilter.getAttribute("aria-pressed")) === "true", filteredText);
  await defaultFilter.click();
  ok("もう一度押すと絞り込みを解除", ((await page.locator(".check-problems").textContent()) ?? "").includes("下書きのファイル side"));
  await page.locator('.check-pill[data-kind="warning"]').click();
  ok("警告だけに絞る", (await page.locator('.check-problems .sev-chip').count()) > 0 && (await page.locator('.check-problems .sev-chip:not(.is-warning)').count()) === 0);
  await page.locator('.check-pill[data-kind="warning"]').click();
  await page.locator('.check-pill[data-kind="suggestion"]').click();
  ok("提案だけに絞る", (await page.locator('.check-problems .sev-chip').count()) > 0 && (await page.locator('.check-problems .sev-chip:not(.is-suggestion)').count()) === 0);
  await page.locator('.check-pill[data-category="command"]').click();
  ok("分類と種別を組み合わせる", (await page.locator('.check-pill[data-kind="suggestion"]').getAttribute("aria-pressed")) === "true" && (await page.locator('.check-problems .sev-chip:not(.is-suggestion)').count()) === 0);
  await page.locator('.check-pill[data-category="command"]').click();
  await page.locator('.check-pill[data-kind="suggestion"]').click();
  await page.screenshot({ path: join(shots, "check.png") });
  // 暗転の塊をまとめる
  const sceneFix = page.locator(".check-fix", { hasText: "@scene-change にまとめられる暗転" });
  await sceneFix.locator(".check-fix-run").click();
  await page.locator(".confirm-dialog .primary").click().catch(() => undefined);
  // ひな形の commandDefaults は @scene-change の time が 1200ms なので、1s は書く。
  // @mask は暗転しきってから枠を隠すので、まとめた @scene-change にも hide-window-at=covered を書く（lang の scene-change.ts）
  ok("まとめて修正で @mask の塊を @scene-change の一行にする", await until(() => disk("extra").includes("@scene-change hill_dusk.webp time=1s hide-window-at=covered\n") && !disk("extra").includes("@mask-off")), disk("extra"));
  await page.waitForTimeout(1500);
  // 行のメニュー
  const row = page.locator(".check-problems li", { hasText: "一つだけ" }).first();
  await row.scrollIntoViewIfNeeded();
  ok("警告と情報の行に「…」が付く", (await row.locator(".diag-more").count()) === 1);
  await row.locator(".diag-more").click();
  const rowMenu = await page.locator(".ctx-menu .ctx-item").allTextContents();
  ok("行のメニューに「この行では出さない」「この種類を出さない」", rowMenu.some((l) => l.includes("この行では出さない")) && rowMenu.some((l) => l.includes("この種類を出さない")), rowMenu);
  await page.screenshot({ path: join(shots, "check-row-menu.png") });
  await page.locator(".ctx-menu .ctx-item", { hasText: "この行では出さない" }).click();
  ok("「この行では出さない」でその行の前に // lim-ignore を書く", await until(() => disk("extra").includes("// lim-ignore single-ellipsis\nそれは…")), disk("extra"));
  await page.waitForTimeout(1500);
  const sameRow = page.locator(".check-problems li", { hasText: "既定値" }).first();
  await sameRow.click({ button: "right" });
  await page.locator(".ctx-menu .ctx-item", { hasText: "この種類を出さない" }).click();
  ok("「この種類を出さない」で check.severity に off を書く", await until(() => readConfig().check?.severity?.["same-as-default"] === "off"), readConfig().check);
  await page.waitForTimeout(2000);
  ok("off にした種類は一覧から消える", !((await page.locator(".check-problems").textContent().catch(() => "")) ?? "").includes("既定値（commandDefaults）と同じ"));

  // ---- 問題の吹き出し（コード表示） ----
  await page.keyboard.press("Control+1");
  await page.waitForTimeout(500);
  await app(page, "s.debug.open && s.debug.open('extra')").catch(() => undefined);
  await page.locator('.toc-file[data-file="extra"] .toc-file-name').click();
  await page.waitForTimeout(1500);
  const lines = disk("extra").split("\n");
  const unreached = lines.findIndex((l) => l.startsWith("@if")) + 1;
  // 吹き出しの操作（波線にマウスを重ねる）
  // 新しい警告の行を書き足して、打鍵ごとの検査の波線を出す
  await app(page, "ed.view.dispatch({ changes: { from: ed.state.doc.length, insert: \"\\nこれも…\" } })");
  await page.waitForTimeout(1200);
  // 保存の検査が届くと検査し直し、開いている吹き出しは閉じる（verify.ts の「hover で直し方」と同じ）。保存が済んでから乗せる
  await page.waitForFunction(() => document.querySelector(".save-status")?.textContent === "保存済み", undefined, { timeout: 10000 });
  await page.waitForTimeout(500);
  const marks = page.locator(".cm-lintRange-info, .cm-lintRange-warning");
  ok("コード表示に警告と情報の波線", (await marks.count()) >= 1, unreached);
  if ((await marks.count()) > 0) {
    await marks.first().hover();
    await page.waitForSelector(".cm-tooltip-lint", { timeout: 5000 }).catch(() => undefined);
    const actions = await page.locator(".cm-tooltip-lint .cm-diagnosticAction").allTextContents();
    ok("問題の吹き出しに「この行では出さない」「この種類を出さない」", actions.includes("この行では出さない") && actions.includes("この種類を出さない"), actions);
    await page.screenshot({ path: join(shots, "lint-tooltip.png") });
  }

  // ---- 整える（シナリオの見出しのメニュー）と元に戻す ----
  const before = await app<string>(page, "return ed.text()");
  await page.locator(".ed-title").click();
  await page.locator(".ctx-menu .ctx-item", { hasText: "整える" }).click();
  await page.waitForTimeout(500);
  const after = await app<string>(page, "return ed.text()");
  ok("「整える」で式の空白を整える", after.includes("@if game.a == 1") && after !== before, after.split("\n").find((l) => l.startsWith("@if")));
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(300);
  ok("「整える」は ⌘Z で元に戻せる", (await app<string>(page, "return ed.text()")) === before);

  // ---- シーンの情報（シーン一覧のシーンのメニュー） ----
  const head = page.locator('.toc-file[data-file="extra"]');
  if ((await head.locator(".toc-file-fold").getAttribute("aria-expanded")) !== "true") await head.locator(".toc-file-fold").click();
  await page.waitForTimeout(300);
  await page.locator(".scene-row", { has: page.locator(".scene-name", { hasText: /^extra$/ }) }).first().click({ button: "right" });
  await page.locator(".ctx-menu .ctx-item", { hasText: "シーンの情報" }).click();
  await page.waitForSelector(".scene-info[open]");
  await page.locator(".scene-info input").nth(0).fill("アカリ");
  await page.locator(".scene-info input").nth(1).fill("8/12");
  await page.locator(".scene-info input").nth(2).fill("天文台");
  await page.screenshot({ path: join(shots, "scene-info.png") });
  await page.locator(".scene-info .primary").click();
  ok("シーンの情報を liminalia.json の scenes に書く", await until(() => JSON.stringify(readConfig().scenes?.["extra#extra"]) === JSON.stringify({ pov: "アカリ", date: "8/12", place: "天文台" })), readConfig().scenes);

  // ---- プロジェクトの設定の「チェック」 ----
  await page.locator(".proj").click();
  await page.waitForTimeout(1500);
  const groups = await page.locator(".proj-section-head h3").allTextContents();
  ok("プロジェクトの設定に「チェック」の欄", groups.includes("チェック"), groups);
  const checkSection = page.locator(".proj-section", { has: page.locator("h3", { hasText: /^チェック$/ }) }).first();
  ok("チェックの欄に約物、演出の決まり、診断の重さ、字下げ", (await checkSection.locator('.proj-field[data-path="check.punctuation"]').count()) === 1 && (await checkSection.locator('.proj-field[data-path="check.rules"]').count()) === 1 && (await checkSection.locator('.proj-field[data-path="check.severity"]').count()) === 1 && (await checkSection.locator('.proj-field[data-path="fmt.indent"]').count()) === 1);
  ok("「この種類を出さない」で書いたものが診断の重さに出る", ((await checkSection.locator('.proj-field[data-path="check.severity"]').textContent()) ?? "").includes("same-as-default"));
  await checkSection.screenshot({ path: join(shots, "settings-check.png") });
  // 約物を一つ外す、決まりを一つ入れる
  await checkSection.locator('.proj-field[data-path="check.punctuation"] input[data-code="single-ellipsis"]').uncheck();
  await checkSection.locator('.proj-field[data-path="check.rules"] .proj-rule').nth(2).locator('input[type="checkbox"]').check();
  ok("約物の欄で外したものを check.punctuation.off に書く", await until(() => JSON.stringify((readConfig().check as { punctuation?: unknown } | undefined)?.punctuation) === JSON.stringify({ off: ["single-ellipsis"] })), readConfig().check);
  ok("演出の決まりの欄で入れたものを check.rules に書く", await until(() => JSON.stringify((readConfig().check as { rules?: unknown } | undefined)?.rules) === JSON.stringify([{ rule: "no-pov-sprite" }])), readConfig().check);
  await page.waitForTimeout(800);
  await checkSection.screenshot({ path: join(shots, "settings-check-2.png") });

  // ---- 校正用の台本（プロジェクト → 書き出し） ----
  await page.locator("button.seg", { hasText: /^書き出し$/ }).first().click();
  await page.waitForTimeout(1000);
  const proof = page.locator(".proj-section", { has: page.locator("h3", { hasText: "校正用の台本" }) });
  ok("書き出しのタブに「校正用の台本」", (await proof.count()) === 1);
  if ((await proof.count()) === 1) {
    await proof.locator("select").selectOption("html");
    await proof.locator("button").click();
    ok("校正用の台本を exports/script に書き出す", await until(() => existsSync(join(project, "exports/script/start.html")) && existsSync(join(project, "exports/script/index.html"))));
    await proof.screenshot({ path: join(shots, "proof-script.png") });
  }

  ok("画面の誤りが無い", errors.length === 0, errors.slice(0, 3));
  await context.close();
} finally {
  await browser.close();
  await server.close();
  rmSync(project, { recursive: true, force: true });
}
console.log(`\n${results.filter((r) => r.startsWith("NG")).length} NG / ${results.length}`);
