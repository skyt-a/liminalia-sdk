/**
 * 英語の表示の制作画面に残る日本語を洗い出す（開発用。結果は一行ずつ「画面: 文字」で出す）。
 *   npx tsx packages/studio/dev/survey-en.ts <スクリーンショットの置き場所> [ポート（既定 5391）] [作品のフォルダ（既定は英語の白紙の作品を作る）]
 * 主な画面（編集・点検・作品・各タブ・キャラクターの位置・ゲームの設定の見本）を開いて撮り、見えている文字のうち日本語の字を含むものを集める。
 * 作品の中身（台本の文・話者の名前）は数えない。終わったらサーバーを止める。
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Frame, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-survey-en"));
mkdirSync(shots, { recursive: true });
const port = Number(process.argv[3] ?? 5391);
const base = `http://localhost:${port}`;
const url = `${base}${STUDIO_PAGE}`;
const lim = resolve(import.meta.dirname, "../../cli/bin/lim.mjs");

let project = process.argv[4] ? resolve(process.argv[4]) : "";
let made = "";
if (!project) {
  made = mkdtempSync(join(tmpdir(), "liminalia-survey-en-"));
  project = join(made, "starlit");
  const r = spawnSync(process.execPath, [lim, "new", project, "--blank", "--lang", "en", "--title", "Starlit Hill"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  appendFileSync(join(project, "scenario/start.lim"), ["Wait… is that you?", "@choice", "  - Go home -> #home", "  - Stay -> #home", "@end", "", "# home", "The end.", ""].join("\n"));
}

if (await fetch(url).then((r) => r.ok).catch(() => false)) throw new Error(`ポート ${port} はほかで使われています`);
const server = spawn(process.execPath, [lim, "studio", project, "--port", String(port)], { stdio: "ignore", env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
process.on("exit", () => {
  server.kill();
  if (made) rmSync(made, { recursive: true, force: true });
});
for (let i = 0; ; i++) {
  if (await fetch(url).then((r) => r.ok).catch(() => false)) break;
  if (i > 120) throw new Error("lim studio が起動しません");
  await new Promise((r) => setTimeout(r, 500));
}

const JA = /[぀-ヿ㐀-鿿！-｠]/;
const found = new Map<string, Set<string>>();
const errors: string[] = [];

/** 見えている文字（と title・placeholder・aria-label）のうち日本語の字を含むもの。 */
async function japanese(target: Page | Frame, root = "body"): Promise<string[]> {
  return target.evaluate(
    ([sel, src]) => {
      const re = new RegExp(src);
      const out = new Set<string>();
      const rootEl = document.querySelector(sel);
      if (!rootEl) return [];
      for (const el of [rootEl, ...rootEl.querySelectorAll("*")]) {
        const e = el as HTMLElement;
        if (e.closest(".cm-content, .cm-gutters, iframe")) continue;
        if (e.offsetParent === null && e.tagName !== "OPTION" && e.tagName !== "BODY") continue;
        for (const attr of ["title", "placeholder", "aria-label"]) {
          const v = e.getAttribute(attr);
          if (v && re.test(v)) out.add(`[${attr}] ${v}`);
        }
        for (const c of e.childNodes) if (c.nodeType === 3 && re.test(c.textContent ?? "")) out.add(c.textContent!.trim());
      }
      return [...out];
    },
    [root, JA.source] as const,
  );
}
const note = (where: string, items: string[]) => {
  const set = found.get(where) ?? new Set<string>();
  for (const i of items) set.add(i);
  found.set(where, set);
};

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
try {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 900 } });
  await context.addInitScript(`localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "1")`);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => void d.dismiss());
  await page.goto(`${url}?lang=en`);
  await page.waitForSelector(".cm-content", { state: "attached" });
  await page.waitForTimeout(2500);
  const app = <T>(code: string) => page.evaluate(`(() => { const s = window.__liminaliaStudioApp; ${code} })()`) as Promise<T>;

  await page.screenshot({ path: join(shots, "desk.png") });
  note("desk", await japanese(page));

  const ids = await app<string[]>("return s.views.ids");
  for (const id of ["check", "project", ...ids]) {
    await app(`s.setSurface(${JSON.stringify(id)})`);
    await page.waitForTimeout(id === "check" ? 4000 : 2500);
    await page.screenshot({ path: join(shots, `view-${id}.png`) });
    note(id, await japanese(page));
    // 画面の中の切り替え（設定・台詞・位置など）も開く
    const segs = page.locator(`[data-view="${id}"]:not([hidden]) .seg, .check-surface:not([hidden]) .seg`);
    const count = await segs.count();
    for (let i = 0; i < count; i++) {
      const seg = segs.nth(i);
      if (!(await seg.isVisible())) continue;
      const name = ((await seg.textContent()) ?? String(i)).trim();
      await seg.click().catch(() => undefined);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(shots, `view-${id}-${i}.png`) });
      note(`${id}/${name}`, await japanese(page));
    }
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      if (!/__liminalia\/cast|ui-preview/.test(f.url())) continue;
      await f.waitForTimeout(1500);
      note(`${id} frame ${new URL(f.url()).pathname}${new URL(f.url()).search}`, await japanese(f).catch(() => []));
    }
  }
  await app(`s.setSurface("desk")`);
  await page.waitForTimeout(800);
  // パーツの欄の地の文と台詞の札
  if (!(await page.locator(".blk-search").isVisible())) await page.locator('.panel-rail[data-panel="parts"]').click().catch(() => undefined);
  await page.waitForTimeout(500);
  // 閉じている区切りと「詳しい命令」を開く
  for (let i = 0; i < 30; i++) {
    const closed = page.locator('.blk-sec-head[aria-expanded="false"]');
    if ((await closed.count()) === 0) break;
    await closed.first().click();
    await page.waitForTimeout(100);
  }
  for (const more of await page.locator(".blk-advanced").all()) await more.click().catch(() => undefined);
  await page.waitForTimeout(300);
  note("parts", await japanese(page, ".blk-palette, .blk-parts, body"));
  for (const label of await page.locator(".blk-part").allTextContents()) if (label.length > 18) console.log(`LONG PART ${label}`);
  await page.screenshot({ path: join(shots, "parts.png") });
  // 地の文のパーツを足す
  await page.locator(".blk-part", { hasText: /^Narration$/ }).first().dblclick();
  await page.waitForTimeout(800);
  await page.keyboard.type("Added narration.");
  await page.screenshot({ path: join(shots, "parts-typing.png") });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const doc = await app<string>("return s.debug.editor.state.doc.toString()");
  console.log(`DOC ${JSON.stringify(doc)}`);
  await page.screenshot({ path: join(shots, "parts-added.png") });
} finally {
  await browser.close();
}
for (const [where, items] of found) for (const i of items) console.log(`${where}: ${i}`);
for (const e of errors) console.log(`ERROR ${e}`);
process.exit(0);
