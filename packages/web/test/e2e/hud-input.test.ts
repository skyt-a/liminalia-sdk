import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 常駐の表示（@hud-button、@hud-text）を、キーボードとゲームパッドだけで遊ぶ人も使えること、遊ぶ人の「文字サイズ」に従うことを、実際のブラウザで確かめる。
 * - key= を書いたボタンは、遊んでいる最中（選択肢を出している間も）にそのキーで押せ、ほかの操作の既定のキー（m のミュート）より先に効く
 * - 矢印キーと十字キーの上下で常駐のボタンを選び、Enter と A で押す。Esc と B で選ぶのをやめる。選んでいなければ十字キーの左右はクイックセーブとクイックロードのまま
 * - 操作説明に、キーを割り当てたボタンが並ぶ
 * - 常駐の文字とボタンの文字は、文字サイズの設定（ui.screen.textScale が message なら従わない）に従う
 * ゲームパッドは getGamepads を真似る（controls.test.ts と同じ）。
 */

const SCENARIO = `@window show
@hud-text day text="一日目" x=40 y=24 size=28
@hud-button memo label=メモ x=980 y=20 call=#memo key=m
@hud-button map label=地図 x=1120 y=20 call=#map
一ページ目。
二ページ目。
@choice
- 進む -> #go
- 残る -> #go
@end

# go
おわり。
@stop

# memo
メモを開いた。
@return

# map
地図を開いた。
@return
`;

const waitText = (p: Page, s: string) => p.waitForFunction((s) => document.querySelector(".message .text")?.textContent?.includes(s) && window.__liminalia!.host.waiting, s, { timeout: 15_000 });
const advance = (p: Page) => p.evaluate("window.__liminalia.host.advance()");
/** 選んでいる常駐のボタンの名前（無ければ null）。 */
const focusedHud = (p: Page) => p.evaluate(() => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".lim-hud-button")?.dataset.hud ?? null);
const fontSize = (p: Page, selector: string) => p.evaluate((s) => parseFloat(getComputedStyle(document.querySelector(s)!).fontSize), selector);

/** 真似たゲームパッドのボタンを押して離す（番号は標準の配置。0: A、1: B、12〜15: 十字キーの上、下、左、右）。 */
async function pad(p: Page, index: number): Promise<void> {
  await p.evaluate(`window.__pad[${index}] = true`);
  await p.waitForTimeout(120);
  await p.evaluate(`window.__pad[${index}] = false`);
  await p.waitForTimeout(120);
}

