import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** 注意書き（ui.contentWarning）と表現を控えめにする設定（ui.contentFilter）を、実際のブラウザで確かめる。 */

const SCENARIO = `@bg hill_night.webp
@window show
@if (system.content_filter)
  控えめ。
@else
  そのまま。
@end
`;

describe.skipIf(!e2e)("注意書きと表現の切り替え（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a", ui: { contentWarning: { text: "この作品には暗い場面があります。" }, contentFilter: { assets: { "bgimage/hill_night.webp": "hill_morning.webp" } } } },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("注意書きは同意するまで出し、同意したら出さない。控えめにすると台本が分かれ、素材が差し替わる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(project.url);
      await p.click(".lm-gate");
      await p.waitForSelector(".lm-warning");
      expect(await p.evaluate(`document.querySelector(".lm-warning-text").textContent`), name).toBe("この作品には暗い場面があります。");
      await p.click(".lm-warning .lm-primary");
      await p.waitForSelector(".lm-title-button");
      await p.reload();
      await p.click(".lm-gate");
      await p.waitForSelector(".lm-title-button");
      expect(await p.evaluate(`!!document.querySelector(".lm-warning")`), name).toBe(false);
      // 控えめにして始める
      await p.evaluate("window.__liminalia.system.updateSettings({ contentFilter: true })");
      await p.locator(".lm-title-button").first().click();
      await p.waitForSelector(".message .text .ch");
      await p.waitForTimeout(400);
      expect(await p.evaluate(`document.querySelector(".message .text").textContent.replace("▼", "")`), name).toBe("控えめ。");
      expect(await p.evaluate(`document.querySelector(".background img").src.split("/").pop().split("?")[0]`), name).toBe("hill_morning.webp");
      await p.close();
    }
  });
});
