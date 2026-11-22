import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 巻き戻し（system.perform("rollback" / "rollforward")・キー・ホイール）を、実際のブラウザで確かめる。
 * - 一ページずつ戻り、戻ったページの文字は一度に出る。戻ったところから進め直せる
 * - 選択肢の直後のページから戻ると選択肢へ。進め直すと前に選んだ先へ。選び直すと進め直す先は消える
 * - ui.rollback.fixChoices なら前に選んだものしか押せない。ui.rollback.enabled: false なら戻れない
 */

// 文字を一字ずつ出すと 1 秒を超える長さ（戻ったページが一度に出るかを見る）
const LONG = "戻ったページはこの長い一文を一度に出すので、一字ずつ出すのを待たなくてよい。";

const SCENARIO = `@window show
一ページ目。${LONG}
二ページ目。
@choice
- 甲 -> #a
- 乙 -> #b
@end
# a
甲の一。
甲の二。
@jump #last
# b
乙の一。
# last
最後。
`;

const text = (p: Page) => p.evaluate(`document.querySelector(".message .text").textContent.replace("▼", "")`) as Promise<string>;
const labels = (p: Page) => p.evaluate(`[...document.querySelectorAll(".choices button")].map((b) => b.textContent)`) as Promise<string[]>;
const locked = (p: Page) => p.evaluate(`[...document.querySelectorAll(".choices button")].map((b) => b.disabled)`) as Promise<boolean[]>;
const status = (p: Page) => p.evaluate("window.__liminalia.system.status") as Promise<{ canRollback: boolean; canRollforward: boolean; choosing: boolean }>;
const perform = async (p: Page, action: string, wait = 400) => {
  await p.evaluate(`void window.__liminalia.system.perform(${JSON.stringify(action)})`);
  await p.waitForTimeout(wait);
};
/**
 * 今のページを出し切ってから次へ、ちょうど一ページ。出し切ったかは時間でなく host.waiting で見る
 * （二回続けて送ると、短いページは一回目で出し切って二回目で次の次へ進むことがある）。
 */
const advance = async (p: Page) => {
  await p.evaluate("window.__liminalia.host.waiting || window.__liminalia.host.advance()");
  await p.waitForFunction("window.__liminalia.host.waiting");
  await p.evaluate("window.__liminalia.host.advance()");
  await p.waitForTimeout(400);
};
const pick = async (p: Page, index: number) => {
  await p.locator(".choices button").nth(index).click();
  await p.waitForTimeout(500);
};

