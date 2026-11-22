import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** 顔ウィンドウ（ui.face）を、実際のブラウザで確かめる。 */

const BODY = resolve(import.meta.dirname, "fixtures/layer-body.png"); // 100×200 の赤
const TOP = resolve(import.meta.dirname, "fixtures/layer-top.png"); // 上半分だけ青、下半分は透明

const cast = {
  speakers: ["ユイ", "ソウ"],
  cast: {
    // 差分ごとの顔の絵
    ユイ: { appearances: { default: { variants: { normal: { image: "yui/body.png", face: "yui/face.png" } } } } },
    // パーツ合成の立ち絵から上半分を切り出す
    ソウ: {
      appearances: {
        default: {
          face: { x: 0, y: 0, width: 100, height: 100 },
          layers: [
            { name: "body", options: { base: "sou/body.png" }, default: "base" },
            { name: "top", options: { blue: "sou/top.png" } },
          ],
          variants: { normal: { image: "", parts: {} }, blue: { image: "", parts: { top: "blue" } } },
        },
      },
    },
  },
};

const scenario = `@window show
ユイ「いち」
@chara ユイ normal
ユイ「に」
地の文。
@face ソウ blue
ソウ「さん」
`;

/** 顔ウィンドウの様子（出ているか、絵、絵の上の真ん中の色、本文の左の余白）。 */
const look = (p: Page) =>
  p.evaluate(`(async () => {
    const m = document.querySelector(".message");
    const img = m.querySelector(".face");
    const shown = m.classList.contains("has-face") && getComputedStyle(img).display !== "none";
    let color = null;
    if (shown) {
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const [r, , b] = g.getImageData(50, 50, 1, 1).data;
      color = r > 200 && b < 50 ? "red" : b > 200 && r < 50 ? "blue" : "other";
    }
    return { shown, src: shown ? (img.src.startsWith("blob:") ? "blob" : img.src.split("/").pop().split("?")[0]) : null, size: shown ? [img.naturalWidth, img.naturalHeight] : null, color, padded: parseFloat(getComputedStyle(m).paddingLeft) > 200 };
  })()`) as Promise<{ shown: boolean; src: string | null; size: number[] | null; color: string | null; padded: boolean }>;

describe.skipIf(!e2e)("顔ウィンドウ（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: scenario },
      config: { entry: "a", ui: { face: { show: "offstage" } } },
      files: { "assets/fgimage/yui/body.png": BODY, "assets/fgimage/yui/face.png": TOP, "assets/fgimage/sou/body.png": BODY, "assets/fgimage/sou/top.png": TOP },
      before: (dir) => writeFileSync(join(dir, "cast.json"), JSON.stringify(cast)),
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("話者の顔を出し、立ち絵を表示中（offstage）と地の文では隠す", async () => {
    for (const { browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      const page = async (text: string) => {
        await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(text)})`);
        await p.waitForTimeout(500);
        return look(p);
      };
      expect(await page("いち")).toEqual({ shown: true, src: "face.png", size: [100, 200], color: "blue", padded: true });
      await p.mouse.click(640, 360);
      expect(await page("に")).toMatchObject({ shown: false, padded: false });
      await p.mouse.click(640, 360);
      expect(await page("地の文")).toMatchObject({ shown: false });
      await p.mouse.click(640, 360);
      // 立ち絵を出していない人物は @face の表情。合成した立ち絵の上半分（青）を切り出す
      expect(await page("さん")).toEqual({ shown: true, src: "blob", size: [100, 100], color: "blue", padded: true });
      await p.close();
    }
  });
});
