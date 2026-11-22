/**
 * プラグイン（標準の命令）が形を宣言した作品のデータの、自動のフォームを lim studio の画面で操作して確かめる。
 *   npx tsx packages/studio/dev/verify-data.ts <スクリーンショットの置き場所> [ポート（既定 5391）]
 * ひな形（templates/default）を一時フォルダに写し、調べる場所のデータを足して開く。リポジトリのひな形は書き換えない。
 * 確かめること: 「データ」の欄に並ぶ・背景の上の板に場所が出る・板を引いて場所を足す・欄を書くと少し待って保存する・
 * ほかで書き換えられていたら三方向に合わせる・シーンの名前を変えるとデータの飛び先も書き換わる・無いデータを作れる
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { STUDIO_API, STUDIO_PAGE } from "../src/protocol.ts";
import { autoConfirm } from "./confirm-auto.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-verify-data"));
mkdirSync(shots, { recursive: true });
const port = Number(process.argv[3] ?? 5391);
const url = `http://localhost:${port}${STUDIO_PAGE}`;

const project = mkdtempSync(join(tmpdir(), "liminalia-verify-data-"));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
writeFileSync(join(project, "scenario/room.lim"), "@investigate room\n調べ終えた。\n@stop\n# window\n窓だ。\n# shelf\n本棚だ。\n");
mkdirSync(join(project, "data"), { recursive: true });
const dataPath = join(project, "data/investigation.json");
const initial = {
  places: {
    room: {
      title: "部屋",
      file: "room",
      views: [{ id: "main", label: "部屋", background: "hill_dusk.webp", spots: [{ id: "window", label: "窓", rect: { x: 100, y: 100, width: 300, height: 200 }, target: "#window" }] }],
    },
  },
};
writeFileSync(dataPath, `${JSON.stringify(initial, null, 2)}\n`);
const read = () => JSON.parse(readFileSync(dataPath, "utf8")) as typeof initial & { places: { room: { views: { spots: { id: string; label: string; target: string }[] }[] } } };

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
  console.log(`${ok ? "ok  " : "NG  "} ${label}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(label);
};
try {
  const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
  await context.addInitScript('localStorage.setItem("liminalia.studio.tourDone", "1")');
  await autoConfirm(context, () => true);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|404|409|autoplay/i.test(m.text()) && errors.push(m.text()));
  await page.goto(url);
  await page.waitForSelector(".cm-content", { state: "attached" });
  await page.waitForTimeout(1500);
  await page.keyboard.press("Control+8");
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, "00-plugins.png") });
  const info = await page.evaluate(`fetch("${STUDIO_API}/project").then((r) => r.json()).then((p) => (p.data ?? []).map((d) => d.decl.file))`);
  console.log("data", info);
  const groups = await page.locator(".plg-group-name").allTextContents();
  expect("「データ」の欄に宣言のあるデータが並ぶ", groups.includes("データ") && (await page.locator(".plg-nav", { hasText: "図鑑" }).count()) > 0, groups);
  await page.locator(".plg-side .plg-nav", { hasText: "調べる場所" }).click();
  await page.waitForSelector(".dform-view .dform-body");
  // 入れ子を開く（場所 room → 視点 → 部屋）。開いた印は画面が覚え、描き直しても開いたまま
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => document.querySelectorAll<HTMLDetailsElement>(".dform-view details:not([open])").forEach((d) => (d.open = true)));
    await page.waitForTimeout(150);
  }
  await page.waitForSelector(".dform-board .dform-box", { timeout: 10_000 });
  expect("背景の上の板に場所の矩形が出る", (await page.locator(".dform-board .dform-box").count()) === 1 && (await page.locator(".dform-board-bg").count()) === 1);
  await page.screenshot({ path: join(shots, "01-form.png") });
  // 板の空いたところを引いて場所を足す
  await page.locator(".dform-board").scrollIntoViewIfNeeded();
  const board = (await page.locator(".dform-board").boundingBox())!;
  await page.mouse.move(board.x + board.width * 0.7, board.y + board.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(board.x + board.width * 0.85, board.y + board.height * 0.75, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const added = read().places.room.views[0]!.spots;
  expect("板を引いて場所を足し、少し待って保存する", added.length === 2 && added[1]!.id === "item2", added);
  await page.screenshot({ path: join(shots, "02-added.png") });
  // 書いている途中にほかで書き換えられたら、三方向に合わせる
  const label = page.locator(".dform-row").filter({ has: page.locator(".dform-label", { hasText: /^見出し\*?$/ }) }).locator("input").last();
  await label.fill("棚の上");
  const external = read();
  external.places.room.title = "ほかで変えた題";
  writeFileSync(dataPath, `${JSON.stringify(external, null, 2)}\n`);
  await page.waitForTimeout(2500);
  const merged = read();
  expect("ほかの変更と合わせて保存する", merged.places.room.title === "ほかで変えた題" && merged.places.room.views[0]!.spots.some((s) => s.label === "棚の上"), merged.places.room);
  // シーンの名前を変えると、データの飛び先も書き換わる
  const r = await fetch(`http://localhost:${port}${STUDIO_API}/labels/rename`, { method: "POST", headers: { "content-type": "application/json", "x-liminalia-studio": "1" }, body: JSON.stringify({ file: "room", from: "window", to: "window_side" }) }).then((x) => x.json() as Promise<{ data?: string[] }>);
  expect("シーンの名前を変えるとデータの飛び先も書き換える", read().places.room.views[0]!.spots[0]!.target === "#window_side" && (r.data ?? []).includes("investigation.json"), r);
  // 無いデータ（図鑑）は「作る」で作れる
  await page.locator(".plg-side .plg-nav", { hasText: "図鑑" }).click();
  await page.waitForTimeout(500);
  await page.locator('.dform-view:visible button.primary', { hasText: "作成" }).click();
  await page.waitForTimeout(1500);
  let codex: unknown = null;
  try {
    codex = JSON.parse(readFileSync(join(project, "data/codex.json"), "utf8"));
  } catch {
    codex = null;
  }
  expect("無いデータを作れる", !!codex && typeof codex === "object", codex);
  await page.screenshot({ path: join(shots, "03-codex.png") });
  expect("画面の誤りが無い", errors.length === 0, errors);
} finally {
  await browser.close();
  server.kill();
  rmSync(project, { recursive: true, force: true });
}
console.log(failures.length === 0 ? "\nすべて ok" : `\n失敗 ${failures.length} 件: ${failures.join(" / ")}`);
process.exit(failures.length === 0 ? 0 : 1);
