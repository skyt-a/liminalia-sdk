/**
 * 話者ごとの台詞・エンディングの一覧・テーマの保存・プラグインのチェック・英語の表示を、lim studio の画面で操作して確かめる。
 *   npx tsx packages/studio/dev/verify-lists.ts <スクリーンショットの置き場所> [ポート（既定 5313）]
 * ひな形（templates/default）を一時フォルダに写し、脇道のシナリオと check を持つプラグインを足して開く。リポジトリのひな形は書き換えない。
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";
import { openGameSection } from "../test/game-section.ts";
import { autoConfirm } from "./confirm-auto.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-verify-lists"));
mkdirSync(shots, { recursive: true });
const port = Number(process.argv[3] ?? 5313);
const url = `http://localhost:${port}${STUDIO_PAGE}`;

const project = mkdtempSync(join(tmpdir(), "liminalia-verify-lists-"));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
const plugin = (name: string, body: string) => {
  const dir = join(project, "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module", exports: { "./commands": "./commands.mjs" } }));
  writeFileSync(join(dir, "commands.mjs"), body);
};
plugin(
  "rules",
  `const gameOver = { name: "game-over", summary: "ゲームオーバー", positional: [], params: { ending: { type: { kind: "string" }, doc: "種類" } }, example: "@game-over", ends: true };
export default {
  name: "rules",
  commands: [gameOver],
  check(project) {
    return [
      { severity: "warning", code: "rules-one", message: "ルールの注意です（訳あり）: " + project.scripts.size, messageEn: "A rule warning (translated): " + project.scripts.size, file: "side", line: 2, hint: "直し方", hintEn: "How to fix" },
      { severity: "warning", code: "rules-two", message: "ルールの注意です（訳なし）", file: "side", line: 3 },
    ];
  },
};
`,
);
plugin("broken", `export default { name: "broken", commands: [], check() { throw new Error("わざと失敗"); } };\n`);
writeFileSync(join(project, "scenario/side.lim"), `# side_a\nアカリ「脇道の台詞です」\n　脇道の地の文。\nソウ「脇道でソウが話します」\n@game-over ending=bad\n\n# side_b\nアカリ「行き止まりです」\n@nope\n@stop\n\n# side_c\nアカリ「ここには届きません」\n@stop\n`);
{
  const path = join(project, "liminalia.json");
  writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, "utf8")) as object), plugins: ["./plugins/rules", "./plugins/broken"] }, null, 2));
}
const server = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/bin/lim.mjs"), "studio", project, "--port", String(port)], { stdio: "ignore", env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
for (let i = 0; ; i++) {
  const up = await fetch(url).then((r) => r.ok).catch(() => false);
  if (up) break;
  if (i > 120) throw new Error("lim studio が起動しません");
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
const failures: string[] = [];
const errors: string[] = [];
const expect = (label: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(label);
};

/** 確認のダイアログへの答え（はじめは「はい」。確かめの途中で差し替える）。 */
let confirmHandler: (message: string) => boolean = () => true;

async function open(language: "ja" | "en"): Promise<Page> {
  const context = await browser.newContext({ locale: language === "ja" ? "ja-JP" : "en-US", viewport: { width: 1440, height: 900 } });
  await context.addInitScript('localStorage.setItem("liminalia.studio.tourDone", "1")');
  await autoConfirm(context, (m) => confirmHandler(m));
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|404|409|autoplay/i.test(m.text()) && errors.push(m.text()));
  await page.goto(`${url}?lang=${language}`);
  await page.waitForSelector(".cm-content", { state: "attached" });
  await page.waitForTimeout(1500);
  return page;
}
/** 開いているファイルと、台本のカーソルの行・文字。 */
const editorState = (page: Page) =>
  page.evaluate(() => {
    const { debug } = (window as unknown as { __liminaliaStudioApp: { debug: { file: string | null; editor: { cursorLine(): number; state: { doc: { toString(): string } } } } } }).__liminaliaStudioApp;
    return { file: debug.file, line: debug.editor.cursorLine(), text: debug.editor.state.doc.toString() };
  });

// ---- 日本語 ----
const ja = await open("ja");

