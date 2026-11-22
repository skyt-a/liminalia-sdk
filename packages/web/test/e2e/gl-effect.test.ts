import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** WebGL でかける画面効果（@effect mosaic・shader など）を、実際のブラウザで確かめる。 */

const STRIPES = resolve(import.meta.dirname, "fixtures/stripes.png"); // 1px ごとに黒と白の縦縞

const SHADER = `uniform float g;
void main() {
  gl_FragColor = vec4(u_strength, g, texture2D(u_texture, v_uv).b * 0.0, 1.0);
}
`;

const scenario = `@bg stripes.png
@window show
はじまり。
@effect mosaic strength=16
モザイク。
@effect-off
戻した。
@effect shader file=shaders/fill.frag strength=1 values="g=1"
自前。
`;

/** 止まった絵では写し直さず、絵が変わったら写し直す（数えるのは texImage2D と drawArrays）。 */
const still = `@bg stripes.png
@window show
はじまり。
@effect mosaic strength=16
止まった絵。
@bg color=#3060c0 time=0ms
替えた絵。
@effect-off
@effect ripple strength=10
波紋。
`;

/**
 * 範囲を決めた効果（元の絵が見えていて動く）を動きのある SVG にかけると、絵の印が同じでも写し続ける（drawImage が今の動きの絵を写す）。
 * 動く GIF は drawImage が一コマ目を写す（HTML の決まり）ので、止まった絵と同じく写し直さない。
 */
const moving = `@bg moving.svg
@window show
@effect mosaic strength=16 mask="radial 640 360 2400 2400"
動く絵。
@effect-off
@bg moving.gif time=0ms
@effect mosaic strength=16
動く GIF。
`;

/** 効果のキャンバス（範囲を決めたものはカメラの外）の (x, y) の色。 */
const glColor = (p: Page, x: number, y: number) =>
  p.evaluate(`(() => {
    const gl = document.querySelector("canvas.lim-gl-effect");
    const c = document.createElement("canvas");
    c.width = gl.width; c.height = gl.height;
    const g = c.getContext("2d");
    g.drawImage(gl, 0, 0);
    return Array.from(g.getImageData(${x}, ${y}, 1, 1).data.slice(0, 3)).join(",");
  })()`) as Promise<string>;

/** 赤と青を 0.1 秒ごとに替える SVG。 */
const MOVING_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#ff0000"><animate attributeName="fill" values="#ff0000;#0000ff" dur="0.2s" calcMode="discrete" repeatCount="indefinite"/></rect></svg>`;

/**
 * 4 色の動く GIF（w×h。colors はコマごとの色の番号（0 黒、1 白、2 赤、3 青）、delay は 1/100 秒、繰り返す）。
 * LZW は表が広がる前に clear を打ち、符号を 3 ビットのままにする。
 */
function animatedGif(w: number, h: number, colors: number[], delay: number): Buffer {
  const out = [...Buffer.from("GIF89a"), w & 255, w >> 8, h & 255, h >> 8, 0xf1, 0, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255];
  out.push(0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 0x03, 0x01, 0, 0, 0);
  for (const c of colors) {
    out.push(0x21, 0xf9, 0x04, 0, delay & 255, delay >> 8, 0, 0, 0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 0x02);
    const codes: number[] = [];
    for (let i = 0; i < w * h; i += 2) codes.push(4, c, ...(i + 1 < w * h ? [c] : []));
    codes.push(5);
    const data: number[] = [];
    let acc = 0;
    let bits = 0;
    for (const code of codes) {
      acc |= code << bits;
      bits += 3;
      while (bits >= 8) {
        data.push(acc & 255);
        acc >>= 8;
        bits -= 8;
      }
    }
    if (bits > 0) data.push(acc & 255);
    for (let i = 0; i < data.length; i += 255) out.push(Math.min(255, data.length - i), ...data.slice(i, i + 255));
    out.push(0);
  }
  out.push(0x3b);
  return Buffer.from(out);
}

/** WebGL に絵を上げた回数（texImage2D）と描いた回数（drawArrays）を数える（ページを開く前に入れる）。 */
const COUNT_GL = `(() => {
  const proto = WebGLRenderingContext.prototype;
  window.__glCount = { uploads: 0, draws: 0 };
  const tex = proto.texImage2D;
  proto.texImage2D = function (...a) { window.__glCount.uploads++; return tex.apply(this, a); };
  const draw = proto.drawArrays;
  proto.drawArrays = function (...a) { window.__glCount.draws++; return draw.apply(this, a); };
})()`;

/** ms ミリ秒の間に絵を上げた回数と描いた回数。 */
const countGl = async (p: Page, ms: number) => {
  const before = (await p.evaluate("({ ...window.__glCount })")) as { uploads: number; draws: number };
  await p.waitForTimeout(ms);
  const after = (await p.evaluate("({ ...window.__glCount })")) as { uploads: number; draws: number };
  return { uploads: after.uploads - before.uploads, draws: after.draws - before.draws };
};

