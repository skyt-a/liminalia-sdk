/**
 * キャラクターの画面の、表情ごとの使った回数・メモ・cast.json の変更履歴・立ち絵の動き（Live2D のモデル）を、lim studio の画面で操作して確かめる。
 *   npx tsx packages/studio/dev/verify-cast.ts <スクリーンショットの置き場所> [ポート（既定 5316）]
 * ひな形（templates/default）を一時フォルダに写し、使っていない差分を一つ足して開く。リポジトリのひな形は書き換えない。
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-verify-cast"));
mkdirSync(shots, { recursive: true });
const port = Number(process.argv[3] ?? 5316);
const url = `http://localhost:${port}${STUDIO_PAGE}`;

const project = mkdtempSync(join(tmpdir(), "liminalia-verify-cast-"));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
const castPath = join(project, "cast.json");
// 使っていない差分（normal の写し）
{
  const raw = JSON.parse(readFileSync(castPath, "utf8")) as { cast: Record<string, { appearances: Record<string, { variants: Record<string, unknown> }> }> };
  const variants = raw.cast["アカリ"]!.appearances["default"]!.variants;
  variants["sleepy"] = structuredClone(variants["normal"]);
  writeFileSync(castPath, `${JSON.stringify(raw, null, 2)}\n`);
}
const original = readFileSync(castPath, "utf8");
// 立ち絵の動きで選ぶ Live2D のモデル（公式のプラグイン live2d のテストの偽のモデル。プラグインは入れない）
cpSync(resolve(import.meta.dirname, "../../../plugins/live2d/test/fixtures/model"), join(project, "assets/fgimage/l2d"), { recursive: true });

const server = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/bin/lim.mjs"), "studio", project, "--port", String(port)], { stdio: "ignore", env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
for (let i = 0; ; i++) {
  if (await fetch(url).then((r) => r.ok).catch(() => false)) break;
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

/** cond が真になるまで待つ（開発サーバーが忙しいと書き込みが遅れる）。 */
async function until(cond: () => boolean, ms = 8000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (cond()) return true;
  return cond();
}

const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
await context.addInitScript('localStorage.setItem("liminalia.studio.tourDone", "1")');
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/favicon|404|409|autoplay/i.test(m.text()) && errors.push(m.text()));
await page.goto(url);
await page.waitForSelector(".cm-content", { state: "attached" });
await page.waitForTimeout(1500);

// 1. 表情ごとの使った回数と、使っていない表情
await page.keyboard.press("Control+4");
await page.waitForSelector(".chars-variant");
await page.locator(".chars-list button", { hasText: "アカリ" }).first().click();
await page.waitForTimeout(500);
const tile = (name: string) => page.locator(".chars-variant", { has: page.locator(".chars-variant-name", { hasText: new RegExp(`^${name}$`) }) });
const smile = (await tile("smile").locator(".chars-soft").textContent()) ?? "";
expect("使った差分に回数が出る", /\d+ 回/.test(smile), smile);
expect("使っていない差分は未使用と出て、薄くなる", ((await tile("sleepy").locator(".chars-soft").textContent()) ?? "").includes("未使用") && (await tile("sleepy").getAttribute("class"))!.includes("is-unused"));
expect("標準の差分は未使用と出さない", !(await tile("normal").getAttribute("class"))!.includes("is-unused"));
expect("見出しに未使用の数", ((await page.locator(".chars-unused-count").textContent()) ?? "").includes("未使用 1"));
await page.screenshot({ path: join(shots, "01-cast-counts.png") });

// 2. メモ（制作画面の共有するデータ .liminalia/shared.json の castNotes。cast.json には書かない）
await page.locator(".chars-memo").fill("声: 未定\n口癖は「……っ」");
await page.locator(".chars-memo").blur();
const statePath = join(project, ".liminalia/shared.json");
const readState = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {}) as { castNotes?: Record<string, string> };
await until(() => readState().castNotes?.["アカリ"] !== undefined);
const state = readState();
expect("メモは制作画面の覚え書きに置く", state.castNotes?.["アカリ"] === "声: 未定\n口癖は「……っ」", state.castNotes);
expect("cast.json は変えない", readFileSync(castPath, "utf8") === original);
await page.locator(".chars-list button", { hasText: "ソウ" }).first().click();
await page.locator(".chars-list button", { hasText: "アカリ" }).first().click();
expect("選び直してもメモが残る", (await page.locator(".chars-memo").inputValue()) === "声: 未定\n口癖は「……っ」");
await page.screenshot({ path: join(shots, "02-cast-note.png") });

