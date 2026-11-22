import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { copyScreen } from "@liminalia/project/screen-copy";
import { STANDARD_SCREENS } from "@liminalia/screens/rules";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";
import { dialogOf, events, focusProbe, onProbe, focusedLabel, open, pad, recordEvents, screenNow, waitFocus, waitScreen } from "./screens-behavior-shared.ts";

/**
 * 写した直後のテンプレート（lim screens copy と同じ写し出しで作品に写し、ui.templates に登録した状態）で、遊ぶ側の画面が標準と同じに動くこと。
 * 確かめは screens-behavior-dialogs.test.ts の確認の画面と同じ（キー、ゲームパッド、フォーカス、結果、閉じ方）。加えて、作った DOM が標準と同じこと。
 * 画面をテンプレートに書き直したら、その画面の今の動きの確かめをここにも並べる。
 */

const SCENARIO = `@window show
一ページ目。
二ページ目。
三ページ目。
`;

/** 確かめを開く（答えは window.__answers に積む）。 */
const ask = (p: Page, message: string) =>
  p.evaluate((m) => {
    const w = window as unknown as { __answers: boolean[] };
    w.__answers ??= [];
    void window.__liminalia!.system.ask!(m).then((ok) => w.__answers.push(ok));
  }, message);
const answers = (p: Page) => p.evaluate(() => (window as unknown as { __answers?: boolean[] }).__answers ?? []) as Promise<boolean[]>;
/** 開いている確認の画面の DOM（フォーカスと押した印は除く）。 */
const confirmDom = (p: Page) =>
  p.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-lm-screen='confirm']")!.cloneNode(true) as HTMLElement;
    for (const el of [root, ...root.querySelectorAll<HTMLElement>("*")]) for (const a of [...el.attributes]) if (/^data-lm-(focus|hover|pressed|selected)$/.test(a.name) || a.name === "aria-labelledby") el.removeAttribute(a.name);
    return root.outerHTML;
  });

describe.skipIf(!e2e)("写した直後のテンプレートで、標準の画面と同じに動く（ブラウザ）", { timeout: 300_000 }, () => {
  let standard: TestProject;
  let copied: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    standard = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
    copied = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" }, before: (dir) => void copyScreen(dir, STANDARD_SCREENS, "confirm") });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await standard?.close();
    await copied?.close();
  });

  it("確認: 作った DOM が標準と同じ", async () => {
    for (const { name, browser } of list) {
      const doms: string[] = [];
      for (const project of [standard, copied]) {
        const p = await open(browser, project.url, { start: "a" });
        await ask(p, "同じですか？");
        await waitScreen(p, "confirm");
        doms.push(await confirmDom(p));
        await p.close();
      }
      expect(doms[1], name).toBe(doms[0]);
    }
  });

  it("確認: 開くと「はい」を選び、矢印と Tab は二つのボタンの間だけを動き、Enter と Space とパッドの A で答え、Esc と右クリックとパッドの B は「いいえ」。閉じたら開く前のところへ戻す", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, copied.url, { start: "a" });
      await recordEvents(p);
      const pages = await p.evaluate(() => window.__liminalia!.pages());
      await focusProbe(p);
      await ask(p, "消してよいですか？");
      await waitScreen(p, "confirm");
      const d = await dialogOf(p, "confirm");
      expect([d?.role, d?.modal], name).toEqual(["alertdialog", "true"]);
      expect(await p.locator(".lm-dialog-message").textContent(), name).toBe("消してよいですか？");
      expect(await p.locator(".lm-dialog-buttons button").allTextContents(), name).toEqual(["いいえ", "はい"]);
      await waitFocus(p, ".lm-dialog-buttons");
      expect(await focusedLabel(p), name).toBe("はい");
      expect(await events(p), name).toEqual(["screen-open:confirm"]);
      await p.keyboard.press("ArrowLeft");
      expect(await focusedLabel(p), name).toBe("いいえ");
      await p.keyboard.press("ArrowLeft");
      expect(await focusedLabel(p), name).toBe("いいえ");
      await p.keyboard.press("ArrowRight");
      expect(await focusedLabel(p), name).toBe("はい");
      await p.keyboard.press("Tab");
      expect(await focusedLabel(p), name).toBe("いいえ");
      await p.keyboard.press("Tab");
      expect(await focusedLabel(p), name).toBe("はい");
      await p.keyboard.press("Shift+Tab");
      expect(await focusedLabel(p), name).toBe("いいえ");
      await p.keyboard.press("Shift+Tab");
      expect(await focusedLabel(p), name).toBe("はい");
      await p.keyboard.press("b");
      await p.keyboard.press("s");
      expect((await screenNow(p)).screen, name).toBe("confirm");
      await p.keyboard.press("Enter");
      await waitScreen(p, null);
      expect(await answers(p), name).toEqual([true]);
      expect(await p.evaluate(() => window.__liminalia!.pages()), name).toBe(pages);
      expect(await onProbe(p), name).toBe(true);
      expect(await events(p), name).toEqual(["screen-close:confirm"]);

      await focusProbe(p);
      await ask(p, "二つ目");
      await waitFocus(p, ".lm-dialog-buttons");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      await ask(p, "三つ目");
      await waitFocus(p, ".lm-dialog-buttons");
      await p.mouse.click(100, 100, { button: "right" });
      await waitScreen(p, null);
      await ask(p, "四つ目");
      await waitFocus(p, ".lm-dialog-buttons");
      await pad(p, "b");
      await waitScreen(p, null);
      await ask(p, "五つ目");
      await waitFocus(p, ".lm-dialog-buttons");
      await pad(p, "left");
      expect(await focusedLabel(p), name).toBe("いいえ");
      await pad(p, "right");
      expect(await focusedLabel(p), name).toBe("はい");
      await pad(p, "left");
      await pad(p, "a");
      await waitScreen(p, null);
      await ask(p, "六つ目");
      await waitFocus(p, ".lm-dialog-buttons");
      await p.keyboard.press(" ");
      await waitScreen(p, null);
      await ask(p, "七つ目");
      await waitFocus(p, ".lm-dialog-buttons");
      await p.mouse.click(30, 30);
      expect((await screenNow(p)).screen, name).toBe("confirm");
      await p.locator(".lm-dialog-buttons button", { hasText: "いいえ" }).click();
      await waitScreen(p, null);
      expect(await answers(p), name).toEqual([true, false, false, false, false, true, false]);
      expect(await p.evaluate(() => window.__liminalia!.pages()), name).toBe(pages);
      await p.close();
    }
  });
});
