import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** コンフィグの「操作」（遊ぶ人のキーとゲームパッドの割り当て）を、実際のブラウザで確かめる。ゲームパッドは getGamepads を真似る。 */

/** 真似たゲームパッドのボタンを押して離す（番号は標準の配置。0: A、1: B、3: Y）。 */
async function pad(p: Page, index: number): Promise<void> {
  await p.evaluate(`window.__pad[${index}] = true`);
  await p.waitForTimeout(120);
  await p.evaluate(`window.__pad[${index}] = false`);
  await p.waitForTimeout(120);
}

describe.skipIf(!e2e)("操作の割り当て（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: "@window show\nいち。\nに。\nさん。\n" }, config: { entry: "a" } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("キーを割り当て直すとその操作になり、ゲームパッドのボタンを入れ替えられる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(() => {
        const w = window as unknown as { __pad: boolean[] };
        w.__pad = Array(16).fill(false);
        navigator.getGamepads = () => [{ buttons: w.__pad.map((pressed) => ({ pressed, value: pressed ? 1 : 0 })), axes: [0, 0] } as unknown as Gamepad];
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("いち")`);
      await p.evaluate("window.__liminalia.system.openConfig()");
      await p.locator(".lm-tab", { hasText: "操作" }).click();
      // バックログを B キーに
      const row = p.locator(".lm-config-row", { hasText: "バックログ" }).first();
      await row.locator(".lm-toggle", { hasText: "変更" }).click();
      expect(await row.locator(".lm-config-keys").textContent()).toBe("キーを押してください");
      await p.keyboard.press("b");
      expect(await row.locator(".lm-config-keys").textContent(), name).toBe("B");
      // ゲームパッド: 「決定、読み進める」を Y に（Y の役目だったバックログは A へ）
      const decide = p.locator(".lm-config-row", { hasText: "決定、読み進める" });
      await decide.locator(".lm-toggle", { hasText: "変更" }).click();
      await pad(p, 3);
      expect(await decide.locator(".lm-config-keys").textContent(), name).toBe("Y");
      expect(await p.locator(".lm-config-row", { hasText: "バックログ" }).nth(1).locator(".lm-config-keys").textContent(), name).toBe("A");
      await p.locator(".lm-config .lm-close").click();
      // Y で読み進め、A でバックログ
      await pad(p, 3);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("に")`);
      await pad(p, 0);
      await p.waitForSelector(".lm-log, .lm-backlog");
      await p.keyboard.press("Escape");
      await p.waitForTimeout(200);
      // B キーでバックログ
      await p.keyboard.press("b");
      await p.waitForSelector(".lm-log, .lm-backlog");
      await p.close();
    }
  });
});
