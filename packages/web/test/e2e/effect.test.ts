import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 画面の演出（@effect / @effect-off）を、実際のブラウザで確かめる。
 * フィルタの種類は画面（カメラ）やレイヤーの filter に足し（@filter とは重ねる）、重ねる種類は前景の上に置く。ロードでかけ直す。
 */

const SCENARIO = `@bg hill_night.webp
@window show
@filter layer=base grayscale=100
@effect glitch
@effect wave layer=base
@effect vignette strength=70
かけた。
@effect-off glitch
外した。
`;

describe.skipIf(!e2e)("画面の演出（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("フィルタを画面とレイヤーにかけ（@filter と重ねる）、重ねるものを置き、外し、ロードでかけ直す", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(300);
      const look = () =>
        p.evaluate(`({
          camera: document.querySelector(".background").closest("[style*='filter'], .camera")?.style.filter ?? "",
          base: document.querySelector(".background").style.filter,
          overlays: [...document.querySelectorAll(".lim-effect")].map((e) => e.className),
        })`) as Promise<{ camera: string; base: string; overlays: string[] }>;
      const first = await look();
      // 被写界深度のぼかし（--dof-layer。かけていなければ空）も後ろに付く
      expect(first.base, name).toMatch(/^url\("?#lim-fx-\d+"?\) grayscale\(100%\) var\(--dof-layer,\s*\)$/);
      expect(first.overlays, name).toEqual(["lim-effect lim-effect-vignette"]);
      expect(await p.evaluate(`[...document.querySelectorAll("[data-fx-filter]")].filter((e) => e.dataset.fxFilter).length`), name).toBe(2);
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(100);
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(400);
      // glitch（画面全体）を外しても、base の wave と @filter は残る
      expect(await p.evaluate(`[...document.querySelectorAll("[data-fx-filter]")].filter((e) => e.dataset.fxFilter).length`), name).toBe(1);
      const save = await p.evaluate("window.__liminalia.system.runtime.save()");
      await p.evaluate(`window.__liminalia.system.loadSave(${JSON.stringify(save)})`);
      await p.waitForTimeout(800);
      const after = await look();
      expect([after.base.includes("grayscale(100%)"), after.base.startsWith("url("), after.overlays], name).toEqual([true, true, ["lim-effect lim-effect-vignette"]]);
      await p.close();
    }
  });
});
