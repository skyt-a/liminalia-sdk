import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** 操作説明の画面を、実際のブラウザで確かめる。 */

describe.skipIf(!e2e)("操作説明（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: "@window show\nはじまり。\n" },
      config: { entry: "a", ui: { keys: { backlog: ["b"] }, help: { title: true, pages: [{ title: "調べる", image: "hill.png", text: "気になる所を押すと調べられる。" }] } } },
      before: async (dir) => {
        const { cpSync } = await import("node:fs");
        const { join } = await import("node:path");
        cpSync(join(dir, "assets/bgimage/hill_dusk.webp"), join(dir, "assets/image/hill.png"));
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("今の割り当てから操作の表を作り、作品のページをタブで足す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1`);
      await p.locator(".lm-title-button", { hasText: "操作説明" }).click();
      const row = (label: string) => p.locator(".lm-help-table tbody tr", { hasText: label }).first().locator("td").allTextContents();
      expect(await row("バックログ"), name).toEqual(["ホイール上、B", "下へスワイプ", "Y"]);
      expect(await row("読み進める"), name).toEqual(["クリック、Enter、Space、ホイール下", "タップ", "A"]);
      // 遊ぶ人が入れ替えたら表も替わる
      await p.evaluate("window.__liminalia.system.updateSettings({ keys: { backlog: ['h'] }, pad: { a: 'y', y: 'a' } })");
      await p.locator(".lm-help .lm-close").click();
      await p.locator(".lm-title-button", { hasText: "操作説明" }).click();
      expect(await row("バックログ"), name).toEqual(["ホイール上、H", "下へスワイプ", "A"]);
      await p.locator(".lm-help .lm-tab", { hasText: "調べる" }).click();
      expect(await p.locator(".lm-help-text").textContent()).toBe("気になる所を押すと調べられる。");
      await p.waitForFunction(`!!document.querySelector(".lm-help-page img")?.naturalWidth`);
      await p.close();
    }
  });
});
