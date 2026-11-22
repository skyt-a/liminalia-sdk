import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";
import { dialogOf, focusedIs, focusedLabel, open, pad, screenNow, waitFocus, waitMode, waitScreen, waitText } from "./screens-behavior-shared.ts";

/**
 * 標準の画面の今の動き（本文の層の選択肢、タイトル、縦長の画面）を固定する。0.4.0 で画面を HTML の型と印で組み直しても、同じテストが通ること。
 * DOM の作りは見ず、遊ぶ人から見える動き（role と名前で探す）と、作品の CSS が当てる部品のクラス（screen-catalog.ts の parts と classes）で確かめる。
 * 制限時間の止め方（choice-timer）、既読の印の付き方（read-marks）、置き方（choice-place）、読み上げの基本（accessibility）とは重ねない。
 */

const LONG_OPTION = "とても長い選択肢の文で、舞台の幅に収まらないほど長く続けて、折り返して二行か三行になることを確かめるための文";

const CHOICE = `@window show
選ぶ前。
@choice
- 一つ目 -> #one
- 鍵の要る二つ目 -> #two locked=true
- 三つ目 -> #three
- ${LONG_OPTION} -> #four
@end
# one
一つ目を選んだ。
@stop
# two
二つ目を選んだ。
@stop
# three
三つ目を選んだ。
@stop
# four
四つ目を選んだ。
@stop
`;

const TIMED = `@window show
選ぶ前。
@choice timeout=60s default=0
- 待つ -> #wait
- 行く -> #go
@end
# wait
待った。
@stop
# go
行った。
@stop
`;

/** 選んだ先を読んだことがあれば、その選択肢に既読の印。 */
const READ = `@window show
# top
選ぶ前。
@choice
- 甲 -> #a
- 乙 -> #b
@end
# a
甲を読んだ。
@jump #top
# b
乙を読んだ。
@stop
`;

/** 選択肢のボタン（role と名前で）。 */
const option = (p: Page, label: string) => p.getByRole("button", { name: label, exact: true });
const toChoice = async (p: Page) => {
  await waitText(p, "選ぶ前");
  await p.evaluate(() => window.__liminalia!.host.advance());
  await p.waitForFunction(() => window.__liminalia!.system.status!.choosing && !!document.querySelector(".choices button"), undefined, { timeout: 15_000 });
};

