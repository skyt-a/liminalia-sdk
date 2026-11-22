import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * クリックで演出を早送りする（背景の切り替え、ルールの切り替え、カメラ、暗転、@wait）と、
 * skip=false の命令・ui.input.skipEffects: false では早送りしないことを、実際のブラウザで確かめる。
 */

const SCENARIO = `@bg hill_night.webp
@window show
はじめ。
@bg hill_morning.webp time=4s
背景。
@bg hill_dusk.webp time=4s pattern=wipe-right
ルール。
@camera zoom=1.5 time=4s
カメラ。
@mask time=4s
@mask-off time=4s
暗転。
@wait 4s
待ち。
@motion-text 見出しの文字 x=200 y=200 time=4s
文字の演出。
@wait 1500ms skip=false
止めない待ち。
`;

const text = (p: Page) => p.evaluate(`document.querySelector(".message .text")?.textContent.replace("▼", "") ?? ""`) as Promise<string>;

/** 今のページを送り、次のページが出るまで 250 ミリ秒ごとに押し続ける。次のページが出るまでの時間（ミリ秒）を返す。 */
async function advanceAndPress(p: Page, next: string): Promise<number> {
  await p.waitForTimeout(300);
  const start = Date.now();
  await p.evaluate("window.__liminalia.host.advance()");
  const shown = () => p.evaluate(`document.querySelector(".message .text")?.textContent.startsWith(${JSON.stringify(next)}) === true`) as Promise<boolean>;
  while (!(await shown())) {
    if (Date.now() - start > 15_000) throw new Error(`${next} が出ません`);
    await p.waitForTimeout(250);
    if (!(await shown())) await p.evaluate("window.__liminalia.host.advance()");
  }
  return Date.now() - start;
}

describe.skipIf(!e2e)("クリックで演出を早送りする（ブラウザ）", { timeout: 240_000 }, () => {
  let on: TestProject;
  let off: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    on = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
    off = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a", ui: { input: { skipEffects: false } } } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await on?.close();
    await off?.close();
  });

  it("背景、ルール、カメラ、暗転、@wait はクリックで終わりまで飛び、skip=false の待ちは飛ばない", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, on.url, "a");
      expect(await text(p), name).toBe("はじめ。");
      expect(await advanceAndPress(p, "背景。"), name).toBeLessThan(2500);
      // 終わりの姿: 新しい背景だけが残っている
      expect(await p.evaluate(`[...document.querySelectorAll(".background img")].map((i) => i.dataset.bg)`), name).toEqual(["hill_morning.webp"]);
      expect(await advanceAndPress(p, "ルール。"), name).toBeLessThan(2500);
      expect(await p.evaluate(`[...document.querySelectorAll(".background img")].map((i) => i.dataset.bg + ":" + (i.style.maskImage || ""))`), name).toEqual(["hill_dusk.webp:"]);
      expect(await advanceAndPress(p, "カメラ。"), name).toBeLessThan(2500);
      expect(await p.evaluate(`new DOMMatrix(getComputedStyle(document.querySelector(".camera")).transform).a`), name).toBeCloseTo(1.5, 2);
      // 暗転と、戻すのとで二回
      expect(await advanceAndPress(p, "暗転。"), name).toBeLessThan(3500);
      expect(await advanceAndPress(p, "待ち。"), name).toBeLessThan(2500);
      // 作品の命令（標準の @motion-text）: 出す、留める（ctx.delay）、消すの三段を、一度押せば描き終わるまで飛ばす
      expect(await advanceAndPress(p, "文字の演出。"), name).toBeLessThan(2000);
      // skip=false は押しても待ち切る
      expect(await advanceAndPress(p, "止めない待ち。"), name).toBeGreaterThanOrEqual(1400);
      await p.close();
    }
  });

  it("ui.input.skipEffects: false なら押しても飛ばない", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, off.url, "a");
      expect(await advanceAndPress(p, "背景。"), name).toBeGreaterThanOrEqual(3800);
      await p.close();
    }
  });
});
