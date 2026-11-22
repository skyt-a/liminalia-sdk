import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";

/**
 * 制作画面の一覧（素材の一覧、人物の顔、差分の格子）は、原寸の画像ではなく縮小した画像（thumbs.ts の blob:）を出す。
 * 背景のフォルダを開いても、原寸の画像を展開して持ち続けない（2026-11-20 の性能の洗い出し P3）。
 * lim studio を立てて Chromium で確かめる。Chrome が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const TEMPLATE = join(ROOT, "templates/default");
const LIM = join(ROOT, "packages/cli/bin/lim.mjs");

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("一覧の縮小画像（lim studio）", { timeout: 300_000 }, () => {
  let dir: string;
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  const showView = (id: string) => page.evaluate((v) => (window as unknown as { __liminaliaStudio: { showView(id: string): void } }).__liminaliaStudio.showView(v), id);
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-thumbs-"));
    cpSync(TEMPLATE, dir, { recursive: true });
    server = spawn(process.execPath, [LIM, "studio", dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      server.stdout!.on("data", (c: Buffer) => {
        out += c.toString();
        const m = /Studio: (\S+)/.exec(out);
        if (m) resolve(m[1]!);
      });
      server.on("exit", (code) => reject(new Error(`lim studio が終わりました（${code}）\n${out}`)));
    });
    browser = await chromium.launch({ executablePath: findChromium(), args: ["--mute-audio"] });
    const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
    await context.addInitScript('localStorage.setItem("liminalia.studio.tourDone", "1")');
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForSelector(".cm-content", { state: "attached" });
    await page.waitForTimeout(1500);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("背景の素材の一覧は、長辺 256px 以下の縮小画像を出す", async () => {
    await showView("assets");
    const assets = page.locator('.view-surface[data-view="assets"]');
    await assets.locator(".assets-kind", { hasText: "背景" }).click();
    const imgs = assets.locator("img[data-src]");
    await expect.poll(() => imgs.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    await expect.poll(() => imgs.evaluateAll((list) => list.every((i) => (i as HTMLImageElement).src.startsWith("blob:") && (i as HTMLImageElement).complete)), { timeout: 20_000 }).toBe(true);
    const sizes = await imgs.evaluateAll((list) => list.map((i) => Math.max((i as HTMLImageElement).naturalWidth, (i as HTMLImageElement).naturalHeight)));
    expect(sizes.every((n) => n > 0 && n <= 256)).toBe(true);
  });

  it("人物の一覧の顔は、縮小した立ち絵で描く", async () => {
    await showView("cast");
    const cast = page.locator('.view-surface[data-view="cast"]');
    const face = cast.locator(".chars-list .face").first();
    await face.waitFor({ timeout: 20_000 });
    await expect.poll(() => face.evaluate((el) => el.getAttribute("style") ?? ""), { timeout: 20_000 }).toContain("blob:");
    expect(errors).toEqual([]);
  });
});
