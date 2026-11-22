import type { Server } from "node:http";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { serveFolder } from "../../../cli/src/serve-folder.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { imageSize } from "@liminalia/lang";
import { runBuild } from "../../../cli/src/commands/build.ts";
import { browsers, e2e } from "./harness.ts";

/**
 * 解像度を下げて書き出した画像（build.*.compress.images.scale。スマホ版の build.mobile と同じ形）を、遊ぶ側が元の大きさで出すこと:
 * 背景、立ち絵、@image（元の大きさのまま置くものと、一部を切り出すもの）の位置と大きさが、下げない書き出しと同じになる。
 * 画像を縮めるのは cwebp なので、無ければ流さない（書き出しが「cwebp が必要です」で止まる。CI のブラウザのジョブでは入れてある）。
 */

const hasCwebp = (() => {
  try {
    execFileSync("cwebp", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const TEMPLATE = resolve(import.meta.dirname, "../../../../templates/default");

const SCENARIO = `@window show
@bg hill_dusk.webp
@chara アカリ normal at=center
@image akari/normal.webp folder=fgimage name=full x=10 y=10 wait=false
@image akari/smile.webp folder=fgimage name=crop x=700 y=10 sx=150 sy=100 sw=300 sh=300 wait=false
はじまり。
`;

interface Look {
  background: number[];
  sprite: number[];
  full: number[];
  natural: number[];
  crop: number[];
  /** 切り出した絵の、4 か所の色。 */
  pixels: number[][];
}

async function look(page: Page): Promise<Look> {
  return (await page.evaluate(`(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 2) / 2); };
    const full = document.querySelector('.lim-img[data-name="full"]');
    const crop = document.querySelector('.lim-img[data-name="crop"]');
    const g = crop.getContext("2d");
    const pixels = [[40, 40], [150, 150], [260, 80], [100, 260]].map(([x, y]) => [...g.getImageData(x, y, 1, 1).data]);
    return { background: box(document.querySelector(".background img")), sprite: box(document.querySelector(".sprite")), full: box(full), natural: [full.naturalWidth, full.naturalHeight], crop: [crop.width, crop.height, ...box(crop)], pixels };
  })()`)) as Look;
}

describe.skipIf(!e2e || !hasCwebp)("解像度を下げて書き出した画像を元の大きさで出す", { timeout: 600_000 }, () => {
  let root: string;
  let list: { name: string; browser: Browser }[];
  const builds: Record<string, string> = {};
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "liminalia-asset-scale-"));
    for (const kind of ["full", "half"] as const) {
      const dir = join(root, kind);
      cpSync(TEMPLATE, dir, { recursive: true });
      writeFileSync(join(dir, "scenario", "a.lim"), SCENARIO);
      const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown> & { build?: Record<string, unknown> };
      cfg.entry = "a";
      cfg.build = { ...cfg.build, browser: { offline: false, ...(kind === "half" ? { compress: { images: { scale: 0.5, quality: 90 } } } : {}) } };
      writeFileSync(join(dir, "liminalia.json"), JSON.stringify(cfg));
      const log = console.log;
      console.log = () => undefined;
      try {
        expect(await runBuild(dir, { targets: ["browser"], import: false, verify: false })).toBe(true);
      } finally {
        console.log = log;
      }
      builds[kind] = join(dir, "dist", "browser", "hoshi_wo_matsu_oka");
    }
    list = await browsers();
  }, 300_000);
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("書き出しは背景と立ち絵の縦横を半分にし、元の大きさを assets-scale.json に書く", () => {
    const table = JSON.parse(readFileSync(join(builds.half!, "project", "assets-scale.json"), "utf8")) as Record<string, number[]>;
    expect(table["fgimage/akari/normal.webp"]).toEqual([600, 900, 300, 450]);
    expect(table["bgimage/hill_dusk.webp"]).toEqual([1280, 720, 640, 360]);
    expect(imageSize(readFileSync(join(builds.half!, "assets", "fgimage", "akari", "normal.webp")))).toEqual({ width: 300, height: 450 });
    expect(JSON.parse(readFileSync(join(builds.full!, "project", "assets-scale.json"), "utf8"))).toEqual({});
  });

  it("背景、立ち絵、@image の位置と大きさ、切り出した絵が、下げない書き出しと同じになる", async () => {
    const servers: Server[] = [];
    try {
      for (const { name, browser } of list) {
        const seen: Record<string, Look> = {};
        for (const kind of ["full", "half"] as const) {
          const { server, url } = await serveFolder(builds[kind]!);
          servers.push(server);
          const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
          const errors: string[] = [];
          page.on("pageerror", (e) => errors.push(e.message));
          await page.goto(`${url}?autostart=1&start=a`);
          await page.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("はじまり"), null, { timeout: 60_000 });
          await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".background img, .sprite img, img.lim-img")].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30_000 });
          seen[kind] = await look(page);
          expect(errors, `${name} ${kind}`).toEqual([]);
          await page.close();
        }
        const { full, half } = seen as { full: Look; half: Look };
        expect(half.background, name).toEqual(full.background);
        expect(half.sprite, name).toEqual(full.sprite);
        expect(half.full, name).toEqual(full.full);
        expect(half.natural, name).toEqual([600, 900]);
        expect(half.crop, name).toEqual(full.crop);
        // 切り出した絵は、同じ所が出る（解像度を下げた分の差だけ）
        // 色はアルファを掛けて比べる（ほとんど透明な画素の色は定まらないため）
        const premultiplied = (p: number[]) => [...p.slice(0, 3).map((v) => (v * p[3]!) / 255), p[3]!];
        for (const [i, p] of half.pixels.entries()) {
          const want = premultiplied(full.pixels[i]!);
          for (const [c, v] of premultiplied(p).entries()) expect(Math.abs(v - want[c]!), `${name} 画素 ${i} の ${c}（${full.pixels[i]} と ${p}）`).toBeLessThanOrEqual(32);
        }
        // 切り出しの中に、不透明な所がある（絵の外を切り出していない）
        expect(half.pixels.some((p) => p[3] === 255), name).toBe(true);
      }
    } finally {
      for (const s of servers) s.close();
    }
  });
});