// 1. キャラクターの「台詞」
await ja.keyboard.press("Control+4");
await ja.waitForTimeout(800);
await ja.locator(".chars-view .seg", { hasText: "台詞" }).click();
await ja.waitForSelector(".says-row");
const akari = await ja.locator(".says-row").count();
expect("台詞の一覧が出る", akari > 0, akari);
const firstFiles = await ja.locator(".says-file-name").allTextContents();
expect("ファイルごとに並ぶ（名前順）", firstFiles.join() === [...firstFiles].sort((a, b) => a.localeCompare(b, "en", { numeric: true })).join(), firstFiles);
await ja.screenshot({ path: join(shots, "01-lines-ja.png") });
await ja.fill(".says-search", "脇道");
await ja.waitForTimeout(100);
const filtered = await ja.locator(".says-row").count();
expect("文字列で絞り込める", filtered >= 1 && filtered < akari, { filtered, akari });
const count = await ja.locator(".says-count").textContent();
expect("絞り込みの数を出す", /\d+ \/ \d+/.test(count ?? ""), count);
await ja.screenshot({ path: join(shots, "02-lines-filter-ja.png") });
const rowLine = Number(await ja.locator(".says-row .says-line").first().textContent());
await ja.locator(".says-row").first().click();
await ja.waitForSelector(".desk:not([hidden])");
await ja.waitForTimeout(800);
const at = await editorState(ja);
expect("行を押すとシナリオのその行へ移る", at.file === "side" && at.line === rowLine, { file: at.file, line: at.line, rowLine });

// 2. ブロック表示の強調
await ja.locator(".seg", { hasText: "ブロック" }).first().click();
await ja.waitForSelector(".blk-text-row.is-say");
await ja.locator(".blk-text-row.is-say").first().hover();
await ja.locator(".blk-text-row.is-say .blk-focus-toggle").first().click();
await ja.waitForSelector(".blk-focus-bar:not([hidden])");
const dim = await ja.evaluate(() => ({
  say: getComputedStyle(document.querySelector(".blk-text-row.is-focus-speaker")!).opacity,
  other: getComputedStyle(document.querySelector(".blk-line-row:not(.is-focus-speaker):not(.blk-label)")!).opacity,
}));
expect("この話者の行はそのまま、ほかの行は薄くなる", dim.say === "1" && Number(dim.other) < 1, dim);
await ja.screenshot({ path: join(shots, "03-focus-ja.png") });
expect("強調しても文書は変わらない", (await editorState(ja)).text === at.text);
await ja.locator(".blk-focus-bar button").click();
expect("やめると元に戻る", !(await ja.locator(".blk-list.is-speaker-focus").count()));
await ja.locator(".blk-text-row.is-say").first().click({ button: "right" });
const menu = await ja.locator(".ctx-menu").textContent();
expect("右クリックのメニューにも出る", (menu ?? "").includes("この人の台詞を目立たせる"), menu);
await ja.keyboard.press("Escape");
await ja.locator(".seg", { hasText: "コード" }).first().click();

// 3. エンディングの一覧（全ルートテストの前）
await ja.keyboard.press("Control+2");
await ja.waitForSelector(".map-card");
await ja.waitForTimeout(500);
await ja.locator(".map-endings").click();
await ja.waitForSelector(".map-endings-row");
const rows = await ja.locator(".map-endings-row").allTextContents();
expect("プレイの終わるシーンが並ぶ（種類の bad と終了）", rows.some((r) => r.includes("bad")) && rows.some((r) => r.includes("終了")), rows);
expect("未実行ならそう書く", (await ja.locator(".map-endings-note").textContent())!.includes("未実行") && rows.every((r) => r.includes("未確認")), rows);
await ja.locator(".map-endings-row", { hasText: "bad" }).click();
await ja.waitForTimeout(900);
const centered = await ja.evaluate(() => {
  const card = document.querySelector<HTMLElement>('.map-card[data-id="side#side_a"]');
  const scroll = document.querySelector<HTMLElement>(".map-scroll")!;
  const view = scroll.getBoundingClientRect();
  if (!card) return null;
  const r = card.getBoundingClientRect();
  // 地図の端のシーンは、それ以上は動かせない（端まで寄せていればよい）
  const atX = scroll.scrollLeft <= 1 || scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 1;
  const atY = scroll.scrollTop <= 1 || scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1;
  return {
    hit: card.classList.contains("is-hit"),
    x: atX || Math.abs(r.left + r.width / 2 - (view.left + view.width / 2)) < 20,
    y: atY || Math.abs(r.top + r.height / 2 - (view.top + view.height / 2)) < 20,
    visible: r.top >= view.top && r.bottom <= view.bottom && r.left >= view.left && r.right <= view.right - 360,
  };
});
expect("押すとそのシーンを真ん中へ寄せて印を付ける", !!centered && centered.hit && centered.x && centered.y && centered.visible, centered);
await ja.screenshot({ path: join(shots, "04-endings-ja.png") });
await ja.locator(".map-endings-panel .icon-btn").click();

