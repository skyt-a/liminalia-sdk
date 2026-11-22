import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { UI_THEMES, applyUiTheme } from "@liminalia/lang";
import { copyUiThemeAssets } from "@liminalia/project";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * テーマ（ui と素材）が実際の画面に効くことと、プラグインの themes が ui.system.preset で出し分けられることを、
 * ブラウザで測る。切り分けた枠の絵は読み込めないと描かれないので、素材の URL まで確かめる。
 */

const SCENARIO = `@window show
本文。
@choice
- 甲 -> #a
- 乙 -> #a
@end
# a
終わり。
`;

const PLUGIN = `
export default {
  name: "t",
  themes: {
    mine: {
      rootClass: "mine-root",
      screens: { backlog: () => { const el = document.createElement("div"); el.id = "mine-log"; return el; } },
    },
  },
};
`;

const toChoice = async (p: Page) => {
  // 一度目は文字を出し切り、二度目で進む
  for (let i = 0; i < 10 && (await p.locator(".choices button").count()) === 0; i++) {
    await p.click(".stage");
    await p.waitForTimeout(300);
  }
};

describe.skipIf(!e2e)("テーマ（ブラウザ）", { timeout: 180_000 }, () => {
  let list: { name: string; browser: Browser }[] = [];
  const projects: TestProject[] = [];
  beforeAll(async () => {
    list = await browsers();
  });
  afterAll(async () => {
    for (const p of projects) await p.close();
    for (const b of list) await b.browser.close();
  });

  const start = async (ui: object, plugin?: string, id?: string) => {
    const project = await startProject({
      scenario: { a: SCENARIO },
      config: { ui },
      ...(plugin ? { plugin } : {}),
      before: (dir) => {
        if (id) copyUiThemeAssets(dir, UI_THEMES.find((t) => t.id === id)!);
      },
    });
    projects.push(project);
    return project;
  };

  for (const id of ["washi", "mansion"]) {
    it(`${id}: 枠・名前・選択肢・システム画面の見た目が変わる`, async () => {
      const theme = UI_THEMES.find((t) => t.id === id)!;
      const project = await start(applyUiTheme({}, theme), undefined, id);
      for (const { browser } of list) {
        const page = await openPlayer(browser, project.url, "a");
        const l = await page.evaluate(() => {
          const css = (selector: string) => getComputedStyle(document.querySelector(selector)!);
          return { font: css(".message .text").fontFamily, source: css(".message-frame").borderImageSource };
        });
        if (id === "mansion") {
          expect(l.source).toContain("themes/mansion/frame.svg");
          // 絵は作品へ写してあり、読める
          expect((await page.request.get(l.source.match(/url\("(.+)"\)/)![1]!)).ok()).toBe(true);
        } else {
          expect(l.source).toBe("none");
          expect(l.font).toContain("Hiragino Mincho");
        }
        await toChoice(page);
        const radius = await page.evaluate(() => getComputedStyle(document.querySelector(".choices button")!).borderRadius);
        expect(radius).toBe(`${theme.ui.choice?.radius ?? 0}px`);
        await page.close();
      }
    });
  }

  it("システム画面の見本は準備中の本文を見せずに開く", async () => {
    const project = await start({ defaults: { textSpeed: 80 } });
    for (const { browser } of list) {
      const page = await browser.newPage();
      await page.addInitScript(() => {
        (window as any).__previewFlash = false;
        (window as any).__previewStageAt = 0;
        (window as any).__previewScreenAt = 0;
        const check = () => {
          const stage = document.querySelector<HTMLElement>(".stage");
          if (stage && !(window as any).__previewStageAt) (window as any).__previewStageAt = performance.now();
          if (stage?.querySelector(".lm-sys > .lm-screen") && !(window as any).__previewScreenAt) (window as any).__previewScreenAt = performance.now();
          if (stage && getComputedStyle(stage).visibility === "visible" && stage.querySelector(".message .text .ch") && !stage.querySelector(".lm-sys > .lm-screen")) {
            (window as any).__previewFlash = true;
          }
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
      for (const preview of ["menu", "save", "load", "config", "log"]) {
        await page.goto(`${project.url}?ui-preview=${preview}`);
        await page.waitForSelector(".lm-sys > .lm-screen", { state: "visible", timeout: 60_000 });
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        expect(await page.evaluate(() => (window as any).__previewFlash), preview).toBe(false);
        expect(await page.evaluate(() => (window as any).__previewScreenAt - (window as any).__previewStageAt), preview).toBeLessThan(2500);
      }
      await page.close();
    }
  });

  it("プラグインの画面は preset が合うときだけ使い、rootClass を付ける", async () => {
    const on = await start({ system: { preset: "mine" } }, PLUGIN);
    const off = await start({ system: { preset: "washi" } }, PLUGIN);
    for (const { browser } of list) {
      const a = await openPlayer(browser, on.url, "a");
      expect(await a.evaluate(() => document.querySelector(".stage")!.classList.contains("mine-root"))).toBe(true);
      await a.evaluate(() => void window.__liminalia!.system.perform?.("backlog"));
      await a.waitForSelector("#mine-log", { state: "attached" });
      await a.close();
      const b = await openPlayer(browser, off.url, "a");
      expect(await b.evaluate(() => document.querySelector(".stage")!.classList.contains("mine-root"))).toBe(false);
      await b.evaluate(() => void window.__liminalia!.system.perform?.("backlog"));
      await b.waitForTimeout(400);
      expect(await b.locator("#mine-log").count()).toBe(0);
      await b.close();
    }
  });
});
