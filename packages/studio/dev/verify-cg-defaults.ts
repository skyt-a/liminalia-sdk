/**
 * チェックの「まとめて削除」（要らない @cg-unlock）と、ゲームの設定の「コマンドの既定値」を、lim studio と同じ開発サーバーで開いて確かめる。
 *   npx tsx packages/studio/dev/verify-cg-defaults.ts [スクリーンショットの置き場所]
 * ひな形を一時フォルダに写し、CG の一覧と要らない @cg-unlock を足して開く。リポジトリのひな形は書き換えない。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadProject } from "@liminalia/project";
import { chromium } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";
import { startPlayerServer } from "../../cli/src/web.ts";
import { STUDIO_PAGE } from "../src/protocol.ts";
import { openGameSection } from "../test/game-section.ts";
import { autoConfirm } from "./confirm-auto.ts";

const shots = resolve(process.argv[2] ?? join(tmpdir(), "cg-defaults-shots"));
mkdirSync(shots, { recursive: true });
const project = mkdtempSync(join(tmpdir(), "liminalia-studio-cg-defaults-"));
cpSync(resolve(import.meta.dirname, "../../../templates/default"), project, { recursive: true });
const configPath = join(project, "liminalia.json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
config.extra = { cg: [{ id: "night", title: "夜の丘", images: ["hill_night.webp"] }] };
writeFileSync(configPath, JSON.stringify(config, null, 2));
writeFileSync(join(project, "scenario", "cg.lim"), ["# cg", "@bg hill_night.webp time=1s", "@cg-unlock hill_night.webp", "夜の丘。", "@scene-change hill_dusk.webp time=600ms", "夕方に戻った。", ""].join("\n"));

const results: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => results.push(`${cond ? "OK  " : "NG  "} ${name}${detail ? ` — ${detail}` : ""}`);
const { server, url: playerUrl } = await startPlayerServer(loadProject(project), 0, true);
const base = playerUrl.replace(/\/$/, "");
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
try {
  // 暗い配色を先に（まとめて削除は明るい配色の回で行うので、暗い配色でも削除する前の画面を撮れる）
  for (const scheme of ["dark", "light"] as const) {
    const page = await browser.newPage({ locale: "ja-JP", viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    // コード表示で開き、はじめの案内を出さない（verify.ts と同じ）
    await page.addInitScript('localStorage.setItem("liminalia.studio.blocks", "0"); localStorage.setItem("liminalia.studio.tourDone", "1")');
    await autoConfirm(page, () => true);
    await page.goto(`${base}${STUDIO_PAGE}`);
    await page.waitForSelector(".cm-content", { timeout: 30000 });
    await page.waitForTimeout(1500);
    // チェック: 要らない @cg-unlock の件数と「まとめて削除」
    await page.keyboard.press("Control+3");
    await page.waitForSelector(".check-surface:not([hidden])", { timeout: 10000 });
    await page.locator(".check-rerun, .check-clear-actions button").first().click();
    // 暗い配色の回でコマンドの既定値（@chara の time=400ms）を足すので、明るい配色の回は「既定値と同じパラメータ」のまとめても並ぶ
    const cgFix = page.locator(".check-fix", { hasText: "@cg-unlock" });
    await cgFix.waitFor({ timeout: 15000 });
    const fixText = (await cgFix.textContent()) ?? "";
    ok(`チェック（${scheme}）: 要らない @cg-unlock の行を出す`, /要らない @cg-unlock 1 行/.test(fixText) && fixText.includes("まとめて削除"), fixText);
    await page.screenshot({ path: join(shots, `check-fix-${scheme}.png`) });
    if (scheme === "light") {
      await cgFix.locator(".check-fix-run").click();
      await cgFix.waitFor({ state: "detached", timeout: 15000 });
      const text = readFileSync(join(project, "scenario", "cg.lim"), "utf8");
      ok("まとめて削除: ファイルから @cg-unlock の行だけを消す", !text.includes("@cg-unlock") && text.includes("@bg hill_night.webp time=1s\n夜の丘。"), JSON.stringify(text.slice(0, 80)));
    }
    // ゲームの設定: コマンドの既定値
    // 欄は見出しで開いたカテゴリの分だけ出る
    await page.keyboard.press("Control+7");
    const section = await openGameSection(page, "commandDefaults");
    await section.locator("select").first().waitFor({ timeout: 15000 });
    await section.scrollIntoViewIfNeeded();
    if (scheme === "dark") {
      const [command, param] = [section.locator("select").nth(0), section.locator("select").nth(1)];
      await command.selectOption("chara");
      // 書式の版 4 で fade= は time= になった
      await param.selectOption("time");
      await section.locator("button", { hasText: "追加" }).click();
      const input = section.locator('input[aria-label="@chara time"]');
      ok("コマンドの既定値: 追加した欄に標準の既定値を薄く出す", (await input.getAttribute("placeholder")) === "0ms");
      await input.fill("400ms");
      await input.press("Tab");
      await page.waitForTimeout(800);
      const saved = JSON.parse(readFileSync(configPath, "utf8")) as { commandDefaults?: Record<string, unknown> };
      // ひな形にはもとから @scene-change の既定値がある（それは残す）
      ok("コマンドの既定値: 入れるとすぐ liminalia.json に保存する", JSON.stringify(saved.commandDefaults?.chara) === JSON.stringify({ time: "400ms" }) && JSON.stringify(saved.commandDefaults?.["scene-change"]) === JSON.stringify({ time: "1200ms" }), JSON.stringify(saved.commandDefaults));
    }
    await page.waitForTimeout(300);
    await section.screenshot({ path: join(shots, `command-defaults-${scheme}.png`) });
    // 線の太さ・文字の大きさ（12px 以上）
    const sizes = await section.evaluate((el) => [...el.querySelectorAll("*")].filter((n) => (n as HTMLElement).offsetParent !== null && n.childNodes.length > 0 && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim() !== "")).map((n) => parseFloat(getComputedStyle(n).fontSize)));
    ok(`コマンドの既定値（${scheme}）: 文字は 12px 以上`, sizes.length > 0 && Math.min(...sizes) >= 12, JSON.stringify([...new Set(sizes)]));
    await page.close();
  }
} catch (e) {
  // 例外でも、それまでの結果を出してブラウザとサーバーを閉じる
  results.push(`NG   例外: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  await browser.close();
  await server.close();
}
for (const r of results) console.log(r);
