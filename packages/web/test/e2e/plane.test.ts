import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** 奥行きのある背景（@plane）が、カメラの動きに奥行きの分だけ遅れてついていくことを、実際のブラウザで確かめる。 */

const scenario = `@bg hill_dusk.webp
@plane sky hill_night.webp depth=1
@plane mid hill_morning.webp depth=0.5
@plane near hill_morning.webp depth=-0.5 front=true
@window show
はじまり。
@camera x=100 time=0ms
右へ。
@camera zoom=2 x=0 time=0ms
寄る。
@camera zoom=1 x=200 time=400ms wait=false
動いている途中。
@bg hill_dusk.webp
背景を替えた。
`;

/** 舞台の座標での、絵の左端と幅（舞台の拡大を戻す）。 */
const boxes = (p: Page) =>
  p.evaluate(`(() => {
    const stage = document.querySelector(".stage").getBoundingClientRect();
    const k = 1280 / stage.width;
    const out = {};
    for (const el of document.querySelectorAll("img.plane")) {
      const r = el.getBoundingClientRect();
      out[el.dataset.plane] = [(Math.round((r.left - stage.left) * k) || 0), Math.round(r.width * k)];
    }
    const bg = document.querySelector(".background img:not(.plane)").getBoundingClientRect();
    out.bg = [(Math.round((bg.left - stage.left) * k) || 0), Math.round(bg.width * k)];
    return out;
  })()`) as Promise<Record<string, [number, number]>>;

describe.skipIf(!e2e)("奥行きのある背景（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: scenario }, config: { entry: "a" } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("奥のものほど小さく動き、手前のものは大きく動き、@bg で外れる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      const page = async (text: string, settle = 300) => {
        await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(text)})`);
        await p.waitForTimeout(settle);
        return boxes(p);
      };
      const next = () => p.mouse.click(640, 80);
      expect(await page("はじまり"), name).toEqual({ sky: [0, 1280], mid: [0, 1280], near: [0, 1280], bg: [0, 1280] });
      // 背景（奥行き 0）は 100 動き、mid は半分、sky は動かず、near は 1.5 倍
      await next();
      expect(await page("右へ"), name).toEqual({ sky: [0, 1280], mid: [-50, 1280], near: [-150, 1280], bg: [-100, 1280] });
      // 寄ると、mid は 1.5 倍、near は 2.5 倍
      await next();
      expect(await page("寄る"), name).toEqual({ sky: [0, 1280], mid: [-320, 1920], near: [-960, 3200], bg: [-640, 2560] });
      // 動いている途中も、奥のものは遅れてついていく
      await next();
      const mid = await page("動いている途中", 150);
      expect(mid.sky, name).toEqual([0, 1280]);
      expect(mid.mid![1]).toBeLessThan(mid.bg![1]);
      await p.waitForTimeout(500);
      expect(await boxes(p), name).toEqual({ sky: [0, 1280], mid: [-100, 1280], near: [-300, 1280], bg: [-200, 1280] });
      await next();
      expect(await page("背景を替えた"), name).toEqual({ bg: [-200, 1280] });
      await p.close();
    }
  });
});
