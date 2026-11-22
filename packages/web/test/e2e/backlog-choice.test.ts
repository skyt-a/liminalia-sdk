import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/** 選んだ選択肢がバックログに残ること（ui.backlogChoices で外せること）を、実際のブラウザで確かめる。 */

const SCENARIO = `@window show
アカリ「どっちへ行く？」
@choice
- 北の道を行く -> #north
- 南の道を行く -> #south
@end
# north
北へ向かった。
@stop
# south
南へ向かった。
@stop
`;

const rows = (p: Page) =>
  p.evaluate(`[...document.querySelectorAll(".lm-log-entry")].map((r) => [r.classList.contains("lm-log-choice"), r.querySelector(".lm-log-name").textContent, r.querySelector(".lm-log-text").textContent])`) as Promise<[boolean, string, string][]>;

describe.skipIf(!e2e)("選んだ選択肢のバックログ（ブラウザ）", { timeout: 180_000 }, () => {
  let on: TestProject;
  let off: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    on = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
    off = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a", ui: { backlogChoices: false } } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await on?.close();
    await off?.close();
  });

  const play = async (browser: Browser, url: string) => {
    const p = await openPlayer(browser, url, "a");
    await p.waitForTimeout(400);
    await p.mouse.click(640, 360);
    await p.waitForSelector(".choices button");
    await p.locator(".choices button").nth(0).click();
    await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("北へ")`);
    await p.waitForTimeout(300);
    await p.evaluate(`void window.__liminalia.system.perform("backlog")`);
    await p.waitForSelector(".lm-log-entry");
    return p;
  };

  it("選んだ文を「選択肢」の印つきで残し、ui.backlogChoices: false なら残さない", async () => {
    for (const { name, browser } of list) {
      const p = await play(browser, on.url);
      expect(await rows(p), name).toEqual([
        [false, "アカリ", "「どっちへ行く？」"],
        [true, "選択肢", "北の道を行く"],
        [false, "", "北へ向かった。"],
      ]);
      // 選んだ文はアクセントカラー、話者の欄は薄い色（ふだんの台詞の名前とは別の色）
      const colors = (await p.evaluate(`(() => { const c = document.querySelector(".lm-log-choice"); return [getComputedStyle(c.querySelector(".lm-log-text")).color, getComputedStyle(document.querySelector(".lm-log-entry .lm-log-text")).color]; })()`)) as [string, string];
      expect(colors[0], name).not.toBe(colors[1]);
      // 見た目を目で確かめるときは LIMINALIA_SHOT_DIR に撮る
      const shots = process.env.LIMINALIA_SHOT_DIR;
      if (name === "chromium" && shots) await p.screenshot({ path: `${shots}/backlog-choice.png` });
      await p.close();
      const q = await play(browser, off.url);
      expect((await rows(q)).map((r) => r[0]), name).toEqual([false, false]);
      await q.close();
    }
  });
});
