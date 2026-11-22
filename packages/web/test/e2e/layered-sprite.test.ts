import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** パーツ合成の立ち絵（層を下から重ねた一枚）を、実際のブラウザで確かめる。 */

const BODY = resolve(import.meta.dirname, "fixtures/layer-body.png"); // 100×200 の赤
const TOP = resolve(import.meta.dirname, "fixtures/layer-top.png"); // 上半分だけ青、下半分は透明

const cast = {
  speakers: ["ユイ"],
  cast: {
    ユイ: {
      appearances: {
        default: {
          layers: [
            { name: "body", options: { base: "yui/body.png" }, default: "base" },
            { name: "top", options: { blue: "yui/top.png" } },
          ],
          variants: { normal: { image: "", parts: {} }, blue: { image: "", parts: { top: "blue" } } },
        },
      },
    },
  },
};

/** 表示中の立ち絵の src と、上半分・下半分の中央の色。 */
const sample = (p: Page) =>
  p.evaluate(`(async () => {
    const img = document.querySelector(".layer.sprites img");
    if (!img) return null;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    // ffmpeg で作った PNG は色がわずかにずれるので、いちばん強い色だけ見る
    const at = (x, y) => { const [r, , b] = g.getImageData(x, y, 1, 1).data; return r > 200 && b < 50 ? "red" : b > 200 && r < 50 ? "blue" : "other"; };
    return { blob: img.src.startsWith("blob:"), size: [img.naturalWidth, img.naturalHeight], top: at(50, 50), bottom: at(50, 150) };
  })()`) as Promise<{ blob: boolean; size: number[]; top: string; bottom: string } | null>;

describe.skipIf(!e2e)("パーツ合成の立ち絵（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: "@window show\n@chara ユイ normal\nひとつめ。\n@chara ユイ normal+blue\nふたつめ。\n" },
      config: { entry: "a" },
      files: { "assets/fgimage/yui/body.png": BODY, "assets/fgimage/yui/top.png": TOP },
      before: (dir) => writeFileSync(join(dir, "cast.json"), JSON.stringify(cast)),
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("層を重ねた一枚を出し、「差分+層の絵」で上に足す", async () => {
    for (const { browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".layer.sprites img");
      await p.waitForTimeout(600);
      // 層が一つなら合成せずそのまま
      expect(await sample(p)).toMatchObject({ blob: false, size: [100, 200], top: "red", bottom: "red" });
      await p.mouse.click(640, 360);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("ふたつめ")`);
      await p.waitForFunction(`[...document.querySelectorAll(".layer.sprites img")].some((i) => i.src.startsWith("blob:"))`);
      await p.waitForTimeout(800);
      expect(await sample(p)).toEqual({ blob: true, size: [100, 200], top: "blue", bottom: "red" });
      await p.close();
    }
  });
});
