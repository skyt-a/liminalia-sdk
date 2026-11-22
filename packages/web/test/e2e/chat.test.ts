import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** チャットアプリ風の画面（@chat-open / @chat / @chat-close）を、実際のブラウザで確かめる。 */

const SCENARIO = `@window hide
@chat-open アカリ me=ソウ
@chat アカリ text="いまどこ？"
@chat ソウ text="着いた"
@chat-close
@window show
終わり。
`;

describe.skipIf(!e2e)("チャットの画面（ブラウザ）", { timeout: 180_000 }, () => {
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

  it("吹き出しを足してクリックを待ち、自分のものは右に出し、ロードで組み直し、閉じる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".lim-chat-bubble");
      await p.waitForTimeout(300);
      await p.mouse.click(640, 360);
      await p.waitForTimeout(400);
      expect(await p.evaluate(`[...document.querySelectorAll(".lim-chat-row")].map((r) => [r.classList.contains("is-me"), r.querySelector(".lim-chat-bubble").textContent])`), name).toEqual([
        [false, "いまどこ？"],
        [true, "着いた"],
      ]);
      expect(await p.evaluate(`document.querySelector(".lim-chat-head").textContent`), name).toBe("アカリ");
      await p.evaluate("window.__liminalia.system.saveTo(1)");
      await p.evaluate("window.__liminalia.system.loadFrom(1)");
      await p.waitForTimeout(800);
      expect(await p.evaluate(`document.querySelectorAll(".lim-chat-bubble").length`), name).toBe(2);
      await p.mouse.click(640, 360);
      await p.waitForSelector(".message .text .ch");
      await p.waitForTimeout(400);
      expect(await p.evaluate(`!!document.querySelector(".lim-chat")`), name).toBe(false);
      await p.close();
    }
  });
});
