import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

describe.skipIf(!e2e)("台詞を目立たせる", { timeout: 120_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: "# a\n本文。\n@stop\n" } });
    list = await browsers();
  }, 60_000);
  afterAll(async () => {
    await project?.close();
    for (const b of list ?? []) await b.browser.close();
  });

  it("名前と説明で操作が分かり、元に戻せる", async () => {
    for (const { browser } of list) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "ja-JP" });
      await page.addInitScript(() => {
        localStorage.setItem("liminalia.studio.tourDone", "1");
        localStorage.setItem("liminalia.studio.blocks", "1");
      });
      await page.goto(`${project.url}__liminalia/studio?file=start&line=27`);
      const row = page.locator(".blk-text-row.is-say").first();
      await row.waitFor({ state: "visible" });
      await row.hover();
      const button = row.locator(".blk-focus-toggle");
      expect(await button.textContent()).toBe("台詞を目立たせる");
      expect(await button.getAttribute("title")).toContain("以外の行を薄く");
      const text = async () => page.evaluate(() => (window as any).__liminaliaStudioApp.editor.text());
      const before = await text();
      await button.click();
      expect(await button.textContent()).toBe("表示を元に戻す");
      expect(await button.getAttribute("aria-pressed")).toBe("true");
      expect(await page.locator(".blk-focus-bar").isVisible()).toBe(true);
      expect(Number(await page.locator(".blk-line-row:not(.is-focus-speaker):not(.blk-label)").first().evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(1);
      await button.click();
      expect(await button.textContent()).toBe("台詞を目立たせる");
      expect(await page.locator(".blk-focus-bar").isVisible()).toBe(false);
      expect(await text()).toBe(before);
      await page.close();
    }
  });
});
