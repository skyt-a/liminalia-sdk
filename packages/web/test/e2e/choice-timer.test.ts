import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/** 制限時間つきの選択肢と押せない選択肢を、実際のブラウザで確かめる。 */

const SCENARIO = `@window show
はじめ。
@choice timeout=1500ms default=1
- 行く -> #go
- 鍵が要る -> #locked locked=(game.key != true)
@end
# go
行った。
@stop
# locked
開いた。
`;

describe.skipIf(!e2e)("制限時間と押せない選択肢（ブラウザ）", { timeout: 180_000 }, () => {
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

  it("押せない選択肢は無効で出し、残り時間のバーを出し、時間切れで default へ進む", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(300);
      await p.mouse.click(640, 360);
      await p.waitForSelector(".choices button");
      expect(await p.evaluate(`[...document.querySelectorAll(".choices button")].map((b) => [b.textContent, b.disabled])`), name).toEqual([
        ["行く", false],
        ["鍵が要る", true],
      ]);
      expect(await p.evaluate(`!!document.querySelector(".choices .choice-timer")`), name).toBe(true);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("行った")`, null, { timeout: 5000 });
      expect(await p.evaluate(`document.querySelectorAll(".choices button").length`), name).toBe(0);
      await p.close();
    }
  });

  it("メニューやバックログを開いている間は残り時間が減らず、閉じたら残りから続ける", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(300);
      await p.mouse.click(640, 360);
      await p.waitForSelector(".choices button");
      await p.waitForTimeout(500);
      await p.evaluate(`void window.__liminalia.system.perform("backlog")`);
      await p.waitForTimeout(100);
      const scale = () => p.evaluate(`new DOMMatrix(getComputedStyle(document.querySelector(".choices .choice-timer")).transform).a`) as Promise<number>;
      const paused = await scale();
      expect(await p.evaluate(`document.querySelector(".stage").classList.contains("lm-timers-paused")`), name).toBe(true);
      // 制限時間より長く開いていても選ばない。バーも止まっている
      await p.waitForTimeout(2000);
      expect(await p.evaluate(`document.querySelectorAll(".choices button").length`), name).toBe(2);
      expect(Math.abs((await scale()) - paused), name).toBeLessThan(0.02);
      await p.keyboard.press("Escape");
      await p.waitForTimeout(100);
      expect(await p.evaluate(`window.__liminalia.system.status.screen`), name).toBe(null);
      // 閉じたら残り（およそ 1 秒）から続け、時間切れで default へ
      await p.waitForTimeout(400);
      expect(await p.evaluate(`document.querySelectorAll(".choices button").length`), name).toBe(2);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("行った")`, null, { timeout: 5000 });
      await p.close();
    }
  });

  it("コンフィグの「選択肢の制限時間」をオフにすると、時間切れにせず、残り時間のバーも出さない", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.evaluate("window.__liminalia.system.updateSettings({ choiceTimer: false })");
      await p.waitForTimeout(300);
      await p.mouse.click(640, 360);
      await p.waitForSelector(".choices button");
      expect(await p.evaluate(`!!document.querySelector(".choices .choice-timer")`), name).toBe(false);
      await p.waitForTimeout(2500);
      expect(await p.evaluate(`document.querySelectorAll(".choices button").length`), name).toBe(2);
      await p.locator(".choices button", { hasText: "行く" }).click();
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("行った")`, null, { timeout: 5000 });
      await p.close();
    }
  });
});
