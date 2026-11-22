import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** クリアの状況で変わるタイトル（ui.title.variants）を、実際のブラウザで確かめる。 */

const scenario = `@window show
エンディング。
@set system.cleared = true
@title-screen
`;

const titleImage = (p: Page) => p.evaluate(`getComputedStyle(document.querySelector(".lm-title")).backgroundImage`) as Promise<string>;

describe.skipIf(!e2e)("クリアの状況で変わるタイトル（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: scenario },
      config: { entry: "a", ui: { title: { background: "hill_dusk.webp", variants: [{ if: "(system.cleared)", background: "hill_morning.webp", showName: false }] } } },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("はじめは標準のタイトル、クリアの変数が立ったあとは置き換えたタイトル", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1`);
      await p.waitForSelector(".lm-title");
      expect(await titleImage(p), name).toContain("hill_dusk.webp");
      expect(await p.locator(".lm-title-name").count()).toBe(1);
      await p.locator(".lm-title-button").first().click();
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("エンディング")`);
      await p.waitForTimeout(300);
      await p.mouse.click(640, 300);
      await p.waitForSelector(".lm-title");
      expect(await titleImage(p), name).toContain("hill_morning.webp");
      expect(await p.locator(".lm-title-name").count()).toBe(0);
      await p.close();
    }
  });
});
