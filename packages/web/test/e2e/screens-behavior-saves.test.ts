import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";
import { dialogOf, events, focusedIs, focusedLabel, focusProbe, onProbe, open, pad, recordEvents, screenNow, waitFocus, waitMode, waitScreen, waitText } from "./screens-behavior-shared.ts";

/**
 * 標準の画面の今の動き（セーブとロード、履歴）を固定する。0.4.0 で画面を HTML の型と印で組み直しても、同じテストが通ること。
 * DOM の作りは見ず、遊ぶ人から見える動きと、作品の CSS が当てる部品のクラス（screen-catalog.ts の parts と classes）で確かめる。
 * メモ・保護・コピー・移動の細かい動き（save-tools）、選んだ選択肢の履歴（backlog-choice）、履歴から戻る（rollback）とは重ねない。
 */

const SCENARIO = `@window show
一ページ目。
ソウ「二ページ目の台詞。」
三ページ目。
四ページ目。
五ページ目。
`;

/** 履歴が画面に収まらないほど長い台本。 */
const LONG = `@window show
${Array.from({ length: 40 }, (_, i) => `長い履歴の${i + 1}ページ目。とても長い文が続いて、一行に収まらずに折り返す。とても長い文が続いて、一行に収まらずに折り返す。`).join("\n")}
`;

const slot = (p: Page, label: string) => p.locator(".lm-slot", { hasText: label });
const slotText = (p: Page, label: string) => slot(p, label).locator(".lm-slot-text").textContent();
/** 押された（aria-pressed が true の）タブの文字。 */
const pressedTab = (p: Page) => p.locator(".lm-tab[aria-pressed=true]").allTextContents();
const toasts = (p: Page) => p.locator(".lm-toast").allTextContents();
/** 送ってその文字が出るまで待つ。 */
const advanceTo = async (p: Page, text: string) => {
  await p.evaluate(() => window.__liminalia!.host.advance());
  await waitText(p, text);
};

