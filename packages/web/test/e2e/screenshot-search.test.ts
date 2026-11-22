import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/** スクリーンショット（ブラウザ版は舞台の絵を PNG で保存させる）と、履歴を探すを、実際のブラウザで確かめる。 */

const SCENARIO = `@bg hill_night.webp
@window show
ソウ「星が見える」
アカリ「きれいだね」
ソウ「流れ星だ」
`;

describe.skipIf(!e2e)("スクリーンショットと履歴を探す（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("スクリーンショットは舞台の大きさの PNG を保存させ、履歴は話者と本文で絞り込める", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(400);
      const [download] = await Promise.all([p.waitForEvent("download"), p.evaluate("void window.__liminalia.system.perform('screenshot')")]);
      expect(download.suggestedFilename(), name).toMatch(/\.png$/);
      for (let i = 0; i < 2; i++) {
        await p.evaluate("window.__liminalia.host.advance()");
        await p.waitForTimeout(80);
        await p.evaluate("window.__liminalia.host.advance()");
        await p.waitForTimeout(250);
      }
      await p.evaluate("void window.__liminalia.system.perform('backlog')");
      await p.waitForSelector(".lm-log-search");
      await p.fill(".lm-log-search", "星");
      expect(await p.evaluate(`[...document.querySelectorAll(".lm-log-entry:not([hidden]) .lm-log-text")].map((e) => e.textContent)`), name).toEqual(["「星が見える」", "「流れ星だ」"]);
      expect(await p.evaluate(`document.querySelector(".lm-log-count").textContent`), name).toBe("2 件");
      await p.fill(".lm-log-search", "アカリ");
      expect(await p.evaluate(`document.querySelectorAll(".lm-log-entry:not([hidden])").length`), name).toBe(1);
      await p.close();
    }
  });
});
