import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { decodePng } from "../../../cli/src/mobile/icon.ts";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 残したカットイン（@cutin stay=true）と常駐の文字（@hud-text）が、暗転（@mask・@scene-change）の黒の上に浮かず、
 * 暗転しきっている間と章の扉の間は隠れ、明けたら戻ることを、画面の画素で確かめる。layer=overlay と書いたカットインは暗転の上に残る。
 */

const FIXTURES = resolve(import.meta.dirname, "fixtures");

const SCENARIO = `@bg hill_dusk.webp
@hud-text day text="1 日目" x=40 y=40 size=40
@cutin face.png stay=true name=clue x=640 y=300 width=200 height=200 from=none in=0ms
@cutin face.png stay=true name=top x=1000 y=300 width=200 height=200 from=none in=0ms layer=overlay
はじまり。
@mask time=200ms
暗転中。
@mask-off time=200ms
明けた。
@scene-change hill_night.webp fade-out=200ms hold=4000ms fade-in=200ms
場面が替わった。
@chapter-card title="扉" time=4000ms fade=100ms
扉のあと。
`;

/** 画面の (x, y) の色。 */
async function rgbAt(p: Page, x: number, y: number): Promise<number[]> {
  const png = await p.screenshot({ clip: { x, y, width: 1, height: 1 } });
  return p.evaluate(`(async () => {
    const img = new Image();
    img.src = "data:image/png;base64,${png.toString("base64")}";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
  })()`) as Promise<number[]>;
}

const black = (rgb: number[]) => Math.max(...rgb) < 16;

/** 常駐の文字の箱の中で、明るい（黒でない）画素の数。 */
async function hudInk(p: Page): Promise<number> {
  const box = (await p.evaluate(`(() => { const r = document.querySelector(".lim-hud-text[data-hud=day]").getBoundingClientRect(); return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`)) as { x: number; y: number; width: number; height: number };
  const img = decodePng(await p.screenshot({ clip: box }))!;
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) if (Math.max(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!) > 160) n++;
  return n;
}

describe.skipIf(!e2e)("暗転と残したカットイン、常駐の文字（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a" },
      files: { "assets/image/face.png": join(FIXTURES, "layer-top.png") },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("暗転しきっている間と章の扉の間は隠れ、明けたら戻る。layer=overlay のカットインは暗転の上に残る", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      const waitText = (t: string) => p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(t)})`, undefined, { timeout: 30_000 });
      const next = () => p.mouse.click(1200, 650);
      /** 残したカットイン（暗転の下）の真ん中、常駐の文字の上、overlay のカットインの真ん中の色。 */
      const look = async () => ({ clue: await rgbAt(p, 640, 300), day: await hudInk(p), top: await rgbAt(p, 1000, 300) });
      const hudHidden = () => p.evaluate(`getComputedStyle(document.querySelector(".layer.hud")).visibility === "hidden"`) as Promise<boolean>;
      await waitText("はじまり");
      await p.waitForTimeout(300);
      // 常駐の文字と残したカットインは、メッセージ枠の上、暗転の下の層に置く
      expect(await p.evaluate(`[!!document.querySelector(".layer.hud > .lim-hud .lim-hud-text"), !!document.querySelector(".layer.hud > .lim-cutin-frame--stay[data-cutin=clue]"), !!document.querySelector(".layer.overlay > .lim-cutin-frame--stay[data-cutin=top]")]`), name).toEqual([true, true, true]);
      const before = await look();
      expect([black(before.clue), black(before.top), before.day > 20, await hudHidden()], name).toEqual([false, false, true, false]);

      await next();
      await waitText("暗転中");
      await p.waitForTimeout(400);
      const masked = await look();
      expect([black(masked.clue), masked.day, black(masked.top), await hudHidden()], `${name} ${JSON.stringify(masked)}`).toEqual([true, 0, false, true]);

      await next();
      await waitText("明けた");
      await p.waitForTimeout(400);
      expect(await hudHidden(), name).toBe(false);
      expect(black((await look()).clue), name).toBe(false);

      // 場面転換の暗転したまま置く間も隠れ、明けたら戻る（残すカットインはそのまま残る）
      await next();
      await p.waitForFunction(`document.querySelector(".stage").classList.contains("lm-masked")`, undefined, { timeout: 10_000 });
      await p.waitForTimeout(200);
      const changing = await look();
      expect([black(changing.clue), changing.day, await hudHidden()], `${name} ${JSON.stringify(changing)}`).toEqual([true, 0, true]);
      await waitText("場面が替わった");
      await p.waitForTimeout(400);
      expect([await hudHidden(), black((await look()).clue)], name).toEqual([false, false]);

      // 章の扉の間も隠す（扉を消したら戻る）
      await next();
      await p.waitForSelector(".lim-chapter-card, .lim-chapter", { timeout: 10_000 }).catch(() => undefined);
      await p.waitForFunction(`document.querySelector(".stage").classList.contains("lm-ui-covered")`, undefined, { timeout: 10_000 });
      expect(await hudHidden(), name).toBe(true);
      await waitText("扉のあと");
      await p.waitForTimeout(300);
      expect(await hudHidden(), name).toBe(false);
      await p.close();
    }
  });
});
