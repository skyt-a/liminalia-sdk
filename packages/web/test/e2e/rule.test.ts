import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { join, resolve } from "node:path";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * ルール画像の切り替え（@bg・@mask・@mask-off・@transition の rule・pattern・vague）を、実際のブラウザで確かめる。
 * 切り替えている間は出す側にマスクがかかり、終わったら外れて古い背景が消える。
 */

const BG = resolve(import.meta.dirname, "../../../../templates/default/assets/bgimage");

const SCENARIO = `@bg hill_night.webp
@bg hill_morning.webp time=1200ms pattern=wipe-right wait=false
@window show
切り替え中。
@bg hill_dusk.webp time=1200ms rule=rule.png vague=128 wait=false
ルール画像で切り替え中。
@mask time=1200ms pattern=circle-in wait=false
覆い中。
`;

describe.skipIf(!e2e)("ルール画像の切り替え（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO }, files: { "assets/image/rule.png": join(BG, "hill_dusk.webp") } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("組み込みの型・ルール画像・覆いで、切り替えている間だけマスクがかかる", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      const look = () =>
        p.evaluate(`(() => {
          const imgs = [...document.querySelectorAll(".background img")];
          const top = imgs.at(-1);
          const m = getComputedStyle(top).maskImage || getComputedStyle(top).webkitMaskImage;
          return { count: imgs.length, masked: !!m && m !== "none", src: top.src.split("/").pop() };
        })()`) as Promise<{ count: number; masked: boolean; src: string }>;
      // 組み込みの型（wipe-right）の途中
      expect(await look(), name).toMatchObject({ count: 2, masked: true, src: "hill_morning.webp" });
      await p.waitForTimeout(1500);
      expect(await look(), name).toMatchObject({ count: 1, masked: false, src: "hill_morning.webp" });
      // ルール画像の途中
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(300);
      expect(await look(), name).toMatchObject({ count: 2, masked: true, src: "hill_dusk.webp" });
      await p.waitForTimeout(1500);
      expect(await look(), name).toMatchObject({ count: 1, masked: false });
      // 覆い（circle-in）: 途中はマスク、終わったら外れて覆いが見える
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(300);
      const mask = () => p.evaluate(`(() => { const s = getComputedStyle(document.querySelector(".mask")); return { masked: (s.maskImage || s.webkitMaskImage) !== "none", opacity: s.opacity }; })()`);
      expect(await mask(), name).toEqual({ masked: true, opacity: "1" });
      await p.waitForTimeout(1500);
      expect(await mask(), name).toEqual({ masked: false, opacity: "1" });
      await p.close();
    }
  });
});