// 4. チェックの画面
await ja.keyboard.press("Control+3");
await ja.waitForSelector(".check-endings");
const endingCount = await ja.locator(".check-endings").textContent();
expect("チェックの画面にエンディングの数を出す", /エンディング \d+ 個/.test(endingCount ?? ""), endingCount);
const pluginPill = await ja.locator('.check-pill[data-category="plugin"]').getAttribute("data-count");
expect("プラグインの分類に数が入る（訳あり・訳なし・例外）", pluginPill === "3", pluginPill);
await ja.locator('.check-pill[data-category="plugin"]').click();
await ja.waitForTimeout(100);
const pluginRows = await ja.locator(".check-problems .msg").allTextContents();
expect("投げたプラグインもそのプラグインの診断として出る", pluginRows.some((t) => t.includes("わざと失敗") && t.includes("broken")), pluginRows);
await ja.screenshot({ path: join(shots, "05-check-plugin-ja.png") });
await ja.locator('.check-pill[data-category="plugin"]').click();
await ja.locator(".check-card button.primary", { hasText: "全ルートテスト" }).click();
await ja.waitForFunction(() => /\d+%/.test(document.querySelector(".check-big b")?.textContent ?? ""), undefined, { timeout: 60000 });
await ja.locator(".check-endings button").click();
await ja.waitForSelector(".map-endings-row");
await ja.waitForTimeout(500);
const covered = await ja.locator(".map-endings-row").allTextContents();
expect("チェックの画面から一覧を開け、全ルートテストの結果が出る", covered.some((r) => r.includes("未到達")) && covered.some((r) => /(?<!未)到達/.test(r)) && !covered.some((r) => r.includes("未確認")), covered);
const kindNote = await ja.locator(".map-endings-note").textContent();
expect("全ルートテストのあとは種類ごとの到達の数も出す", (kindNote ?? "").includes("種類ごとの到達: bad"), kindNote);
await ja.screenshot({ path: join(shots, "06-endings-covered-ja.png") });

