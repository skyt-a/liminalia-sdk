import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/** @chara の大きさ・直後の @chara-move・ui の画像の url()・NVL のロード・顔窓の explicit・@window-image・@image の切り出しなどを、実際のブラウザで確かめる。 */

const BODY = resolve(import.meta.dirname, "fixtures/layer-body.png"); // 100×200

const cast = { speakers: ["ユイ"], cast: { ユイ: { appearances: { default: { variants: { normal: { image: "yui/body.png", face: "yui/body.png" } } } } } } };

const SPRITE = `@window show
@freeze
@chara ユイ normal x=300 y=20
@chara-move ユイ left=300 top=20 width=50 height=100 time=0ms wait=false
@transition time=1ms
はじめ
`;
const CHOICE = `@window show
選びます
@choice
- 外へ -> #a
- 中へ -> #a
@end
# a
終わり
`;
const NVL = `@nvl on
ひとつめの段落
ふたつめの段落
みっつめの段落
よっつめの段落
`;

const SIZED = `@window show
@chara ユイ normal x=10 y=20 width=30 height=60
はじめ
`;
const FACE = `@window show
ユイ「顔なし」
@face ユイ normal
ユイ「顔あり」
地の文でも出る。
@face-off
ユイ「また無し」
`;
const LOOKS = `@window show
@window-image other.png
@image button.png folder=image name=part x=5 y=6 sx=10 sy=20 sw=30 sh=40 wait=false
本文
@window-image
本文
`;
const QUAKE = `@window show
本文
@quake target=background time=2000ms count=4 horizontal=10 wait=false
本文
`;

const box = (p: Page) =>
  p.evaluate(`(() => {
    const s = document.querySelector('.sprite[data-who="ユイ"]');
    if (!s) return null;
    const a = s.getBoundingClientRect(), b = s.querySelector("img").getBoundingClientRect(), o = document.querySelector(".stage").getBoundingClientRect();
    const k = o.width / 1280;
    return { x: Math.round((a.x - o.x) / k), y: Math.round((a.y - o.y) / k), width: Math.round(a.width / k), imgWidth: Math.round(b.width / k), imgHeight: Math.round(b.height / k) };
  })()`);

