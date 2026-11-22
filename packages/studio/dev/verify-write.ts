/**
 * 書く道具（⌘K の検索とコマンド・表情と話者を一覧から選ぶ・行の参照を開く・ルビ・本文を写す・お気に入り・文字数の目標・
 * ブックマーク・分割表示・ファイルのタブ）を、lim studio の画面で操作して確かめる。
 *   npx tsx packages/studio/dev/verify-write.ts <スクリーンショットの置き場所> [ポート（既定 5341）]
 * ひな形（templates/default）を一時フォルダに写し、用語集（extra.glossary）を足して開く。
 * リポジトリのひな形は書き換えない。結果は一行ずつ「OK」か「NG」で出す（NG でも終了コードは 0）。終わったらサーバーを止める。
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-verify-write"));
mkdirSync(shots, { recursive: true });
const port = Number(process.argv[3] ?? 5341);
const base = `http://localhost:${port}`;
const url = `${base}${STUDIO_PAGE}`;

const project = mkdtempSync(join(tmpdir(), "liminalia-verify-write-"));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
const scenario = join(project, "scenario");
{
  const configPath = join(project, "liminalia.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.extra = { glossary: [{ id: "meteor", term: "流星群", reading: "りゅうせいぐん", description: "流れ星の群れ" }, { id: "tenmon", term: "天文台", reading: "てんもんだい", description: "星を見る建物" }] };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}
const disk = (file: string) => readFileSync(join(scenario, `${file}.lim`), "utf8");
const studioState = () => {
  const path = join(project, ".liminalia/studio.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
};

if (await fetch(url).then((r) => r.ok).catch(() => false)) throw new Error(`ポート ${port} はほかで使われています。止めてから流してください`);
const server = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/bin/lim.mjs"), "studio", project, "--port", String(port)], { stdio: "ignore", env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
const stop = () => {
  server.kill();
  rmSync(project, { recursive: true, force: true });
};
process.on("exit", stop);
for (let i = 0; ; i++) {
  const up = await fetch(url).then((r) => r.ok).catch(() => false);
  if (up) break;
  if (i > 120) throw new Error("lim studio が起動しません");
  await new Promise((r) => setTimeout(r, 500));
}

const results: string[] = [];
const ok = (name: string, cond: boolean, detail: unknown = "") => {
  const line = `${cond ? "OK  " : "NG  "} ${name}${!cond && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`;
  results.push(line);
  console.log(line);
};
const errors: string[] = [];
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function open(blocks: boolean, init = ""): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  await context.addInitScript(`localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "${blocks ? "1" : "0"}"); ${init}`);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|404|409|autoplay|ERR_FAILED/i.test(m.text()) && errors.push(m.text()));
  await page.goto(url);
  await page.waitForSelector(".cm-content", { state: "attached" });
  await page.waitForTimeout(1500);
  return { context, page };
}
const app = <T>(page: Page, code: string) => page.evaluate(`(() => { const s = window.__liminaliaStudioApp; const ed = s.debug.editor; ${code} })()`) as Promise<T>;
const goto = async (page: Page, line: number) => {
  await app(page, `ed.gotoLine(${line})`);
  await page.waitForTimeout(500);
};
const where = (page: Page) => app<{ file: string | null; line: number }>(page, "return { file: s.debug.file, line: ed.cursorLine() }");
const text = (page: Page) => app<string>(page, "return ed.text()");
const lineOf = async (page: Page, needle: string) => (await text(page)).split("\n").findIndex((l) => l.includes(needle)) + 1;
const pick = async (page: Page, label: string) => {
  await page.locator(".ctx-menu .ctx-item", { hasText: label }).first().click();
};
const quick = async (page: Page, query: string) => {
  await page.keyboard.press(`${MOD}+KeyK`);
  await page.locator(".quick-input").fill(query);
  await page.waitForTimeout(200);
};

// ---- ⌘K: 検索とコマンド ----
{
  const { context, page } = await open(false);
  await quick(page, "あかり");
  const kinds = await page.locator(".quick-list li .quick-kind").allTextContents();
  ok("⌘K: ひらがなでキャラクター（アカリ）が見つかる", kinds.includes("キャラクター"), kinds);
  await page.screenshot({ path: join(shots, "palette-cast.png") });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  ok("⌘K: キャラクターを選ぶとキャラクターの画面を開く", (await page.locator(".tab.on, .proj.on").first().textContent())?.includes("キャラクター") ?? false);
  await quick(page, "hill_night");
  await page.screenshot({ path: join(shots, "palette-asset.png") });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  ok("⌘K: 素材を選ぶと素材の画面でその素材を選ぶ", (await page.locator(".asset-tile.on, .asset-tile[aria-selected=true], .asset-tile.is-selected").count()) > 0 || (await page.locator(".assets-detail").textContent())?.includes("hill_night") === true);
  await quick(page, "looked");
  await page.waitForTimeout(800);
  const vars = await page.locator(".quick-list li .quick-label").allTextContents();
  ok("⌘K: 変数が見つかる", vars.includes("game.looked"), vars);
  await page.keyboard.press("Escape");
  await quick(page, "コード表示");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await quick(page, "ブロック表示");
  const action = await page.locator(".quick-list li.on .quick-label").textContent();
  ok("⌘K: 操作が見つかる（ブロック表示にする）", action === "ブロック表示にする", action);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  ok("⌘K: 操作を選ぶと動く", await app<boolean>(page, "return document.querySelector('.editor-host').classList.contains('block-mode')"));
  await quick(page, "# night");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  ok("⌘K: シーンを開く", (await where(page)).line === (await lineOf(page, "# night")));
  await context.close();
}

// ---- 表情を顔の一覧から選ぶ ----
{
  const { context, page } = await open(true);
  const say = await lineOf(page, "アカリ「着いた");
  const row = page.locator(`.blk-line-row[data-from="${say}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.locator(".blk-face-btn").click();
  await page.waitForSelector(".face-pop");
  ok("表情: 台詞の顔を押すと顔の一覧が出る", (await page.locator(".face-pop .face-choice").count()) >= 3);
  await page.screenshot({ path: join(shots, "faces-block.png") });
  await page.locator('.face-pop .face-choice[data-variant="smile"]').click();
  await page.waitForTimeout(400);
  const chara = (await text(page)).split("\n")[say - 2];
  ok("表情: 選ぶとページの @chara の差分を書き換える", chara === "@chara アカリ smile at=center time=400ms", chara);
  // コマンドの編集の差分の欄
  const cue = page.locator(`.blk-cue-row[data-from="${say - 1}"] .blk-cue`);
  await cue.click();
  await page.waitForTimeout(300);
  await cue.click();
  await page.waitForSelector(".inspector:not([hidden]) .face-grid");
  await page.screenshot({ path: join(shots, "faces-inspector.png") });
  await page.locator('.inspector .face-choice[data-variant="surprised"]').click();
  await page.waitForTimeout(400);
  ok("表情: コマンドの編集の差分を顔の一覧から選ぶ", (await text(page)).split("\n")[say - 2] === "@chara アカリ surprised at=center time=400ms", (await text(page)).split("\n")[say - 2]);
  // 補完の候補の頭に顔
  await page.locator(".seg", { hasText: "コード" }).click();
  await goto(page, say - 1);
  await app(page, `const l = ed.state.doc.line(${say - 1}); ed.view.dispatch({ changes: { from: l.from, to: l.to, insert: "@chara アカリ " }, selection: { anchor: l.from + 11 } }); ed.view.focus();`);
  await page.keyboard.press("Control+Space");
  await page.waitForTimeout(500);
  ok("表情: 補完の差分の候補に顔が出る", (await page.locator(".cm-tooltip-autocomplete .cm-face").count()) >= 3);
  await page.screenshot({ path: join(shots, "faces-complete.png") });
  await page.keyboard.press("Escape");
  await context.close();
}

// ---- 話者を一覧から選ぶ ----
{
  const { context, page } = await open(true);
  const say = await lineOf(page, "ソウ「……お客さんか");
  const row = page.locator(`.blk-line-row[data-from="${say}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.locator(".blk-speaker-btn").click();
  await page.waitForSelector(".face-pop .speaker-choice");
  await page.screenshot({ path: join(shots, "speaker-pick.png") });
  await page.locator('.face-pop .speaker-choice[data-speaker="アカリ"]').click();
  await page.waitForTimeout(400);
  ok("話者: 名前を押して一覧から選び直す", (await text(page)).split("\n")[say - 1] === "アカリ「……お客さんか。めずらしいな」", (await text(page)).split("\n")[say - 1]);
  const prose = await lineOf(page, "扉につるされた");
  const prow = page.locator(`.blk-line-row[data-from="${prose}"]`);
  await prow.scrollIntoViewIfNeeded();
  await prow.locator(".blk-text").click({ button: "right" });
  await pick(page, "話者を変更");
  await page.locator('.face-pop .speaker-choice[data-speaker="ソウ"]').click();
  await page.waitForTimeout(400);
  ok("話者: 地の文を右クリックから台詞にする", (await text(page)).split("\n")[prose - 1]!.startsWith("ソウ「扉につるされた"), (await text(page)).split("\n")[prose - 1]);
  await page.locator(`.blk-line-row[data-from="${prose}"] .blk-speaker-btn`).click();
  await page.locator('.face-pop .speaker-choice[data-speaker=""]').click();
  await page.waitForTimeout(400);
  ok("話者: 台詞を地の文に戻す", (await text(page)).split("\n")[prose - 1]!.startsWith("　扉につるされた"), (await text(page)).split("\n")[prose - 1]);
  await context.close();
}

// ---- 行の右クリックから、その行が使うものを開く ----
{
  const { context, page } = await open(true);
  const surface = () => page.locator(".topbar .tab.on, .topbar .proj.on").first().textContent();
  const bg = await lineOf(page, "@bg hill_dusk.webp");
  await page.locator(`.blk-cue-row[data-from="${bg}"] .blk-cue`).click({ button: "right" });
  await page.screenshot({ path: join(shots, "refs-menu.png") });
  await pick(page, "背景「hill_dusk.webp」を開く");
  await page.waitForTimeout(1200);
  ok("参照: 背景のコマンドから素材の画面でその素材を開く", (await surface())?.includes("素材") === true && (await page.locator(".asset-tile.on").getAttribute("data-path")) === "hill_dusk.webp", await page.locator(".asset-tile.on").getAttribute("data-path").catch(() => null));
  await page.locator(".topbar .tab", { hasText: "シナリオ" }).click();
  await page.waitForTimeout(500);
  const say = await lineOf(page, "アカリ「着いた");
  await page.locator(`.blk-line-row[data-from="${say}"] .blk-text`).click({ button: "right" });
  await pick(page, "キャラクター「アカリ」を開く");
  await page.waitForTimeout(800);
  ok("参照: 台詞からキャラクターを開く", (await surface())?.includes("キャラクター") === true);
  await page.locator(".topbar .tab", { hasText: "シナリオ" }).click();
  await page.waitForTimeout(500);
  const set = await lineOf(page, "@set game.looked = false");
  await page.locator(`.blk-cue-row[data-from="${set}"] .blk-cue`).click({ button: "right" });
  await pick(page, "変数「game.looked」を開く");
  await page.waitForTimeout(1200);
  ok("参照: @set から変数の画面でその変数を開く", (await surface())?.includes("変数") === true && (await page.locator(".vars-row.on").count()) > 0);
  await context.close();
}

// ---- ルビ ----
{
  const { context, page } = await open(false);
  // 用語集の読みでまとめて振る（シナリオの見出しのメニュー）
  await page.locator(".ed-title").click();
  await pick(page, "用語集の読みでルビを振る");
  await page.waitForTimeout(800);
  const all = await text(page);
  ok("ルビ: 用語集の読みでシーンごとの最初の一つに振る", all.includes("小さな{r 天文台|てんもんだい}がある") && !all.includes("古い{r 天文台"), all.split("\n").filter((l) => l.includes("天文台")).slice(0, 3));
  // 選んだ文字に振る（コード表示）
  const l = await lineOf(page, "息を整えながら");
  await app(page, `const line = ed.state.doc.line(${l}); const at = line.text.indexOf("鞄"); ed.view.dispatch({ selection: { anchor: line.from + at, head: line.from + at + 1 } }); ed.view.focus();`);
  await page.keyboard.press(`${MOD}+Alt+KeyR`);
  await page.keyboard.type("かばん");
  await page.waitForTimeout(300);
  ok("ルビ: コード表示で選んだ文字に {r 親|} を付け、読みを書ける", (await text(page)).split("\n")[l - 1]!.includes("{r 鞄|かばん}"), (await text(page)).split("\n")[l - 1]);
  // ブロック表示で直している本文の文字に振る
  await page.locator(".seg", { hasText: "ブロック" }).click();
  await page.waitForTimeout(500);
  const p = await lineOf(page, "扉につるされた");
  await goto(page, p);
  await page.locator(`.blk-line-row[data-from="${p}"] .blk-text`).click();
  await page.waitForTimeout(300);
  await page.evaluate((line) => {
    const el = document.querySelector<HTMLElement>(`.blk-text[data-edit-line="${line}"]`)!;
    const node = [...el.childNodes].find((n) => n.nodeType === 3)!;
    const at = node.textContent!.indexOf("鈴");
    const r = document.createRange();
    r.setStart(node, at);
    r.setEnd(node, at + 1);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
  }, p);
  await page.keyboard.press(`${MOD}+Alt+KeyR`);
  await page.keyboard.type("すず");
  await page.screenshot({ path: join(shots, "ruby-block.png") });
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForTimeout(500);
  ok("ルビ: ブロック表示で直している本文の文字に振る", (await text(page)).split("\n")[p - 1]!.includes("{r 鈴|すず}"), (await text(page)).split("\n")[p - 1]);
  await context.close();
}

// ---- シーンの本文を写す ----
{
  const { context, page } = await open(true);
  const label = await lineOf(page, "# telescope");
  await page.locator(`.blk-label[data-from="${label}"] .blk-banner`).click({ button: "right" });
  await pick(page, "シーンの本文をコピー");
  await page.waitForTimeout(500);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  ok("本文を写す: シーンの見出しの右クリックから、台詞と地の文だけを写す", copied.startsWith("ソウ「この望遠鏡は古いけど") && !copied.includes("@") && !copied.includes("#"), copied.slice(0, 80));
  // シーン一覧のシーンの右クリック（開いていないファイル）
  await page.locator(".toc-file", { hasText: "epilogue.lim" }).locator(".toc-file-fold").click();
  await page.waitForTimeout(500);
  await page.locator(".scene-row").filter({ has: page.locator(".scene-name", { hasText: "dawn" }) }).first().click({ button: "right" });
  await pick(page, "シーンの本文をコピー");
  await page.waitForTimeout(800);
  const other = await page.evaluate(() => navigator.clipboard.readText());
  ok("本文を写す: シーン一覧から開いていないファイルのシーンを写す", other.length > 0 && !other.includes("@"), other.slice(0, 80));
  await context.close();
}

// ---- お気に入りを作品に持たせる ----
{
  const old = JSON.stringify([{ label: "前のお気に入り", lines: ["@quake time=300ms"] }]);
  const { context, page } = await open(true, `if (!sessionStorage.getItem("seeded")) { localStorage.setItem("liminalia.studio.favorites", ${JSON.stringify(old)}); sessionStorage.setItem("seeded", "1"); }`);
  await page.waitForTimeout(800);
  const moved = studioState().favorites as { label: string }[] | undefined;
  ok("お気に入り: 前の localStorage の分を作品の .liminalia/studio.json へ写す", moved?.some((f) => f.label === "前のお気に入り") === true, moved);
  if (await page.locator(".blk-palette").evaluate((el) => el.closest(".parts-closed") !== null).catch(() => true)) await page.locator('.panel-rail[data-panel="parts"]').click();
  await page.waitForTimeout(300);
  ok("お気に入り: パーツの欄に出る", (await page.locator(".blk-part", { hasText: "前のお気に入り" }).count()) > 0);
  const say = await lineOf(page, "アカリ「着いた");
  await page.locator(`.blk-line-row[data-from="${say}"] .blk-text`).click({ button: "right" });
  await pick(page, "お気に入りに追加");
  await page.waitForTimeout(800);
  const after = studioState().favorites as { lines: string[] }[] | undefined;
  ok("お気に入り: 追加したものを作品に書く", after?.length === 2 && after[1]!.lines[0]!.startsWith("アカリ「着いた"), after);
  await page.reload();
  await page.waitForSelector(".cm-content", { state: "attached" });
  await page.waitForTimeout(1500);
  ok("お気に入り: 開き直しても二重に写さない", (studioState().favorites as unknown[]).length === 2);
  await page.screenshot({ path: join(shots, "favorites.png") });
  await context.close();
}

// ---- 文字数の目標と進み具合 ----
{
  const { context, page } = await open(false);
  await page.locator(".topbar .tab", { hasText: "チェック" }).click();
  await page.waitForSelector(".progress-card");
  await page.waitForTimeout(1500);
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const daily = studioState().textDaily as Record<string, [number, number]> | undefined;
  ok("進み具合: 数えた字数を今日の分として作品に書く", Array.isArray(daily?.[date]) && daily![date]![1] > 0, daily);
  await page.locator(".progress-goal").click();
  await page.locator(".progress-goal-input").fill("20000");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  ok("進み具合: 目標の字数を決める", studioState().textGoal === 20000 && ((await page.locator(".progress-goal").textContent()) ?? "").includes("20,000"), studioState().textGoal);
  ok("進み具合: 想定プレイ時間を出す", ((await page.locator(".progress-card").textContent()) ?? "").includes("想定プレイ時間"));
  await page.locator(".progress-card").screenshot({ path: join(shots, "progress-card.png") });
  await page.screenshot({ path: join(shots, "progress.png") });
  await context.close();
}

// ---- ブックマーク ----
{
  const { context, page } = await open(false);
  const a = await lineOf(page, "# night");
  const b = await lineOf(page, "# telescope");
  await goto(page, a);
  await page.keyboard.press(`${MOD}+Alt+KeyK`);
  await goto(page, b);
  await page.keyboard.press(`${MOD}+Alt+KeyK`);
  await page.waitForTimeout(1000);
  const saved = studioState().bookmarks as Record<string, { line: number; text: string }[]> | undefined;
  ok("ブックマーク: ⌘⌥K で付け、作品に書く", saved?.start?.map((x) => x.line).join(",") === `${a},${b}` && saved.start[0]!.text === "# night", saved);
  ok("ブックマーク: コード表示の行に印", (await page.locator(".cm-line.cm-bookmarked").count()) >= 1);
  ok("ブックマーク: シーン一覧に一覧を出す", (await page.locator(".toc-bookmark").count()) === 2);
  await goto(page, 1);
  await page.keyboard.press("F2");
  await page.waitForTimeout(300);
  ok("ブックマーク: F2 で次のブックマークへ", (await where(page)).line === a, await where(page));
  // 上に行を足すと印も動く
  await app(page, `ed.view.dispatch({ changes: { from: 0, insert: "// 足した行\\n" } })`);
  await page.waitForTimeout(1000);
  ok("ブックマーク: 上に行を足すと印も動く", (studioState().bookmarks as Record<string, { line: number }[]>).start?.[0]?.line === a + 1, studioState().bookmarks);
  await page.locator(".toc-bookmark").nth(1).click();
  await page.waitForTimeout(400);
  ok("ブックマーク: 一覧を押すとその行へ", (await where(page)).line === b + 1, await where(page));
  await page.screenshot({ path: join(shots, "bookmarks.png") });
  // ブロック表示の印と、右クリックで外す
  await page.locator(".seg", { hasText: "ブロック" }).click();
  await page.waitForTimeout(600);
  ok("ブックマーク: ブロック表示の行に印", (await page.locator(".blk-mark-bookmark").count()) === 2);
  await page.locator(`.blk-label[data-from="${b + 1}"] .blk-banner`).click({ button: "right" });
  await pick(page, "ブックマーク");
  await page.waitForTimeout(1000);
  ok("ブックマーク: 行の右クリックで外す", (studioState().bookmarks as Record<string, unknown[]>).start?.length === 1);
  // ⌘K に出る
  await quick(page, "night");
  ok("ブックマーク: ⌘K に出る", (await page.locator(".quick-list li .quick-kind", { hasText: "ブックマーク" }).count()) === 1);
  await page.keyboard.press("Escape");
  // 開いていないファイルをほかで書き換えても、印は付いた行に付いたまま動く
  await page.locator(".seg", { hasText: "コード" }).click();
  await page.locator(".toc-file-name", { hasText: "epilogue.lim" }).click();
  await page.waitForTimeout(800);
  const dawn = await lineOf(page, "空の端が白みはじめていた");
  await goto(page, dawn);
  await page.keyboard.press(`${MOD}+Alt+KeyK`);
  await page.locator(".toc-file-name", { hasText: "start.lim" }).click();
  await page.waitForTimeout(1500);
  writeFileSync(join(scenario, "epilogue.lim"), `// ほかで足した一行目\n// ほかで足した二行目\n${disk("epilogue")}`);
  let moved: { line: number; text: string }[] | undefined;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(400);
    moved = (studioState().bookmarks as Record<string, { line: number; text: string }[]> | undefined)?.epilogue;
    if (moved?.[0]?.line === dawn + 2) break;
  }
  ok("ブックマーク: 開いていないファイルをほかで書き換えても、付いた行に付いたまま動く", moved?.[0]?.line === dawn + 2 && moved[0]!.text.includes("空の端が白みはじめていた"), moved);
  await page.locator(".toc-bookmark", { hasText: "空の端" }).click();
  await page.waitForTimeout(800);
  ok("ブックマーク: 動いた行を一覧から開く", (await where(page)).file === "epilogue" && (await where(page)).line === dawn + 2, await where(page));
  // 次の確かめは start から始める（最後に開いていたファイルを作品に覚えるので）
  await page.locator(".toc-file-name", { hasText: "start.lim" }).click();
  await page.waitForTimeout(2000);
  await context.close();
}

// ---- ファイルのタブ ----
{
  const { context, page } = await open(false);
  ok("タブ: 一つだけのときは出さない", await page.locator(".file-tabs").isHidden());
  await page.locator(".toc-file-name", { hasText: "epilogue.lim" }).click();
  await page.waitForTimeout(600);
  const names = await page.locator(".file-tab .file-tab-name").allTextContents();
  ok("タブ: 二つ目を開くとタブを出す", names.join(",") === "start,epilogue", names);
  await page.locator(".file-tab .file-tab-name", { hasText: "start" }).click();
  await page.waitForTimeout(600);
  ok("タブ: 押すとそのファイルへ", (await where(page)).file === "start");
  await page.screenshot({ path: join(shots, "tabs.png") });
  await page.locator(".file-tab.on .file-tab-close").click();
  await page.waitForTimeout(800);
  ok("タブ: 今のタブを閉じると隣のファイルを開き、一つになれば隠す", (await where(page)).file === "epilogue" && (await page.locator(".file-tabs").isHidden()), await where(page));
  await context.close();
}

// ---- 分割表示 ----
{
  const { context, page } = await open(false);
  if ((await where(page)).file !== "start") {
    await page.locator(".toc-file-name", { hasText: "start.lim" }).click();
    await page.waitForTimeout(800);
  }
  await page.locator(".toc-file", { hasText: "epilogue.lim" }).click({ button: "right" });
  await pick(page, "右に並べて表示");
  await page.waitForSelector(".split-pane:not([hidden]) .cm-content");
  await page.waitForTimeout(500);
  ok("分割表示: シーン一覧のファイルのメニューから右に並べる", ((await page.locator(".split-name").textContent()) ?? "") === "epilogue.lim" && (await where(page)).file === "start");
  // 分割表示の側で書くと保存する
  {
    const box = (await page.locator(".split-pane .split-editor").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + 120);
  }
  ok("分割表示: 並べたファイルを押すと入力がそちらへ移る", await page.evaluate(() => !!document.activeElement?.closest(".split-pane")));
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type("\n// 分割表示で足した行");
  await page.waitForTimeout(2000);
  ok("分割表示: 並べたファイルを書いて保存する", disk("epilogue").includes("// 分割表示で足した行"));
  // 境目を引いて幅を変え、覚える
  {
    const pane = page.locator(".split-pane");
    const before = (await pane.boundingBox())!.width;
    const bar = (await page.locator(".editor-row > .splitter-right").boundingBox())!;
    await page.mouse.move(bar.x + 4, bar.y + 200);
    await page.mouse.down();
    await page.mouse.move(bar.x - 116, bar.y + 200, { steps: 6 });
    await page.mouse.up();
    const after = (await pane.boundingBox())!.width;
    const stored = await page.evaluate(() => localStorage.getItem("liminalia.studio.width--split-w"));
    ok("分割表示: 境目を引いて幅を変え、覚える", after - before > 100 && Number(stored) === Math.round(after), { before, after, stored });
  }
  // 並べたファイルの行からプレビューを動かす（カーソルの行の本文を舞台に出す）
  const splitLine = async (needle: string) => (await page.evaluate((n) => [...document.querySelectorAll(".split-pane .cm-line")].findIndex((l) => l.textContent?.includes(n)), needle)) + 1;
  {
    const target = page.locator(".split-pane .cm-line", { hasText: "空の端が白みはじめていた" });
    await target.scrollIntoViewIfNeeded();
    await target.click();
    const frame = page.frameLocator(".stage-frame");
    let shown = "";
    for (let i = 0; i < 30 && !shown.includes("空の端が白みはじめていた"); i++) {
      await page.waitForTimeout(300);
      shown = (await frame.locator("body").innerText().catch(() => "")) ?? "";
    }
    ok("分割表示: 並べたファイルの行をプレビューに出す", shown.includes("空の端が白みはじめていた"), shown.slice(0, 120));
  }
  // 行番号の欄の右クリックで、ブレークポイント・コメント・ここからテストプレイ
  {
    const row = await splitLine("空の端が白みはじめていた");
    const gutter = page.locator(".split-pane .cm-lineNumbers .cm-gutterElement", { hasText: new RegExp(`^${row}$`) });
    await gutter.click({ button: "right" });
    const items = await page.locator(".ctx-menu .ctx-item").allTextContents();
    await pick(page, "ブレークポイント");
    await page.waitForTimeout(1200);
    const bps = (studioState().breakpoints as { file: string; line: number }[] | undefined) ?? [];
    ok("分割表示: 行のメニューからブレークポイントを付け、印を出す", bps.some((b) => b.file === "epilogue" && b.line === row) && (await page.locator(".split-pane .cm-breakpoint").count()) === 1, { bps, items });
    await page.locator(".split-pane .cm-breakpoint").first().click();
    await page.waitForTimeout(1200);
    ok("分割表示: 印を押すとブレークポイントを外す", !((studioState().breakpoints as { file: string }[] | undefined) ?? []).some((b) => b.file === "epilogue"));
    await gutter.click({ button: "right" });
    await pick(page, "コメントを付ける");
    await page.locator(".review-new textarea").fill("分割表示から付けたコメント");
    await page.locator(".review-new button.primary").click();
    await page.waitForTimeout(1500);
    const reviews = existsSync(join(project, "reviews")) ? readdirSync(join(project, "reviews")).map((f) => JSON.parse(readFileSync(join(project, "reviews", f), "utf8")) as { file: string; line: number }) : [];
    ok("分割表示: 行のメニューからコメントを付け、印を出す", reviews.some((r) => r.file === "epilogue" && r.line === row) && (await page.locator(".split-pane .cm-review").count()) >= 1, reviews);
    await page.screenshot({ path: join(shots, "split-marks.png") });
  }
  // 入れ替え
  await page.locator(".split-head button", { hasText: "" }).first().click();
  await page.waitForTimeout(1200);
  ok("分割表示: シナリオと入れ替える", (await where(page)).file === "epilogue" && ((await page.locator(".split-name").textContent()) ?? "") === "start.lim", { main: (await where(page)).file, split: await page.locator(".split-name").textContent() });
  // シナリオで同じファイルを開くと分割表示を閉じる
  await page.locator(".toc-file-name", { hasText: "start.lim" }).click();
  await page.waitForTimeout(1000);
  ok("分割表示: 並べているファイルをシナリオで開くと閉じる", (await where(page)).file === "start" && (await page.locator(".split-pane").isHidden()));
  await context.close();
}

console.log("");
for (const e of errors) console.log(`NG   画面のエラー — ${e}`);
await browser.close();
stop();
writeFileSync(join(shots, "results.txt"), `${[...results, ...errors.map((e) => `NG   画面のエラー — ${e}`)].join("\n")}\n`);
