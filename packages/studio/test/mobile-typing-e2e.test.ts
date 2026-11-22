import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "../../web/test/e2e/harness.ts";

describe.skipIf(!e2e)("スマホの台本編集", { timeout: 180_000 }, () => {
  let project: TestProject;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    project = await startProject({ scenario: { start: `# scene\n最初の本文。\n二行目の本文。\n@wait 1s\n${Array.from({ length: 250 }, (_, i) => `# scene_${i}\n本文 ${i}。`).join("\n")}\n@stop` } });
    browser = (await browsers())[0]!.browser;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ja-JP" });
    await context.addInitScript(() => { localStorage.setItem("liminalia.studio.tourDone", "1"); localStorage.setItem("liminalia.studio.blocks", "1"); });
    page = await context.newPage();
    await page.goto(`${project.url}__liminalia/studio?lan=1`);
    await page.waitForSelector('.blk-text[data-edit-line="2"]');
  });
  afterAll(async () => { await browser?.close(); await project?.close(); });
  it("ブロックで入力・行分割・確定でき、コードに切り替えても続けて入力できる", async () => {
    const line = page.locator('.blk-text[data-edit-line="2"]');
    await line.tap();
    if (!(await page.locator('.blk-list[contenteditable="plaintext-only"]').count())) await line.tap();
    await page.locator('.blk-list[contenteditable="plaintext-only"]').waitFor();
    await page.keyboard.press("End");
    await page.keyboard.insertText("追記");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("新しい行");
    await page.keyboard.press("Meta+Enter");
    await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text()), { timeout: 10000 }).toContain("追記\n新しい行");
    // 別のページへ移った後も入力できる（前の編集で付いた contenteditable を残さない）。
    const other = page.locator('.blk-text[data-edit-line="7"]');
    await other.scrollIntoViewIfNeeded();
    await other.tap();
    if (!(await page.locator('.blk-list[contenteditable="plaintext-only"]').count())) await other.tap();
    await page.locator('.blk-list[contenteditable="plaintext-only"]').waitFor();
    await page.keyboard.press("End");
    await page.keyboard.insertText("次の場所");
    await page.keyboard.press("Meta+Enter");
    await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text()), { timeout: 10000 }).toContain("次の場所");
    await page.evaluate(() => (window as any).__liminaliaStudioApp.debug.setBlockMode(false));
    await page.waitForSelector('.cm-content[contenteditable="true"]');
    await page.evaluate(() => {
      const ed = (window as any).__liminaliaStudioApp.debug.editor;
      const at = ed.view.state.doc.line(2).to;
      ed.view.dispatch({ changes: { from: at, insert: "コード" }, userEvent: "input.type" });
    });
    await expect.poll(() => page.evaluate(() => (window as any).__liminaliaStudioApp.debug.editor.text())).toContain("コード");
    await expect.poll(async () => (await (await page.request.get(`${project.url}__liminalia/studio/api/file?file=start`)).json()).text, { timeout: 15000 }).toContain("コード");
  });
});
