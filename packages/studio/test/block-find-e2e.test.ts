import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("ブロック検索の置換前の探し直し", () => {
  let dir: string;
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  let original: string;
  const editor = <T>(code: string) => page.evaluate(`(() => { const ed = window.__liminaliaStudioApp.debug.editor; ${code} })()`) as Promise<T>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-block-find-"));
    cpSync(resolve(import.meta.dirname, "../../../examples/lighthouse"), dir, { recursive: true });
    server = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/bin/lim.mjs"), "studio", dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      server.stdout!.on("data", (c: Buffer) => {
        out += c.toString();
        const m = /Studio: (\S+)/.exec(out);
        if (m) resolve(m[1]!);
      });
      server.on("exit", (code) => reject(new Error(`lim studio: ${code}\n${out}`)));
    });
    browser = await chromium.launch({ executablePath: findChromium() });
    const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
    await context.addInitScript('localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "1")');
    page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector(".cm-content", { state: "attached" });
    await page.locator(".topbar-search").click();
    await page.locator(".quick-input").fill("このファイル");
    await page.locator(".quick-list li", { hasText: "このファイルの中を置換" }).click();
    await page.locator(".blk-find:not([hidden]) .blk-find-action").first().waitFor();
    original = await editor<string>("return ed.text()");
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  for (const action of ["すべて置換", "置換して次へ"]) {
    for (const query of ["__no_match__", "", "(", "灯台"]) {
      it(`${action}: 入力直後の ${JSON.stringify(query)} の当たりだけを使う`, async () => {
        await editor(`ed.applyExternal(${JSON.stringify(original)})`);
        const find = page.locator(".blk-find:not([hidden])");
        const input = find.locator('input[type="search"]');
        const regex = find.locator('[data-flag="regex"]');
        if (await regex.getAttribute("aria-pressed") !== "true") await regex.click();
        await input.fill("。");
        await expect.poll(() => find.locator(".blk-find-count").textContent()).toMatch(/\d+ \/ \d+/);
        await find.locator('input[type="text"]').fill("REPLACED");
        // 入力とクリックを同じタスクで行い、120 ms の待ち時間を確実に残す。
        await find.evaluate((el, { query, action }) => {
          const input = el.querySelector<HTMLInputElement>('input[type="search"]')!;
          input.value = query;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          [...el.querySelectorAll<HTMLButtonElement>(".blk-find-action")].find((b) => b.textContent === action)!.click();
        }, { query, action });
        if (process.env.LIMINALIA_BLOCK_FIND_EVIDENCE && query === "__no_match__" && action === "すべて置換") {
          await page.screenshot({ path: process.env.LIMINALIA_BLOCK_FIND_EVIDENCE });
        }
        const text = await editor<string>("return ed.text()");
        if (query === "灯台" && action === "置換して次へ") {
          expect(text.match(/REPLACED/g)).toHaveLength(1);
          expect(text.replace("REPLACED", query)).toBe(original);
        } else {
          expect(text).toBe(query === "灯台" ? original.replaceAll(query, "REPLACED") : original);
        }
      });
    }
  }
});
