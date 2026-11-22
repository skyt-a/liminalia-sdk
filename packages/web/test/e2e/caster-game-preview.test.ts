import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

describe.skipIf(!e2e)("立ち絵の位置調整でゲーム画面を重ねる", { timeout: 120_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { start: "見本。" } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });
  it("作品のメッセージ画面を表示し、位置を編集でき、切り替えを覚える", async () => {
    for (const { browser } of list) {
      const page = await browser.newPage({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
      await page.goto(`${project.url}__liminalia/cast?who=${encodeURIComponent("アカリ")}`);
      await page.locator("#target:not([hidden])").waitFor();
      await page.locator("#show-game-ui").check();
      const frame = page.frameLocator("#game-overlay");
      await frame.locator(".message.visible .text").waitFor();
      expect(await frame.locator(".stage").evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
      expect(await frame.locator(".message .text").textContent()).toContain("見本");
      expect(await page.locator(".stage .grid").isVisible()).toBe(false);
      const left = page.locator("#left");
      const original = await left.inputValue();
      await left.fill("123");
      await left.dispatchEvent("input");
      expect(await page.locator("#target").evaluate((e: HTMLElement) => e.style.left)).toBe("123px");
      await left.fill(original);
      await left.dispatchEvent("input");
      await page.locator("#show-game-ui").uncheck();
      expect(await page.locator("#game-overlay").isVisible()).toBe(false);
      expect(await page.locator(".stage .grid").isVisible()).toBe(true);
      await page.locator("#show-game-ui").check();
      await page.reload();
      expect(await page.locator("#show-game-ui").isChecked()).toBe(true);
      await page.close();
    }
  });
});