describe.skipIf(!e2e)("標準の画面の今の動き: セーブとロード、履歴（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let long: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
    long = await startProject({ scenario: { long: LONG }, config: { entry: "long" } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await long?.close();
  });

  it("セーブ: 開くと画面の根にフォーカスし、ページのタブとスロットを出す。空きに書くと知らせ、使っているスロットは上書きを確かめ、保護したスロットには書かない", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await recordEvents(p);
      await focusProbe(p);
      await p.evaluate(() => void window.__liminalia!.system.perform!("save"));
      await waitScreen(p, "save");
      expect(await dialogOf(p, "save"), name).toEqual({ role: "dialog", modal: "true", label: "セーブ" });
      for (const cls of [".lm-saveload", ".lm-slots", ".lm-slot", ".lm-slot-thumb", ".lm-slot-name", ".lm-slot-text", ".lm-slot-date", ".lm-screen-title", ".lm-tab", ".lm-close"]) {
        expect(await p.locator(cls).count(), `${name} ${cls}`).toBeGreaterThan(0);
      }
      await p.waitForFunction(() => document.activeElement === document.querySelector("[data-lm-screen=save]"));
      // セーブはページ 1〜6（クイックとオートのページは無い）。開いたのは 1 ページ目で、8 枠とも空き（押せる）
      expect(await p.locator(".lm-tab").allTextContents(), name).toEqual(["1", "2", "3", "4", "5", "6"]);
      expect(await pressedTab(p), name).toEqual(["1"]);
      expect(await p.locator(".lm-slot-name").allTextContents(), name).toEqual(["No.01", "No.02", "No.03", "No.04", "No.05", "No.06", "No.07", "No.08"]);
      expect(new Set(await p.locator(".lm-slot-text").allTextContents()), name).toEqual(new Set(["空き"]));
      expect(await p.locator(".lm-slot:disabled").count(), name).toBe(0);
      expect(await p.locator(".lm-slot-tool").count(), name).toBe(0);
      // 矢印で最初のタブ、下へでスロットを選ぶ
      await p.keyboard.press("ArrowDown");
      expect(await focusedLabel(p), name).toBe("1");
      await p.keyboard.press("ArrowDown");
      expect(await focusedIs(p, ".lm-slot"), name).toBe(true);
      expect(await focusedLabel(p), name).toContain("No.01");
      // Enter で空きに書く（確かめない）。本文の頭と日時を出し、知らせる
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => window.__liminalia!.system.slot!(0).empty === false);
      expect(await slotText(p, "No.01"), name).toBe("一ページ目。");
      expect((await slot(p, "No.01").locator(".lm-slot-date").textContent())!.length, name).toBeGreaterThan(0);
      expect(await toasts(p), name).toContain("セーブしました");
      // 使っているスロットにはメモ、保護、コピー、移動、削除のボタン
      expect(await p.locator(".lm-slot-tool").allTextContents(), name).toEqual(["メモ", "保護", "コピー", "移動", "削除"]);
      // 遊んでいる最中のキー（PageDown は進め直し、B はバックログ）は効かず、ページも変わらない
      await p.keyboard.press("PageDown");
      await p.keyboard.press("b");
      expect([(await screenNow(p)).screen, await pressedTab(p)], name).toEqual(["save", ["1"]]);
      await pad(p, "rb");
      await pad(p, "lb");
      expect([(await screenNow(p)).screen, await pressedTab(p)], name).toEqual(["save", ["1"]]);

      // 本文を進めてから、使っているスロットを押すと上書きを確かめる。いいえ（Esc）なら書かず、押したスロットへフォーカスを戻す
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      await advanceTo(p, "二ページ目");
      await p.evaluate(() => void window.__liminalia!.system.perform!("save"));
      await waitScreen(p, "save");
      await slot(p, "No.01").focus();
      await slot(p, "No.01").press("Enter");
      await waitScreen(p, "confirm");
      expect(await p.locator(".lm-dialog-message").textContent(), name).toBe("No.01 に上書きしますか？");
      await waitFocus(p, ".lm-dialog-buttons");
      await p.keyboard.press("Escape");
      await waitScreen(p, "save");
      expect(await focusedIs(p, ".lm-slot"), name).toBe(true);
      expect(await slotText(p, "No.01"), name).toBe("一ページ目。");
      // はいなら書く
      await slot(p, "No.01").click();
      await waitFocus(p, ".lm-dialog-buttons");
      await p.keyboard.press("Enter");
      await waitScreen(p, "save");
      await p.waitForFunction(() => !!document.querySelector(".lm-slot .lm-slot-text")?.textContent?.includes("二ページ目の台詞"));
      // 保護したスロットは確かめずに断る
      await p.locator(".lm-slot-tool", { hasText: "保護" }).click();
      expect(await slot(p, "No.01").locator(".lm-slot-lock").textContent(), name).toBe("保護中");
      expect(await slot(p, "No.01").evaluate((b) => b.classList.contains("is-locked")), name).toBe(true);
      await slot(p, "No.01").click();
      await p.waitForFunction(() => [...document.querySelectorAll(".lm-toast")].some((t) => t.textContent === "保護されているスロットです"));
      expect((await screenNow(p)).screen, name).toBe("save");
      // 2 ページ目の 10 番に書くと、次に開いたときは 2 ページ目から
      await p.locator(".lm-tab", { hasText: "2" }).click();
      expect(await pressedTab(p), name).toEqual(["2"]);
      expect(await p.locator(".lm-slot-name").first().textContent(), name).toBe("No.09");
      await slot(p, "No.10").click();
      await p.waitForFunction(() => window.__liminalia!.system.slot!(9).empty === false);
      // 閉じるボタンで閉じ、開く前のところへ戻す
      await p.locator(".lm-saveload .lm-close").click();
      await waitScreen(p, null);
      expect(await onProbe(p), name).toBe(true);
      await p.evaluate(() => void window.__liminalia!.system.perform!("save"));
      await waitScreen(p, "save");
      expect(await pressedTab(p), name).toEqual(["2"]);
      // 右クリック、パッドの B でも閉じる
      await p.mouse.click(640, 360, { button: "right" });
      await waitScreen(p, null);
      await p.evaluate(() => void window.__liminalia!.system.perform!("save"));
      await waitScreen(p, "save");
      await pad(p, "b");
      await waitScreen(p, null);
      expect((await events(p)).filter((e) => e.endsWith(":save")).length, name).toBe(8);
      await p.close();
    }
  });

  it("ロード: オートとクイックのページを先に並べ、いちばん新しいセーブのページで開き、空きは押せない。ゲーム中は確かめてからロードし、削除はいつも確かめる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      expect(await p.evaluate(() => window.__liminalia!.system.saveTo!(0)), name).toBe(true);
      await advanceTo(p, "二ページ目");
      await advanceTo(p, "三ページ目");
      await p.keyboard.press("s");
      await p.waitForFunction(() => [...document.querySelectorAll(".lm-toast")].some((t) => t.textContent === "クイックセーブしました"));
      await advanceTo(p, "四ページ目");
      await p.evaluate(() => void window.__liminalia!.system.perform!("load"));
      await waitScreen(p, "load");
      expect(await dialogOf(p, "load"), name).toEqual({ role: "dialog", modal: "true", label: "ロード" });
      // A（オートセーブ。読み上げの名前は「オートセーブ」）、Q、1〜6。いちばん新しいのはクイックセーブ
      expect(await p.locator(".lm-tab").allTextContents(), name).toEqual(["A", "Q", "1", "2", "3", "4", "5", "6"]);
      expect(await p.locator(".lm-tab").first().getAttribute("aria-label"), name).toBe("オートセーブ");
      expect(await pressedTab(p), name).toEqual(["Q"]);
      expect(await p.locator(".lm-slot-name").first().textContent(), name).toBe("クイック");
      expect(await p.locator(".lm-slot-text").first().textContent(), name).toBe("三ページ目。");
      // 番号のページ: 空きは押せない
      await p.locator(".lm-tab", { hasText: "1" }).click();
      expect(await slot(p, "No.01").isDisabled(), name).toBe(false);
      expect(await slot(p, "No.02").isDisabled(), name).toBe(true);
      expect(await slotText(p, "No.02"), name).toBe("空き");
      // ゲーム中のロードは確かめる。いいえなら残る
      await slot(p, "No.01").click();
      await waitScreen(p, "confirm");
      expect(await p.locator(".lm-dialog-message").textContent(), name).toBe("No.01 をロードしますか？\n現在の進行状況は失われます。");
      await waitFocus(p, ".lm-dialog-buttons");
      await pad(p, "b");
      await waitScreen(p, "load");
      // はいならロードし、画面を閉じてセーブしたページへ
      await slot(p, "No.01").click();
      await waitFocus(p, ".lm-dialog-buttons");
      await pad(p, "a");
      await waitScreen(p, null);
      await waitText(p, "一ページ目");
      // 削除は確かめ（コンフィグで確認を省いていても）、消したら知らせて空きにする
      await p.evaluate(() => window.__liminalia!.system.updateSettings!({ confirm: false }));
      await p.evaluate(() => void window.__liminalia!.system.perform!("load"));
      await waitScreen(p, "load");
      await p.locator(".lm-tab", { hasText: "1" }).click();
      await p.locator(".lm-slot-tool", { hasText: "削除" }).click();
      await waitScreen(p, "confirm");
      expect(await p.locator(".lm-dialog-message").textContent(), name).toBe("No.01 を削除しますか？");
      await waitFocus(p, ".lm-dialog-buttons");
      await p.keyboard.press("Enter");
      await waitScreen(p, "load");
      await p.waitForFunction(() => [...document.querySelectorAll(".lm-toast")].some((t) => t.textContent === "削除しました"));
      expect(await slotText(p, "No.01"), name).toBe("空き");
      expect(await p.evaluate(() => window.__liminalia!.system.slot!(0).empty), name).toBe(true);
      await p.close();
    }
  });

  it("ロード: タイトルの「つづきから」で開き、確かめずにロードする。セーブが無ければ「つづきから」は押せない", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url);
      expect(await p.locator(".lm-title-button", { hasText: "つづきから" }).isDisabled(), name).toBe(true);
      await p.locator(".lm-title-button", { hasText: "はじめから" }).click();
      await waitText(p, "一ページ目");
      await advanceTo(p, "二ページ目");
      expect(await p.evaluate(() => window.__liminalia!.system.saveTo!(2)), name).toBe(true);
      await p.keyboard.press("Escape");
      await waitFocus(p, "[data-lm-screen=menu]");
      await p.locator(".lm-menu-list button", { hasText: "タイトルへ" }).click();
      await waitFocus(p, ".lm-dialog-buttons");
      await p.keyboard.press("Enter");
      await waitMode(p, "title");
      const cont = p.locator(".lm-title-button", { hasText: "つづきから" });
      expect(await cont.isDisabled(), name).toBe(false);
      await cont.focus();
      await cont.press("Enter");
      await waitScreen(p, "load");
      // タイトルから開いたロードを閉じると「つづきから」へ戻る
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      expect(await focusedLabel(p), name).toBe("つづきから");
      await cont.click();
      await waitScreen(p, "load");
      expect(await pressedTab(p), name).toEqual(["1"]);
      await slot(p, "No.03").click();
      await waitMode(p, "game");
      await waitText(p, "二ページ目");
      expect((await screenNow(p)).screen, name).toBeNull();
      await p.close();
    }
  });

  it("履歴: B、ホイール上、パッドの Y で開き、本文と話者を古い順に並べて一番下を見せる。Esc・閉じるボタン・右クリック・パッドの B と Y・一番下でのホイール下で閉じる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await advanceTo(p, "二ページ目");
      await advanceTo(p, "三ページ目");
      await recordEvents(p);
      await focusProbe(p);
      await p.keyboard.press("b");
      await waitScreen(p, "backlog");
      expect(await dialogOf(p, "backlog"), name).toEqual({ role: "dialog", modal: "true", label: "バックログ" });
      for (const cls of [".lm-backlog", ".lm-log", ".lm-log-name", ".lm-log-text", ".lm-log-search", ".lm-screen-title", ".lm-close"]) expect(await p.locator(cls).count(), `${name} ${cls}`).toBeGreaterThan(0);
      // 開いたら一覧にフォーカス
      await waitFocus(p, ".lm-log");
      expect(await p.locator(".lm-log-text").allTextContents(), name).toEqual(["一ページ目。", "「二ページ目の台詞。」", "三ページ目。"]);
      expect(await p.locator(".lm-log-name").allTextContents(), name).toEqual(["", "ソウ", ""]);
      // 今のページ（最後）のほかは「ここに戻る」
      expect(await p.locator(".lm-log-jump").count(), name).toBe(2);
      // 検索欄（読み上げの名前は「バックログを検索」）。矢印の最初の一押しで選ぶ
      expect(await p.locator(".lm-log-search").getAttribute("aria-label"), name).toBe("バックログを検索");
      await p.keyboard.press("ArrowDown");
      expect(await focusedIs(p, ".lm-log-search"), name).toBe(true);
      // 打つと当たったページの数を出し、当たったページだけが見える（0.4.0 の段 f2 で直した。前は .lm-log-entry の display: grid が hidden を上書きして消えなかった）。
      // 入力中の Esc は文字を消すだけ、もう一度で閉じる
      await p.locator(".lm-log-search").fill("台詞");
      await p.locator("[data-lm-screen=backlog]").getByText("1 件", { exact: true }).waitFor();
      expect(await p.locator(".lm-log-text:visible").allTextContents(), name).toEqual(["「二ページ目の台詞。」"]);
      await p.keyboard.press("Escape");
      expect([await p.locator(".lm-log-search").inputValue(), (await screenNow(p)).screen], name).toEqual(["", "backlog"]);
      expect(await p.locator(".lm-log-text:visible").count(), name).toBe(3);
      // 入力欄で打った b は閉じず、ほかの操作にもならない
      await p.keyboard.type("b");
      expect((await screenNow(p)).screen, name).toBe("backlog");
      await p.keyboard.press("Backspace");
      await p.keyboard.press("Escape");
      await waitScreen(p, null);
      expect(await onProbe(p), name).toBe(true);
      expect(await events(p), name).toEqual(["screen-open:backlog", "screen-close:backlog"]);

      // ホイール上で開き、パッドの Y で閉じる
      await p.mouse.move(640, 300);
      await p.mouse.wheel(0, -200);
      await waitScreen(p, "backlog");
      await pad(p, "y");
      await waitScreen(p, null);
      // パッドの Y で開き、B で閉じる
      await pad(p, "y");
      await waitScreen(p, "backlog");
      await pad(p, "b");
      await waitScreen(p, null);
      // 右クリック、閉じるボタン
      await p.keyboard.press("b");
      await waitScreen(p, "backlog");
      await p.mouse.click(640, 360, { button: "right" });
      await waitScreen(p, null);
      await p.keyboard.press("b");
      await waitScreen(p, "backlog");
      await p.locator(".lm-backlog .lm-close").click();
      await waitScreen(p, null);
      // 一番下でホイールを下へ回すと閉じる（開いた直後の 400ms の慣性は捨てる）
      await p.keyboard.press("b");
      await waitScreen(p, "backlog");
      await p.evaluate(() => new Promise((r) => setTimeout(r, 450)));
      const box = (await p.locator(".lm-log").boundingBox())!;
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.mouse.wheel(0, 200);
      await waitScreen(p, null);
      // 閉じても本文は進めない
      await waitText(p, "三ページ目");
      await p.close();
    }
  });

  it("履歴: 「ここに戻る」は確かめ、いいえなら履歴に残ってそのボタンへ戻り、はいならそのページから読み直す。長い履歴は一番下を見せる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url, { start: "a" });
      await advanceTo(p, "二ページ目");
      await advanceTo(p, "三ページ目");
      await pad(p, "y");
      await waitScreen(p, "backlog");
      const jump = p.locator(".lm-log-jump").first();
      expect(await jump.textContent(), name).toBe("ここに戻る");
      await jump.focus();
      await jump.press("Enter");
      await waitScreen(p, "confirm");
      expect(await p.locator(".lm-dialog-message").textContent(), name).toBe("このページまで戻りますか？\n以降の進行状況は失われます。");
      await waitFocus(p, ".lm-dialog-buttons");
      await p.keyboard.press("Escape");
      await waitScreen(p, "backlog");
      expect(await focusedLabel(p), name).toBe("ここに戻る");
      await jump.click();
      await waitFocus(p, ".lm-dialog-buttons");
      await p.keyboard.press("Enter");
      await waitScreen(p, null);
      await waitText(p, "一ページ目");
      await p.close();

      const q = await open(browser, long.url, { start: "long" });
      for (let i = 2; i <= 30; i++) await advanceTo(q, `長い履歴の${i}ページ目`);
      await q.keyboard.press("b");
      await waitScreen(q, "backlog");
      await waitFocus(q, ".lm-log");
      const at = await q.evaluate(() => {
        const l = document.querySelector<HTMLElement>(".lm-log")!;
        return { scrolls: l.scrollHeight > l.clientHeight, bottom: l.scrollTop + l.clientHeight >= l.scrollHeight - 2 };
      });
      expect(at, name).toEqual({ scrolls: true, bottom: true });
      expect(await q.locator(".lm-log-text").count(), name).toBe(30);
      await q.close();
    }
  });
});
