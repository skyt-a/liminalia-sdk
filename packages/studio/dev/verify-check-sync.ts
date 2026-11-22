/**
 * 制作画面のチェックが lim check と同じ結果を出し、外の変更のあとで画面のどこも古いまま残らないことを、制作画面で操作して確かめる。
 *   npx tsx packages/studio/dev/verify-check-sync.ts [スクリーンショットの置き場所]
 * - POST /check の一覧（file、line、重さ、code）が lim check --json と同じ（調べる場所のデータからだけ入るシーン、訳のファイル、書式の版）
 * - 外で cast.json を直すと、再チェックを押さなくても、シナリオの見出しの問題の数、ファイル一覧の印、行の波線、タブの丸が消える
 * - タブの丸は、エラーがあれば赤、警告だけなら黄（is-warning）。書き方の提案だけなら出さない
 * - シーン一覧のメニューで、entry のファイルは「下書きにする」を押せない
 * ひな形を一時フォルダに写して開き、終わったらサーバーを止める。NG の行があっても終了の値は 0（ほかの verify と同じ。NG の行を見る）。
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@liminalia/lang";
import { loadProject } from "@liminalia/project";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { startPlayerServer } from "../../cli/src/web.ts";
import { STUDIO_API, STUDIO_PAGE } from "../src/protocol.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-check-sync-shots"));
mkdirSync(shots, { recursive: true });
const project = mkdtempSync(join(tmpdir(), "liminalia-check-sync-"));
cpSync(join(REPO, "templates/default"), project, { recursive: true });
const scenario = join(project, "scenario");
const castPath = join(project, "cast.json");
// 調べる場所（@investigate）のデータからだけ入るシーンと、cast.json に無いキャラクター（guide）を出す行
writeFileSync(
  join(scenario, "extra.lim"),
  ["# extra", "@bg hill_dusk.webp", "　書庫の前に来た。", "@chara guide normal at=center", "@investigate library", "@stop", "# shelf", "　棚を見た。", "@stop", "# done", "@chara guide smile", "　調べ終えた。", "@stop"].join("\n") + "\n",
);
mkdirSync(join(project, "data"), { recursive: true });
const rect = { x: 10, y: 10, width: 100, height: 100 };
writeFileSync(join(project, "data/investigation.json"), JSON.stringify({ places: { library: { title: "書庫", file: "extra", views: [{ id: "main", label: "書庫", background: "hill_dusk.webp", spots: [{ id: "shelf", label: "棚", rect, target: "#shelf" }] }], done: "#done" } } }));
const configPath = join(project, "liminalia.json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
writeFileSync(configPath, JSON.stringify({ ...config, format: 999, languages: ["ja", "ko"] }, null, 2));
const castBefore = readFileSync(castPath, "utf8");

const { server, url: playerUrl } = await startPlayerServer(loadProject(project), 0, true);
const url = `${playerUrl.replace(/\/$/, "")}${STUDIO_PAGE}`;
const api = `${playerUrl.replace(/\/$/, "")}${STUDIO_API}`;
const ok = (name: string, cond: boolean, detail: unknown = "") => console.log(`${cond ? "OK  " : "NG  "} ${name}${!cond && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
const brief = (list: readonly Pick<Diagnostic, "file" | "line" | "severity" | "code">[]) => list.map((d) => `${d.file}:${d.line} ${d.severity} ${d.code}`).sort();
const errors: string[] = [];
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
async function until(cond: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  for (let t = 0; t < ms; t += 250) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return cond();
}

try {
  // ---- POST /check と lim check ----
  const studioCheck = (await (await fetch(`${api}/check`, { method: "POST" })).json()) as { diagnostics: Diagnostic[] };
  const cli = spawnSync(process.execPath, [join(REPO, "packages/cli/bin/lim.mjs"), "check", project, "--json"], { cwd: REPO, encoding: "utf8" });
  const limCheck = (JSON.parse(cli.stdout) as { diagnostics: Diagnostic[] }).diagnostics;
  ok("制作画面のチェック（POST /check）と lim check の一覧が同じ", JSON.stringify(brief(studioCheck.diagnostics)) === JSON.stringify(brief(limCheck)), { studio: brief(studioCheck.diagnostics), cli: brief(limCheck) });
  ok("調べる場所のデータからだけ入るシーンを unused-label と出さない", !studioCheck.diagnostics.some((d) => d.code === "unused-label" && d.file === "extra"), brief(studioCheck.diagnostics));
  ok("訳のファイルが無いことと、書式の版を知らせる", ["missing-translation", "newer-format"].every((c) => studioCheck.diagnostics.some((d) => d.code === c)), brief(studioCheck.diagnostics));

  const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
  await context.addInitScript(`localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "0"); localStorage.setItem("liminalia.studio.tocOpen", JSON.stringify(["extra", "start"]));`);
  const page: Page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|403|404|409|autoplay|ERR_FAILED/i.test(m.text()) && errors.push(m.text()));
  await page.goto(url);
  await page.waitForSelector(".cm-content", { state: "attached" });
  await page.evaluate(`(async () => { await window.__liminaliaStudioApp.open("extra", 4); })()`);
  await page.waitForTimeout(1500);

  const header = () => page.locator(".ed-problems").first().textContent().then((t) => t ?? "");
  const squiggles = () => page.locator(".cm-content .cm-lintRange-error").count();
  const fileDot = () => page.locator('.toc-file[data-file="extra"] .problem-dot').count();
  const badge = async () => {
    const el = page.locator(".tab .badge").first();
    return { hidden: await el.evaluate((n) => (n as HTMLElement).hidden), text: (await el.textContent()) ?? "", warning: await el.evaluate((n) => n.classList.contains("is-warning")) };
  };
  ok("cast.json に無いキャラクターの行が赤い波線になる", await until(async () => (await squiggles()) > 0), await squiggles());
  ok("シナリオの見出しに問題の数が出る", /問題 \d/.test(await header()), await header());
  ok("ファイル一覧に問題の印が出る", (await fileDot()) > 0);
  const before = await badge();
  ok("エラーがあればタブの丸は赤（is-warning ではない）", !before.hidden && !before.warning, before);
  await page.screenshot({ path: join(shots, "before.png") });

  // ---- 外で cast.json を直す（guide を足す）。再チェックを押さずに、画面のどこも新しくなる ----
  const cast = JSON.parse(castBefore) as { cast: Record<string, unknown> };
  const first = Object.values(cast.cast)[0];
  // 行の様子とルート（現在地）も取り直すか（古い現在地のルートを出したままにしない）
  let sweeps = 0;
  page.on("request", (r) => {
    if (r.url().includes(`${STUDIO_API}/sweep?`)) sweeps++;
  });
  writeFileSync(castPath, JSON.stringify({ ...cast, cast: { ...cast.cast, guide: first } }, null, 2));
  ok("外で cast.json を直すと、行の赤い波線が消える", await until(async () => (await squiggles()) === 0), await squiggles());
  ok("外で cast.json を直すと、行の様子とルートを取り直す", await until(async () => sweeps > 0), sweeps);
  ok("シナリオの見出しの問題の数が新しくなる", await until(async () => !/問題 [1-9]/.test(await header()) || (await header()).includes("問題なし")), await header());
  ok("ファイル一覧の印が消える", await until(async () => (await fileDot()) === 0), await fileDot());
  const after = await badge();
  ok("エラーが無く警告だけならタブの丸は黄（is-warning）", !after.hidden && after.warning, after);
  await page.screenshot({ path: join(shots, "after-cast.png") });
  // チェックの画面の数とタブの丸がそろう
  await page.locator(".tab", { hasText: "チェック" }).first().click();
  await page.waitForTimeout(800);
  const big = (await page.locator(".check-card .check-big b").nth(0).textContent().catch(() => "")) ?? "";
  const cards = await page.locator(".check-card .check-big b").allTextContents();
  ok("チェックの画面の「問題」の数とタブの丸が同じ", cards.includes((await badge()).text), { cards, badge: await badge(), big });
  await page.screenshot({ path: join(shots, "check.png") });

  // ---- entry のファイルは下書きにできない ----
  await page.locator(".tab", { hasText: "シナリオ" }).first().click().catch(() => undefined);
  await page.waitForTimeout(500);
  await page.locator('.toc-file[data-file="start"]').click({ button: "right" });
  const draftItem = page.locator(".ctx-menu .ctx-item", { hasText: "下書きにする" });
  ok("entry のファイルのメニューの「下書きにする」は押せない", (await draftItem.count()) === 1 && (await draftItem.isDisabled()), await draftItem.count());
  await page.keyboard.press("Escape");
  await page.locator('.toc-file[data-file="extra"]').click({ button: "right" });
  const otherItem = page.locator(".ctx-menu .ctx-item", { hasText: "下書きにする" });
  ok("ほかのファイルは下書きにできる", (await otherItem.count()) === 1 && !(await otherItem.isDisabled()));
  await page.keyboard.press("Escape");
  ok("画面にエラーが出ない", errors.length === 0, errors);
} finally {
  await browser.close();
  await server.close();
  rmSync(project, { recursive: true, force: true });
}