// 3. 変更履歴: 名前の色を変えて（前の内容が変更履歴に残る）、見比べてから戻す
const color = page.locator(".chars-field", { hasText: "名前の色" }).locator("input").first();
await color.evaluate((el: HTMLInputElement) => {
  el.value = "#123456";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
});
expect("色を書いた", await until(() => readFileSync(castPath, "utf8").includes("#123456")));
await page.locator(".chars-history").click();
await page.waitForSelector(".history-item");
await page.waitForSelector(".history-diff");
const diff = (await page.locator(".history-diff").textContent()) ?? "";
expect("変更履歴に、今との違いが出る", diff.includes("#123456"), diff.slice(0, 200));
expect("見出しは cast.json", ((await page.locator(".history-head .mono").textContent()) ?? "") === "cast.json");
await page.waitForTimeout(400);
await page.screenshot({ path: join(shots, "03-cast-history.png") });
await page.locator(".history-foot .primary").click();
await until(() => !readFileSync(castPath, "utf8").includes("#123456"));
await page.waitForTimeout(500);
expect("戻すと前の内容になる", !readFileSync(castPath, "utf8").includes("#123456") && JSON.stringify(JSON.parse(readFileSync(castPath, "utf8")).cast) === JSON.stringify(JSON.parse(original).cast));
expect("戻したことも変更履歴に残る", ((await page.locator(".history-item").count()) ?? 0) >= 2);
await page.screenshot({ path: join(shots, "04-cast-restored.png") });
await page.keyboard.press("Escape");

// 5. 立ち絵の動き: プラグインが無ければ Live2D を選んでも cast.json に書かず、プラグインが無いことを知らせる。
//    プラグインを入れてあれば、fgimage の .model3.json を model.src にする
let motion = page.locator(".chars-field", { hasText: "立ち絵の動き" }).locator("select");
const readModel = () => (JSON.parse(readFileSync(castPath, "utf8")) as { cast: Record<string, { model?: Record<string, unknown> }> }).cast["アカリ"]?.model;
expect("立ち絵の動きは、なし、揺らす、Live2D、Spine", JSON.stringify(await motion.locator("option").allTextContents()) === JSON.stringify(["なし", "揺らす", "Live2D", "Spine"]), await motion.locator("option").allTextContents());
await motion.selectOption("live2d");
expect("プラグインが無いことを知らせる", await page.waitForFunction(() => document.body.textContent?.includes("Live2D のプラグインが入っていません"), undefined, { timeout: 5000 }).then(() => true, () => false));
await page.waitForTimeout(800);
expect("プラグインが無ければ cast.json に書かず、選びを戻す", readModel() === undefined && (await motion.inputValue()) === "", { model: readModel(), value: await motion.inputValue() });
// 公式のプラグインを入れたことにする（名前だけのフォルダ。画面はプラグインの一覧の名前で見分ける）
mkdirSync(join(project, "plugins/live2d"), { recursive: true });
writeFileSync(join(project, "plugins/live2d/package.json"), JSON.stringify({ name: "liminalia-live2d", version: "0.0.0", type: "module" }));
{
  const config = JSON.parse(readFileSync(join(project, "liminalia.json"), "utf8")) as { plugins?: string[] };
  config.plugins = [...(config.plugins ?? []), "./plugins/live2d"];
  writeFileSync(join(project, "liminalia.json"), `${JSON.stringify(config, null, 2)}\n`);
}
await page.reload();
await page.waitForSelector(".cm-content", { state: "attached" });
await page.waitForTimeout(1500);
await page.keyboard.press("Control+4");
await page.waitForSelector(".chars-variant");
await page.locator(".chars-list button", { hasText: "アカリ" }).first().click();
motion = page.locator(".chars-field", { hasText: "立ち絵の動き" }).locator("select");
await motion.selectOption("live2d");
expect("Live2D のモデルを cast.json に書く", await until(() => readModel()?.src === "l2d/fake.model3.json"), readModel());
const file = page.locator(".chars-field", { hasText: "モデルのファイル" }).locator("select");
await file.waitFor();
expect("モデルのファイルに .model3.json だけが並ぶ（選んだあとは「選んでいません」を出さない）", JSON.stringify(await file.locator("option").allTextContents()) === JSON.stringify(["l2d/fake.model3.json"]), await file.locator("option").allTextContents());
await page.locator(".chars-field", { hasText: "立ち絵の動き" }).scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: join(shots, "05-cast-model.png") });
await motion.selectOption("");
expect("なしに戻すと model を消す", await until(() => readModel() === undefined), readModel());

expect("画面の誤りが無い", errors.length === 0, errors);
await browser.close();
server.kill();
rmSync(project, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nすべて ok" : `\n失敗 ${failures.length} 件: ${failures.join(" / ")}`);
process.exit(failures.length === 0 ? 0 : 1);
