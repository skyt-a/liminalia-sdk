import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * NVL の見た目（ui.nvl）と、名前を付けた見た目（ui.nvlStyles）を @nvl on style= で場面ごとに切り替える（手紙や文書を本文として書く）ことを、
 * 実際のブラウザで確かめる。セーブとロードで同じ見た目に戻り、本文はバックログにも入る。
 */

const SCENARIO = `@bg hill_night.webp
はじまり。
@nvl on
ふだんの NVL。
@nvl on style=letter
アカリ「拝啓、お元気ですか。」
手紙の二行目。
@nvl off
もどった。
@stop
`;

const UI = {
  nvl: { background: "rgb(10, 20, 30)", align: "center" },
  nvlStyles: {
    letter: { background: "rgb(240, 230, 210)", color: "rgb(40, 30, 20)", font: "serif", valign: "top", padding: [80, 200, 60, 220], size: 30, lineHeight: 2, fade: 400, names: false },
  },
};

describe.skipIf(!e2e)("NVL の見た目を場面ごとに切り替える（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a", ui: UI } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  const until = async (p: Page, text: string) => {
    await p.waitForFunction(() => window.__liminalia?.host.waiting);
    for (let i = 0; i < 6; i++) {
      if (await p.evaluate((value) => document.querySelector(".message .text")?.textContent?.includes(value), text)) return;
      const previous = await p.evaluate(() => {
        const game = window.__liminalia!;
        const pages = game.pages();
        game.host.advance();
        return pages;
      });
      await p.waitForFunction((pages) => window.__liminalia!.pages() > pages && window.__liminalia!.host.waiting, previous);
    }
    throw new Error(`${text} まで進めませんでした`);
  };
  const look = (p: Page) =>
    p.evaluate(() => {
      const m = document.querySelector<HTMLElement>(".message")!;
      const t = document.querySelector<HTMLElement>(".message .text")!;
      const page = t.querySelector<HTMLElement>(".nvl-page:last-child");
      const name = t.querySelector<HTMLElement>(".nvl-name");
      const cs = getComputedStyle(m);
      return {
        nvl: m.classList.contains("nvl"),
        bg: cs.backgroundColor,
        align: getComputedStyle(t).textAlign,
        justify: getComputedStyle(t).justifyContent,
        color: getComputedStyle(t).color,
        font: getComputedStyle(t).fontFamily,
        size: parseFloat(cs.fontSize),
        line: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize),
        padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft],
        fade: page ? getComputedStyle(page).animationDuration : "",
        names: name ? getComputedStyle(name).display : "",
      };
    });

  it("ui.nvl でふだんの NVL を、ui.nvlStyles の名前で手紙の見た目を出し、@nvl off で戻る", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await until(p, "ふだんの NVL");
      const base = await look(p);
      expect(base.nvl, name).toBe(true);
      expect(base.bg, name).toBe("rgb(10, 20, 30)");
      expect(base.align, name).toBe("center");
      expect(base.justify, name).toBe("flex-end");

      await until(p, "手紙の二行目");
      const letter = await look(p);
      expect(letter.bg, name).toBe("rgb(240, 230, 210)");
      expect(letter.color, name).toBe("rgb(40, 30, 20)");
      expect(letter.font, name).toContain("serif");
      // 書いていない揃えは ui.nvl のまま
      expect(letter.align, name).toBe("center");
      expect(letter.justify, name).toBe("flex-start");
      expect(letter.padding, name).toEqual(["80px", "200px", "60px", "220px"]);
      expect(letter.size, name).toBe(30);
      expect(letter.line, name).toBeCloseTo(2, 1);
      expect(letter.fade, name).toBe("0.4s");
      expect(letter.names, name).toBe("none");

      // セーブとロードで同じ見た目に戻る
      await p.evaluate('window.__liminalia.system.perform("quick-save")');
      await p.evaluate('window.__liminalia.system.perform("quick-load")');
      await p.waitForFunction(() => window.__liminalia!.host.waiting && document.querySelector(".message .text")?.textContent?.includes("手紙の二行目"));
      const loaded = await look(p);
      expect(loaded.bg, name).toBe("rgb(240, 230, 210)");
      expect(await p.evaluate(() => document.querySelector(".message .text")?.textContent), name).toContain("手紙の二行目");

      // 手紙の本文もバックログに入る
      await p.evaluate(`void window.__liminalia.system.perform("backlog")`);
      await p.waitForSelector(".lm-log-entry");
      expect(await p.evaluate(() => [...document.querySelectorAll(".lm-log-entry .lm-log-text")].map((e) => e.textContent).join("\n")), name).toContain("手紙の二行目");
      await p.keyboard.press("Escape");
      await p.locator(".lm-log-entry").first().waitFor({ state: "hidden" });

      await until(p, "もどった");
      expect((await look(p)).nvl, name).toBe(false);
      await p.close();
    }
  });
});
