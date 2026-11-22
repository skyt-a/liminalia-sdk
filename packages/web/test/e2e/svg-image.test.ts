import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * @image で出した SVG の素材（ブラウザ）。中のスクリプトはゲームのページのオリジンで動かず、絵は今までと同じ大きさで出る。
 * 開発サーバーは .svg にスクリプトを止める Content-Security-Policy を付ける（直接開いても動かない）。
 */

/** 幅と高さを書いた SVG。 */
const SIZED = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#c00"/></svg>`;
/** viewBox だけの SVG（固有の大きさが無く、縦横の比だけがある）。 */
const VIEWBOX = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#0c0"/></svg>`;
/** 中のスクリプトが親のページに印を付けようとする SVG。 */
const SCRIPTED = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="#00c"/><script>try { (window.parent || window).document.documentElement.dataset.svgRan = "1" } catch (e) {} try { window.top.document.documentElement.dataset.svgRan = "1" } catch (e) {}</script></svg>`;

const scenario = `@image sized.svg name=sized x=0 y=0 time=0ms
@image viewbox.svg name=viewbox x=200 y=0 time=0ms
@image sized.svg name=wide x=0 y=200 width=240 time=0ms
@image scripted.svg name=scripted x=400 y=0 time=0ms
@window show
出した。
@stop
`;

describe.skipIf(!e2e)("SVG の画像（ブラウザ）", { timeout: 120_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: scenario },
      config: { entry: "a" },
      before: (dir) => {
        const folder = join(dir, "assets", "fgimage");
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "sized.svg"), SIZED);
        writeFileSync(join(folder, "viewbox.svg"), VIEWBOX);
        writeFileSync(join(folder, "scripted.svg"), SCRIPTED);
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("中のスクリプトは動かず、絵は今までと同じ大きさで出る", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("出した")`);
      // 読み込み終えたあとに動くスクリプトにも時間を与える
      await p.waitForTimeout(1_000);
      expect.soft(await p.evaluate(() => document.documentElement.dataset.svgRan ?? null), name).toBeNull();
      const boxes = await p.evaluate(() =>
        Object.fromEntries(
          ["sized", "viewbox", "wide", "scripted"].map((n) => {
            const el = document.querySelector<HTMLElement>(`.lim-img[data-name="${n}"]`);
            const r = el?.getBoundingClientRect();
            return [n, r ? { tag: el!.tagName.toLowerCase(), width: Math.round(r.width), height: Math.round(r.height) } : null];
          }),
        ),
      );
      // 大きさは <object> で読んでいたときに測ったもの（舞台は 1280×720 のままなので画面の座標と同じ）。
      // viewBox だけの SVG は、Chromium は置いた位置から舞台の右端までの幅（1280 - 200）、WebKit は舞台の幅にして、縦横の比を合わせる
      expect.soft(boxes, name).toMatchObject({
        sized: { width: 120, height: 80 },
        viewbox: name === "webkit" ? { width: 1280, height: 640 } : { width: 1080, height: 540 },
        wide: { width: 240, height: 160 },
        scripted: { width: 50, height: 50 },
      });
      // 絵が描かれている（読み込みに失敗した <img> は naturalWidth が 0）
      const drawn = await p.evaluate(() => [...document.querySelectorAll<HTMLElement>(".lim-img")].map((el) => (el instanceof HTMLImageElement ? el.complete && el.naturalWidth > 0 : el.tagName)));
      expect.soft(drawn, name).toEqual([true, true, true, true]);
      await p.close();
    }
  });

  it("開発サーバーは .svg にスクリプトを止める Content-Security-Policy を付ける", async () => {
    const r = await fetch(`${project.url}assets/fgimage/scripted.svg`);
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    const ranged = await fetch(`${project.url}assets/fgimage/scripted.svg`, { headers: { range: "bytes=0-9" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-security-policy")).toContain("sandbox");
  });
});