// 5. テーマの保存（ゲームの設定の欄は見出しで開いたカテゴリの分だけ出るので、テーマのカテゴリを開いてから押す）
await ja.keyboard.press("Control+7");
await (await openGameSection(ja, "theme")).locator(".game-theme-current button").click();
await ja.waitForSelector(".game-themes");
const builtinTrash = await ja.locator(".game-theme-trash").count();
expect("用意されたテーマには外すボタンが無い", builtinTrash === 0, builtinTrash);
await ja.locator(".game-theme").nth(1).click();
expect("選んだテーマが適用前に選択される", (await ja.locator(".game-theme-dialog[open] .game-theme[aria-pressed=true]").textContent())!.includes("和紙"));
await ja.locator(".game-theme-dialog[open] footer .primary").click();
await ja.waitForFunction(() => document.querySelector(".game-theme-current")?.textContent?.includes("和紙"));
expect("適用したテーマが使用中になる", (await ja.locator(".game-theme-current").textContent())!.includes("和紙"));
await (await openGameSection(ja, "theme")).locator(".game-theme-current button").click();
await ja.getByRole("tab", { name: "オリジナルテーマ" }).click();
expect("オリジナルが空なら案内を出す", await ja.getByText("オリジナルテーマはまだありません。").isVisible());
const fieldName = async (name: string) => {
  await ja.locator(".game-theme-save-open").click();
  await ja.fill(".game-theme-save-name", name);
};
await fieldName("私のテーマ");
await ja.screenshot({ path: join(shots, "07-theme-form-ja.png") });
await ja.locator(".game-theme-save .primary").click();
await ja.waitForSelector(".game-theme-wrap");
expect("保存すると一覧に並ぶ", (await ja.locator(".game-theme-wrap").textContent())!.includes("私のテーマ"));
const themeFile = join(project, "themes/theme/theme.json");
expect("themes/<id>/theme.json を書く", existsSync(themeFile));
const saved = JSON.parse(readFileSync(themeFile, "utf8")) as { name: string; ui: Record<string, unknown> };
expect("操作の項目を入れない", !("keys" in saved.ui) && !("defaults" in saved.ui) && !("preset" in ((saved.ui.system as object) ?? {})), saved.ui);
await ja.screenshot({ path: join(shots, "08-theme-saved-ja.png") });
// 同じ名前は確かめる
let asked = "";
confirmHandler = (m) => {
  asked = m;
  confirmHandler = () => true;
  return false;
};
await fieldName("私のテーマ");
await ja.locator(".game-theme-save .primary").click();
await ja.waitForTimeout(400);
expect("同じ名前は上書きを確かめる", asked.includes("上書き"), asked);
await ja.locator(".game-theme-save .primary").click();
await ja.waitForTimeout(600);
expect("確かめたら上書きする（増えない）", (await ja.locator(".game-theme-wrap").count()) === 1);
// 外す・戻す
await ja.locator(".game-theme-wrap").hover();
await ja.locator(".game-theme-trash").click();
await ja.waitForFunction(() => !document.querySelector(".game-theme-wrap"));
expect("ごみ箱に入れると一覧から消える", !existsSync(themeFile));
await ja.screenshot({ path: join(shots, "09-theme-trashed-ja.png") });
await ja.locator(".notice button").first().click();
await (await openGameSection(ja, "theme")).locator(".game-theme-current button").click();
await ja.getByRole("tab", { name: "オリジナルテーマ" }).click();
await ja.waitForSelector(".game-theme-wrap");
expect("元に戻せる", existsSync(themeFile));

await ja.keyboard.press("Escape");

// 6. ボイス: 読んだあとで行が変わったら書かない（ファイルの選択を開いている間と、落としたときのダイアログを開いている間）
{
  const scene = join(project, "scenario/vo_check.lim");
  const STALE = "シナリオが変わっていたので読み込み直しました";
  const base = ["# a", "// メモ", "アカリ「声の確かめ一」", "アカリ「声の確かめ二」"];
  writeFileSync(scene, `${base.join("\n")}\n`);
  await ja.locator(".topbar-screens").click();
  await ja.locator(".ctx-item", { hasText: "ボイス" }).click();
  const row = (text: string) => ja.locator(".voice-row", { hasText: text });
  await row("声の確かめ二").waitFor({ timeout: 15000 });
  const reloadedAt = async (line: number) => row("声の確かめ二").locator(".voice-at", { hasText: `vo_check:${line}` }).waitFor({ timeout: 15000 });
  const sound = { name: "take.ogg", mimeType: "audio/ogg", buffer: Buffer.from("x") };

  await row("声の確かめ二").locator(".voice-choose").click();
  const [chooser] = await Promise.all([ja.waitForEvent("filechooser"), ja.locator(".voice-picker button", { hasText: "ファイルから追加" }).click()]);
  writeFileSync(scene, `足した地の文\n${base.join("\n")}\n`);
  await reloadedAt(5);
  await chooser.setFiles({ ...sound, name: "pick.ogg" });
  await ja.getByText(STALE).first().waitFor({ timeout: 15000 });
  expect("ボイス: ファイルの選択を開いている間に行がずれたら書かず知らせる", !readFileSync(scene, "utf8").includes("@voice"), readFileSync(scene, "utf8"));
  await ja.waitForTimeout(300);

  // 落としたときのダイアログ（一致しないファイルを未設定の行へ割り当てる）
  await ja.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "take.ogg", { type: "audio/ogg" }));
    document.querySelector(".voice-view")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await ja.waitForSelector(".voice-drop select");
  await ja.locator(".voice-drop select").first().selectOption("vo_check:5");
  writeFileSync(scene, `足した地の文\nもう一行\n${base.join("\n")}\n`);
  await reloadedAt(6);
  await ja.locator(".voice-drop .primary").click();
  await ja.getByText(STALE).first().waitFor({ timeout: 15000 });
  expect("ボイス: ダイアログを開いている間に行がずれたら書かず知らせる", !readFileSync(scene, "utf8").includes("@voice"), readFileSync(scene, "utf8"));

  // 変わっていなければ書く。@voice はメモの上に入る
  await reloadedAt(6);
  await row("声の確かめ一").locator(".voice-choose").click();
  const [again] = await Promise.all([ja.waitForEvent("filechooser"), ja.locator(".voice-picker button", { hasText: "ファイルから追加" }).click()]);
  await again.setFiles({ ...sound, name: "pick2.ogg" });
  await ja.waitForFunction(() => document.querySelector(".voice-view .voice-row.is-set, .voice-view .voice-row.is-missing") !== null);
  await ja.waitForTimeout(500);
  const written = readFileSync(scene, "utf8").split("\n");
  expect("ボイス: 変わっていなければ書き、@voice はメモの上に入る", written.slice(2, 6).join("|") === "# a|@voice pick2.ogg|// メモ|アカリ「声の確かめ一」", written);
  rmSync(scene);
  await ja.keyboard.press("Control+1");
  await ja.waitForTimeout(800);
}

