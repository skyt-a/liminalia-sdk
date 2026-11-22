/**
 * 行・シーンからの移動と遊び方を、lim studio の画面で操作して確かめる（「ここから遊ぶ」・離れる前の確かめ・ジャンプ先へ移動と
 * このシーンへ来る行・タイムラインとボイスの画面の元に戻す）。
 *   npx tsx packages/studio/dev/verify-nav.ts <スクリーンショットの置き場所> [ポート（既定 5315）]
 * ひな形（templates/default）を一時フォルダに写し、サブフォルダのシナリオ（part1/chapter2）と、そこへ飛ぶシーンを足して開く。
 * リポジトリのひな形は書き換えない。結果は一行ずつ「OK」か「NG」で出す（NG でも終了コードは 0）。終わったらサーバーを止める。
 */
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-verify-nav"));
mkdirSync(shots, { recursive: true });
const port = Number(process.argv[3] ?? 5315);
const base = `http://localhost:${port}`;
const url = `${base}${STUDIO_PAGE}`;

const project = mkdtempSync(join(tmpdir(), "liminalia-verify-nav-"));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
const scenario = join(project, "scenario");
// サブフォルダのシナリオ（ほかのファイルへのジャンプ先と、ほかのファイルから来る行を持つ）
mkdirSync(join(scenario, "part1"), { recursive: true });
writeFileSync(join(scenario, "part1/chapter2.lim"), ["# chapter2", "@bg hill_morning.webp", "@chara アカリ normal at=center", "アカリ「サブフォルダのシナリオです」", "", "# later", "@set game.sub = 1", "アカリ「後のシーン」", "@jump start#menu", ""].join("\n"));
appendFileSync(join(scenario, "start.lim"), "\n# sub\n@jump part1/chapter2#later\n");
// ボイスの割り当てに使う素材
mkdirSync(join(project, "assets/voice"), { recursive: true });
cpSync(join(project, "assets/sound/chime.wav"), join(project, "assets/voice/akari_001.wav"));
const disk = (file: string) => readFileSync(join(scenario, `${file}.lim`), "utf8");

// 前の確かめのサーバーが残っていると、そちらの作品を直してしまう
if (await fetch(url).then((r) => r.ok).catch(() => false)) throw new Error(`ポート ${port} はほかで使われています。止めてから流してください`);
const server = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/bin/lim.mjs"), "studio", project, "--port", String(port)], { stdio: "ignore", env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
const stop = () => {
  server.kill();
  rmSync(project, { recursive: true, force: true });
};
// 途中で失敗しても、サーバーを残さない
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

async function open(blocks: boolean): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
  await context.addInitScript(`localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "${blocks ? "1" : "0"}")`);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  // ERR_FAILED は、保存の失敗を確かめるためにわざと切った書き込み
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
/** 開いているメニューの項目を押す。 */
const pick = async (page: Page, label: string) => {
  await page.locator(".ctx-menu .ctx-item", { hasText: label }).first().click();
};

// ---- ここから遊ぶ ----

interface Played {
  url: string;
  at: { file: string; line: number } | null;
  background: string | null;
  bgm: string | null;
  sprites: string[];
  game: Record<string, unknown>;
}

/** 開いたテストプレイのウィンドウで「クリックで開始」を押し、ページか選択肢が出たときの実行器の状態を読む。 */
async function played(popup: Page, name: string): Promise<Played> {
  await popup.waitForLoadState();
  await popup.locator(".layer.start").click({ timeout: 20_000 });
  await popup.waitForFunction(() => {
    const w = window as unknown as { __liminalia?: { host: { waiting: boolean; choosing: boolean } } };
    return !!w.__liminalia && (w.__liminalia.host.waiting || w.__liminalia.host.choosing);
  }, undefined, { timeout: 20_000 });
  await popup.waitForTimeout(800);
  await popup.screenshot({ path: join(shots, `${name}.png`) });
  return popup.evaluate(() => {
    const rt = (window as unknown as { __liminalia: { runtime(): { at: { file: string; line: number } | null; state: { stage: { background: { image?: string } | string | null; bgm: { file: string } | null; sprites: Record<string, unknown> }; game: Record<string, unknown> } } | null } }).__liminalia.runtime();
    const bg = rt?.state.stage.background ?? null;
    return {
      url: location.search,
      at: rt?.at ?? null,
      background: typeof bg === "string" ? bg : (bg?.image ?? null),
      bgm: rt?.state.stage.bgm?.file ?? null,
      sprites: Object.keys(rt?.state.stage.sprites ?? {}).sort(),
      game: rt?.state.game ?? {},
    };
  });
}

