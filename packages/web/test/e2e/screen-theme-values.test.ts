import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * テーマの値（liminalia.json と theme.json の ui）で替わる画面を、実際のブラウザの見た目で確かめる。
 * - 結末の名前の画面（ui.ending）: 地、絵、書体、名前の色と大きさと字間、種類の文言の色、罫、終わりの表記の色と大きさと出し方
 * - 確かめと入力の枠（@dialog）、通知（@notify）、短い知らせは、ui.system の色に合わせる（書いていなければ前の暗い色のまま）
 * - 章の扉と章末（ui.chapter）: 地、絵、書体、文字の色、題の大きさと字間、番号の色と大きさ、副題の色と大きさ、罫、終わりの表記の色と大きさ
 */

const SCENARIO = {
  end: `@bg hill_dusk.webp
@window show
はじまり。
@title-screen ending=bad title="沈黙"
`,
  dlg: `@window show
はじまり。
@notify "知らせ"
@dialog type=confirm text="進みますか"
おわり。
`,
  chap: `@window show
はじまり。
@chapter-card number=第一章 title=雨の駅 subtitle=駅の名前 time=3000ms fade=100ms
扉のあと。
@chapter-end number=第一章 title=雨の駅 time=3000ms fade=100ms leave=none
おわり。
`,
};

const ENDING = { background: "rgb(10, 20, 30)", image: "hill_dusk.webp", font: "monospace", color: "rgb(200, 100, 50)", size: 60, letterSpacing: "0.5em", kindColor: "rgb(0, 128, 0)", rule: "rgb(1, 2, 3)", markColor: "rgb(30, 60, 90)", markSize: 30, mark: "above" };
const CHAPTER = { background: "rgb(11, 22, 33)", image: "hill_dusk.webp", font: "monospace", color: "rgb(201, 101, 51)", size: 64, letterSpacing: "0.5em", accent: "rgb(0, 129, 0)", numberSize: 30, subtitleColor: "rgb(2, 3, 4)", subtitleSize: 24, rule: "rgb(5, 6, 7)", endColor: "rgb(31, 61, 91)", endSize: 50 };
const SYSTEM = { theme: "light", fg: "rgb(43, 38, 32)", accent: "rgb(168, 64, 44)", screenBg: "rgb(243, 236, 221)", controlBg: "rgb(230, 220, 200)", border: "rgb(92, 70, 40)" };

