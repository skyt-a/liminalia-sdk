import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

describe.skipIf(!e2e)("コード表示の部品欄", { timeout: 120_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: "# a\n最初の行。\n次の行。\n@stop\n" } });
    list = await browsers();
  }, 60_000);
  afterAll(async () => {
    await project?.close();
    for (const b of list ?? []) await b.browser.close();
  });

  it("コードへドラッグし、取り消せる。書き方の例はコード表示だけ", async () => {
    for (const { browser } of list) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, locale: "ja-JP" });
      await page.addInitScript(() => {
        localStorage.setItem("liminalia.studio.tourDone", "1");
        localStorage.setItem("liminalia.studio.blocks", "0");
        localStorage.setItem("liminalia.studio.closedPanels", '["flow"]');
      });
      await page.goto(`${project.url}__liminalia/studio`);
      await page.waitForSelector(".blk", { timeout: 30_000 });
      if (!(await page.locator(".blk-palette").isVisible())) {
        throw new Error(`palette hidden: ${await page.locator(".blk").getAttribute("class")}`);
      }
      const palette = page.locator(".blk-palette");
      const part = palette.locator(".blk-sec-common .blk-part", { hasText: "背景" }).first();
      await part.waitFor({ state: "visible" });
      await part.hover();
      await page.locator(".part-card-example").waitFor({ state: "visible" });
      const editor = page.locator(".cm-content");
      await editor.waitFor({ state: "visible" });
      const before = await editor.innerText();
      await part.dragTo(page.locator(".cm-line").first());
      await expect.poll(async () => await editor.innerText()).not.toBe(before);
      expect(await editor.innerText()).toContain("@bg");
      await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
      await expect.poll(async () => await editor.innerText()).toBe(before);
      await page.getByRole("button", { name: "ブロック", exact: true }).click();
      await part.hover();
      await page.locator(".part-card:not([hidden])").waitFor();
      expect(await page.locator(".part-card-example").count()).toBe(0);
      await page.close();
    }
  });
});
