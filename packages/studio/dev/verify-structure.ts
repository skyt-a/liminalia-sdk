/**
 * シーンとファイルの組み立て（シーンの操作・別のファイルへ移す・ファイルを分ける・フローチャートで組み立てる・全体表示と絞り込み・
 * シーン一覧のフォルダ）と、デバッグの道具（全ルートテストの経過と結果・ブレークポイントの一覧・プレビューの言語・あふれるページ）を、
 * lim studio の画面で操作して確かめる。
 *   npx tsx packages/studio/dev/verify-structure.ts <スクリーンショットの置き場所> [ポート（既定 5316）]
 * ひな形（templates/default）を一時フォルダに写して開く。リポジトリのひな形は書き換えない。
 * 結果は一行ずつ「OK」か「NG」で出す（NG でも終了コードは 0）。終わったらサーバーを止める。
 */
import { spawn } from "node:child_process";
import { existsSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";
import { translationKey } from "@liminalia/lang";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-verify-structure"));
mkdirSync(shots, { recursive: true });
const port = Number(process.argv[3] ?? 5316);
const base = `http://localhost:${port}`;
const url = `${base}${STUDIO_PAGE}`;

const project = mkdtempSync(join(tmpdir(), "liminalia-verify-structure-"));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
const scenario = join(project, "scenario");
mkdirSync(join(scenario, "part1/chapter2"), { recursive: true });
writeFileSync(join(scenario, "part1/chapter2/side.lim"), ["# side", "アカリ「サブフォルダのシナリオです」", "@jump start#menu", ""].join("\n"));
writeFileSync(join(scenario, "flow.lim"), ["# f1", "　一つ目。", "", "# f2", "　二つ目。", "", "# f3", "　三つ目。", ""].join("\n"));
writeFileSync(join(scenario, "bp.lim"), ["# bp", "@bg hill_night.webp", "　一つ目。", "@set game.n = 1", "　二つ目。", "@set game.n = 2", "　三つ目。", "@set game.n = 3", "　四つ目。", ""].join("\n"));
writeFileSync(join(scenario, "long.lim"), ["# long", `　${"長い本文がメッセージウィンドウに収まらない。".repeat(14)}`, "　短い本文。", "アカリ「{r 流星群|りゅうせいぐん}を{b 見に}来ました」", ""].join("\n"));
// 訳（プレビューの言語）
{
  const configPath = join(project, "liminalia.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.languages = ["ja", "en"];
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  mkdirSync(join(project, "lang"), { recursive: true });
  const key = translationKey("bp", "line", "　二つ目。");
  // 原文は収まるが、訳はあふれる行（あふれるページは言語ごとに知らせる）
  const short = translationKey("long", "line", "　短い本文。");
  writeFileSync(join(project, "lang/en.json"), JSON.stringify({ language: "en", lines: { [key]: { source: "　二つ目。", text: "The second one." }, [short]: { source: "　短い本文。", text: "A short line in Japanese becomes a very long line once it is translated. ".repeat(10) } } }, null, 2));
}
const disk = (file: string) => readFileSync(join(scenario, `${file}.lim`), "utf8");
const has = (file: string) => existsSync(join(scenario, `${file}.lim`));

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

async function open(blocks: boolean, init = ""): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
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
const pick = async (page: Page, label: string) => {
  await page.locator(".ctx-menu .ctx-item", { hasText: label }).first().click();
};
const menuLabels = (page: Page) => page.locator(".ctx-menu .ctx-item").allTextContents();
/** シーン一覧でそのファイルのシーンを開く（たたんでいれば）。 */
async function unfold(page: Page, file: string): Promise<void> {
  const head = page.locator(`.toc-file[data-file="${file}"]`);
  if ((await head.locator(".toc-file-fold").getAttribute("aria-expanded")) !== "true") await head.locator(".toc-file-fold").click();
  await page.waitForTimeout(200);
}
const sceneRow = (page: Page, name: string) => page.locator(".scene-row", { has: page.locator(".scene-name", { hasText: new RegExp(`^${name}$`) }) }).first();
/** ディスクの中身が cond を満たすまで待つ（自動保存は手が止まってから書く）。 */
async function until(cond: () => boolean, ms = 6000): Promise<boolean> {
  for (let t = 0; t < ms; t += 200) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return cond();
}
/** 名前の欄（移す先・分ける先）に書いて Enter。 */
async function answer(page: Page, text: string): Promise<void> {
  const input = page.locator(".scene-rename input");
  await input.fill(text);
  await input.press("Enter");
  await page.waitForTimeout(1500);
}

// ---- シーン一覧のフォルダ ----
{
  const { page } = await open(false);
  const folder = page.locator('.toc-folder[data-folder="part1"]');
  const sub = page.locator('.toc-folder[data-folder="part1/chapter2"]');
  const side = page.locator('.toc-file[data-file="part1/chapter2/side"]');
  ok("名前順で、サブフォルダを見出しにしてファイルを入れる", (await folder.count()) === 1 && (await sub.count()) === 1 && (await side.locator(".toc-file-name").textContent()) === "side.lim");
  await unfold(page, "part1/chapter2/side");
  await page.screenshot({ path: join(shots, "toc-folders.png") });
  await folder.click();
  await page.waitForTimeout(200);
  ok("フォルダをたたむと中のファイルを出さない", (await side.count()) === 0 && (await folder.getAttribute("aria-expanded")) === "false");
  await folder.click();
  await page.close();
}

// ---- シーンの操作・別のファイルへ移す・ファイルを分ける ----
{
  const { page } = await open(false);
  await unfold(page, "start");
  await sceneRow(page, "night").click({ button: "right" });
  await page.waitForTimeout(200);
  const tocItems = await menuLabels(page);
  await page.screenshot({ path: join(shots, "scene-menu-toc.png") });
  ok("シーン一覧の右クリックに、名前の変更・複製・移動・分割・削除が出る", ["シーンの名前を変更", "シーンを複製", "別のファイルへ移動", "ここからファイルを分ける", "シーンを削除"].every((l) => tocItems.includes(l)), tocItems);
  await pick(page, "シーンを複製");
  ok("複製: 写しをファイルの終わりに名前_2 で置く", await until(() => /\n# night_2\n/.test(disk("start")), 25000), disk("start").slice(-300));

  // 写しを消す（⌘Z の代わりにお知らせの「元に戻す」）
  await sceneRow(page, "night_2").click({ button: "right" });
  await pick(page, "シーンを削除");
  ok("削除: シーンの行を消す", await until(() => !disk("start").includes("# night_2"), 25000));
  await page.locator(".notice-action", { hasText: "元に戻す" }).first().click();
  ok("削除: お知らせの「元に戻す」で戻る", await until(() => disk("start").includes("# night_2"), 25000));

  // telescope を新しいファイルへ移す
  await sceneRow(page, "telescope").click({ button: "right" });
  await pick(page, "別のファイルへ移動");
  await page.waitForSelector(".scene-rename input");
  await page.screenshot({ path: join(shots, "scene-move-ask.png") });
  await answer(page, "extra/tele");
  ok("移動: 新しいファイルにシーンを置く", has("extra/tele") && disk("extra/tele").startsWith("# telescope"), has("extra/tele") ? disk("extra/tele") : "無い");
  ok("移動: 選択肢のジャンプ先を移した先へ書き換える", disk("start").includes("- 望遠鏡をのぞく -> extra/tele#telescope"));
  ok("移動: 移したシーンの中の、元のファイルのシーンは ファイル#ラベル にする", has("extra/tele") && disk("extra/tele").includes("@jump start#menu"));
  await page.screenshot({ path: join(shots, "scene-moved.png") });

  // outside から最後までを分ける
  await sceneRow(page, "outside").click({ button: "right" });
  await pick(page, "ここからファイルを分ける");
  await page.waitForSelector(".scene-rename input");
  const proposed = await page.locator(".scene-rename input").inputValue();
  await answer(page, proposed);
  ok("分割: そのシーンから最後までを新しいファイルへ", proposed === "start_2" && has("start_2") && /^# outside$/m.test(disk("start_2")) && !disk("start").includes("# outside"), { proposed, start: disk("start").slice(-200) });
  await page.screenshot({ path: join(shots, "scene-split.png") });

  // ブロック表示の見出しとフローチャートのカードにも同じ操作
  await page.locator(".tab", { hasText: "フローチャート" }).first().click();
  await page.waitForSelector(".map-card");
  await page.waitForTimeout(800);
  await page.locator('.map-card[data-id="start#night"]').click({ button: "right" });
  await page.waitForTimeout(200);
  const mapItems = await menuLabels(page);
  await page.screenshot({ path: join(shots, "scene-menu-map.png") });
  ok("フローチャートのカードの右クリックにも、名前の変更・複製・移動・削除が出る", ["シーンの名前を変更", "シーンを複製", "別のファイルへ移動", "シーンを削除"].every((l) => mapItems.includes(l)), mapItems);
  await pick(page, "シーンの名前を変更");
  await page.locator(".scene-rename input").fill("evening");
  await page.locator(".scene-rename input").press("Enter");
  await page.waitForTimeout(2000);
  ok("フローチャートのカードから名前を変更でき、カードも描き直す", disk("start").includes("# evening") && (await page.locator('.map-card[data-id="start#evening"]').count()) === 1);
  await page.close();
}

// ---- フローチャートで組み立てる ----
{
  const { page } = await open(false);
  await page.locator(".tab", { hasText: "フローチャート" }).first().click();
  await page.waitForSelector(".map-card");
  // 見えている近くのカードだけを描くので、検索で寄せる
  await page.locator(".map-search").fill("二つ目");
  await page.waitForTimeout(1200);
  await page.locator(".map-search").fill("");
  await page.waitForTimeout(500);
  const card = (id: string) => page.locator(`.map-card[data-id="${id}"]`);
  // f1 のつまみを引いて f3 で離す
  await card("flow#f1").hover();
  const handle = await card("flow#f1").locator(".map-card-link").boundingBox();
  const target = await card("flow#f3").boundingBox();
  if (handle && target) {
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + 40, { steps: 8 });
    await page.screenshot({ path: join(shots, "map-link-drag.png") });
    await page.mouse.up();
  }
  ok("線を引く: そのまま続くシーンの終わりに @jump を足す", await until(() => disk("flow").includes("　一つ目。\n@jump #f3")), disk("flow"));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(shots, "map-linked.png") });

  // 引いた線を右クリックして消す
  const at = await page.evaluate(() => {
    const path = document.querySelector('.map-edge[data-from="flow#f1"][data-to="flow#f3"]') as SVGPathElement | null;
    if (!path) return null;
    const p = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
  });
  if (at) {
    await page.mouse.click(at.x, at.y, { button: "right" });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(shots, "map-edge-menu.png") });
    await pick(page, "線を削除");
  }
  ok("線を消す: 右クリックの「線を削除」で @jump の行を消す", at !== null && (await until(() => !disk("flow").includes("@jump #f3"))), { at, flow: disk("flow") });

  // 地を右クリックしてシーンを足す（f3 の右の空いたところ）
  const box = await card("flow#f3").boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width + 160, box.y + box.height / 2, { button: "right" });
    await page.waitForTimeout(200);
    const items = await menuLabels(page);
    ok("地の右クリックに、そのファイルへシーンを追加が出る", items.includes("flow.lim にシーンを追加"), items);
    await pick(page, "flow.lim にシーンを追加");
    await page.locator(".scene-rename input").fill("f4");
    await page.locator(".scene-rename input").press("Enter");
  }
  ok("シーンを足す: ファイルの終わりに足し、終わりで止まっていたシーンには @stop を足す", await until(() => /　三つ目。\n@stop\n\n# f4\n/.test(disk("flow"))), disk("flow"));
  await page.waitForTimeout(2000);
  const placed = await card("flow#f4").boundingBox();
  ok("シーンを足す: 押した場所にカードを置く", placed !== null && box !== null && Math.abs(placed.x - (box.x + box.width + 160 - placed.width / 2)) < 30, { placed, box });
  await page.screenshot({ path: join(shots, "map-added.png") });
  await page.keyboard.press("Meta+KeyZ");
  ok("フローチャートの画面の ⌘Z で、足したシーンを元に戻す", await until(() => !disk("flow").includes("# f4")), disk("flow"));

  // 全体を表示と絞り込み
  await page.waitForTimeout(1500);
  await page.locator(".map-filter").first().selectOption("flow");
  await page.waitForTimeout(800);
  const count = await page.locator(".map-count").textContent();
  const dim = await page.locator(".map-card.is-dim").count();
  ok("ファイルで絞り込むと、当てはまらないシーンを薄くして数を出す", /^3 \/ \d+ シーン$/.test(count ?? "") && dim > 0, { count, dim });
  await page.screenshot({ path: join(shots, "map-filter-file.png") });
  await page.locator(".map-filter").first().selectOption("");
  await page.locator(".map-filter").nth(1).selectOption("ソウ");
  await page.waitForTimeout(800);
  ok("人物で絞り込む（話すシーンだけ）", (await page.locator('.map-card.is-dim[data-id="flow#f1"]').count()) === 1 && (await page.locator(".map-card.is-match").count()) > 0);
  await page.locator(".map-filter").nth(1).selectOption("");
  await page.locator(".map-fit").click();
  await page.waitForTimeout(800);
  const zoomText = await page.locator(".map-zoom-value").textContent();
  const mini = await page.locator(".map-mini").isVisible();
  ok("全体を表示: 全体が収まる大きさにする", Number(zoomText?.replace("%", "")) < 100, zoomText);
  await page.screenshot({ path: join(shots, "map-fit.png") });
  await page.locator(".map-zoom button").last().click();
  await page.locator(".map-zoom button").last().click();
  await page.waitForTimeout(500);
  ok("全体図: 全体が欄に収まらないときに出す", (await page.locator(".map-mini").isVisible()) && !mini, { mini });
  await page.screenshot({ path: join(shots, "map-mini.png") });
  await page.close();
}

// ---- 全ルートテストの経過・結果を覚える・実行後に変わった印 ----
{
  const { page } = await open(false);
  await page.locator(".tab", { hasText: "チェック" }).first().click();
  await page.waitForTimeout(800);
  const run = page.locator(".check-surface button", { hasText: /全ルートテストを(再)?実行|再実行/ }).first();
  await run.click();
  let sawProgress = false;
  for (let i = 0; i < 100 && !sawProgress; i++) {
    // 数えてから読むと、その間に実行が終わって経過の欄が消え、読むのを 30 秒待って止まる。一度に読む
    sawProgress = /回目/.test(await page.evaluate(() => document.querySelector(".check-progress-text")?.textContent ?? ""));
    if (!sawProgress) await page.waitForTimeout(50);
  }
  await page.screenshot({ path: join(shots, "coverage-progress.png") });
  ok("全ルートテスト: 実行中に何回目かとファイルを出す", sawProgress);
  ok("全ルートテスト: 結果を .liminalia/coverage.json に覚える", await until(() => existsSync(join(project, ".liminalia/coverage.json")), 60000));
  await page.waitForTimeout(1000);
  await page.close();

  const again = await open(false);
  await again.page.locator(".tab", { hasText: "チェック" }).first().click();
  await again.page.waitForTimeout(1000);
  const text = (await again.page.locator(".check-surface").textContent()) ?? "";
  ok("全ルートテスト: 開き直しても前の結果を出す", !text.includes("全ルートテストを実行すると") && /再実行/.test(text), text.slice(0, 200));
  // シナリオを変えると、実行後に変わった印を出す
  await again.page.locator(".tab", { hasText: "シナリオ" }).first().click();
  await app(again.page, "ed.gotoLine(16); ed.view.dispatch({ changes: { from: ed.view.state.doc.line(16).to, insert: ' ' } })");
  await until(() => / \n/.test(disk("start")), 15000);
  await again.page.waitForTimeout(1500);
  await again.page.locator(".tab", { hasText: "チェック" }).first().click();
  await again.page.waitForTimeout(800);
  ok("全ルートテスト: 実行後にシナリオが変わったら印を出す", (await again.page.locator(".check-note.is-stale").count()) > 0);
  await again.page.screenshot({ path: join(shots, "coverage-stale.png") });
  await again.page.close();
}

// ---- ブレークポイントの一覧・条件・一つずつ進める・行の中身で覚える ----
{
  const { page } = await open(false);
  const studioJson = () => JSON.parse(readFileSync(join(project, ".liminalia/studio.json"), "utf8")) as { breakpoints?: { file: string; line: number; text: string; cond?: string }[] };
  const points = () => (existsSync(join(project, ".liminalia/studio.json")) ? (studioJson().breakpoints ?? []) : []);
  await page.locator(".tab", { hasText: "シナリオ" }).first().click();
  await app(page, "s.debug.open ? s.debug.open('bp') : null");
  await unfold(page, "bp");
  await sceneRow(page, "bp").click();
  await page.waitForTimeout(1200);
  await app(page, "ed.toggleBreakpoint(6)");
  ok("ブレークポイント: 行の中身と一緒に .liminalia/studio.json に覚える", await until(() => points().some((p) => p.file === "bp" && p.line === 6 && p.text === "@set game.n = 2")), points());
  // 上に行を足すと、印も覚えた行番号も動く
  await app(page, "ed.view.dispatch({ changes: { from: 0, insert: '// 足した行\\n' } })");
  ok("ブレークポイント: 上に行を足すと、同じ中身の行に付いたまま覚え直す", await until(() => points().some((p) => p.line === 7 && p.text === "@set game.n = 2")), points());
  // 一覧で条件を書く（game.n が 1 のとき = 二つ目の後）
  await page.locator(".stage-breakpoints").click();
  await page.waitForSelector(".bp-panel");
  await page.screenshot({ path: join(shots, "breakpoint-list.png") });
  await page.locator(".bp-panel .bp-cond").first().fill("game.n == 5");
  await page.locator(".bp-panel .bp-cond").first().press("Enter");
  ok("ブレークポイント: 一覧で条件を書くと覚える", await until(() => points().some((p) => p.cond === "game.n == 5")), points());
  await page.keyboard.press("Escape");
  // 条件が偽なら止まらない
  await app(page, "ed.gotoLine(4)");
  await page.waitForTimeout(1500);
  const stageFrame = page.locator(".stage-frame");
  const stopped = () => page.locator(".stage-step:not([hidden])").count();
  for (let i = 0; i < 4; i++) {
    await stageFrame.click();
    await page.waitForTimeout(600);
  }
  ok("ブレークポイント: 条件が偽なら止まらない", (await stopped()) === 0);
  // 条件を真にすると止まり、「一つ進める」で次のコマンドの前で止まる
  await page.locator(".stage-breakpoints").click();
  await page.locator(".bp-panel .bp-cond").first().fill("game.n == 1");
  await page.locator(".bp-panel .bp-cond").first().press("Enter");
  await page.keyboard.press("Escape");
  await app(page, "ed.gotoLine(9)");
  await page.waitForTimeout(1200);
  await app(page, "ed.gotoLine(4)");
  await page.waitForTimeout(1500);
  for (let i = 0; i < 4 && (await stopped()) === 0; i++) {
    await stageFrame.click();
    await page.waitForTimeout(600);
  }
  const at1 = await app<number>(page, "return ed.cursorLine()");
  ok("ブレークポイント: 条件が真なら止まる", (await stopped()) === 1 && at1 === 7, { at1 });
  await page.screenshot({ path: join(shots, "breakpoint-stopped.png") });
  await page.locator(".stage-step").click();
  await page.waitForTimeout(1500);
  const at2 = await app<number>(page, "return ed.cursorLine()");
  ok("一つ進める: 止まったコマンドを実行して、次のコマンドの前で止まる", (await stopped()) === 1 && at2 === 8, { at2 });
  await page.close();
}

// ---- 訳した言語でプレビューする ----
{
  const { page } = await open(false);
  const select = page.locator(".stage-lang");
  ok("プレビューの言語: 遊べる言語が二つ以上なら選びを出す", (await select.isVisible()) && (await select.locator("option").allTextContents()).join(",") === "ja（原文）,en");
  await unfold(page, "bp");
  await sceneRow(page, "bp").click();
  await page.waitForTimeout(800);
  const line = await app<number>(page, "return ed.text().split('\\n').findIndex((l) => l === '　二つ目。') + 1");
  await select.selectOption("en");
  await page.waitForTimeout(2500);
  await app(page, `ed.gotoLine(${line})`);
  const frame = page.frameLocator(".stage-frame");
  let shown = "";
  for (let i = 0; i < 30 && !shown.includes("The second one."); i++) {
    await page.waitForTimeout(300);
    shown = (await frame.locator("body").innerText().catch(() => "")) ?? "";
  }
  ok("プレビューの言語: 訳した言語で本文を出す", shown.includes("The second one."), shown.slice(0, 200));
  await page.screenshot({ path: join(shots, "preview-language.png") });
  // 読み直しても同じ言語（同じブラウザに覚える）
  await page.reload();
  await page.waitForSelector(".cm-content", { state: "attached" });
  await page.waitForTimeout(2000);
  ok("プレビューの言語: 選んだ言語を覚える", (await page.locator(".stage-lang").inputValue()) === "en");
  await page.close();
}

// ---- メッセージウィンドウからあふれるページ ----
{
  const { page } = await open(false);
  await page.waitForTimeout(1500);
  await page.locator(".tab", { hasText: "チェック" }).first().click();
  await page.locator(".check-overflow-run").click();
  await page.waitForFunction(() => /ページがメッセージウィンドウからあふれます|あふれるページはありません/.test(document.querySelector(".check-overflow")?.textContent ?? ""), undefined, { timeout: 120_000 });
  const line = (await page.locator(".check-overflow-head").textContent()) ?? "";
  const rows = await page.locator(".check-problems li", { hasText: "メッセージウィンドウからあふれます" }).allTextContents();
  ok("あふれるページ: 長い本文の行と、訳であふれる行を言語ごとにチェックの一覧に出す", /^2 ページ/.test(line) && rows.length === 2 && rows.every((r) => r.includes("long")) && rows.filter((r) => r.includes("en の訳で")).length === 1, { line, rows });
  ok("あふれるページ: 結果の場所と本文を検査のすぐ下に出す", (await page.locator(".check-overflow-result").count()) === 2 && (await page.locator(".check-overflow-result").first().textContent())!.includes("long.lim:2"));
  await page.screenshot({ path: join(shots, "overflow.png") });
  // 計る言語を原文だけにすると、訳の行は知らせない
  await page.locator(".check-overflow-lang").selectOption("ja");
  await page.locator(".check-overflow-run").click();
  await page.waitForFunction(() => /^1 ページ/.test(document.querySelector(".check-overflow-head")?.textContent ?? ""), undefined, { timeout: 120_000 }).catch(() => undefined);
  const only = await page.locator(".check-problems li", { hasText: "メッセージウィンドウからあふれます" }).allTextContents();
  ok("あふれるページ: 計る言語を原文だけにできる", only.length === 1 && !only[0]!.includes("en の訳で"), only);
  await page.locator(".check-overflow-lang").selectOption("*");
  await page.locator(".check-overflow-result").first().click();
  await page.waitForTimeout(800);
  ok("あふれるページ: 押すとその行へ", (await app<{ file: string; line: number }>(page, "return { file: s.debug.file, line: ed.cursorLine() }")).line === 2);
  ok("あふれるページ: プレビューを開く", await page.locator(".stage-frame").isVisible());
  await page.close();
}

console.log("");
for (const e of errors) console.log(`NG   画面のエラー — ${e}`);
await browser.close();
stop();
writeFileSync(join(shots, "results.txt"), `${results.join("\n")}\n`);
