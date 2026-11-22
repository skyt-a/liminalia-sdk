import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** 文字の動き（{fx …}）の大きさと速さ（strength=・speed=）を実際のブラウザで確かめる。 */

const scenario = `@window show
{fx wave strength=2 speed=2 波}{fx wave 平}
`;

describe.skipIf(!e2e)("文字の動きの大きさと速さ（ブラウザ）", { timeout: 180_000 }, () => {
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

  it("speed= は動きの時間を、strength= は動きの幅を変える。書かなければ標準", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(`document.querySelectorAll(".tfx").length === 2`);
      const looks = (await p.evaluate(`[...document.querySelectorAll(".tfx")].map((el) => {
        const s = getComputedStyle(el);
        return { name: s.animationName, duration: s.animationDuration, k: s.getPropertyValue("--fx-k").trim() };
      })`)) as { name: string; duration: string; k: string }[];
      expect(looks.map((l) => [l.name, l.duration, l.k]), name).toEqual([
        ["lim-fx-wave", "0.7s", "2"],
        ["lim-fx-wave", "1.4s", "1"],
      ]);
      await p.close();
    }
  });
});
