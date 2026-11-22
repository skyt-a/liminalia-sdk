import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser } from "playwright-core";
import { browsers, e2e } from "../../web/test/e2e/harness.ts";

describe.skipIf(!e2e)("場面マーカーの一覧と移動", { timeout: 180_000 }, () => {
  let dir: string, url: string, server: ChildProcess;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    dir = mkdtempSync(join(tmpdir(), "liminalia-markers-"));
    cpSync(resolve(import.meta.dirname, "../../../templates/default"), dir, { recursive: true });
    writeFileSync(join(dir, "scenario/start.lim"), `// @scene date=8/27 event=奏の来訪\n本文。\n@jump second\n${Array.from({ length: 30 }, (_, i) => `// @scene 検証 ${i + 1}`).join("\n")}\n`);
    writeFileSync(join(dir, "scenario/second.lim"), "// @scene 翌日 捜索\n別の本文。\n");
    server = spawn(process.execPath, [resolve(import.meta.dirname, "../../cli/bin/lim.mjs"), "studio", dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
    url = await new Promise<string>((done, reject) => {
      let output = "";
      server.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); const match = /Studio: (\S+)/.exec(output); if (match) done(match[1]!); });
      server.on("exit", (code) => reject(new Error(`lim studio exited: ${code}\n${output}`)));
    });
  }, 120_000);
  afterAll(async () => { for (const b of list ?? []) await b.browser.close(); server?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("全ファイルのマーカーを検索して移動し、未保存の追加にも追従する", async () => {
    for (const { browser, name } of list) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.on("pageerror", (e) => console.error("pageerror:", e.message));
      await page.addInitScript(() => { localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "0"); });
      await page.goto(url);
      await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor);
      await page.locator(".toc-markers-trigger").click();
      await expect.poll(() => page.locator(".toc-marker", { hasText: "奏の来訪" }).count()).toBe(1);
      expect(await page.locator(".toc-marker", { hasText: "翌日 捜索" }).count()).toBe(1);
      await page.locator(".toc-order .seg").first().click();
      const ordered = () => page.locator(".toc-marker").filter({ hasText: /奏の来訪|翌日 捜索/ }).locator(".toc-marker-title").allTextContents();
      await expect.poll(ordered).toEqual(["翌日 捜索", "8/27 · 奏の来訪"]);
      await page.locator(".toc-order .seg").nth(1).click();
      await expect.poll(ordered).toEqual(["8/27 · 奏の来訪", "翌日 捜索"]);
      await page.locator(".toc-marker-search").fill("捜索");
      expect(await page.locator(".toc-marker").count()).toBe(1);
      await page.locator(".toc-marker").click();
      expect(await page.locator(".toc-markers").isVisible()).toBe(false);
      await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text())).toContain("翌日 捜索");
      await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.state.readOnly)).toBe(false);
      await page.locator(".toc-markers-trigger").click();
      await page.locator(".toc-marker-search").fill("");
      await page.locator(".toc-marker-add").click();
      await expect.poll(() => page.locator("dialog.scene-marker-dialog").count()).toBe(1);
      await page.locator("dialog.scene-marker-dialog input").nth(0).fill("翌週");
      await page.locator("dialog.scene-marker-dialog input").nth(1).fill(`報告${name}`);
      await page.locator("dialog.scene-marker-dialog button.primary").click();
      await page.locator(".toc-markers-trigger").click();
      await expect.poll(() => page.locator(".toc-marker", { hasText: `翌週 · 報告${name}` }).count()).toBe(1);
      expect(await page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text())).toContain(`// @scene date=翌週 event=報告${name}`);
      await page.locator(".toc-marker", { hasText: "奏の来訪" }).click();
      await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text())).toContain("奏の来訪");
      await page.locator(".toc-markers-trigger").click();
      await expect.poll(() => page.locator(".toc-marker", { hasText: `翌週 · 報告${name}` }).count()).toBe(1);
      await page.keyboard.press("Escape");
      expect(await page.locator(".toc-markers").isVisible()).toBe(false);
      await page.locator(".toc-markers-trigger").click();
      await page.locator(".toc-marker-close").click();
      expect(await page.locator(".toc-markers").isVisible()).toBe(false);
      await page.locator(".toc-markers-trigger").click();
      await page.locator(".panel-title").first().click();
      expect(await page.locator(".toc-markers").isVisible()).toBe(false);
      await page.close();
    }
  });

  it("一覧をスクロールしても閉じる操作は動かず、閉じれば領域を占めない", async () => {
    const page = await list[0]!.browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { localStorage.setItem("liminalia.studio.tourDone", "1"); });
    await page.goto(url);
    await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor);
    const listBox = page.locator(".toc-list");
    const before = await listBox.boundingBox();
    await page.locator(".toc-markers-trigger").click();
    const head = page.locator(".toc-marker-close");
    const y = (await head.boundingBox())!.y;
    await page.locator(".toc-marker-list").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    expect(await page.locator(".toc-marker-list").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect((await head.boundingBox())!.y).toBe(y);
    expect((await listBox.boundingBox())!.height).toBe(before!.height);
    await head.click();
    expect(await page.locator(".toc-markers").isVisible()).toBe(false);
    await page.close();
  });

  it("台本のメニューから、そのファイルのフォルダを開く要求を送る", async () => {
    const page = await list[0]!.browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { localStorage.setItem("liminalia.studio.tourDone", "1"); });
    const calls: unknown[] = [];
    await page.route("**/__liminalia/studio/api/files/reveal", async (route) => {
      calls.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    });
    // はじめは start を開く（ファイルのタブは二つ開いてから出る。前のテストが最後に開いたファイルは、制作画面が次に開くファイルとして覚えている）
    const start = new URL(url);
    start.searchParams.set("file", "start");
    await page.goto(start.href);
    await page.waitForFunction(() => !!(window as any).__liminaliaStudioApp?.debug?.editor);
    await page.locator('.toc-file[data-file="second"] .toc-file-more').click();
    await page.getByRole("menuitem", { name: /フォルダを開く|Open containing folder/ }).click();
    expect(calls).toEqual([{ file: "second" }]);
    await page.locator('.toc-file[data-file="second"] .toc-file-name').click();
    await page.locator('.file-tab[data-file="second"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: /フォルダを開く|Open containing folder/ }).click();
    expect(calls).toEqual([{ file: "second" }, { file: "second" }]);
    await page.close();
  });

});
