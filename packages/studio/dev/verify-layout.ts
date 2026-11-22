/**
 * ゲームの設定の「配置を編集」（プレビューの上でドラッグして配置を決める）を、lim studio と同じ開発サーバーをブラウザで開いて確かめる。
 *   npx tsx packages/studio/dev/verify-layout.ts [スクリーンショットの置き場所]
 * - メッセージウィンドウ、名前欄、クイックメニュー、選択肢をドラッグで動かし、端を引いて大きさを変え、liminalia.json の ui に書く
 * - キーで動かす（矢印で 1px、Shift で 10px、⌥ で大きさ）。⌘Z で元に戻す。Esc でドラッグをやめる
 * - 左の欄と上の数の欄で数を変えるとプレビューと枠も動き、ドラッグすると欄の数も変わる
 * - 立ち絵をドラッグすると cast.json の立ち位置を、その立ち絵セットの差分すべてで同じだけずらす。⌘Z で元に戻す
 * - 常駐の表示（@hud-button・@hud-text）をドラッグすると、シナリオのその行の x・y を書き換える。⌘Z で元に戻す
 * - 縦長（720×1280）、基準と違う大きさ（1920×1080）、英語の画面でも枠がプレビューの上に重なり、値が文字と枠の座標になる
 * ひな形（templates/default）を一時フォルダに写して使う。結果は一行ずつ「OK」か「NG」で出す（NG でも終了コードは 0）。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadProject } from "@liminalia/project";
import { chromium, type Frame, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { startPlayerServer } from "../../cli/src/web.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-verify-layout"));
mkdirSync(shots, { recursive: true });
const results: string[] = [];
const ok = (name: string, cond: boolean, detail: unknown = "") => {
  const line = `${cond ? "OK  " : "NG  "} ${name}${!cond && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`;
  results.push(line);
  console.log(line);
};
const errors: string[] = [];
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
const MOD = process.platform === "darwin" ? "Meta" : "Control";

type Ui = { message?: Record<string, number>; name?: Record<string, number>; menuBar?: Record<string, number>; choice?: Record<string, number>; face?: Record<string, number> };
type Box = { x: number; y: number; width: number; height: number };
type CastFile = { cast: Record<string, { appearances: Record<string, { variants: Record<string, { frame?: { positions?: Record<string, { left: number; top: number }> } }> }> }> };

/** 条件がそろうまで待つ（そろえば true）。 */
async function until(cond: () => boolean | Promise<boolean>, ms = 10000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** 確かめに足す常駐の表示（出す条件は偽でも、配置の編集では出す）。 */
const HUD = ["@hud-button memo label=メモ x=1100 y=20 call=#radio_on show-if=(game.looked)", '@hud-text clock text="夕方" x=40 y=30'];

/** ひな形を写したプロジェクト（screen を替えられる。シナリオの頭に常駐の表示を足す。face なら見本の話者に顔ウィンドウの範囲を付ける）。 */
function makeProject(screen?: { width: number; height: number }, face = false): string {
  const dir = mkdtempSync(join(tmpdir(), "liminalia-verify-layout-"));
  cpSync(resolve(import.meta.dirname, "../../../templates/default"), dir, { recursive: true });
  const start = join(dir, "scenario", "start.lim");
  writeFileSync(start, readFileSync(start, "utf8").replace("@set game.wished = false\n", `@set game.wished = false\n${HUD.join("\n")}\n`));
  if (face) {
    const path = join(dir, "cast.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as CastFile & { cast: Record<string, { appearances: Record<string, { face?: unknown }> }> };
    raw.cast["アカリ"]!.appearances["default"]!.face = { x: 120, y: 40, width: 240, height: 240 };
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
    // 顔ウィンドウは ui.face を書いた作品だけに出す
    const configPath = join(dir, "liminalia.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { ui?: Record<string, unknown> };
    config.ui = { ...config.ui, face: { show: "always" } };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  if (screen) {
    const path = join(dir, "liminalia.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.screen = screen;
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  }
  return dir;
}

/** プロジェクトを開いてゲームの設定の「配置を編集」を始める。 */
async function open(project: string, language: "ja" | "en") {
  const { server, url: playerUrl } = await startPlayerServer(loadProject(project), 0, true);
  const base = playerUrl.replace(/\/$/, "");
  const context = await browser.newContext({ locale: language === "en" ? "en-US" : "ja-JP", viewport: { width: 1440, height: 900 } });
  const close = async () => {
    await context.close();
    await server.close();
    rmSync(project, { recursive: true, force: true });
  };
  // 開いている途中で止まっても、開発サーバーを閉じる（閉じないと終わらずに止まったままになる）
  try {
    await context.addInitScript((lang) => {
      localStorage.setItem("liminalia.studio.tourDone", "1");
      localStorage.setItem("liminalia.studio.language", lang);
    }, language);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !/favicon|404|409|autoplay|ERR_FAILED/i.test(m.text()) && errors.push(m.text()));
    await page.goto(`${base}${STUDIO_PAGE}`);
    await page.waitForSelector(".cm-content", { state: "attached" });
    await page.waitForTimeout(1200);
    // 欄は見出しで開いたカテゴリの分だけ出る（枠を選ぶと、その枠の欄のカテゴリが開く）。開いた画面は見出しの並びで待つ
    await page.keyboard.press("Control+7");
    await page.waitForSelector(".game-section .game-category-button");
    await page.waitForTimeout(800);
    await page.locator(".game-layout-toggle").click();
    await page.waitForSelector('.layout-box[data-id="message"]', { timeout: 30000 });
    await page.waitForTimeout(800);
    const config = () => JSON.parse(readFileSync(join(project, "liminalia.json"), "utf8")) as { ui?: Ui };
    const cast = () => JSON.parse(readFileSync(join(project, "cast.json"), "utf8")) as CastFile;
    const frame = (): Frame => page.frames().find((f) => f.url().includes("ui-preview="))!;
    const script = () => readFileSync(join(project, "scenario", "start.lim"), "utf8");
    return { page, config, cast, frame, script, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** 枠の矩形（ページの px）。 */
async function box(page: Page, id: string): Promise<Box> {
  const b = await page.locator(`.layout-box[data-id="${id}"]`).boundingBox();
  if (!b) throw new Error(`${id} の枠がありません`);
  return b;
}

/** 枠をつかむ所（枠の真ん中はほかの枠が重なることがあるので、左上寄り）。ハンドルは選んでから、ハンドルの層のものをつかむ。 */
async function grip(page: Page, id: string, handle?: string): Promise<{ x: number; y: number }> {
  if (handle && (await page.locator(`.layout-box[data-id="${id}"]`).getAttribute("aria-pressed")) !== "true") await page.locator(`.layout-box[data-id="${id}"]`).focus();
  const target = handle ? page.locator(`.layout-handles .layout-handle.is-${handle}`) : page.locator(`.layout-box[data-id="${id}"]`);
  const b = await target.boundingBox();
  if (!b) throw new Error(`${id} ${handle ?? ""} がありません`);
  return handle ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : { x: b.x + Math.min(24, b.width / 2), y: b.y + Math.min(30, b.height / 2) };
}

/** 枠をドラッグする（handle を渡せば、そのハンドルを引く）。 */
async function drag(page: Page, id: string, dx: number, dy: number, handle?: string): Promise<void> {
  const { x, y } = await grip(page, id, handle);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + (dx * i) / 6, y + (dy * i) / 6);
  await page.mouse.up();
}

/** プレビューの中の要素の矩形（ページの px に直したもの）。 */
async function inPreview(page: Page, frame: Frame, selector: string): Promise<Box | null> {
  const f = await page.locator(".game-frame").boundingBox();
  const r = await frame.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  }, selector);
  return r && f ? { x: r.x + f.x, y: r.y + f.y, width: r.width, height: r.height } : null;
}

/** 舞台の幅（ページの px）。 */
const stageWidth = (frame: Frame) => frame.evaluate(() => document.querySelector(".stage")!.getBoundingClientRect().width);

const near = (a: number | undefined, b: number, tol = 2) => a !== undefined && Math.abs(a - b) <= tol;

try {
  // ---- 1280×720、日本語 ----
  {
    const { page, config, cast, frame, script, close } = await open(makeProject(), "ja");
    const ids = await page.locator(".layout-box").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
    ok("配置を編集: メッセージウィンドウ、名前欄、クイックメニュー、立ち絵、常駐の表示の枠を出す", ["message", "name", "menuBar", "sprite:アカリ", "sprite:ソウ", "hud:button:memo", "hud:text:clock"].every((id) => ids.includes(id)), ids);
    ok("配置を編集: ボタンが押された見た目になる", (await page.locator(".game-layout-toggle").getAttribute("aria-pressed")) === "true");
    await page.screenshot({ path: join(shots, "page.png") });
    const k = 1280 / (await stageWidth(frame()));
    const msg0 = await box(page, "message");
    const prev0 = await inPreview(page, frame(), ".message");
    ok("配置を編集: 枠がプレビューのメッセージウィンドウに重なる", !!prev0 && near(prev0.x, msg0.x) && near(prev0.y, msg0.y) && near(prev0.width, msg0.width) && near(prev0.height, msg0.height), { prev0, msg0 });

    // ドラッグで動かす
    const bar0 = await page.locator(".game-bar").boundingBox();
    await drag(page, "message", 40, -30);
    ok("ドラッグ: メッセージウィンドウの位置と大きさを ui.message に書く", await until(() => near(config().ui?.message?.x, 60 + 40 * k) && near(config().ui?.message?.y, 542 - 30 * k) && config().ui?.message?.width === 1160 && config().ui?.message?.height === 150), config().ui?.message);
    ok("ドラッグ: プレビューのメッセージウィンドウも動く", await until(async () => near((await inPreview(page, frame(), ".message"))?.x, msg0.x + 40, 2)), await inPreview(page, frame(), ".message"));
    ok("ドラッグ: 左の欄の数も変わる", await until(async () => (await page.locator('[data-field="message.x"] input').inputValue()) === String(config().ui?.message?.x)), await page.locator('[data-field="message.x"] input').inputValue());
    ok("ドラッグ: 上に選んだものの数の欄を出す", (await page.locator(".game-layout-name").textContent()) === "メッセージウィンドウ" && (await page.locator('.game-layout-fields input[data-key="width"]').inputValue()) === "1160");
    ok("ドラッグ: 選んでも上の行の高さが変わらない（プレビューの大きさが変わらない）", near((await page.locator(".game-bar").boundingBox())?.height, bar0?.height ?? 0, 1), { before: bar0, after: await page.locator(".game-bar").boundingBox() });
    ok("ドラッグ: 左の同じ項目の欄を目立たせる", (await page.locator(".game-field.is-linked").count()) === 4);
    await page.screenshot({ path: join(shots, "message-moved.png") });

    // 角を引いて大きさを変える（右端は画面の右端の近くなので、内へ縮める）
    await drag(page, "message", -30, 20, "se");
    ok("大きさ: 右下の角を引くと幅と高さを変え、位置はそのまま", await until(() => near(config().ui?.message?.width, 1160 - 30 * k) && near(config().ui?.message?.height, 150 + 20 * k) && near(config().ui?.message?.x, 60 + 40 * k)), config().ui?.message);
    await drag(page, "message", 20, 0, "w");
    ok("大きさ: 左の辺を引くと左端が動き、右端はそのまま", await until(() => near(config().ui?.message?.x, 60 + 60 * k) && near(config().ui?.message?.width, 1160 - 50 * k)), config().ui?.message);
    // 画面の外へは引けない（右の辺を大きく引いても、右端は画面の右端で止まる）
    await drag(page, "message", 400, 0, "e");
    ok("大きさ: 画面の外へは引けない（右端で止める）", await until(() => near((config().ui?.message?.x ?? 0) + (config().ui?.message?.width ?? 0), 1280)), config().ui?.message);
    await drag(page, "message", -30, 0, "e");
    ok("大きさ: 画面の右端から内へは引ける", await until(() => near((config().ui?.message?.x ?? 0) + (config().ui?.message?.width ?? 0), 1280 - 30 * k)), config().ui?.message);

    // キー
    const beforeKeys = structuredClone(config().ui?.message);
    await page.locator('.layout-box[data-id="message"]').focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Alt+ArrowRight");
    ok("キー: 矢印で 1px、Shift で 10px 動かし、⌥ と矢印で幅を変える", await until(() => config().ui?.message?.x === beforeKeys!.x! + 3 && config().ui?.message?.y === beforeKeys!.y! + 10 && config().ui?.message?.width === beforeKeys!.width! + 1), { before: beforeKeys, after: config().ui?.message });
    await page.waitForTimeout(400);
    await page.keyboard.press(`${MOD}+z`);
    ok("⌘Z: 続けて押したキーの分をまとめて元に戻す", await until(() => JSON.stringify(config().ui?.message) === JSON.stringify(beforeKeys)), { before: beforeKeys, after: config().ui?.message });
    const k2 = 1280 / (await stageWidth(frame()));
    const stage = await inPreview(page, frame(), ".stage");
    ok("⌘Z: 枠とプレビューも元の位置へ戻る", await until(async () => near((await box(page, "message")).x, stage!.x + beforeKeys!.x! / k2, 2) && near((await inPreview(page, frame(), ".message"))?.x, stage!.x + beforeKeys!.x! / k2, 2)), { box: await box(page, "message"), expected: stage!.x + beforeKeys!.x! / k2 });

    // 上の数の欄
    const xInput = page.locator('.game-layout-fields input[data-key="x"]');
    await xInput.fill("100");
    await xInput.press("Enter");
    ok("数の欄: X を入れると ui.message.x に書く", await until(() => config().ui?.message?.x === 100), config().ui?.message);
    ok("数の欄: プレビューと枠も動く", await until(async () => near((await inPreview(page, frame(), ".message"))?.x, stage!.x + 100 / k2, 2) && near((await box(page, "message")).x, stage!.x + 100 / k2, 2)));
    // 左の欄
    const yField = page.locator('[data-field="message.y"] input');
    await yField.fill("400");
    await yField.press("Tab");
    ok("左の欄: Y を変えると枠とプレビューが動き、上の数の欄も変わる", await until(async () => near((await box(page, "message")).y, stage!.y + 400 / k2, 2) && near((await inPreview(page, frame(), ".message"))?.y, stage!.y + 400 / k2, 2) && (await page.locator('.game-layout-fields input[data-key="y"]').inputValue()) === "400"), { box: await box(page, "message") });
    await until(() => config().ui?.message?.y === 400);

    // Esc でドラッグをやめる
    const beforeEsc = structuredClone(config().ui?.message);
    {
      const { x, y } = await grip(page, "message");
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 30, y + 30);
      await page.mouse.move(x + 60, y + 60);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await page.waitForTimeout(800);
    }
    ok("Esc: ドラッグをやめると書かず、枠も戻る", JSON.stringify(config().ui?.message) === JSON.stringify(beforeEsc) && near((await box(page, "message")).y, stage!.y + 400 / k2, 2), { config: config().ui?.message, box: await box(page, "message") });

    // 名前欄（メッセージウィンドウの内側の左上から）
    await drag(page, "name", 30, 0);
    ok("名前欄: ドラッグで ui.name の x と y を書く（y は今の位置のまま）", await until(() => near(config().ui?.name?.x, 28 + 30 * k2) && config().ui?.name?.y === -22), config().ui?.name);
    ok("名前欄: プレビューの名前欄が枠に重なる", await until(async () => near((await inPreview(page, frame(), ".message .name"))?.x, (await box(page, "name")).x, 2)), { preview: await inPreview(page, frame(), ".message .name"), box: await box(page, "name") });

    // クイックメニュー
    const bar = await box(page, "menuBar");
    await drag(page, "menuBar", -300, -380);
    ok("クイックメニュー: ドラッグで ui.menuBar の x と y を書く", await until(() => config().ui?.menuBar?.x !== undefined && near(config().ui?.menuBar?.y, (bar.y - stage!.y - 380) * k2, 3)), config().ui?.menuBar);
    ok("クイックメニュー: プレビューの帯も動く", await until(async () => near((await inPreview(page, frame(), ".lm-menubar"))?.x, bar.x - 300, 3) && near((await inPreview(page, frame(), ".lm-menubar"))?.y, bar.y - 380, 3)), { preview: await inPreview(page, frame(), ".lm-menubar"), bar });
    ok("クイックメニュー: 左の欄にも数が入る", (await page.locator('[data-field="menuBar.x"] input').inputValue()) === String(config().ui?.menuBar?.x));
    await page.screenshot({ path: join(shots, "moved.png") });

    // 立ち絵
    const akari = () => cast().cast["アカリ"]!.appearances["default"]!.variants;
    const kStage = k2; // 1280×720 では舞台の座標と同じ
    await drag(page, "sprite:アカリ", 50, 0);
    ok("立ち絵: ドラッグで cast.json の立ち位置を書き、立ち絵セットの差分すべてを同じだけずらす", await until(() => near(akari()["normal"]!.frame!.positions!.left!.left, 60 + 50 * kStage) && near(akari()["smile"]!.frame!.positions!.left!.left, 60 + 50 * kStage) && akari()["normal"]!.frame!.positions!.center!.left === 407), akari()["normal"]!.frame!.positions);
    ok("立ち絵: プレビューの立ち絵も動き、枠に重なる", await until(async () => near((await inPreview(page, frame(), '.sprite[data-who="アカリ"]'))?.x, (await box(page, "sprite:アカリ")).x, 2)), { preview: await inPreview(page, frame(), '.sprite[data-who="アカリ"]'), box: await box(page, "sprite:アカリ") });
    ok("立ち絵: 上の欄に名前と立ち位置を出す", (await page.locator(".game-layout-name").textContent()) === "アカリ（left）" && (await page.locator(".game-layout-fields select").inputValue()) === "left");
    await page.screenshot({ path: join(shots, "sprite.png") });
    await page.locator('.layout-box[data-id="sprite:アカリ"]').focus();
    await page.keyboard.press(`${MOD}+z`);
    ok("立ち絵: ⌘Z で cast.json の立ち位置を元に戻す", await until(() => akari()["normal"]!.frame!.positions!.left!.left === 60 && akari()["smile"]!.frame!.positions!.left!.left === 60), akari()["normal"]!.frame!.positions);
    ok("立ち絵: 元に戻すとプレビューの立ち絵も戻る", await until(async () => near((await inPreview(page, frame(), '.sprite[data-who="アカリ"]'))?.x, stage!.x + 60 / kStage, 2)), await inPreview(page, frame(), '.sprite[data-who="アカリ"]'));
    // 立ち位置を替えて、その立ち位置を動かす
    await page.locator(".game-layout-fields select").selectOption("center");
    await page.waitForSelector('.layout-box[data-id="sprite:アカリ"]', { timeout: 20000 });
    await page.waitForTimeout(600);
    ok("立ち絵: 立ち位置を替えると、その立ち位置で出し直す", await until(async () => near((await inPreview(page, frame(), '.sprite[data-who="アカリ"]'))?.x, stage!.x + 407 / kStage, 2)), await inPreview(page, frame(), '.sprite[data-who="アカリ"]'));
    await page.locator('.layout-box[data-id="sprite:アカリ"]').focus();
    await page.keyboard.press("Shift+ArrowUp");
    ok("立ち絵: キーで動かすと、その立ち位置だけ書く", await until(() => akari()["normal"]!.frame!.positions!.center!.top === 20 && akari()["normal"]!.frame!.positions!.left!.top === 30), akari()["normal"]!.frame!.positions);

    // 常駐の表示（シナリオの行を書き換える。開いているファイルでも）
    const memo0 = await box(page, "hud:button:memo");
    const memoPreview = await inPreview(page, frame(), '.lim-hud [data-hud="memo"]');
    ok("常駐の表示: 出す条件が偽でも枠を出し、プレビューのボタンに重なる", !!memoPreview && near(memoPreview.x, memo0.x) && near(memoPreview.y, memo0.y), { memoPreview, memo0 });
    await drag(page, "hud:button:memo", -40, 20);
    const memoLine = () => script().split("\n").find((l) => l.startsWith("@hud-button memo")) ?? "";
    ok("常駐の表示: ドラッグでシナリオのその行の x と y を書き換える", await until(() => /x=(\d+)/.test(memoLine()) && near(Number(/x=(\d+)/.exec(memoLine())![1]), 1100 - 40 * k2) && near(Number(/ y=(\d+)/.exec(memoLine())![1]), 20 + 20 * k2)), memoLine());
    ok("常駐の表示: ほかのパラメータはそのまま", memoLine().includes("call=#radio_on") && memoLine().includes("show-if=(game.looked)") && memoLine().includes("label=メモ"), memoLine());
    ok("常駐の表示: プレビューのボタンも動く", await until(async () => near((await inPreview(page, frame(), '.lim-hud [data-hud="memo"]'))?.x, memo0.x - 40, 2)));
    ok("常駐の表示: 上の欄に名前と位置を出す", (await page.locator(".game-layout-name").textContent()) === "常駐のボタン memo");
    await page.screenshot({ path: join(shots, "hud.png") });
    await page.locator('.layout-box[data-id="hud:button:memo"]').focus();
    await page.keyboard.press(`${MOD}+z`);
    ok("常駐の表示: ⌘Z でシナリオの行を元に戻し、プレビューも戻る", await until(async () => memoLine() === HUD[0] && near((await inPreview(page, frame(), '.lim-hud [data-hud="memo"]'))?.x, memo0.x, 2)), memoLine());
    await page.locator('.layout-box[data-id="hud:text:clock"]').focus();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    ok("常駐の表示: 文字もキーで動かせる", await until(() => script().includes('@hud-text clock text="夕方" x=60 y=30')), script().split("\n").find((l) => l.startsWith("@hud-text")));

    // 選択肢
    await page.locator(".game-bar .seg", { hasText: "選択肢" }).click();
    await page.waitForSelector('.layout-box[data-id="choices"]', { timeout: 20000 });
    await page.waitForTimeout(600);
    const choices0 = await box(page, "choices");
    const choicesPreview = await inPreview(page, frame(), ".choices button");
    ok("選択肢: 枠がプレビューの選択肢に重なる", !!choicesPreview && near(choicesPreview.y, choices0.y) && near(choicesPreview.x, choices0.x), { choicesPreview, choices0 });
    await drag(page, "choices", 80, 40);
    ok("選択肢: ドラッグは縦だけ動かし、ui.choice.y に書く", await until(async () => config().ui?.choice?.y !== undefined && near((await box(page, "choices")).y, choices0.y + 40, 2) && near((await box(page, "choices")).x, choices0.x, 1)), { choice: config().ui?.choice, box: await box(page, "choices") });
    ok("選択肢: プレビューの選択肢も動く", await until(async () => near((await inPreview(page, frame(), ".choices button"))?.y, choices0.y + 40, 2)), await inPreview(page, frame(), ".choices button"));
    await drag(page, "choices", 20, 0, "e");
    ok("選択肢: 右の辺を引くと、真ん中を保って幅を広げる（ui.choice.width）", await until(() => near(config().ui?.choice?.width, 560 + 40 * k2, 2)), config().ui?.choice);
    await page.screenshot({ path: join(shots, "choices.png") });

    // やめる
    await page.locator(".game-layout-toggle").click();
    ok("配置を編集をやめると枠と数の欄を外す", await until(async () => (await page.locator(".layout-box").count()) === 0 && (await page.locator(".game-layout-fields").isHidden())));
    await close();
  }

  // ---- 顔ウィンドウ（話者に顔のある作品） ----
  {
    const { page, config, frame, close } = await open(makeProject(undefined, true), "ja");
    const face0 = await box(page, "face");
    const facePreview = await inPreview(page, frame(), ".message .face");
    ok("顔ウィンドウ: 枠がプレビューの顔ウィンドウに重なる", !!facePreview && near(facePreview.x, face0.x) && near(facePreview.y, face0.y) && near(facePreview.width, face0.width), { facePreview, face0 });
    const k = 1280 / (await stageWidth(frame()));
    await drag(page, "face", 20, -30);
    ok("顔ウィンドウ: ドラッグで ui.face の x と y を書き（大きさは書かない）、プレビューも動く", await until(async () => config().ui?.face?.x !== undefined && config().ui?.face?.width === undefined && near((await inPreview(page, frame(), ".message .face"))?.y, face0.y - 30, 2) && near((await inPreview(page, frame(), ".message .face"))?.x, face0.x + 20, 2)), config().ui?.face);
    await drag(page, "face", -20, 0, "w");
    ok("顔ウィンドウ: 左の辺を引くと幅を書く", await until(() => near(config().ui?.face?.width, 180 + 20 * k)), config().ui?.face);
    await page.screenshot({ path: join(shots, "face.png") });
    await close();
  }

  // ---- 縦長（720×1280） ----
  {
    const { page, config, frame, close } = await open(makeProject({ width: 720, height: 1280 }), "ja");
    const k = 720 / (await stageWidth(frame()));
    const msg0 = await box(page, "message");
    const prev0 = await inPreview(page, frame(), ".message");
    ok("縦長: 枠がプレビューのメッセージウィンドウに重なる", !!prev0 && near(prev0.x, msg0.x) && near(prev0.y, msg0.y) && near(prev0.width, msg0.width) && near(prev0.height, msg0.height), { prev0, msg0 });
    await drag(page, "message", 10, -40);
    ok("縦長: ドラッグで縦長の既定の大きさのまま位置を書く（幅 672、高さ 250）", await until(() => near(config().ui?.message?.x, 24 + 10 * k) && config().ui?.message?.width === 672 && config().ui?.message?.height === 250), config().ui?.message);
    ok("縦長: プレビューも動く", await until(async () => near((await inPreview(page, frame(), ".message"))?.y, msg0.y - 40, 2)));
    await page.locator('.layout-box[data-id="message"]').click();
    await page.screenshot({ path: join(shots, "portrait.png") });
    await close();
  }

  // ---- 基準と違う大きさ（1920×1080）、英語 ----
  {
    const { page, config, frame, close } = await open(makeProject({ width: 1920, height: 1080 }), "en");
    ok("英語: ボタンの名前", (await page.locator(".game-layout-toggle").textContent()) === "Edit layout");
    const k = 1280 / (await stageWidth(frame()));
    const msg0 = await box(page, "message");
    const prev0 = await inPreview(page, frame(), ".message");
    ok("1920×1080: 枠がプレビューのメッセージウィンドウに重なる", !!prev0 && near(prev0.x, msg0.x) && near(prev0.y, msg0.y) && near(prev0.width, msg0.width) && near(prev0.height, msg0.height), { prev0, msg0 });
    // 右端は画面の右端の近く（x 60、幅 1160）なので、左へ動かす
    await drag(page, "message", -30, 0);
    ok("1920×1080: 値は文字と枠の座標（1280×720 の px）で書く", await until(() => near(config().ui?.message?.x, 60 - 30 * k) && config().ui?.message?.width === 1160), config().ui?.message);
    ok("1920×1080: プレビューも動き、枠に重なる", await until(async () => near((await inPreview(page, frame(), ".message"))?.x, msg0.x - 30, 2) && near((await box(page, "message")).x, msg0.x - 30, 2)));
    ok("英語: 数の欄の名前", (await page.locator(".game-layout-name").textContent()) === "Message window" && (await page.locator('.game-layout-fields input[data-key="width"]').getAttribute("aria-label")) === "Message window Width");
    await page.screenshot({ path: join(shots, "scaled-en.png") });
    await close();
  }
} catch (e) {
  ok("例外なく終わる", false, (e as Error).stack ?? String(e));
} finally {
  await browser.close();
}
ok("エラーが出ない", errors.length === 0, errors);
writeFileSync(join(shots, "results.txt"), `${results.join("\n")}\n`);
// 途中の例外で閉じられなかった開発サーバーが残っても、ここで終える
process.exit(0);
