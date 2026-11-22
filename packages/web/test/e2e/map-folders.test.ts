import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 図鑑の地図（data/codex.json の区分の map）と地図の選択の地図（data/investigation.json の maps の background）は、
 * どちらも bgimage から探し、無ければ前の置き場所の image から読むことを、実際のブラウザで確かめる（同じパスを書けば同じ絵が出る）。
 */

const FIXTURES = resolve(import.meta.dirname, "fixtures");

const SCENARIO = `@bg hill_night.webp
はじまり。
@set game.met = true
@codex
@map-choice now result=temp.where
@map-choice before result=temp.where
おわり。
@stop
`;

const CODEX = {
  categories: [
    { id: "now", label: "今の置き場所", type: "map", map: "maps/now.png" },
    { id: "before", label: "前の置き場所", type: "map", map: "maps/before.png" },
  ],
  entries: [
    { id: "a", category: "now", title: "駅", x: 40, y: 30, if: "game.met" },
    { id: "b", category: "before", title: "丘", x: 60, y: 40, if: "game.met" },
  ],
};

const MAPS = {
  maps: {
    now: { background: "maps/now.png", spots: [{ id: "s", label: "駅", rect: { x: 100, y: 300, width: 120, height: 60 } }] },
    before: { background: "maps/before.png", spots: [{ id: "h", label: "丘", rect: { x: 400, y: 300, width: 120, height: 60 } }] },
  },
};

/** 絵が読めた（大きさがある）か、と今の URL。 */
const loaded = (p: Page, selector: string) =>
  p.waitForFunction((s) => {
    const img = document.querySelector<HTMLImageElement>(s);
    return img && img.complete && img.naturalWidth > 0 ? img.currentSrc || img.src : null;
  }, selector, { timeout: 10_000 }).then((h) => h.jsonValue() as Promise<string>);

describe.skipIf(!e2e)("図鑑の地図と地図の選択の絵を探すフォルダ（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a" },
      // 今の置き場所（bgimage）と、前の置き場所（image）
      files: { "assets/bgimage/maps/now.png": join(FIXTURES, "stripes.png"), "assets/image/maps/before.png": join(FIXTURES, "layer-top.png") },
      before: (dir) => {
        mkdirSync(join(dir, "data"), { recursive: true });
        writeFileSync(join(dir, "data", "codex.json"), JSON.stringify(CODEX));
        writeFileSync(join(dir, "data", "investigation.json"), JSON.stringify(MAPS));
      },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("bgimage にある地図も、前の image にある地図も出る", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      const until = async (selector: string) => {
        for (let i = 0; i < 20 && (await p.locator(selector).count()) === 0; i++) {
          await p.mouse.click(640, 650);
          await p.waitForTimeout(300);
        }
        await p.waitForSelector(selector, { timeout: 20_000 });
      };
      // 図鑑
      await until(".lm-codex");
      expect(await loaded(p, ".lm-codex-board-image"), name).toContain("/bgimage/maps/now.png");
      await p.locator('.lm-tab[data-category="before"]').click();
      expect(await loaded(p, ".lm-codex-board-image"), name).toContain("/image/maps/before.png");
      await p.locator(".lm-codex .lm-close").click();
      // 地図の選択
      await until(".lm-map-choice");
      expect(await loaded(p, ".lm-map-choice-bg"), name).toContain("/bgimage/maps/now.png");
      await p.locator('.lm-map-choice-spot[data-spot="s"]').click();
      await p.locator(".lm-map-choice-go").click();
      await p.waitForSelector('.lm-map-choice-spot[data-spot="h"]', { timeout: 20_000 });
      expect(await loaded(p, ".lm-map-choice-bg"), name).toContain("/image/maps/before.png");
      await p.close();
    }
  });
});