/** 操作をしてテストプレイのウィンドウが開くのを待ち、遊んだ状態を読んで閉じる。 */
async function playVia(context: BrowserContext, name: string, action: () => Promise<void>): Promise<Played | null> {
  const popup = context.waitForEvent("page", { timeout: 30_000 });
  await action();
  try {
    const p = await popup;
    const r = await played(p, name);
    await p.close();
    return r;
  } catch {
    return null;
  }
}

{
  const { context, page } = await open(true);
  // ブロック表示: シーンの見出し（# midnight）の右クリック
  await goto(page, 97);
  const label = page.locator('.blk-line-row.blk-label[data-from="97"]');
  await label.scrollIntoViewIfNeeded();
  await label.click({ button: "right" });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(shots, "play-block-menu.png") });
  const midnight = await playVia(context, "play-block-midnight", () => pick(page, "ここからテストプレイ"));
  ok("ここから遊ぶ（ブロック表示のシーンの見出し）: 前のシーンの背景・BGM・立ち絵のまま始める", midnight?.background === "hill_night.webp" && midnight.bgm === "quiet_night.wav" && midnight.sprites.join(",") === "アカリ,ソウ", midnight);
  ok("ここから遊ぶ: 前のシーンで決めた変数を持つ", midnight?.game.looked === true, midnight?.game);
  ok("ここから遊ぶ: シーンの頭のコマンドから流す（@call した部品のページ）", midnight?.at?.line === 159 && /from=/.test(midnight.url) && /start=start%23midnight/.test(midnight.url), midnight);

  // ブロック表示: コマンドの行（26 行 @chara アカリ）の右クリック
  await goto(page, 26);
  await page.locator('.blk-cue-row[data-from="26"]').click({ button: "right" });
  const chara = await playVia(context, "play-block-command", () => pick(page, "ここからテストプレイ"));
  ok("ここから遊ぶ（コマンドの行）: その行を実行してから最初のページへ", chara?.at?.line === 27 && chara.sprites.join(",") === "アカリ" && chara.background === "hill_dusk.webp", chara);

  // シーン一覧: サブフォルダのファイルのシーン
  await page.evaluate(() => localStorage.setItem("liminalia.studio.tocOpen", JSON.stringify(["part1/chapter2"])));
  await page.reload();
  await page.waitForSelector(".cm-content", { state: "attached" });
  await page.waitForTimeout(1500);
  const later = page.locator(".scene-row", { hasText: "later" });
  await later.click({ button: "right" });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(shots, "play-scene-menu.png") });
  const sub = await playVia(context, "play-scene-subfolder", () => pick(page, "ここからテストプレイ"));
  ok("ここから遊ぶ（シーン一覧・サブフォルダのファイル）: そのファイルの前のシーンの背景と立ち絵で始める", sub?.at?.file === "part1/chapter2" && sub.at.line === 8 && sub.background === "hill_morning.webp" && sub.sprites.join(",") === "アカリ" && sub.game.sub === 1, sub);

  // フローチャート: カードの右クリック
  await page.locator(".tab", { hasText: "フローチャート" }).click();
  await page.waitForTimeout(1500);
  const card = page.locator('.map-card[data-id="start#telescope"]');
  await card.scrollIntoViewIfNeeded();
  await card.click({ button: "right" });
  const tele = await playVia(context, "play-map-card", () => pick(page, "ここからテストプレイ"));
  ok("ここから遊ぶ（フローチャートのカード）: 選択肢のあとの背景・立ち絵から", tele?.at?.line === 60 && tele.background === "hill_night.webp" && tele.game.looked === true, tele);

  // コード表示: ⌘⌥P（カーソルの行から）
  await page.locator(".tab", { hasText: "シナリオ" }).first().click();
  await page.locator(".segmented .seg", { hasText: "コード" }).click();
  await goto(page, 135);
  const watch = await playVia(context, "play-code-key", () => page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Alt+KeyP`));
  ok("ここから遊ぶ（コード表示で ⌘⌥P）: カーソルの本文の行のページから", watch?.at?.line === 135 && watch.game.wished === false, watch);
  await context.close();
}

// ---- 離れる前の確かめ ----

{
  const { context, page } = await open(false);
  const saveStatus = () => page.locator(".save-status").textContent();
  /** 閉じようとして（beforeunload を走らせて）、確かめが出たか。出たら取りやめる（ページは残る）。 */
  const tryClose = async (): Promise<boolean> => {
    // 待っている間は Playwright が勝手に確かめに答えない
    const dialog = page.waitForEvent("dialog", { timeout: 5000 }).catch(() => null);
    await page.close({ runBeforeUnload: true });
    const d = await dialog;
    await d?.dismiss();
    await page.waitForTimeout(300);
    return d?.type() === "beforeunload" && !page.isClosed();
  };
  const typeAt = async (line: number, text: string) => {
    await app(page, `ed.gotoLine(${line}); ed.view.dispatch({ selection: { anchor: ed.state.doc.line(${line}).to } })`);
    await page.locator(".cm-content").focus();
    await page.keyboard.type(text);
  };

  await typeAt(23, "あ");
  ok("離れる前の確かめ: 保存していない変更があれば止める", await tryClose());
  await page.waitForTimeout(2500);
  ok("離れる前の確かめ: 止めたあと自動保存は続く", disk("start").includes("天文台がある。あ") && (await saveStatus()) === "保存済み", await saveStatus());

  // 保存に失敗した（書き込み口がつながらない）
  await page.route("**/__liminalia/studio/api/file", (route) => (route.request().method() === "PUT" ? route.abort() : route.continue()));
  await typeAt(23, "い");
  await page.waitForTimeout(2000);
  const failed = await saveStatus();
  ok("離れる前の確かめ: 保存に失敗した変更があれば止める", (await tryClose()) && !disk("start").includes("天文台がある。あい"), failed);
  await page.unroute("**/__liminalia/studio/api/file");
  await page.waitForTimeout(4500);
  ok("離れる前の確かめ: つながれば保存し直す", disk("start").includes("天文台がある。あい"), await saveStatus());

  // 競合（同じ行をほかで書き換えた）
  await typeAt(24, "う");
  writeFileSync(join(scenario, "start.lim"), disk("start").replace("古い天文台だ。", "古い天文台だ。（外で書き換え）"));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(shots, "leave-conflict.png") });
  const conflict = await saveStatus();
  ok("離れる前の確かめ: 競合している変更があれば止める", conflict === "変更が競合しています" && (await tryClose()), conflict);
  await page.locator(".merge-side.ours button").first().click();
  await page.locator(".overlay button.primary", { hasText: "反映" }).click();
  await page.waitForTimeout(2500);

  // 保存済みなら止めない
  const saved = await saveStatus();
  const dialog = page.waitForEvent("dialog", { timeout: 3000 }).catch(() => null);
  await page.close({ runBeforeUnload: true });
  const asked = await dialog;
  await asked?.dismiss();
  await new Promise((r) => setTimeout(r, 500));
  ok("離れる前の確かめ: 保存済みなら止めない", !asked && page.isClosed(), saved);
  await context.close();
}

// ---- ジャンプ先へ移動・このシーンへ来る行 ----

const MOD = process.platform === "darwin" ? "Meta" : "Control";
{
  const { context, page } = await open(false);
  // コード表示: ⌘ を押しながら乗せると下線、押すとそこへ
  await app(page, "return s.open('start', 50)");
  await page.waitForTimeout(800);
  const option = page.locator(".cm-line", { hasText: "望遠鏡をのぞく" }).locator(".lim-t-target");
  await option.scrollIntoViewIfNeeded();
  const box = (await option.boundingBox())!;
  await page.keyboard.down(MOD);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(200);
  const underlined = await page.locator(".lim-goto-link").count();
  await page.screenshot({ path: join(shots, "goto-code-hover.png") });
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up(MOD);
  await page.waitForTimeout(600);
  ok("ジャンプ先へ移動（コード表示）: ⌘ で乗せると下線、⌘クリックで選択肢のジャンプ先へ", underlined === 1 && (await where(page)).line === 58, { underlined, ...(await where(page)) });
  ok("ジャンプ先へ移動: ⌘ を離すと下線を消す", (await page.locator(".lim-goto-link").count()) === 0);

  // F12: ほかのファイル（サブフォルダ）のシーンへ。⌘[ で戻る
  const subLine = disk("start").split("\n").indexOf("@jump part1/chapter2#later") + 1;
  await goto(page, subLine);
  await page.locator(".cm-content").focus();
  await page.keyboard.press("F12");
  await page.waitForTimeout(1500);
  const there = await where(page);
  ok("ジャンプ先へ移動（F12）: ほかのファイル・サブフォルダのシーンを開く", there.file === "part1/chapter2" && there.line === 6, there);
  await page.keyboard.press(`${MOD}+BracketLeft`);
  await page.waitForTimeout(1500);
  const back = await where(page);
  ok("ジャンプ先へ移動: ⌘[ で元の行へ戻る", back.file === "start" && back.line === subLine, back);

  // F12: ジャンプ先の無い行
  await goto(page, 23);
  await page.locator(".cm-content").focus();
  await page.keyboard.press("F12");
  await page.waitForTimeout(300);
  ok("ジャンプ先へ移動（F12）: ジャンプ先の無い行ではそう知らせる", ((await page.locator(".notice").textContent()) ?? "").includes("ジャンプ先がありません"));

  // このシーンへ来る行: シーン一覧のシーンの右クリック
  await page.evaluate(() => localStorage.setItem("liminalia.studio.tocOpen", JSON.stringify(["start"])));
  await page.reload();
  await page.waitForSelector(".cm-content", { state: "attached" });
  await page.waitForTimeout(1500);
  await page.locator(".scene-row", { hasText: "menu" }).first().click({ button: "right" });
  await pick(page, "このシーンへ来る行");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(shots, "incoming-menu.png") });
  const items = await page.locator(".ctx-menu .ctx-item").allTextContents();
  ok("このシーンへ来る行（シーン一覧）: ジャンプ・前のシーンから続く・ほかのファイルからの行を並べる", items.some((t) => t.includes("ジャンプstart.lim 72")) && items.some((t) => t.includes("前のシーンから続くstart.lim 50")) && items.some((t) => t.includes("part1/chapter2.lim 9")), items);
  await page.locator(".ctx-menu .ctx-item", { hasText: "part1/chapter2.lim 9" }).click();
  await page.waitForTimeout(1200);
  const came = await where(page);
  ok("このシーンへ来る行: 押すとその行へ（ほかのファイルも開く）", came.file === "part1/chapter2" && came.line === 9, came);

  // フローチャートのカード
  await page.locator(".tab", { hasText: "フローチャート" }).click();
  await page.waitForTimeout(1500);
  const card = page.locator('.map-card[data-id="start#ending"]');
  await card.scrollIntoViewIfNeeded();
  await card.click({ button: "right" });
  await pick(page, "このシーンへ来る行");
  await page.waitForTimeout(1200);
  const endings = await page.locator(".ctx-menu .ctx-item").allTextContents();
  ok("このシーンへ来る行（フローチャートのカード）", endings.length === 2 && endings.some((t) => t.includes("start.lim 130")), endings);
  await page.keyboard.press("Escape");
  await context.close();
}
{
  // ブロック表示
  const { context, page } = await open(true);
  // 前の確かめで最後に開いたファイル（覚えている）ではなく、start を開く
  await app(page, "return s.open('start', 52)");
  await page.waitForTimeout(800);
  const target = page.locator('.blk-option[data-edit-line="54"] .blk-option-target');
  await target.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, "goto-block-choice.png") });
  await target.click();
  await page.waitForTimeout(800);
  ok("ジャンプ先へ移動（ブロック表示）: 選択肢の「→ ジャンプ先」を押すとそこへ", (await where(page)).line === 74, await where(page));
  await goto(page, 70);
  await page.locator('.blk-line-row[data-from="72"]').click({ modifiers: [MOD] });
  await page.waitForTimeout(800);
  ok("ジャンプ先へ移動（ブロック表示）: @jump の行を ⌘クリック", (await where(page)).line === 51, await where(page));
  await goto(page, 76);
  await page.locator('.blk-line-row[data-from="76"]').click({ button: "right" });
  await page.screenshot({ path: join(shots, "goto-block-menu.png") });
  await pick(page, "ジャンプ先へ移動");
  await page.waitForTimeout(800);
  ok("ジャンプ先へ移動（ブロック表示）: 行の右クリックのメニュー（@call）", (await where(page)).line === 156, await where(page));
  await goto(page, 97);
  await page.locator('.blk-line-row.blk-label[data-from="97"]').click({ button: "right" });
  await pick(page, "このシーンへ来る行");
  await page.waitForTimeout(1200);
  const mid = await page.locator(".ctx-menu .ctx-item").allTextContents();
  ok("このシーンへ来る行（ブロック表示のシーンの見出し）", mid.length === 1 && mid[0]!.includes("前のシーンから続く"), mid);
  await page.keyboard.press("Escape");
  await context.close();
}

// ---- タイムライン・ボイス・BGM のループの画面の ⌘Z ----

{
  const { context, page } = await open(false);
  const editorText = () => app<string>(page, "return ed.text()");
  const press = async (keys: string) => {
    // 入力欄で打っているときは入力欄の取り消しなので、画面の見出しへ入力を移してから
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press(keys);
    await page.waitForTimeout(1200);
  };
  const tmp = disk("start");
  // タイムライン: 帯を選んで Shift+→ で長さを変え、⌘Z で戻し、⇧⌘Z でやり直す（開いているファイル。シナリオの履歴をたどる）
  await app(page, "return s.open('start', 23)");
  await page.waitForTimeout(800);
  await app(page, "s.setSurface('timeline')");
  await page.waitForTimeout(1500);
  const original = await editorText();
  await page.locator(".tl-blk.is-editable[data-line=\"21\"]").click();
  await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(400);
  const lengthened = await editorText();
  await page.screenshot({ path: join(shots, "undo-timeline.png") });
  await press(`${MOD}+KeyZ`);
  const undone = await editorText();
  await press(`${MOD}+Shift+KeyZ`);
  const redone = await editorText();
  ok("⌘Z（タイムライン）: 帯の書き換えを元に戻し、⇧⌘Z でやり直す", lengthened !== original && undone === original && redone === lengthened, { changed: lengthened !== original, undone: undone === original, redone: redone === lengthened });
  await press(`${MOD}+KeyZ`);
  await press(`${MOD}+KeyZ`);
  ok("⌘Z（タイムライン）: その画面で行った変更が無ければ、シナリオの変更は戻さずに知らせる", (await editorText()) === original && ((await page.locator(".notice").textContent()) ?? "").includes("元に戻せる変更はありません"));
  await page.waitForTimeout(1500);

  // ボイス: 開いていないファイル（epilogue）に割り当て、⌘Z で書く前の内容に戻す
  await app(page, "s.setSurface('voices')");
  await page.waitForSelector(".voice-row", { timeout: 15_000 });
  await page.locator(".voice-bar select").nth(1).selectOption("epilogue");
  await page.waitForTimeout(400);
  const before = disk("epilogue");
  await page.locator(".voice-row .voice-choose").first().click();
  await page.locator(".voice-pick-name").first().click();
  await page.waitForTimeout(1500);
  const assigned = disk("epilogue");
  await press(`${MOD}+KeyZ`);
  const voiceUndone = disk("epilogue");
  await page.screenshot({ path: join(shots, "undo-voice.png") });
  await press(`${MOD}+Shift+KeyZ`);
  ok("⌘Z（ボイス）: 割り当て（開いていないファイル）を元に戻し、⇧⌘Z でやり直す", /@voice\s+akari_001\.wav/.test(assigned) && voiceUndone === before && disk("epilogue") === assigned, { assigned: assigned.includes("@voice"), undone: voiceUndone === before, redone: disk("epilogue") === assigned });
  ok("⌘Z（ボイス）: 一覧も読み直す", (await page.locator(".voice-row .voice-file").first().textContent()) === "akari_001.wav");

  // BGM のループ: 開いているファイル（start）の @bgm の行に書き、⌘Z で戻す
  await page.locator(".tab", { hasText: "素材" }).click();
  await page.locator(".assets-kind", { hasText: "BGM" }).click();
  await page.locator('.asset-tile[data-path="quiet_night.wav"]').click();
  await page.waitForSelector(".bgm-controls:not([hidden])", { timeout: 15_000 });
  const startInput = page.locator(".bgm-fields input").first();
  await startInput.fill("1");
  await startInput.dispatchEvent("change");
  await page.locator(".bgm-save").click();
  await page.locator(".bgm-confirm button.primary").click();
  await page.waitForTimeout(1500);
  const looped = await editorText();
  await press(`${MOD}+KeyZ`);
  const loopUndone = await editorText();
  ok("⌘Z（素材の BGM のループ）: シナリオへの保存を元に戻す", looped.includes("loop-start=") && loopUndone === tmp, { looped: looped.includes("loop-start"), undone: !loopUndone.includes("loop-start") });
  await page.waitForTimeout(1500);
  ok("⌘Z（素材の BGM のループ）: 戻した内容を保存する", !disk("start").includes("loop-start"));
  await context.close();
}

console.log("");
for (const e of errors) console.log(`NG   画面のエラー — ${e}`);
await browser.close();
stop();
writeFileSync(join(shots, "results.txt"), `${results.join("\n")}\n`);
