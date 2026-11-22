import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 用語集（extra.glossary）と章選択（extra.chapters）を、実際のブラウザで確かめる。
 * 本文に出た語は解放して印を付け、押すと説明が出る（本文は送らない）。章の始まりに着いたら解放し、そこから読み直せる。
 */

const SCENARIO = `@window show
はじまりの空に星が流れた。
@set game.count = 1
# second
第二章の始まり。ほうき星が見える。
最後。
`;

const text = (p: Page) => p.evaluate(`document.querySelector(".message .text").textContent.replace("▼", "")`) as Promise<string>;
const advance = async (p: Page) => {
  await p.evaluate("window.__liminalia.host.advance()");
  await p.waitForTimeout(80);
  await p.evaluate("window.__liminalia.host.advance()");
  await p.waitForTimeout(300);
};

describe.skipIf(!e2e)("用語集と章選択（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: SCENARIO },
      config: {
        entry: "a",
        extra: {
          glossary: [
            { id: "meteor", term: "流れ星", aliases: ["星が流れ"], description: "空を横切る光。" },
            { id: "comet", term: "ほうき星", description: "尾を引く星。", link: false },
          ],
          chapters: [{ id: "c2", title: "第二章", target: "a#second", synopsis: "ほうき星の夜。" }],
        },
      },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("用語の印と説明、解放、章の解放と読み直し", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(500);
      // 別の書き方（星が流れ）にも印が付く
      expect(await p.evaluate(`[...document.querySelectorAll(".lm-term")].map((e) => e.textContent).join("")`), name).toBe("星が流れ");
      await p.locator(".lm-term").first().click();
      await p.waitForSelector(".lm-term-pop");
      expect(await p.evaluate(`document.querySelector(".lm-term-pop").textContent`), name).toBe("流れ星空を横切る光。");
      // 押しても本文は進まない。どこかを押すと説明だけ閉じる
      expect(await text(p), name).toBe("はじまりの空に星が流れた。");
      await p.mouse.click(640, 300);
      await p.waitForTimeout(200);
      expect([await p.evaluate(`!!document.querySelector(".lm-term-pop")`), await text(p)], name).toEqual([false, "はじまりの空に星が流れた。"]);
      await advance(p);
      expect(await text(p), name).toBe("第二章の始まり。ほうき星が見える。");
      // link: false の語は印を付けずに解放だけ
      expect(await p.evaluate(`document.querySelectorAll(".lm-term").length`), name).toBe(0);
      expect(await p.evaluate("window.__liminalia.system.systemVariables.glossary_unlocked"), name).toEqual({ meteor: true, comet: true });
      expect(await p.evaluate("window.__liminalia.system.systemVariables.chapters_unlocked"), name).toEqual({ c2: true });
      // 章から読み直す（おまけの章のタブ）
      await advance(p);
      await p.evaluate("window.__liminalia.system.showTitle(true)");
      await p.waitForTimeout(500);
      await p.locator(".lm-title-button", { hasText: "おまけ" }).click();
      await p.locator(".lm-tab", { hasText: "章" }).click();
      expect(await p.evaluate(`document.querySelector(".lm-extra-chapter").textContent`), name).toBe("01第二章ほうき星の夜。");
      await p.locator(".lm-extra-chapter").click();
      await p.click(".lm-dialog .lm-primary");
      await p.waitForTimeout(800);
      expect([await text(p), await p.evaluate("window.__liminalia.system.runtime.state.game.count")], name).toEqual(["第二章の始まり。ほうき星が見える。", 1]);
      await p.close();
    }
  });
});
