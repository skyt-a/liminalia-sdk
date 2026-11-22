/**
 * プロジェクトの画面の「翻訳」を、lim studio と同じ開発サーバーをブラウザで開いて確かめる。
 *   npx tsx packages/studio/dev/verify-i18n.ts [スクリーンショットの置き場所]
 * - 日本語と英語以外の言語では、システム画面の文言（ui。英語の原文つき）も本文の訳と同じ並びに出し、書くと lang/<言語>.json の ui に入る
 * - 訳したあとで原文が変わった訳（translatedFrom）は、訳したときの原文を添え、「原文が変わった訳」で絞れ、「この訳のまま」で外せる
 * ひな形（templates/default）を一時フォルダに写して使う。結果は一行ずつ「OK」か「NG」で出す（NG でも終了コードは 0）。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadProject } from "@liminalia/project";
import { chromium } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { startPlayerServer } from "../../cli/src/web.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "liminalia-verify-i18n"));
mkdirSync(shots, { recursive: true });
const project = mkdtempSync(join(tmpdir(), "liminalia-verify-i18n-"));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
// 固定の行 ID の行と、訳したあとで原文を書き換えた訳
writeFileSync(join(project, "scenario", "idline.lim"), "# idline\n　新しい原文の行。 #line:a1b2c3d4\n");
const configPath = join(project, "liminalia.json");
writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")), languages: ["ja", "fr"] }, null, 2));
mkdirSync(join(project, "lang"), { recursive: true });
writeFileSync(join(project, "lang", "fr.json"), JSON.stringify({ language: "fr", lines: { "idline:l@a1b2c3d4": { source: "　新しい原文の行。", text: "Ancienne traduction.", translatedFrom: "　古い原文の行。" } } }, null, 2));
const fr = () => JSON.parse(readFileSync(join(project, "lang", "fr.json"), "utf8")) as { lines?: Record<string, { text: string; translatedFrom?: string }>; ui?: Record<string, string | { text: string }> };

const { server, url: playerUrl } = await startPlayerServer(loadProject(project), 0, true);
const base = playerUrl.replace(/\/$/, "");
const results: string[] = [];
const ok = (name: string, cond: boolean, detail: unknown = "") => {
  const line = `${cond ? "OK  " : "NG  "} ${name}${!cond && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`;
  results.push(line);
  console.log(line);
};
async function until(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ja-JP" });
  await context.addInitScript('localStorage.setItem("liminalia.studio.tourDone", "1")');
  const page = await context.newPage();
  await page.goto(`${base}${STUDIO_PAGE}`);
  await page.waitForSelector(".cm-content, .blk", { timeout: 60_000 });
  await page.locator(".topbar .proj").click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(shots, "i18n-project.png") });
  await page.locator(".proj-bar .seg", { hasText: "翻訳" }).click({ timeout: 10_000 });
  await page.waitForSelector(".proj-lines .proj-line", { timeout: 15_000 });
  // 原文が変わった訳
  const changedFilter = page.locator(".proj-section-head .seg", { hasText: "原文が変わった訳" });
  ok("原文が変わった訳があれば、それに絞る分け方を出す", (await changedFilter.count()) === 1);
  await changedFilter.click();
  const rows = page.locator(".proj-lines .proj-line");
  ok("原文が変わった訳だけに絞り、訳したときの原文を添える", (await rows.count()) === 1 && ((await rows.first().textContent()) ?? "").includes("古い原文の行"), await rows.allTextContents());
  await page.screenshot({ path: join(shots, "i18n-changed.png") });
  await rows.first().locator(".proj-previous button").click();
  ok("「この訳のまま」で translatedFrom を外して保存する", await until(() => fr().lines?.["idline:l@a1b2c3d4"]?.translatedFrom === undefined && fr().lines?.["idline:l@a1b2c3d4"]?.text === "Ancienne traduction."), fr().lines);
  // システム画面の文言（シナリオの訳とは分けて数え、「システム画面」の分け方で並べる）
  const counts = (await page.locator(".proj-lang button").first().textContent()) ?? "";
  ok("訳した数は、シナリオとシステム画面の文言を分けて出す", /シナリオ \d+ \/ \d+/.test(counts) && /システム画面 \d+ \/ \d+/.test(counts), counts);
  await page.locator(".proj-kinds .seg", { hasText: "システム画面" }).click();
  await page.locator(".proj-section-head .seg", { hasText: "すべて" }).click();
  await page.locator(".proj-search").fill("title.");
  await page.waitForTimeout(400);
  const ui = page.locator(".proj-lines .proj-line", { hasText: "システム画面の文言" });
  ok("日本語と英語以外の言語では、システム画面の文言を英語の原文つきで並べる", (await ui.count()) > 0, await page.locator(".proj-lines").textContent());
  const first = ui.first();
  const key = ((await first.locator(".proj-line-head .mono").textContent()) ?? "").trim();
  await first.locator("textarea").fill("Commencer");
  ok("システム画面の文言の訳を書くと lang/fr.json の ui に入る", await until(() => {
    const v = fr().ui?.[key];
    return (typeof v === "string" ? v : v?.text) === "Commencer";
  }), { key, ui: fr().ui?.[key] });
  await page.screenshot({ path: join(shots, "i18n-ui.png") });
} finally {
  await browser.close();
  await server.close();
  rmSync(project, { recursive: true, force: true });
}
console.log(`\n${results.filter((r) => r.startsWith("NG")).length} 件の NG`);