/** 効果のキャンバスの (x, y) の色と、カメラを隠しているか。 */
const probe = (p: Page, points: [number, number][]) =>
  p.evaluate(`(() => {
    const camera = document.querySelector(".camera");
    const gl = camera.querySelector("canvas.lim-gl-effect");
    if (!gl) return { gl: false, hidden: getComputedStyle(camera).visibility === "hidden", colors: [] };
    const c = document.createElement("canvas");
    c.width = gl.width; c.height = gl.height;
    const g = c.getContext("2d");
    g.drawImage(gl, 0, 0);
    const colors = ${JSON.stringify(points)}.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)));
    return { gl: true, hidden: getComputedStyle(camera).visibility === "hidden", colors };
  })()`) as Promise<{ gl: boolean; hidden: boolean; colors: number[][] }>;

describe.skipIf(!e2e)("WebGL の画面効果（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: scenario, b: still, c: moving },
      config: { entry: "a" },
      files: { "assets/bgimage/stripes.png": STRIPES },
      before: (dir) => {
        mkdirSync(join(dir, "assets/others/shaders"), { recursive: true });
        writeFileSync(join(dir, "assets/others/shaders/fill.frag"), SHADER);
        writeFileSync(join(dir, "assets/bgimage/moving.svg"), MOVING_SVG);
        writeFileSync(join(dir, "assets/bgimage/moving.gif"), animatedGif(8, 8, [2, 3], 10));
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("モザイクは升目の中を一色にし、外すと元に戻る。作品のシェーダーには強さと値が渡る", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      const page = async (text: string) => {
        await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(text)})`);
        await p.waitForTimeout(600);
      };
      const next = () => p.mouse.click(640, 200);
      await page("はじまり");
      expect((await probe(p, [])).gl).toBe(false);
      await next();
      await page("モザイク");
      const mosaic = await probe(p, [
        [1, 100],
        [2, 100],
        [9, 100],
      ]);
      expect(mosaic, name).toMatchObject({ gl: true, hidden: true });
      // 縞（隣どうし白と黒）が、16px の升目の中では同じ色になる
      expect(mosaic.colors[0]).toEqual(mosaic.colors[1]);
      expect(mosaic.colors[0]).toEqual(mosaic.colors[2]);
      await next();
      await page("戻した");
      expect(await probe(p, [])).toEqual({ gl: false, hidden: false, colors: [] });
      await next();
      await page("自前");
      expect((await probe(p, [[640, 360]])).colors).toEqual([[255, 255, 0]]);
      await p.close();
    }
  });

  it("止まった絵では毎コマ写し直さず（テクスチャを上げ直さず）、絵が変わったら写し直す。時間で動く効果は描き続ける", async () => {
    // 写し直しがいちばん重いのは WebKit（上げるたびに画素を読み戻す）なので、CI では WebKit でも確かめる

    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(COUNT_GL);
      await p.goto(`${project.url}?autostart=1&start=b`);
      const page = async (text: string) => {
        await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(text)})`);
        await p.waitForTimeout(600);
      };
      const next = () => p.mouse.click(640, 200);
      await page("はじまり");
      await next();
      await page("止まった絵");
      expect((await probe(p, [])).gl, name).toBe(true);
      // 絵が止まっていれば、一秒の間に一度も上げ直さない（前は毎コマ写して上げていた）
      expect((await countGl(p, 1000)).uploads, name).toBe(0);
      await next();
      await page("替えた絵");
      // 背景を替えたら写し直す（古い絵のまま残らない）
      expect((await probe(p, [[100, 100]])).colors, name).toEqual([[48, 96, 192]]);
      expect((await countGl(p, 1000)).uploads, name).toBe(0);
      await next();
      await page("波紋");
      // 時間で動く効果は、絵を上げ直さずに描き続ける
      const ripple = await countGl(p, 1000);
      expect(ripple.uploads, name).toBe(0);
      expect(ripple.draws, name).toBeGreaterThan(10);
      await p.close();
    }
  });

  it("範囲を決めて動きのある SVG にかけた効果は写し続けて動きを出し、動く GIF（drawImage は一コマ目）は止まった絵と同じく写し直さない", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(COUNT_GL);
      await p.goto(`${project.url}?autostart=1&start=c`);
      const page = async (text: string) => {
        await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(text)})`);
        await p.waitForTimeout(600);
      };
      await page("動く絵");
      expect((await countGl(p, 1000)).uploads, name).toBeGreaterThan(5);
      // 赤と青の両方が出る（一枚目のままにならない）
      const seen = new Set<string>();
      for (let i = 0; i < 12; i++) {
        seen.add(await glColor(p, 640, 360));
        await p.waitForTimeout(45);
      }
      expect([...seen].sort(), name).toEqual(["0,0,255", "255,0,0"]);
      await p.mouse.click(640, 200);
      await page("動く GIF");
      expect((await countGl(p, 1000)).uploads, name).toBe(0);
      expect(await glColor(p, 100, 100), name).toBe("255,0,0");
      await p.close();
    }
  });
});
