import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 高解像度の画面（devicePixelRatio 2）で、舞台の左上が画素にそろうこと（端数の位置で文字と絵がにじまない）と、
 * パーティクルと WebGL の効果のキャンバスを表示される細かさで描くことを、実際のブラウザで確かめる。
 */

const SCENARIO = `@window show
@particles snow
いち。
@effect mosaic strength=8
に。
`;

describe.skipIf(!e2e)("高解像度の画面（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("舞台の左上を画素にそろえ、パーティクルと WebGL の効果を表示される細かさで描く", async () => {
    for (const { name, browser } of list) {
      // 端数の出る大きさのウィンドウ
      const context = await browser.newContext({ viewport: { width: 1001, height: 637 }, deviceScaleFactor: 2 });
      const p = await context.newPage();
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".message .text .ch");
      await p.waitForTimeout(1200);
      const stage = (await p.evaluate(`(() => { const r = window.__liminalia.host.stage.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, dpr: devicePixelRatio }; })()`)) as { left: number; top: number; width: number; dpr: number };
      expect(stage.dpr, name).toBe(2);
      expect(Math.abs(stage.left * 2 - Math.round(stage.left * 2)), name).toBeLessThan(0.01);
      expect(Math.abs(stage.top * 2 - Math.round(stage.top * 2)), name).toBeLessThan(0.01);
      // 真ん中に置く（そろえた分の 1 画素未満しかずれない）
      expect(Math.abs(stage.left - (1001 - stage.width) / 2), name).toBeLessThan(0.5);
      // パーティクル: 表示される画素の数（舞台の幅 × 2）に近い細かさ（0.25 倍刻み）
      const particles = (await p.evaluate(`document.querySelector("canvas.lim-particles").width`)) as number;
      expect(particles, name).toBeGreaterThan(1280);
      expect(Math.abs(particles - stage.width * 2), name).toBeLessThanOrEqual(1280 * 0.125 + 1);
      await p.waitForFunction("window.__liminalia.host.waiting");
      await p.mouse.click(500, 300);
      await p.waitForSelector("canvas.lim-gl-effect");
      await p.waitForTimeout(500);
      const gl = (await p.evaluate(`document.querySelector("canvas.lim-gl-effect").width`)) as number;
      expect(gl, name).toBe(particles);
      await context.close();
    }
  });
});