describe.skipIf(!e2e)("標準の画面の今の動き: 選択肢、タイトル、縦長（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let noNumbers: TestProject;
  let title: TestProject;
  let portrait: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    const scenario = { c: CHOICE, timed: TIMED, read: READ };
    project = await startProject({ scenario, config: { entry: "c" } });
    noNumbers = await startProject({ scenario, config: { entry: "c", ui: { input: { numberKeys: false } } } });
    title = await startProject({ scenario: { c: CHOICE }, config: { entry: "c", title: "中立の題", ui: { help: { title: true } } } });
    portrait = await startProject({ scenario: { c: CHOICE }, config: { entry: "c", title: "中立の題", screen: { width: 720, height: 1280 } } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    for (const t of [project, noNumbers, title, portrait]) await t?.close();
  });

  it("選択肢: 最初の押せるものを選び、押せないものは無効で読み上げに入れない。矢印とパッドの十字キーで押せるものだけを動き、Enter とパッドの A で選ぶ", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "c", speech: true });
      await p.evaluate(() => window.__liminalia!.system.updateSettings!({ selfVoicing: true }));
      await toChoice(p);
      expect(await p.locator(".choices > button").allTextContents(), name).toEqual(["一つ目", "鍵の要る二つ目", "三つ目", LONG_OPTION]);
      expect(await option(p, "鍵の要る二つ目").isDisabled(), name).toBe(true);
      expect(await option(p, "鍵の要る二つ目").evaluate((b) => b.classList.contains("is-locked")), name).toBe(true);
      expect(await p.locator(".choices .is-locked").count(), name).toBe(1);
      await waitFocus(p, ".choices");
      expect(await focusedLabel(p), name).toBe("一つ目");
      // スクリーンリーダーとテキスト読み上げには押せるものだけ
      await p.waitForFunction(() => document.querySelector(".lm-sr-only")?.textContent?.startsWith("選択肢:"));
      expect(await p.evaluate(() => document.querySelector(".lm-sr-only")!.textContent), name).toBe(`選択肢: 一つ目、三つ目、${LONG_OPTION}`);
      expect(await p.evaluate(() => (window as unknown as { __said: string[] }).__said.at(-1)), name).toBe(`選択肢。一つ目。三つ目。${LONG_OPTION}`);
      // 録画には押せないものを除いて知らせる
      const offered = (await p.evaluate(() => window.__liminalia!.host.offered())) as { options: (string | null)[] } | null;
      expect(offered?.options, name).toEqual(["一つ目", null, "三つ目", LONG_OPTION]);
      // 長い文は折り返して舞台の幅に収まる
      const short = (await option(p, "一つ目").boundingBox())!;
      const fit = await option(p, LONG_OPTION).evaluate((b, shortHeight) => {
        const r = b.getBoundingClientRect();
        const s = document.querySelector(".stage")!.getBoundingClientRect();
        return { inside: r.left >= s.left - 1 && r.right <= s.right + 1, wrapped: r.height > shortHeight * 1.3 };
      }, short.height);
      expect(fit, name).toEqual({ inside: true, wrapped: true });
      // 矢印: 下へで押せないものを飛ばす。端でさらに押しても外へ出ない
      await p.keyboard.press("ArrowDown");
      expect(await focusedLabel(p), name).toBe("三つ目");
      await p.keyboard.press("ArrowDown");
      expect(await focusedLabel(p), name).toBe(LONG_OPTION);
      await p.keyboard.press("ArrowDown");
      expect(await focusedLabel(p), name).toBe(LONG_OPTION);
      await p.keyboard.press("ArrowUp");
      expect(await focusedLabel(p), name).toBe("三つ目");
      // パッドの十字キーでも同じ
      await pad(p, "up");
      expect(await focusedLabel(p), name).toBe("一つ目");
      await pad(p, "down");
      expect(await focusedLabel(p), name).toBe("三つ目");
      // 選んでいるボタンを読み上げる（キーで動かしたとき）
      await p.keyboard.press("ArrowDown");
      await p.keyboard.press("ArrowUp");
      expect(await p.evaluate(() => (window as unknown as { __said: string[] }).__said.at(-1)), name).toBe("三つ目");
      // Enter で選ぶ
      await p.keyboard.press("Enter");
      await waitText(p, "三つ目を選んだ");
      expect(await p.locator(".choices button").count(), name).toBe(0);
      await p.close();

      // パッドの A で選ぶ
      const q = await open(browser, project.url, { start: "c" });
      await toChoice(q);
      await waitFocus(q, ".choices");
      await pad(q, "a");
      await waitText(q, "一つ目を選んだ");
      await q.close();
    }
  });

  it("選択肢: 数字のキーは押せるものを上から数えて選ぶ（押せないものは数えない）。ui.input.numberKeys が false なら選ばない", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "c" });
      await toChoice(p);
      // 押せるのは 一つ目、三つ目、長い文 の三つ。2 は三つ目
      await p.keyboard.press("9");
      expect(await p.locator(".choices button").count(), name).toBe(4);
      await p.keyboard.press("2");
      await waitText(p, "三つ目を選んだ");
      await p.close();

      const q = await open(browser, noNumbers.url, { start: "c" });
      await toChoice(q);
      await q.keyboard.press("1");
      expect([await q.locator(".choices button").count(), (await screenNow(q)).screen], name).toEqual([4, null]);
      await q.close();
    }
  });

  it("選択肢: 出している間、Esc と右クリックとパッドの START・B はメニュー、B キーとパッドの Y は履歴を開き、閉じたら選択肢へフォーカスを戻す", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "c" });
      await toChoice(p);
      await waitFocus(p, ".choices");
      await p.keyboard.press("ArrowDown");
      expect(await focusedLabel(p), name).toBe("三つ目");
      await p.keyboard.press("Escape");
      await waitScreen(p, "menu");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      expect(await focusedLabel(p), name).toBe("三つ目");
      await p.keyboard.press("b");
      await waitScreen(p, "backlog");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      expect(await focusedLabel(p), name).toBe("三つ目");
      await p.mouse.click(30, 30, { button: "right" });
      await waitScreen(p, "menu");
      await p.mouse.click(30, 30, { button: "right" });
      await waitScreen(p, null);
      // パッドも操作説明の表のとおり、選択肢を出している間にメニューと履歴を開く（前は遊んでいる最中だけで、選択肢の間は何もしなかった）。
      // 同じボタンで閉じ、選択肢へフォーカスを戻す（右クリックで押したところからフォーカスが外れるので、選び直してから）
      await option(p, "三つ目").focus();
      for (const [b, screen] of [["start", "menu"], ["b", "menu"], ["y", "backlog"]] as const) {
        await pad(p, b);
        await waitScreen(p, screen);
        await pad(p, b);
        await waitScreen(p, null);
        expect(await focusedLabel(p), `${name} ${b}`).toBe("三つ目");
      }
      expect(await p.locator(".choices button").count(), name).toBe(4);
      await p.close();
    }
  });

  it("選択肢: 制限時間のバーは progressbar で、選んだ先を読んだことのあるものには既読の印", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "timed" });
      await toChoice(p);
      expect(await p.locator(".choices .choice-timer").count(), name).toBe(1);
      expect(await p.locator(".choices").getByRole("progressbar").count(), name).toBe(1);
      await option(p, "行く").click();
      await waitText(p, "行った");
      expect(await p.locator(".choices .choice-timer").count(), name).toBe(0);
      await p.close();

      const q = await open(browser, project.url, { start: "read" });
      await toChoice(q);
      expect(await q.locator(".choices > button.is-read").count(), name).toBe(0);
      await option(q, "甲").click();
      await waitText(q, "甲を読んだ");
      // 読んだ先から同じ選択肢へ戻ると、甲にだけ印
      await q.evaluate(() => window.__liminalia!.host.advance());
      await toChoice(q);
      expect([await option(q, "甲").evaluate((b) => b.classList.contains("is-read")), await option(q, "乙").evaluate((b) => b.classList.contains("is-read"))], name).toEqual([true, false]);
      await q.close();
    }
  });

  it("タイトル: 題を見出しにしてボタンを並べる。開いたときはどこも選ばず、矢印とパッドの十字キーで押せるボタンを選び、Enter とパッドの A で押す。開いた画面を閉じたら押したボタンへ戻る", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, title.url);
      for (const cls of [".lm-title", ".lm-title-name", ".lm-title-menu", ".lm-title-button"]) expect(await p.locator(cls).count(), `${name} ${cls}`).toBeGreaterThan(0);
      expect(await p.getByRole("heading", { name: "中立の題" }).count(), name).toBe(1);
      expect(await p.locator(".lm-title-button").allTextContents(), name).toEqual(["はじめから", "つづきから", "コンフィグ", "操作説明"]);
      expect(await p.getByRole("button", { name: "つづきから" }).isDisabled(), name).toBe(true);
      expect(await p.evaluate(() => document.activeElement === document.body), name).toBe(true);
      // ゲームの操作のキーとパッドは効かない
      for (const k of ["Escape", "b", "s", "Enter"]) await p.keyboard.press(k);
      for (const b of ["start", "y", "b", "a"]) await pad(p, b);
      await p.mouse.click(640, 360, { button: "right" });
      expect(await screenNow(p), name).toEqual({ mode: "title", screen: null });
      // 矢印で選ぶ（押せないつづきからは飛ばす）
      await p.keyboard.press("ArrowDown");
      expect(await focusedLabel(p), name).toBe("はじめから");
      await p.keyboard.press("ArrowDown");
      expect(await focusedLabel(p), name).toBe("コンフィグ");
      // Enter でコンフィグを開き、閉じるとコンフィグのボタンへ戻る
      await p.keyboard.press("Enter");
      await waitScreen(p, "config");
      expect((await dialogOf(p, "config"))?.label, name).toBe("コンフィグ");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      expect(await focusedLabel(p), name).toBe("コンフィグ");
      // パッド: 下へで操作説明、A で開き、B で閉じて操作説明へ戻る
      await pad(p, "down");
      expect(await focusedLabel(p), name).toBe("操作説明");
      await pad(p, "a");
      await waitScreen(p, "help");
      await pad(p, "b");
      await waitScreen(p, null);
      expect(await focusedLabel(p), name).toBe("操作説明");
      // 上へ戻って「はじめから」を A で
      await pad(p, "up");
      await pad(p, "up");
      expect(await focusedLabel(p), name).toBe("はじめから");
      await pad(p, "a");
      await waitMode(p, "game");
      await waitText(p, "選ぶ前");
      expect(await p.locator(".lm-title").count(), name).toBe(0);
      await p.close();
    }
  });

  it("縦長の画面: 選択肢、メニュー、セーブ、確認が舞台に収まり、キーとパッドで同じに動く", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, portrait.url, { start: "c", viewport: { width: 540, height: 960 } });
      expect(await p.evaluate(() => document.querySelector(".stage")!.classList.contains("lm-portrait")), name).toBe(true);
      const inStage = (sel: string) =>
        p.evaluate((s) => {
          const st = document.querySelector(".stage")!.getBoundingClientRect();
          return [...document.querySelectorAll(s)].every((e) => {
            const r = e.getBoundingClientRect();
            return r.width === 0 || (r.left >= st.left - 1 && r.right <= st.right + 1 && r.top >= st.top - 1 && r.bottom <= st.bottom + 1);
          });
        }, sel) as Promise<boolean>;
      await toChoice(p);
      expect(await inStage(".choices > button"), name).toBe(true);
      await waitFocus(p, ".choices");
      await p.keyboard.press("ArrowDown");
      expect(await focusedLabel(p), name).toBe("三つ目");
      // メニュー: 同じ並びで、ゲームに戻るを選んで開く
      await p.keyboard.press("Escape");
      await waitScreen(p, "menu");
      await waitFocus(p, "[data-lm-screen=menu]");
      expect(await focusedLabel(p), name).toBe("ゲームに戻る");
      expect(await inStage(".lm-menu-panel .lm-button"), name).toBe(true);
      await p.locator(".lm-menu-list button", { hasText: /^セーブ$/ }).click();
      await waitScreen(p, "save");
      expect(await inStage(".lm-slot"), name).toBe(true);
      await p.locator(".lm-slot", { hasText: "No.01" }).click();
      await p.waitForFunction(() => window.__liminalia!.system.slot!(0).empty === false);
      await p.locator(".lm-slot", { hasText: "No.01" }).click();
      await waitScreen(p, "confirm");
      expect(await inStage(".lm-dialog"), name).toBe(true);
      await waitFocus(p, ".lm-dialog-buttons");
      expect(await focusedLabel(p), name).toBe("はい");
      await pad(p, "b");
      await waitScreen(p, "save");
      await pad(p, "b");
      await waitScreen(p, null);
      expect(await focusedIs(p, ".choices"), name).toBe(true);
      await p.close();
    }
  });
});
