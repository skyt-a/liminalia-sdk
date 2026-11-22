import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { decodePng, encodePng, type Rgba } from "../../../cli/src/mobile/icon.ts";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 範囲を決めた画面効果（@effect の WebGL の種類と @filter）を、画面の画素で確かめる。
 * 範囲の中は効果で変わり、外は元のまま（radial-out はその逆）。範囲の中が黒く抜けないこと。
 * DOM の style だけを見るテストでは、効果の絵が出ていなくても通ってしまう（範囲の中が黒い穴になる不具合を見逃した）。
 */

const W = 1280;
const H = 720;

/** 一画素ごとに色が変わり、どこも暗くない模様（どの色も 64 以上）。 */
function pattern(): Rgba {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = 64 + ((x * 7 + y * 3) % 192);
      data[i + 1] = 64 + ((y * 11 + x) % 192);
      data[i + 2] = 64 + (((x ^ y) * 5) % 192);
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

/** 範囲（楕円の中心と大きさ）。ぼかしは既定（小さいほうの 4 分の 1）で、中心から半径の半分までは効果だけが見える。 */
const CX = 360;
const CY = 240;
const SIZE = 260;
const MASK = `${CX} ${CY} ${SIZE} ${SIZE}`;

const SCENARIO = `@bg pattern.png
@window show
はじまり。
@effect mosaic strength=16 mask="radial ${MASK}"
範囲の中のモザイク。
@effect-off
@effect ripple strength=14 mask="radial-out ${MASK}"
範囲の外の波紋。
@effect-off
@effect zoom-blur strength=20 layer=base mask="radial ${MASK}"
背景の層の範囲のぼかし。
@effect-off
@effect mosaic strength=16
全体のモザイク。
@effect-off
@filter grayscale=100 mask="radial ${MASK}"
範囲の中の白黒。
@filter-off
@filter grayscale=100 mask="radial-out ${MASK}"
範囲の外の白黒。
@filter-off
おわり。
`;

/** 範囲の中（中心から半径の 0.4 倍まで）と外（右の広い所。本文の枠より上）から取る点。 */
const INSIDE: [number, number][] = [];
const OUTSIDE: [number, number][] = [];
for (let dy = -50; dy <= 50; dy += 5) for (let dx = -50; dx <= 50; dx += 5) if (dx * dx + dy * dy <= 52 * 52) INSIDE.push([CX + dx, CY + dy]);
for (let y = 40; y <= 420; y += 12) for (let x = 760; x <= 1240; x += 12) OUTSIDE.push([x, y]);
/** ぼかしの縁（半径の 0.6〜0.9 倍の輪）。効果の絵と元の絵が重なって移る所。 */
const BAND: [number, number][] = [];
for (let a = 0; a < 360; a += 6) for (const k of [0.6, 0.75, 0.9]) BAND.push([Math.round(CX + Math.cos((a * Math.PI) / 180) * k * (SIZE / 2)), Math.round(CY + Math.sin((a * Math.PI) / 180) * k * (SIZE / 2))]);

/** 点の明るさの平均。 */
const brightness = (img: Rgba, points: [number, number][]) => points.reduce((sum, [x, y]) => sum + at(img, x, y).reduce((a, b) => a + b, 0) / 3, 0) / points.length;

interface Stats {
  /** 元の絵から変わった点の割合。 */
  changed: number;
  /** 黒い（どの色も 24 未満の）点の割合。 */
  black: number;
  /** 白黒になった（赤・緑・青の差が 6 以下の）点の割合。 */
  gray: number;
}

const at = (img: Rgba, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!] as const;
};

function stats(shot: Rgba, base: Rgba, points: [number, number][]): Stats {
  let changed = 0;
  let black = 0;
  let gray = 0;
  for (const [x, y] of points) {
    const a = at(shot, x, y);
    const b = at(base, x, y);
    if (Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) > 24) changed++;
    if (Math.max(...a) < 24) black++;
    if (Math.max(...a) - Math.min(...a) <= 6) gray++;
  }
  const n = points.length;
  return { changed: changed / n, black: black / n, gray: gray / n };
}

const shot = async (p: Page): Promise<Rgba> => decodePng(await p.screenshot())!;

describe.skipIf(!e2e)("範囲を決めた画面効果の画素（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a" },
      before: (dir) => writeFileSync(join(dir, "assets/bgimage/pattern.png"), encodePng(pattern(), false)),
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("範囲の中だけが変わり、外は元のまま。radial-out はその逆。範囲の中は黒く抜けない", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: W, height: H } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      const page = async (text: string) => {
        await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(text)})`, undefined, { timeout: 30_000 });
        // 効果を掛け終わり、文字が出そろうまで
        await p.waitForTimeout(700);
      };
      const next = () => p.mouse.click(1000, 600);
      await page("はじまり");
      const base = await shot(p);
      // 元の絵が写っている（範囲の外も中も模様のまま）
      expect(stats(base, base, INSIDE).black, name).toBe(0);

      const check = async (text: string, inside: "changed" | "same", outside: "changed" | "same", kind: keyof Stats = "changed") => {
        await next();
        await page(text);
        const img = await shot(p);
        const i = stats(img, base, INSIDE);
        const o = stats(img, base, OUTSIDE);
        const label = `${name} ${text} 中 ${JSON.stringify(i)} 外 ${JSON.stringify(o)}`;
        expect(i.black, label).toBe(0);
        expect(o.black, label).toBe(0);
        if (inside === "changed") expect(i[kind], label).toBeGreaterThan(0.5);
        else expect(i.changed, label).toBeLessThan(0.02);
        if (outside === "changed") expect(o[kind], label).toBeGreaterThan(0.5);
        else expect(o.changed, label).toBeLessThan(0.02);
        // 縁で暗い輪にならない（元の絵と効果の絵を両方薄くすると、下の黒が透ける）
        expect(brightness(img, BAND) / brightness(base, BAND), label).toBeGreaterThan(0.9);
      };
      await check("範囲の中のモザイク", "changed", "same");
      await check("範囲の外の波紋", "same", "changed");
      await check("背景の層の範囲のぼかし", "changed", "same");
      await check("全体のモザイク", "changed", "changed");
      // 範囲を決めた @filter は下を写す板（backdrop-filter）で掛ける。Playwright の WebKit の撮影には写らない（画面には出る）ので Chromium だけ見る
      if (name === "chromium") {
        await check("範囲の中の白黒", "changed", "same", "gray");
        await check("範囲の外の白黒", "same", "changed", "gray");
      }
      await p.close();
    }
  });
});
