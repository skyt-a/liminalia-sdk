import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, TEST_FONT, type TestProject } from "./harness.ts";

/**
 * 本文の組み方を、Chromium と WebKit（iOS・Safari と同じ描き方）で測る。WebKit だけで崩れる不具合
 * （ルビが左にずれる・文字送りの途中で行が下がる。3afdeac）を、実機より先に見つけるため。
 * - 横書き・NVL・縦書きで、ルビが親文字の中央（縦書きは右）に載る
 * - 文字送りの途中で、ルビの付いた所が出ても行が動かない
 * - ui.text の数値（ルビの大きさと間・一行の字数・段落の間）と ui.glyph（印の大きさと間）が効く
 */

const LINE = "あいうえおかきくけこさしすせそ{r 櫻羽|おうば}たちつてとなにぬねのはひふへほ{r 紫|ゆかり}まみむめも。";

/** 一つ目のルビと親文字（縦書きは親文字の箱）の位置、最初の文字の上端、最初の行の字数、印の大きさと余白。 */
async function measure(p: Page, vertical: boolean) {
  return (await p.evaluate(`(() => {
    const r = document.querySelector(".message .text .ruby"); const t = r.querySelector(".rt");
    const range = document.createRange(); range.selectNodeContents(r.firstChild);
    // 縦書きは親文字を一字ぶんの箱に入れて、その右端から置く。文字の範囲はフォントの上下の余白で 1em より広くなることがある（Linux の CJK フォント）ので箱で測る
    const g = ${vertical} ? r.getBoundingClientRect() : range.getBoundingClientRect(); const c = t.getBoundingClientRect();
    const chs = [...document.querySelectorAll(".message .text .ch")]; const first = chs[0].getBoundingClientRect();
    const line = chs.filter((e) => { const b = e.getBoundingClientRect(); return ${vertical} ? Math.abs(b.left - first.left) < 4 : Math.abs(b.top - first.top) < 4; }).length;
    const glyph = document.querySelector(".message .glyph"); const gs = glyph && getComputedStyle(glyph);
    return {
      centerX: (c.left + c.width / 2) - (g.left + g.width / 2), centerY: (c.top + c.height / 2) - (g.top + g.height / 2),
      above: g.top - c.bottom, right: c.left - g.right, rubyPx: parseFloat(getComputedStyle(t).fontSize),
      top: first.top, left: first.left, line,
      advance: ${vertical} ? chs[1].getBoundingClientRect().top - first.top : chs[1].getBoundingClientRect().left - first.left,
      glyph: gs ? { size: parseFloat(gs.fontSize), gap: parseFloat(${vertical} ? gs.marginTop : gs.marginLeft) } : null,
    };
  })()`)) as { centerX: number; centerY: number; above: number; right: number; rubyPx: number; top: number; left: number; line: number; advance: number; glyph: { size: number; gap: number } | null };
}

