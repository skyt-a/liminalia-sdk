import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

describe.skipIf(!e2e)("舞台の操作アイコン", { timeout: 120_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: "# a\n本文。\n@stop\n" } });
    list = await browsers();
  });
  afterAll(async () => {
    await project?.close();
    for (const b of list ?? []) await b.browser.close();
  });

  it("操作名と説明がホバーとフォーカスで出て、状態も変わる", async () => {
    for (const { browser } of list) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "ja-JP" });
      await page.addInitScript(() => localStorage.setItem("liminalia.studio.tourDone", "1"));
      await page.goto(`${project.url}__liminalia/studio`);
      await page.locator(".desk").evaluate((el: HTMLElement) => el.style.setProperty("--right-w", "340px"));
      for (const action of ["pause", "mute", "follow", "fullscreen"]) {
        const button = page.locator(`.stage-btn.stage-${action}`);
        await button.waitFor({ state: "visible" });
        expect(await button.locator("svg").count()).toBe(1);
        expect(await button.getAttribute("aria-label")).toBeTruthy();
        expect(await button.getAttribute("aria-description")).toBeTruthy();
        await button.hover();
        expect(await button.evaluate((el) => getComputedStyle(el, "::after").display)).toBe("block");
        const bounds = await button.evaluate((el) => {
          const button = el.getBoundingClientRect();
          const pane = el.closest(".right")!.getBoundingClientRect();
          const tip = getComputedStyle(el, "::after");
          const width = parseFloat(tip.width) + (tip.boxSizing === "border-box" ? 0 : parseFloat(tip.paddingLeft) + parseFloat(tip.paddingRight) + parseFloat(tip.borderLeftWidth) + parseFloat(tip.borderRightWidth));
          const left = button.left + parseFloat(tip.left);
          return { left, right: left + width, paneLeft: pane.left, paneRight: pane.right };
        });
        expect(bounds.left, action).toBeGreaterThanOrEqual(bounds.paneLeft - 1);
        expect(bounds.right, action).toBeLessThanOrEqual(bounds.paneRight + 1);
        await button.focus();
      }
      const mute = page.locator(".stage-btn.stage-mute");
      const before = await mute.getAttribute("aria-pressed");
      await mute.click();
      expect(await mute.getAttribute("aria-pressed")).not.toBe(before);
      expect(await mute.getAttribute("data-tooltip")).toContain("\n");
      expect(await page.locator(".stage-btn.stage-play").count()).toBe(0);
      const pause = page.locator(".stage-btn.stage-pause");
      expect(await pause.locator(".icon-pause").count()).toBe(1);
      await pause.click();
      expect(await pause.getAttribute("aria-pressed")).toBe("true");
      expect(await pause.locator(".icon-play").count()).toBe(1);
      await pause.click();
      expect(await pause.getAttribute("aria-pressed")).toBe("false");
      expect(await pause.locator(".icon-pause").count()).toBe(1);
      await page.close();
    }
  });

  it("変数は初めに閉じ、開閉と現在地の更新で状態を保つ", async () => {
    for (const { browser } of list) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "ja-JP" });
      await page.addInitScript(() => {
        localStorage.setItem("liminalia.studio.tourDone", "1");
        localStorage.setItem("liminalia.studio.blocks", "0");
      });
      await page.goto(`${project.url}__liminalia/studio?file=start&line=27`);
      const toggle = page.locator(".facts-vars-toggle");
      await toggle.waitFor({ state: "visible", timeout: 60_000 });
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      expect(await page.locator(".facts-vars-body").isVisible()).toBe(false);
      expect(await page.locator(".facts-stage").isVisible()).toBe(true);
      await toggle.click();
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      expect(await page.locator(".facts-vars-body").isVisible()).toBe(true);
      await page.locator(".cm-content").click();
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(600);
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      await toggle.click();
      expect(await page.locator(".facts-vars-body").isVisible()).toBe(false);
      await page.close();
    }
  });
});