describe.skipIf(!e2e)("テーマの値で替わる画面（ブラウザ）", { timeout: 300_000 }, () => {
  let themed: TestProject;
  let markNone: TestProject;
  let ruleNone: TestProject;
  let plain: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    themed = await startProject({ scenario: SCENARIO, config: { entry: "end", ui: { ending: ENDING, chapter: CHAPTER, system: SYSTEM } } });
    markNone = await startProject({ scenario: SCENARIO, config: { entry: "end", ui: { ending: { mark: "none" } } } });
    ruleNone = await startProject({ scenario: SCENARIO, config: { entry: "end", ui: { ending: { rule: "none" }, chapter: { rule: "none" } } } });
    plain = await startProject({ scenario: SCENARIO, config: { entry: "end" } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    for (const p of [themed, markNone, ruleNone, plain]) await p?.close();
  });

  const open = async (browser: Browser, url: string, start: string): Promise<Page> => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await p.goto(`${url}?autostart=1&start=${start}&lang=ja`);
    await p.waitForFunction(`document.querySelector(".message .text")?.textContent.length > 0`, undefined, { timeout: 60_000 });
    return p;
  };
  /** 結末の名前を出し、動きが済むまで待って、部品の見た目を読む。 */
  const ending = async (browser: Browser, url: string) => {
    const p = await open(browser, url, "end");
    for (let i = 0; i < 10 && (await p.locator(".lm-ending").count()) === 0; i++) {
      await p.mouse.click(640, 400);
      await p.waitForTimeout(400);
    }
    await p.waitForSelector(".lm-ending");
    await p.waitForTimeout(2600);
    const look = (await p.evaluate(`(() => {
      const s = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
      const root = s(".lm-ending"), go = s(".lm-ending-go"), kind = s(".lm-ending-kind"), name = s(".lm-ending-name"), rule = s(".lm-ending-rule"), mark = s(".lm-ending-mark");
      const top = (sel) => document.querySelector(sel).getBoundingClientRect().top;
      return {
        bg: root.backgroundColor, image: root.backgroundImage, font: go.fontFamily,
        kind: kind.color, name: [name.color, name.fontSize, name.letterSpacing],
        rule: [rule.display, rule.borderTopColor], mark: [mark.display, mark.color, mark.fontSize],
        markAbove: top(".lm-ending-mark") < top(".lm-ending-name"),
      };
    })()`)) as { bg: string; image: string; font: string; kind: string; name: string[]; rule: string[]; mark: string[]; markAbove: boolean };
    return { p, look };
  };

  it("ui.ending の値で、結末の名前の画面の地、絵、書体、色、大きさ、罫、終わりの表記が替わる", async () => {
    for (const { name, browser } of list) {
      const { p, look } = await ending(browser, themed.url);
      await p.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/ending-theme-${name}.png` }).catch(() => undefined);
      expect(look.bg, name).toBe(ENDING.background);
      expect(look.image, name).toContain("hill_dusk");
      expect(look.font, name).toContain("monospace");
      expect(look.kind, name).toBe(ENDING.kindColor);
      expect(look.name, name).toEqual([ENDING.color, "60px", "30px"]);
      expect(look.rule, name).toEqual(["block", ENDING.rule]);
      expect(look.mark, name).toEqual(["block", ENDING.markColor, "30px"]);
      expect(look.markAbove, name).toBe(true);
      await p.close();

      const plainLook = (await ending(browser, plain.url)).look;
      // 書いていなければシステム画面の色（既定の暗い配色）と、名前の下の終わりの表記
      expect(plainLook.name.slice(0, 2), name).toEqual(["rgb(236, 235, 230)", "48px"]);
      expect(plainLook.image, name).toContain("gradient");
      expect(plainLook.markAbove, name).toBe(false);
      expect(plainLook.rule[0], name).toBe("block");
    }
  });

  it("mark が none なら終わりの表記と罫を出さず、rule が none なら罫だけを出さない", async () => {
    for (const { name, browser } of list) {
      const a = await ending(browser, markNone.url);
      expect([a.look.mark[0], a.look.rule[0]], name).toEqual(["none", "none"]);
      await a.p.close();
      const b = await ending(browser, ruleNone.url);
      expect([b.look.mark[0], b.look.rule[0]], name).toEqual(["block", "none"]);
      await b.p.close();
    }
  });

  /** 章の扉（か章末）を出し、浮かび終わるまで待って、部品の見た目を読む。 */
  const chapter = async (p: Page, selector: string) => {
    for (let i = 0; i < 10 && (await p.locator(selector).count()) === 0; i++) {
      await p.mouse.click(640, 400);
      await p.waitForTimeout(300);
    }
    await p.waitForSelector(selector);
    await p.waitForTimeout(900);
    return (await p.evaluate(`(() => {
      const s = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
      const root = s(".lim-chapter"), title = s(".lim-chapter-title"), number = s(".lim-chapter-number"), rule = s(".lim-chapter-rule"), sub = s(".lim-chapter-subtitle"), end = s(".lim-chapter-end");
      return {
        bg: root.backgroundColor, image: root.backgroundImage, font: root.fontFamily, color: root.color,
        title: [title.fontSize, title.letterSpacing], number: [number.color, number.fontSize],
        rule: rule ? [rule.display, rule.borderTopColor] : null, sub: sub ? [sub.color, sub.fontSize] : null, end: end ? [end.color, end.fontSize] : null,
      };
    })()`)) as { bg: string; image: string; font: string; color: string; title: string[]; number: string[]; rule: string[] | null; sub: string[] | null; end: string[] | null };
  };

  it("ui.chapter の値で、章の扉と章末の地、絵、書体、色、大きさ、罫、終わりの表記が替わる", async () => {
    for (const { name, browser } of list) {
      const p = await open(browser, themed.url, "chap");
      const card = await chapter(p, ".lim-chapter--card");
      await p.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/chapter-theme-${name}.png` }).catch(() => undefined);
      expect(card.bg, name).toBe(CHAPTER.background);
      expect(card.image, name).toContain("hill_dusk");
      expect(card.font, name).toContain("monospace");
      expect(card.color, name).toBe(CHAPTER.color);
      expect(card.title, name).toEqual(["64px", "32px"]);
      expect(card.number, name).toEqual([CHAPTER.accent, "30px"]);
      expect(card.rule, name).toEqual(["block", CHAPTER.rule]);
      expect(card.sub, name).toEqual([CHAPTER.subtitleColor, "24px"]);
      await p.waitForSelector(".lim-chapter--card", { state: "detached", timeout: 10_000 });
      const end = await chapter(p, ".lim-chapter--end");
      expect(parseFloat(end.title[0]!), name).toBeCloseTo((64 * 8) / 13, 1);
      expect(end.end, name).toEqual([CHAPTER.endColor, "50px"]);
      await p.close();

      // 書いていなければ、システム画面の色（既定の暗い配色）と前と同じ大きさ
      const q = await open(browser, plain.url, "chap");
      const plainCard = await chapter(q, ".lim-chapter--card");
      expect([plainCard.color, plainCard.title[0], plainCard.number[1]], name).toEqual(["rgb(236, 235, 230)", "52px", "22px"]);
      expect(plainCard.image, name).toContain("gradient");
      expect(plainCard.rule?.[0], name).toBe("block");
      await q.waitForSelector(".lim-chapter--card", { state: "detached", timeout: 10_000 });
      const plainEnd = await chapter(q, ".lim-chapter--end");
      expect([plainEnd.title[0], plainEnd.end?.[1]], name).toEqual(["32px", "44px"]);
      await q.close();

      // rule が none なら罫を引かない
      const r = await open(browser, ruleNone.url, "chap");
      expect((await chapter(r, ".lim-chapter--card")).rule?.[0], name).toBe("none");
      await r.close();
    }
  });

  it("確かめの枠、通知、短い知らせは ui.system の色に合わせ、書いていなければ暗い色のまま", async () => {
    for (const { name, browser } of list) {
      const read = async (url: string) => {
        const p = await open(browser, url, "dlg");
        for (let i = 0; i < 10 && (await p.locator(".lm-panel-box").count()) === 0; i++) {
          await p.mouse.click(640, 400);
          await p.waitForTimeout(300);
        }
        await p.waitForSelector(".lm-panel-box");
        await p.waitForSelector(".lm-notice");
        await p.evaluate(`window.__liminalia.system.perform("quick-save")`).catch(() => undefined);
        await p.waitForSelector(".lm-toast", { timeout: 10_000 }).catch(() => undefined);
        const look = (await p.evaluate(`(() => {
          const s = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
          const box = s(".lm-panel-box"), button = s(".lm-panel-buttons button"), notice = s(".lm-notice"), toast = s(".lm-sys > .lm-toast");
          return { box: box.borderTopColor, button: [button.backgroundColor, button.color], notice: [notice.backgroundColor, notice.color, notice.borderLeftColor], toast: toast ? toast.backgroundColor : null };
        })()`)) as { box: string; button: string[]; notice: string[]; toast: string | null };
        return { p, look };
      };
      const t = await read(themed.url);
      await t.p.screenshot({ path: `${process.env.LIMINALIA_E2E_SHOTS ?? "/tmp"}/dialog-theme-${name}.png` }).catch(() => undefined);
      expect(t.look.box, name).toBe(SYSTEM.border);
      expect(t.look.button, name).toEqual([SYSTEM.controlBg, SYSTEM.fg]);
      expect(t.look.notice, name).toEqual([SYSTEM.screenBg, SYSTEM.fg, SYSTEM.accent]);
      expect(t.look.toast, name).toBe(SYSTEM.screenBg);
      await t.p.close();
      const d = await read(plain.url);
      expect(d.look.box, name).toBe("rgba(232, 217, 176, 0.4)");
      expect(d.look.button[0], name).toBe("rgba(10, 12, 18, 0.85)");
      expect(d.look.notice[0], name).toBe("rgba(10, 12, 18, 0.86)");
      expect(d.look.toast, name).toBe("rgba(0, 0, 0, 0.78)");
      await d.p.close();
    }
  });
});