describe.skipIf(!e2e)("本文の組み方（Chromium と WebKit）", { timeout: 300_000 }, () => {
  let list: { name: string; browser: Browser }[];
  const projects: TestProject[] = [];
  beforeAll(async () => {
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    for (const p of projects) await p.close();
  });

  // OS の書体で値が変わらないよう、テストの書体（和文は横も縦も一字 1em）で組む
  const FONT = { files: { "assets/others/test-font.ttf": TEST_FONT } };
  const withFont = (ui: Record<string, unknown> = {}) => ({ ...ui, text: { fontFile: "test-font.ttf", ...(ui.text as object) } });
  const open = async (scenario: string, ui?: Record<string, unknown>) => {
    const project = await startProject({ scenario: { a: scenario }, config: { ui: withFont(ui) }, ...FONT });
    projects.push(project);
    return project;
  };

  it("横書き: ルビは親文字の上の中央、文字送りの途中で行が動かない", async () => {
    const project = await open(`@window show\n${LINE}\n`);
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      expect(await p.evaluate(`[...document.fonts].filter((f) => f.status === "loaded").length`), `${name} テストの書体`).toBeGreaterThan(0);
      const before = (await p.evaluate(`document.querySelector(".message .text .ch").getBoundingClientRect().top`)) as number;
      await p.waitForSelector(".message .text .ruby .rt");
      await p.waitForTimeout(1500);
      const m = await measure(p, false);
      expect(Math.abs(m.centerX), name).toBeLessThanOrEqual(1);
      expect(Math.abs(m.above), name).toBeLessThanOrEqual(1);
      expect(m.top, `${name} 行の上端（文字送りの前後）`).toBeCloseTo(before, 0);
      await p.close();
    }
  });

  it("NVL と縦書き: ルビの位置（縦書きは親文字の右・上下の中央）", async () => {
    const project = await open(`@window show\n@nvl on\n${LINE}\n@nvl off\n@vertical on\n${LINE}\n`);
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.mouse.click(640, 360);
      await p.waitForTimeout(300);
      const nvl = await measure(p, false);
      expect(Math.abs(nvl.centerX), `${name} NVL`).toBeLessThanOrEqual(1);
      await p.mouse.click(640, 360);
      await p.waitForSelector(".message.vertical .ruby");
      await p.mouse.click(640, 360);
      await p.waitForTimeout(300);
      const v = await measure(p, true);
      expect(Math.abs(v.centerY), `${name} 縦書き`).toBeLessThanOrEqual(1);
      expect(Math.abs(v.right), `${name} 縦書き`).toBeLessThanOrEqual(1);
      await p.close();
    }
  });

  it("ui.text・ui.glyph の数値が効く（ルビの大きさと間・一行の字数・印）", async () => {
    const ui = { text: { rubySize: 0.5, rubyGap: 0.2, lineChars: 10 }, glyph: { size: 1, gap: 0.5 } };
    const horizontal = await open(`@window show\n${LINE}\n`, ui);
    const vertical = await open(`@window show\n@vertical on\n${LINE}\n`, ui);
    for (const { name, browser } of list) {
      for (const [project, isVertical] of [[horizontal, false], [vertical, true]] as const) {
        const p = await openPlayer(browser, project.url, "a");
        await p.mouse.click(640, 360);
        await p.waitForTimeout(400);
        const m = await measure(p, isVertical);
        const label = `${name} ${isVertical ? "縦" : "横"}`;
        expect(m.rubyPx, label).toBeCloseTo(13, 0);
        // 親文字 26px の 0.2 倍 = 5.2px
        expect(isVertical ? m.right : m.above, label).toBeGreaterThanOrEqual(4);
        expect(isVertical ? m.right : m.above, label).toBeLessThanOrEqual(6);
        expect(m.line, `${label} 一字の送り ${m.advance}px`).toBe(10);
        expect(m.glyph, label).toEqual({ size: 26, gap: 13 });
        await p.close();
      }
    }
  });

  it("NVL の段落の間（ui.text.paragraphGap）", async () => {
    const project = await open("@window show\n@nvl on\n一つ目の段落。\n二つ目の段落。\n", { text: { paragraphGap: 0 } });
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.mouse.click(640, 360);
      await p.mouse.click(640, 360);
      await p.waitForTimeout(400);
      const gap = (await p.evaluate(`(() => { const [a, b] = [...document.querySelectorAll(".nvl-page")]; return b.getBoundingClientRect().top - a.getBoundingClientRect().bottom; })()`)) as number;
      expect(Math.abs(gap), name).toBeLessThanOrEqual(1);
      await p.close();
    }
  });

  it("枠の位置（ui.message）と NVL の切り替え、作品の CSS が弱いセレクタで勝つ", async () => {
    const plugin = `import { defineWebPlugin } from "@liminalia/web";
export default defineWebPlugin({ name: "t", setup() {
  const s = document.createElement("style");
  // エンジンの .message.nvl .nvl-page・.message .text より弱いセレクタ
  s.textContent = ".nvl-page { margin-block-end: 11px; } .text { color: rgb(255, 0, 0); }";
  document.head.append(s);
} });`;
    const project = await startProject({
      scenario: { a: "@window show\n枠の中。\n@nvl on\n一つ目。\n二つ目。\n@nvl off\n戻った。\n" },
      plugin,
      config: { ui: withFont({ message: { x: 100, y: 400, width: 600, height: 200 } }) },
      ...FONT,
    });
    projects.push(project);
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      const rect = () => p.evaluate(`(() => { const r = document.querySelector(".message").getBoundingClientRect(); const s = document.querySelector(".stage").getBoundingClientRect(); const k = s.width / 1280; return [Math.round((r.left - s.left) / k), Math.round((r.top - s.top) / k), Math.round(r.width / k), Math.round(r.height / k)]; })()`);
      expect(await rect(), `${name} ui.message`).toEqual([100, 400, 600, 200]);
      expect(await p.evaluate(`getComputedStyle(document.querySelector(".message .text")).color`), `${name} 作品の CSS`).toBe("rgb(255, 0, 0)");
      await p.mouse.click(900, 100);
      await p.mouse.click(900, 100);
      await p.mouse.click(900, 100);
      await p.waitForTimeout(300);
      expect(await rect(), `${name} NVL は画面全体`).toEqual([0, 0, 1280, 720]);
      expect(await p.evaluate(`getComputedStyle(document.querySelector(".nvl-page")).marginBlockEnd`), `${name} 作品の CSS`).toBe("11px");
      for (let i = 0; i < 4; i++) {
        await p.mouse.click(900, 100);
        await p.waitForTimeout(150);
      }
      expect(await rect(), `${name} NVL から戻る`).toEqual([100, 400, 600, 200]);
      await p.close();
    }
  });
});