describe.skipIf(!e2e)("常駐の表示をキーボードとゲームパッドで使い、文字サイズに従う（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let messageOnly: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
    messageOnly = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a", ui: { screen: { textScale: "message" } } } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await messageOnly?.close();
  });

  const open = async (browser: Browser, url: string): Promise<Page> => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await p.addInitScript(() => {
      const w = window as unknown as { __pad: boolean[] };
      w.__pad = Array(16).fill(false);
      navigator.getGamepads = () => [{ buttons: w.__pad.map((pressed) => ({ pressed, value: pressed ? 1 : 0 })), axes: [0, 0] } as unknown as Gamepad];
    });
    await p.goto(`${url}?autostart=1&start=a`);
    await waitText(p, "一ページ目");
    return p;
  };

  it("key= のキーで押せ、ミュートのキーより先に効く。選択肢を出している間も押せる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url);
      expect(await p.locator(".lim-hud-button[data-hud=memo]").getAttribute("aria-keyshortcuts"), name).toBe("M");
      await p.keyboard.press("m");
      await waitText(p, "メモを開いた");
      expect(await p.evaluate("window.__liminalia.system.settings.mute"), name).toBe(false);
      await advance(p);
      await waitText(p, "一ページ目");
      // 大文字（Shift や Caps Lock）でも押せる
      await p.keyboard.press("Shift+M");
      await waitText(p, "メモを開いた");
      await advance(p);
      await waitText(p, "一ページ目");
      await advance(p);
      await waitText(p, "二ページ目");
      await advance(p);
      await p.waitForSelector(".choices button");
      await p.keyboard.press("m");
      await waitText(p, "メモを開いた");
      await advance(p);
      await p.waitForFunction(`document.querySelectorAll(".choices button").length === 2`, null, { timeout: 15_000 });
      await p.close();
    }
  });

  it("矢印キーで選んで Enter で押し、Esc で選ぶのをやめる。押したあとは本文を送るキーで本文が進む", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url);
      await p.keyboard.press("ArrowDown");
      expect(await focusedHud(p), name).not.toBeNull();
      const first = await focusedHud(p);
      await p.keyboard.press(first === "memo" ? "ArrowRight" : "ArrowLeft");
      expect(await focusedHud(p), name).not.toBe(first);
      // 選んだボタンを押す（Enter は本文を送らない）
      const chosen = await focusedHud(p);
      await p.keyboard.press("Enter");
      await waitText(p, chosen === "memo" ? "メモを開いた" : "地図を開いた");
      expect(await focusedHud(p), name).toBeNull();
      await p.keyboard.press("Enter");
      await waitText(p, "一ページ目");
      // Esc は選ぶのをやめるだけ（メニューを開かない）
      await p.keyboard.press("ArrowDown");
      expect(await focusedHud(p), name).not.toBeNull();
      await p.keyboard.press("Escape");
      expect(await focusedHud(p), name).toBeNull();
      expect(await p.evaluate("window.__liminalia.system.status.screen"), name).toBeNull();
      await p.keyboard.press("Enter");
      await waitText(p, "二ページ目");
      await p.close();
    }
  });

  it("十字キーの上下で選んで A で押し、B でやめる。選んでいなければ十字キーの右はクイックセーブ", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url);
      await pad(p, 13);
      expect(await focusedHud(p), name).not.toBeNull();
      await pad(p, 15);
      const chosen = await focusedHud(p);
      expect(chosen, name).not.toBeNull();
      await pad(p, 0);
      await waitText(p, chosen === "memo" ? "メモを開いた" : "地図を開いた");
      await pad(p, 0);
      await waitText(p, "一ページ目");
      await pad(p, 12);
      expect(await focusedHud(p), name).not.toBeNull();
      await pad(p, 1);
      expect(await focusedHud(p), name).toBeNull();
      expect(await p.evaluate("window.__liminalia.system.status.screen"), name).toBeNull();
      await pad(p, 15);
      await p.waitForFunction(`[...document.querySelectorAll(".lm-toast")].some((t) => t.textContent.includes("クイックセーブしました"))`, undefined, { timeout: 5000 });
      await p.close();
    }
  });

  it("操作説明に、キーを割り当てた常駐のボタンが並ぶ", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url);
      await p.evaluate("void window.__liminalia.system.openScreenByName('help')");
      await p.waitForSelector(".lm-help-table");
      const row = await p.evaluate(() => [...document.querySelectorAll(".lm-help-table tbody tr")].map((r) => [...r.children].map((c) => c.textContent)).find((c) => c[0] === "メモ") ?? null);
      expect(row, name).toEqual(["メモ", "クリック、M", "タップ", "十字キーで選んで A"]);
      await p.close();
    }
  });

  it("常駐の文字とボタンの文字は、遊ぶ人の文字サイズに従う（ui.screen.textScale が message なら従わない）", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, project.url);
      expect(await fontSize(p, ".lim-hud-text[data-hud=day]"), name).toBeCloseTo(28, 1);
      const button = await fontSize(p, ".lim-hud-button[data-hud=memo]");
      await p.evaluate("window.__liminalia.system.updateSettings({ textScale: 150 })");
      expect(await fontSize(p, ".lim-hud-text[data-hud=day]"), name).toBeCloseTo(42, 1);
      expect(await fontSize(p, ".lim-hud-button[data-hud=memo]"), name).toBeCloseTo(button * 1.5, 1);
      await p.close();
      const q = await open(browser, messageOnly.url);
      await q.evaluate("window.__liminalia.system.updateSettings({ textScale: 150 })");
      expect(await fontSize(q, ".lim-hud-text[data-hud=day]"), name).toBeCloseTo(28, 1);
      await q.close();
    }
  });
});