describe.skipIf(!e2e)("立ち絵の枠・ui の画像・NVL のロード（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { sprite: SPRITE, choice: CHOICE, nvl: NVL, sized: SIZED, face: FACE, looks: LOOKS, quake: QUAKE },
      config: {
        entry: "sprite",
        ui: {
          message: { image: "frame.png" },
          face: { show: "explicit", x: 0, y: -50, width: 80, height: 80 },
          choice: { image: "button.png", hoverImage: "button.png", y: 200, height: 60, backdrop: "button.png" },
        },
      },
      files: { "assets/fgimage/yui/body.png": BODY, "assets/image/button.png": BODY, "assets/image/frame.png": BODY, "assets/image/other.png": BODY },
      before(dir) {
        return import("node:fs").then((fs) => fs.writeFileSync(`${dir}/cast.json`, JSON.stringify(cast)));
      },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("@chara の直後の @chara-move が効き、絵も枠と同じ大きさになる。ロードしても同じ", async () => {
    for (const { name, browser } of list) {
      const page = await openPlayer(browser, project.url, "sprite");
      await page.waitForSelector('.sprite[data-who="ユイ"]');
      const want = { x: 300, y: 20, width: 50, imgWidth: 50, imgHeight: 100 };
      expect(await box(page), name).toEqual(want);
      await page.evaluate("window.__liminalia.system.saveTo(1)");
      void page.evaluate("window.__liminalia.system.loadFrom(1)").catch(() => {});
      await page.waitForTimeout(800);
      expect(await box(page), `${name} ロード後`).toEqual(want);
      await page.close();
    }
  });

  it("ui.choice.image はページを基準に読む", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "choice");
      await p.waitForSelector(".message .text .glyph");
      await p.mouse.click(640, 300);
      await p.waitForSelector(".choices button");
      const [image, origin] = (await p.evaluate(`[getComputedStyle(document.querySelector(".choices button")).backgroundImage, location.origin]`)) as string[];
      expect(image, name).toContain(`${origin}/assets/image/button.png`);
      await p.close();
    }
  });

  it("NVL をロードすると、読み終えた段落も出し直す", async () => {
    for (const { name, browser } of list) {
      const page = await openPlayer(browser, project.url, "nvl");
      const count = () => page.evaluate(`document.querySelectorAll(".message .text .nvl-page").length`);
      const text = () => page.evaluate(`document.querySelector(".message .text").textContent`) as Promise<string>;
      for (const n of [2, 3]) {
        await page.waitForSelector(".message .text .glyph");
        await page.mouse.click(640, 300);
        await page.waitForFunction(`document.querySelectorAll(".message .text .nvl-page").length === ${n}`);
      }
      await page.waitForSelector(".message .text .glyph");
      const before = await text();
      await page.evaluate("window.__liminalia.system.saveTo(2)");
      await page.mouse.click(640, 300);
      await page.waitForFunction(`document.querySelectorAll(".message .text .nvl-page").length === 4`);
      void page.evaluate("window.__liminalia.system.loadFrom(2)").catch(() => {});
      await page.waitForFunction(`document.querySelectorAll(".message .text .nvl-page").length === 3`);
      await page.waitForSelector(".message .text .glyph");
      expect(await count(), name).toBe(3);
      expect(await text(), name).toBe(before);
      await page.close();
    }
  });

  it("@chara の width・height で大きさを決める", async () => {
    for (const { name, browser } of list) {
      const page = await openPlayer(browser, project.url, "sized");
      await page.waitForSelector('.sprite[data-who="ユイ"]');
      expect(await box(page), name).toEqual({ x: 10, y: 20, width: 30, imgWidth: 30, imgHeight: 60 });
      await page.close();
    }
  });

  it("show が explicit の顔窓は @face の間だけ出て、本文をずらさない", async () => {
    for (const { name, browser } of list) {
      const page = await openPlayer(browser, project.url, "face");
      const state = () => page.evaluate(`(() => { const m = document.querySelector(".message"); return { face: m.classList.contains("has-face"), placed: m.classList.contains("face-placed"), pad: getComputedStyle(m).paddingLeft }; })()`) as Promise<{ face: boolean; placed: boolean; pad: string }>;
      const next = async () => {
        await page.waitForSelector(".message .text .glyph");
        await page.mouse.click(640, 300);
        await page.waitForTimeout(250);
      };
      await page.waitForSelector(".message .text .glyph");
      const first = await state();
      expect(first.face, `${name} 顔なし`).toBe(false);
      await next();
      await page.waitForSelector(".message.has-face");
      expect((await state()).pad, `${name} 本文をずらさない`).toBe(first.pad);
      await next();
      expect((await state()).face, `${name} 地の文でも出る`).toBe(true);
      await next();
      await page.waitForSelector(".message:not(.has-face)");
      await page.close();
    }
  });

  it("@window-image で枠の絵を替えて戻す。@image の切り出しは指定の大きさ", async () => {
    for (const { name, browser } of list) {
      const page = await openPlayer(browser, project.url, "looks");
      const frame = () => page.evaluate(`getComputedStyle(document.querySelector(".message-frame")).backgroundImage`) as Promise<string>;
      await page.waitForSelector(".message .text .glyph");
      expect(await frame(), name).toContain("other.png");
      const part = await page.evaluate(`(() => { const e = document.querySelector('[data-name="part"]'); return [e.tagName, e.width, e.height, e.style.left]; })()`);
      expect(part, name).toEqual(["CANVAS", 30, 40, "5px"]);
      await page.mouse.click(640, 300);
      await page.waitForFunction(`getComputedStyle(document.querySelector(".message-frame")).backgroundImage.includes("frame.png")`);
      await page.close();
    }
  });

  it("選択肢の backdrop は本文の下に敷き、y と height で置く", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "choice");
      await p.waitForSelector(".message .text .glyph");
      await p.mouse.click(640, 300);
      await p.waitForSelector(".choices button");
      const r = (await p.evaluate(`(() => { const b = document.querySelector(".choices button").getBoundingClientRect(), o = document.querySelector(".stage").getBoundingClientRect(), k = o.width / 1280; return { top: Math.round((b.y - o.y) / k), height: Math.round(b.height / k), fx: getComputedStyle(document.querySelector(".fx")).backgroundImage, under: !!(document.querySelector(".fx").compareDocumentPosition(document.querySelector(".message")) & 4) }; })()`)) as { top: number; height: number; fx: string; under: boolean };
      expect(r, name).toMatchObject({ top: 200, height: 60, under: true });
      expect(r.fx, name).toContain("button.png");
      await p.close();
    }
  });

  it("@quake target=background は背景の層だけを動かす", async () => {
    for (const { name, browser } of list) {
      const page = await openPlayer(browser, project.url, "quake");
      await page.waitForSelector(".message .text .glyph");
      await page.mouse.click(640, 300);
      await page.waitForFunction(`document.querySelector(".layer.background").getAnimations().length > 0`);
      expect(await page.evaluate(`document.querySelector(".stage > .layer").getAnimations().length`), name).toBe(0);
      await page.close();
    }
  });
});
