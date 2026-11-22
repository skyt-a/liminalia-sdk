import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, CDPSession, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 指で横になぞって一ページ戻る・進め直す操作と、オート中・スキップ中の表示を、実際のブラウザで確かめる。
 * 指の操作は Chromium の DevTools の口（Input.dispatchTouchEvent）で本物のタッチとして送る（なぞったあとにクリックが来ないことも見る）。
 */

const SCENARIO = `@window show
いちページめ。
にページめ。
@choice
- 甲 -> #a
- 乙 -> #a
@end
# a
さんページめ。
`;

const text = (p: Page) => p.evaluate(`document.querySelector(".message .text").textContent.replace("▼", "")`) as Promise<string>;
const waitText = (p: Page, s: string) => p.waitForFunction((s) => document.querySelector(".message .text")?.textContent?.includes(s) && window.__liminalia!.host.waiting, s, { timeout: 10_000 });

/** 指で (x1, y) から (x2, y) へなぞる。 */
async function swipe(cdp: CDPSession, x1: number, x2: number, y = 300): Promise<void> {
  const steps = 6;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x1, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x1 + ((x2 - x1) * i) / steps, y }] });
    await new Promise((r) => setTimeout(r, 16));
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

describe.skipIf(!e2e)("指で戻る操作とオート中・スキップ中の表示（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("右へなぞると一ページ戻り、左へなぞると進め直す。選択肢を出している間も戻れ、画面の端から始めたものと ui.input.swipeSide: none では何もしない", async () => {
    const chromium = list.find((b) => b.name === "chromium")!;
    const context = await chromium.browser.newContext({ viewport: { width: 1280, height: 720 }, hasTouch: true, isMobile: true });
    const p = await context.newPage();
    const cdp = await context.newCDPSession(p);
    await p.goto(`${project.url}?autostart=1&start=a`);
    await waitText(p, "いちページめ");
    await p.evaluate("window.__liminalia.host.advance()");
    await waitText(p, "にページめ");
    await swipe(cdp, 400, 700);
    await waitText(p, "いちページめ");
    await p.waitForTimeout(300);
    // なぞったあとにクリック（送り）が来ていない
    expect(await text(p)).toContain("いちページめ");
    await swipe(cdp, 700, 400);
    await waitText(p, "にページめ");
    // 選択肢を出している間も戻れる
    await p.evaluate("window.__liminalia.host.advance()");
    await p.waitForSelector(".choices button");
    await swipe(cdp, 400, 700);
    await waitText(p, "にページめ");
    // 端（左から 24px 以内）から始めたものは戻らない
    await swipe(cdp, 10, 300);
    await p.waitForTimeout(400);
    expect(await text(p)).toContain("にページめ");
    // 作品の設定で外す
    await p.evaluate(`window.__liminalia.system.env.project.ui = { input: { swipeSide: "none" } }`);
    await swipe(cdp, 400, 700);
    await p.waitForTimeout(400);
    expect(await text(p)).toContain("にページめ");
    await context.close();
  });

  it("オート中・スキップ中は小さな表示を出し、ui.indicator で位置を替えたり出さなくしたりできる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await waitText(p, "いちページめ");
      const indicator = p.locator(".lm-indicator");
      expect(await indicator.isHidden(), name).toBe(true);
      // 確かめている間にオートで進まないように
      await p.evaluate(`window.__liminalia.system.updateSettings({ autoWait: 5000 })`);
      await p.evaluate(`window.__liminalia.system.perform("auto")`);
      expect(await indicator.isVisible(), name).toBe(true);
      expect([await indicator.getAttribute("data-state"), await indicator.textContent()], name).toEqual(["auto", "オート"]);
      expect(await indicator.evaluate((e) => e.classList.contains("lm-indicator-at-top-left")), name).toBe(true);
      await p.screenshot({ path: `${process.env.LIMINALIA_SHOT_DIR ?? "/tmp"}/indicator-auto-${name}.png` }).catch(() => undefined);
      // 画面を開いている間は出さない
      await p.evaluate("window.__liminalia.system.openConfig()");
      expect(await indicator.isHidden(), name).toBe(true);
      await p.keyboard.press("Escape");
      // オートを止めると消える
      await p.evaluate(`window.__liminalia.system.perform("auto")`);
      expect(await indicator.isHidden(), name).toBe(true);
      // 位置を替える・出さない（作品の設定）
      await p.evaluate(`window.__liminalia.system.env.project.ui = { indicator: "bottom-right" }`);
      await p.evaluate(`window.__liminalia.system.perform("auto")`);
      expect(await indicator.evaluate((e) => e.classList.contains("lm-indicator-at-bottom-right")), name).toBe(true);
      await p.evaluate(`window.__liminalia.system.perform("auto")`);
      await p.evaluate(`window.__liminalia.system.env.project.ui = { indicator: "hidden" }`);
      await p.evaluate(`window.__liminalia.system.perform("auto")`);
      expect(await indicator.isHidden(), name).toBe(true);
      await p.close();
    }
  });
});
