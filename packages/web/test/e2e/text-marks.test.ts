import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/** 傍点（{dot …}）と本文の中の画像（{img …}）を、実際のブラウザで確かめる（本文とバックログ）。 */

describe.skipIf(!e2e)("傍点と本文の中の画像（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: "@window show\nこれは{dot 大事}な{img icon.png 40}こと。\n次。\n" },
      config: { entry: "a", ui: { text: { emphasis: "open circle" } } },
      files: { "assets/image/icon.png": resolve(import.meta.dirname, "../../../../templates/default/assets/bgimage/hill_dusk.webp") },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("傍点は ui.text.emphasis の形で打ち、画像は一字として高さを守って出し、バックログにも出す", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(800);
      const look = (await p.evaluate(`(() => {
        const em = document.querySelector(".message .text .lm-emphasis");
        const s = getComputedStyle(em);
        const img = document.querySelector(".message .text .lm-inline-image");
        return { text: em.textContent, style: s.textEmphasisStyle || s.webkitTextEmphasisStyle, imgHeight: img.getBoundingClientRect().height, imgSrc: img.src.split("/").pop().split("?")[0] };
      })()`)) as { text: string; style: string; imgHeight: number; imgSrc: string };
      expect(look.text, name).toBe("大事");
      expect(look.style, name).toBe("open circle");
      expect(Math.round(look.imgHeight), name).toBe(40);
      expect(look.imgSrc, name).toBe("icon.png");
      await p.mouse.click(640, 360);
      await p.waitForTimeout(500);
      await p.evaluate(`void window.__liminalia.system.perform("backlog")`);
      await p.waitForSelector(".lm-log-entry");
      expect(await p.evaluate(`!!document.querySelector(".lm-log .lm-emphasis") && !!document.querySelector(".lm-log .lm-inline-image")`), name).toBe(true);
      await p.close();
    }
  });
});
