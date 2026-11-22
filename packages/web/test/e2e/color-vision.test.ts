import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { decodePng } from "../../../cli/src/mobile/icon.ts";
import { colorVisionMatrix } from "../../src/system/color-vision.ts";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 色覚の補正（コンフィグの「色覚の補正」）を、画面の画素で確かめる。舞台の中のもの（背景の塗り、毎コマ描き直すキャンバス）に同じ色の行列がかかる。
 * 補正をかけている間は、舞台の中のキャンバスを別の層にする（WebKit は SVG のフィルタをかけた舞台の中でキャンバスが描き変わるたびに、
 * 舞台の絵をすべて描き直してフィルタをかけ直すので、粒子などでコマが落ちる。別の層にしても行列はかかる）。
 */

const BG: [number, number, number] = [200, 60, 40];
const CANVAS: [number, number, number] = [40, 160, 90];

/** 色に補正の行列をかけた色（0〜255 に収める）。 */
function corrected(kind: "protan" | "deutan" | "tritan", c: [number, number, number]): number[] {
  const m = colorVisionMatrix(kind);
  return [0, 1, 2].map((r) => Math.round(Math.min(1, Math.max(0, m[r * 5]! * (c[0] / 255) + m[r * 5 + 1]! * (c[1] / 255) + m[r * 5 + 2]! * (c[2] / 255))) * 255));
}

/** 画面の (x, y) の色。 */
async function pixel(p: Page, x: number, y: number): Promise<number[]> {
  const img = decodePng(await p.screenshot({ clip: { x, y, width: 1, height: 1 }, scale: "css" }));
  if (!img) throw new Error("画面写真を読めません");
  return Array.from(img.data.slice(0, 3));
}

const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 4);

describe.skipIf(!e2e)("色覚の補正（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: `@bg color=#${BG.map((v) => v.toString(16).padStart(2, "0")).join("")} time=0ms\n@window show\nはじまり。\n` },
      config: { entry: "a" },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("背景と毎コマ描き直すキャンバスに同じ行列がかかり、かけている間はキャンバスを別の層にする", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("はじまり")`);
      // 画面効果の層に、毎コマ同じ色で描き直すキャンバスを置く（粒子と同じ置き方）
      await p.evaluate(`(() => {
        const c = document.createElement("canvas");
        c.className = "t-canvas";
        c.width = 400; c.height = 200;
        Object.assign(c.style, { position: "absolute", left: "600px", top: "100px", width: "400px", height: "200px" });
        document.querySelector(".layer.fx").append(c);
        const g = c.getContext("2d");
        const draw = () => { if (!c.isConnected) return; g.clearRect(0, 0, 400, 200); g.fillStyle = "rgb(${CANVAS.join(",")})"; g.fillRect(0, 0, 400, 200); requestAnimationFrame(draw); };
        draw();
      })()`);
      const willChange = () => p.evaluate(`getComputedStyle(document.querySelector(".t-canvas")).willChange`);
      await p.waitForTimeout(300);
      expect(await pixel(p, 200, 150), name).toEqual(BG);
      expect(await pixel(p, 800, 200), name).toEqual(CANVAS);
      expect(await willChange(), name).toBe("auto");
      for (const kind of ["deutan", "protan", "tritan"] as const) {
        await p.evaluate(`window.__liminalia.system.updateSettings({ colorVision: "${kind}" })`);
        await p.waitForTimeout(300);
        const bg = await pixel(p, 200, 150);
        const canvas = await pixel(p, 800, 200);
        expect(near(bg, corrected(kind, BG)), `${name} ${kind} 背景 ${bg} / ${corrected(kind, BG)}`).toBe(true);
        expect(near(canvas, corrected(kind, CANVAS)), `${name} ${kind} キャンバス ${canvas} / ${corrected(kind, CANVAS)}`).toBe(true);
        expect(await willChange(), `${name} ${kind}`).toBe("transform");
      }
      // 外すと元の色に戻り、キャンバスも元の層に戻る
      await p.evaluate(`window.__liminalia.system.updateSettings({ colorVision: "" })`);
      await p.waitForTimeout(300);
      expect(await pixel(p, 200, 150), name).toEqual(BG);
      expect(await pixel(p, 800, 200), name).toEqual(CANVAS);
      expect(await willChange(), name).toBe("auto");
      await p.close();
    }
  });
});