describe.skipIf(!e2e)("巻き戻し（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let fixed: TestProject;
  let off: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO } });
    fixed = await startProject({ scenario: { a: SCENARIO }, config: { ui: { rollback: { fixChoices: true }, input: { wheelUp: "rollback" } } } });
    off = await startProject({ scenario: { a: SCENARIO }, config: { ui: { rollback: { enabled: false } } } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await fixed?.close();
    await off?.close();
  });

  it("一ページずつ戻って進め直す。選択肢の直後からは選択肢へ戻り、選び直すと進め直す先は消える", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(300);
      expect((await status(p)).canRollback, name).toBe(false);
      await advance(p);
      expect(await text(p), name).toBe("二ページ目。");
      // 戻ったページは一度に出る（一字ずつなら 1 秒を超える）
      await perform(p, "rollback", 150);
      expect(await text(p), name).toBe(`一ページ目。${LONG}`);
      expect(await status(p), name).toMatchObject({ canRollback: false, canRollforward: true });
      await perform(p, "rollforward");
      expect(await text(p), name).toBe("二ページ目。");
      expect((await status(p)).canRollforward, name).toBe(false);

      // 選択肢で甲 → 甲の二まで。戻ると甲の一 → 選択肢 → 二ページ目
      await advance(p);
      await pick(p, 0);
      await advance(p);
      expect(await text(p), name).toBe("甲の二。");
      await perform(p, "rollback");
      expect(await text(p), name).toBe("甲の一。");
      await perform(p, "rollback");
      expect([(await status(p)).choosing, await labels(p)], name).toEqual([true, ["甲", "乙"]]);
      await perform(p, "rollback");
      expect([(await status(p)).choosing, await text(p)], name).toEqual([false, "二ページ目。"]);
      // 進め直す: 選択肢 → 前に選んだ甲の先 → 甲の二
      await perform(p, "rollforward");
      expect(await labels(p), name).toEqual(["甲", "乙"]);
      await perform(p, "rollforward");
      expect(await text(p), name).toBe("甲の一。");
      // クリックで読み進めても、同じところなら進め直す先は残る
      await advance(p);
      expect([await text(p), (await status(p)).canRollforward], name).toEqual(["甲の二。", false]);

      // 選択肢へ戻って乙を選び直すと、進め直す先は消える。前の選択肢へも戻れる
      await perform(p, "rollback");
      await perform(p, "rollback");
      expect((await status(p)).canRollforward, name).toBe(true);
      await pick(p, 1);
      expect([await text(p), (await status(p)).canRollforward], name).toEqual(["乙の一。", false]);
      expect(await p.evaluate("window.__liminalia.system.status.canPrevChoice"), name).toBe(true);
      // キー（PageUp）でも戻る
      await p.keyboard.press("PageUp");
      await p.waitForTimeout(400);
      expect(await labels(p), name).toEqual(["甲", "乙"]);
      await p.close();
    }
  });

  it("fixChoices なら戻ったあとは前に選んだものしか押せない。ホイールを上へで戻り、下へで進め直す", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, fixed.url, "a");
      await p.waitForTimeout(300);
      await advance(p);
      await advance(p);
      await pick(p, 1);
      expect(await text(p), name).toBe("乙の一。");
      await p.mouse.move(640, 360);
      await p.mouse.wheel(0, -200);
      await p.waitForTimeout(500);
      expect([await labels(p), await locked(p)], name).toEqual([["甲", "乙"], [true, false]]);
      await p.mouse.wheel(0, 200);
      await p.waitForTimeout(500);
      expect(await text(p), name).toBe("乙の一。");
      await p.close();
    }
  });

  it("ロードしたあとも一つ戻れ、バックログの「ここに戻る」も使える（セーブに直近のページの読み直すセーブを入れる）", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(300);
      await advance(p);
      await advance(p);
      await pick(p, 0);
      await advance(p);
      expect(await text(p), name).toBe("甲の二。");
      await perform(p, "quick-save");
      await perform(p, "quick-load", 800);
      expect([await text(p), (await status(p)).canRollback], name).toEqual(["甲の二。", true]);
      // 選んだ選択肢の項目と今のページのほかは戻れる
      const jumps = (await p.evaluate("window.__liminalia.system.backlog.filter((e) => !e.choice).map((e) => e.canJump)")) as boolean[];
      expect(jumps, name).toEqual([true, true, true, false]);
      await perform(p, "rollback");
      expect(await text(p), name).toBe("甲の一。");
      await perform(p, "rollback");
      expect([(await status(p)).choosing, await labels(p)], name).toEqual([true, ["甲", "乙"]]);
      await perform(p, "rollback");
      expect(await text(p), name).toBe("二ページ目。");
      await p.close();
    }
  });

  it("?skip=N で飛ばしたページへも戻れ、戻ったあとに頭から飛ばし直さない", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a&skip=2`);
      await p.waitForFunction(() => {
        const l = window.__liminalia;
        return !!l && l.pages() >= 2 && l.host.waiting && !l.host.skipping;
      }, null, { timeout: 30_000 });
      expect([await text(p), (await status(p)).canRollback], name).toEqual(["二ページ目。", true]);
      await perform(p, "rollback");
      expect([await text(p), await p.evaluate("window.__liminalia.host.skipping")], name).toEqual([`一ページ目。${LONG}`, false]);
      // 進め直すと、飛ばしたページへ戻る（早送りはし直さない）
      await perform(p, "rollforward");
      expect(await text(p), name).toBe("二ページ目。");
      await p.close();
    }
  });

  it("enabled: false なら戻れない", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, off.url, "a");
      await p.waitForTimeout(300);
      await advance(p);
      await perform(p, "rollback");
      expect([await text(p), (await status(p)).canRollback], name).toEqual(["二ページ目。", false]);
      await p.close();
    }
  });
});
