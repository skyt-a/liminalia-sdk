import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser } from "playwright-core";
import { browsers, e2e } from "../../web/test/e2e/harness.ts";

describe.skipIf(!e2e)("コード表示の選択", { timeout: 180_000 }, () => {
  let dir: string, url: string, server: ChildProcess;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    dir = mkdtempSync(join(tmpdir(), "liminalia-selection-"));
    cpSync(resolve(import.meta.dirname, "../../../templates/default"), dir, { recursive: true });
    writeFileSync(join(dir, "scenario/start.lim"), `長い行です。${"折り返す文章が続きます。".repeat(12)}\n短い行です。\n三行目の選択された文章。\n@wait 1s\n# middle\n@unknown-command\n// @scene date=翌日 event=捜索\n本文です。\n# last\n最後。\n`);
    server = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/bin/lim.mjs"), "studio", dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
    url = await new Promise<string>((done, reject) => {
      let output = "";
      server.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); const match = /Studio: (\S+)/.exec(output); if (match) done(match[1]!); });
      server.on("exit", (code) => reject(new Error(`lim studio exited: ${code}\n${output}`)));
    });
  }, 120_000);
  afterAll(async () => { for (const b of list ?? []) await b.browser.close(); server?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("折り返しを含む複数行で、描画用の選択とネイティブの選択が重ならない", async () => {
    for (const { browser, name } of list) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
      await page.addInitScript(() => { localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "0"); });
      await page.goto(url);
      await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor);
      await page.evaluate(() => {
        const ed = (window as any).__liminaliaStudioApp.debug.editor;
        ed.view.focus();
        ed.view.dispatch({ selection: { anchor: ed.state.doc.line(1).from + 3, head: ed.state.doc.line(3).to - 2 } });
      });
      await page.waitForFunction(() => (window.getSelection()?.toString().length ?? 0) > 0);
      const actual = await page.locator(".cm-editor").evaluate((root) => {
        const content = root.querySelector(".cm-content")!;
        const line = content.querySelector(".cm-line")!;
        const selected = root.querySelectorAll(".cm-selectionLayer .cm-selectionBackground");
        return { line: getComputedStyle(line, "::selection").backgroundColor, selectionLayers: selected.length, focused: root.classList.contains("cm-focused"), selected: window.getSelection()?.toString() ?? "" };
      });
      expect(actual.line, name).not.toBe("rgba(0, 0, 0, 0)");
      expect(actual.selectionLayers, name).toBe(0);
      expect(actual.focused, name).toBe(true);
      expect(actual.selected, name).toContain("短い行です");
      const before = await page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text());
      await page.keyboard.insertText("置換");
      await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text())).not.toBe(before);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
      await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text())).toBe(before);
      await page.close();
    }
  });

  it("問題の内訳と文字数の範囲を表示し、問題の行へ移る", async () => {
    for (const { browser } of list) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript(() => { localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "0"); });
      await page.goto(url);
      await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor);
      await expect.poll(() => page.locator(".ed-problems").textContent()).toMatch(/1/);
      await page.locator(".ed-problems").hover();
      await expect.poll(() => page.locator(".ed-status-popover:visible .ed-problem-item").count()).toBe(1);
      expect(await page.locator(".ed-status-popover:visible").innerText()).toContain("unknown-command");
      const fits = await page.locator(".ed-problem-item").evaluate((item) => { const text = item.querySelector(".ed-problem-body")!.getBoundingClientRect(); const box = item.getBoundingClientRect(); return text.bottom <= box.bottom; });
      expect(fits).toBe(true);
      await page.locator(".ed-status-popover:visible .ed-problem-item").click();
      await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.cursorLine())).toBe(6);
      await page.locator(".ed-chars").click();
      const details = page.locator(".ed-status-popover:visible");
      await expect.poll(() => details.innerText()).toMatch(/5[〜–]8/);
      expect(await details.innerText()).toContain("#middle");
      await page.keyboard.press("Escape");
      expect(await page.locator(".ed-status-popover:visible").count()).toBe(0);
      await page.locator(".ed-chars").click();
      await page.locator(".ed-status-popover:visible .ed-status-popover-close").click();
      expect(await page.locator(".ed-status-popover:visible").count()).toBe(0);
      await page.evaluate(() => { const app = (window as any).__liminaliaStudioApp; app.debug.setBlockMode(true); app.debug.editor.gotoLine(1); });
      await page.locator(".ed-problems").click();
      await page.locator(".ed-status-popover:visible .ed-problem-item").click();
      await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.cursorLine())).toBe(6);
      await expect.poll(() => page.locator('.blk-line-row.on[data-from="6"]').count()).toBe(1);
      await page.close();
    }
  });
});