// ---- 英語 ----
const en = await open("en");
await en.keyboard.press("Control+3");
await en.waitForSelector(".check-endings");
await en.waitForTimeout(800);
const messages = await en.locator(".check-problems .msg").allTextContents();
const hints = await en.locator(".check-problems .hint").allTextContents();
const jp = /[぀-ヿ㐀-鿿]/;
expect("問題の文が英語で出る（訳の無いプラグインの文は原文のまま）", messages.filter((m) => jp.test(m)).every((m) => m.includes("訳なし") || m.includes("わざと失敗")) && messages.some((m) => m.includes("There's no command @nope")), messages);
expect("訳のあるプラグインの文は訳を使う", messages.some((m) => m.includes("A rule warning (translated)")), messages);
expect("直し方も英語で出る", hints.every((h) => !jp.test(h)), hints);
expect("エンディングの数が英語で出る", /\d+ endings?/.test((await en.locator(".check-endings").textContent()) ?? ""));
await en.screenshot({ path: join(shots, "10-check-en.png") });
await en.keyboard.press("Control+4");
await en.waitForTimeout(800);
await en.locator(".chars-view .seg", { hasText: "Lines" }).click();
await en.waitForSelector(".says-row");
await en.screenshot({ path: join(shots, "11-lines-en.png") });
await en.keyboard.press("Control+2");
await en.waitForSelector(".map-card");
await en.waitForTimeout(500);
await en.locator(".map-endings").click();
await en.waitForSelector(".map-endings-row");
await en.screenshot({ path: join(shots, "12-endings-en.png") });
await en.keyboard.press("Control+7");
await (await openGameSection(en, "theme")).locator(".game-theme-current button").click();
await en.getByRole("tab", { name: "Original themes" }).click();
await en.locator(".game-theme-save-open").click();
await en.screenshot({ path: join(shots, "13-theme-en.png") });
await en.keyboard.press("Escape");
await en.keyboard.press("Control+1");
await en.waitForTimeout(800);
// 打鍵中の構文チェックの札も英語で出る
await en.locator(".seg", { hasText: "Code" }).first().click();
await en.locator(".toc-file-name", { hasText: "side" }).first().click();
await en.waitForTimeout(1500);
// 波線はプラグインの check の警告（2 行目）にも付くので、@nope の行の誤りの波線に乗せる
await en.locator(".cm-lintRange-error", { hasText: "nope" }).first().hover();
await en.waitForSelector(".lim-diag");
const lint = await en.locator(".lim-diag").first().textContent();
expect("シナリオの中の問題の札も英語で出る", (lint ?? "").includes("There's no command @nope") && !jp.test(lint ?? ""), lint);
await en.screenshot({ path: join(shots, "14-editor-en.png") });

expect("画面の誤りが無い", errors.length === 0, errors);
await browser.close();
server.kill();
rmSync(project, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nすべて ok" : `\n失敗 ${failures.length} 件: ${failures.join(" / ")}`);
process.exit(failures.length === 0 ? 0 : 1);
