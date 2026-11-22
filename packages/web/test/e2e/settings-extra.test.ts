import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * コンフィグの足りなかった項目（三回目の洗い出しの 26）を、実際のブラウザで確かめる。
 * - スキップの速さ（速い、最速）
 * - 既読の文の色を遊ぶ人が付けるか決める
 * - 行間と、文字の縁取りか影
 * - 画面の揺れと光の点滅を、ほかの動きと分けて弱める
 * - 話者ごとの声の音量を、まだ声を聞いていない人物でも出す（名前を伏せるかは作品の ui.settings.voiceSpeakers）
 */

const pages = Array.from({ length: 12 }, (_, i) => `${i + 1} ページ目。`).join("\n");
const SCENARIO = {
  a: `@bg hill_night.webp
はじまり。
${pages}
おわり。
@stop
`,
  fx: `@bg hill_night.webp
はじまり。
@quake time=600ms
揺れた。
@flash count=3 time=60 gap=60
光った。
@stop
`,
};

describe.skipIf(!e2e)("コンフィグの項目（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let masked: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: SCENARIO, config: { entry: "a", ui: { settings: { voiceSpeakers: "all" } } } });
    masked = await startProject({ scenario: SCENARIO, config: { entry: "a", ui: { text: { readColor: "#ff0000" }, settings: { voiceSpeakers: "masked" } } } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await masked?.close();
  });

  const set = (p: Page, patch: Record<string, unknown>) => p.evaluate((x) => (window as unknown as { __liminalia: { system: { updateSettings(p: unknown): void } } }).__liminalia.system.updateSettings(x), patch);

  it("スキップの速さ: 速いは一ページずつ見せ、最速は今までどおり", async () => {
    for (const { name, browser } of list) {
      const time = async (speed: string) => {
        const p = await openPlayer(browser, project.url, "a");
        await set(p, { skipUnread: true, skipSpeed: speed });
        const start = Date.now();
        await p.evaluate(`void window.__liminalia.system.perform("skip")`);
        await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("おわり"), undefined, { timeout: 30_000 });
        const ms = Date.now() - start;
        await p.close();
        return ms;
      };
      const fastest = await time("fastest");
      const fast = await time("fast");
      expect(fast, name).toBeGreaterThan(12 * 100);
      expect(fast, name).toBeGreaterThan(fastest * 2);
    }
  });

  it("既読の文の色を付けるか、行間、縁取りか影を遊ぶ人が決める", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, masked.url, "a");
      const look = () =>
        p.evaluate(() => {
          const text = document.querySelector<HTMLElement>(".message .text")!;
          const m = document.querySelector<HTMLElement>(".message")!;
          return { color: getComputedStyle(text).color, line: parseFloat(getComputedStyle(m).lineHeight) / parseFloat(getComputedStyle(m).fontSize), shadow: getComputedStyle(m).textShadow };
        });
      await p.evaluate("window.__liminalia.host.setPageRead(true)");
      expect((await look()).color, `${name} 作品の既読の色`).toBe("rgb(255, 0, 0)");
      await set(p, { readColor: "off" });
      expect((await look()).color, `${name} 付けない`).not.toBe("rgb(255, 0, 0)");
      const base = await look();
      await set(p, { lineSpacing: 150 });
      expect((await look()).line / base.line, `${name} 行間`).toBeCloseTo(1.5, 1);
      await set(p, { textEdge: "edge" });
      expect((await look()).shadow, `${name} 縁取り`).toContain("1px 1px 0px");
      await set(p, { textEdge: "none" });
      expect((await look()).shadow, `${name} なし`).toBe("none");
      await p.close();

      // 作品が既読の色を決めていなくても、付けると色が変わる
      const q = await openPlayer(browser, project.url, "a");
      await q.evaluate("window.__liminalia.host.setPageRead(true)");
      const before = await q.evaluate(() => getComputedStyle(document.querySelector(".message .text")!).color);
      await set(q, { readColor: "on" });
      expect(await q.evaluate(() => getComputedStyle(document.querySelector(".message .text")!).color), `${name} 付ける`).not.toBe(before);
      await q.close();
    }
  });

  it("画面の揺れと光の点滅を弱める", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "fx");
      await set(p, { reduceShake: true, reduceFlash: true });
      // 揺れ: 動かさない（はじまりのページを出し終えてから送る）
      await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("▼"), undefined, { timeout: 10_000 });
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(150);
      const moving = await p.evaluate(() => document.querySelector(".stage")!.getAnimations({ subtree: true }).filter((a) => a instanceof CSSAnimation === false && (a.effect as KeyframeEffect | null)?.getKeyframes().some((k) => String(k.transform ?? "").includes("translate("))).length);
      expect(moving, `${name} 揺れ`).toBe(0);
      await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("揺れた"), undefined, { timeout: 10_000 });
      // 点滅: 点滅させずに薄い幕を一度かける
      await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("▼"), undefined, { timeout: 10_000 });
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForSelector(".lim-flash", { state: "attached", timeout: 5000 });
      expect(await p.locator(".lim-flash").getAttribute("class"), `${name} 点滅`).toContain("lim-flash--soft");
      await p.close();
    }
  });

  it("コンフィグの画面に項目が並び、話者ごとの音量は作品が決めればまだ聞いていない人物も出す（伏せるなら？？？）", async () => {
    for (const { name, browser } of list) {
      for (const [proj, want] of [
        [project, "アカリ"],
        [masked, "？？？"],
      ] as const) {
        const p = await openPlayer(browser, proj.url, "a");
        await p.evaluate(`void window.__liminalia.system.perform("config")`);
        await p.waitForSelector(".lm-config");
        const labels = () => p.evaluate(() => [...document.querySelectorAll(".lm-config-rows:not([hidden]) .lm-config-label")].map((e) => e.textContent));
        expect(await labels(), name).toEqual(expect.arrayContaining(["スキップの速さ"]));
        await p.locator(".lm-config .lm-tab", { hasText: "画面" }).click();
        expect(await labels(), name).toEqual(expect.arrayContaining(["既読の文の色", "行間", "文字の縁", "画面の揺れ", "光の点滅"]));
        await p.locator(".lm-config .lm-tab", { hasText: "サウンド" }).click();
        expect((await labels()).some((l) => l?.includes(want)), `${name} ${want}`).toBe(true);
        await p.close();
      }
    }
  });
});
