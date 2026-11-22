import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** 立ち絵の色調（@tone）を、実際のブラウザで確かめる。色は画面写真の一点で見る。 */

const BODY = resolve(import.meta.dirname, "fixtures/layer-body.png"); // 100×200 の赤

const cast = {
  speakers: ["ユイ", "ソウ"],
  cast: {
    ユイ: { appearances: { default: { variants: { normal: { image: "yui.png", frame: { width: 100, height: 200, positions: { left: { left: 100, top: 100 } } } } } } } },
    ソウ: { appearances: { default: { variants: { normal: { image: "yui.png", frame: { width: 100, height: 200, positions: { right: { left: 1000, top: 100 } } } } } } } },
  },
};

const scenario = `@window show
@chara ユイ normal at=left
はじまり。
@tone mono
白黒。
@chara ソウ normal at=right
あとから出た人も。
@tone blue who=ユイ
ユイだけ。
@tone none
戻した。
`;

/** 画面の (x, y) の色（画面写真から）。 */
async function colorAt(p: Page, x: number, y: number): Promise<string> {
  const png = await p.screenshot({ clip: { x, y, width: 1, height: 1 } });
  return p.evaluate(`(async () => {
    const img = new Image();
    img.src = "data:image/png;base64,${png.toString("base64")}";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
    const near = (a, b) => Math.abs(a - b) < 24;
    if (near(r, gr) && near(gr, b)) return "gray";
    if (r > 180 && gr < 60 && b < 60) return "red";
    if (b > r && b > gr) return "blue";
    return [r, gr, b].join(",");
  })()`) as Promise<string>;
}

describe.skipIf(!e2e)("立ち絵の色調（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: scenario },
      config: { entry: "a", ui: { tones: { blue: { color: "#4060ff", saturation: 0 } } } },
      files: { "assets/fgimage/yui.png": BODY },
      before: (dir) => writeFileSync(join(dir, "cast.json"), JSON.stringify(cast)),
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("すべての立ち絵（後から出したものも）と、一人だけの色調を変え、none で戻す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      const page = async (text: string) => {
        await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(text)})`);
        await p.waitForTimeout(500);
      };
      const next = () => p.mouse.click(640, 80);
      const yui = () => colorAt(p, 150, 200);
      const sou = () => colorAt(p, 1050, 200);
      await page("はじまり");
      expect(await yui(), name).toBe("red");
      await next();
      await page("白黒");
      expect(await yui(), name).toBe("gray");
      await next();
      await page("あとから");
      expect([await yui(), await sou()], name).toEqual(["gray", "gray"]);
      await next();
      await page("ユイだけ");
      expect([await yui(), await sou()], name).toEqual(["blue", "gray"]);
      await next();
      await page("戻した");
      expect([await yui(), await sou()], name).toEqual(["red", "red"]);
      await p.close();
    }
  });
});
