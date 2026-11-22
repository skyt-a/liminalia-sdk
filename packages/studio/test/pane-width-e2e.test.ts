import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";

/**
 * 編集の欄の幅（splitter.ts）が窓に収まることを、lim studio を立てて Chromium で確かめる。
 * - 広い窓で覚えた幅のまま狭い窓で開いても、右の欄（プレビュー）が窓の外へはみ出さない
 * - 窓を広げ直すと、覚えた幅に戻る
 * - 「拡大」の既定の幅も、狭い窓に収まる
 * Chrome が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const LIM = join(ROOT, "packages/cli/bin/lim.mjs");

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("編集の欄の幅を窓に収める（lim studio）", { timeout: 300_000 }, () => {
  let dir: string;
  let server: ChildProcess;
  let browser: Browser;
  let url: string;

  type Box = { left: number; right: number };
  const boxes = (page: Page) =>
    page.evaluate(() => {
      const box = (s: string) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right) };
      };
      return { window: innerWidth, desk: box(".desk"), toc: box(".desk > .toc"), script: box(".desk > .script"), right: box(".desk > .right") };
    }) as Promise<{ window: number; desk: Box; toc: Box; script: Box; right: Box }>;

  async function open(width: number, widths: Record<string, number> = {}): Promise<Page> {
    const context = await browser.newContext({ locale: "ja-JP", viewport: { width, height: 768 } });
    const saved = Object.entries(widths).map(([v, px]) => `localStorage.setItem("liminalia.studio.width${v}", "${px}");`);
    await context.addInitScript(`localStorage.setItem("liminalia.studio.tourDone", "1"); ${saved.join(" ")}`);
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector(".cm-content", { state: "attached" });
    await page.waitForTimeout(1000);
    return page;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-pane-width-"));
    cpSync(join(ROOT, "examples/lighthouse"), dir, { recursive: true });
    server = spawn(process.execPath, [LIM, "studio", dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LIMINALIA_EXIT_WITH_PARENT: "1" } });
    url = await new Promise<string>((resolve, reject) => {
      let out = "";
      server.stdout!.on("data", (c: Buffer) => {
        out += c.toString();
        const m = /Studio: (\S+)/.exec(out);
        if (m) resolve(m[1]!);
      });
      server.on("exit", (code) => reject(new Error(`lim studio が終わりました（${code}）\n${out}`)));
    });
    browser = await chromium.launch({ executablePath: findChromium() });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("1280px で覚えた幅のまま 1024px で開いても、欄が窓に収まり、窓を広げると覚えた幅に戻る", async () => {
    const page = await open(1024, { "--toc-w": 300, "--right-w": 610 });
    let b = await boxes(page);
    expect(b.desk.right).toBe(1024);
    expect(b.right.right).toBeLessThanOrEqual(1024);
    expect(b.script.right - b.script.left).toBeGreaterThanOrEqual(320);

    await page.setViewportSize({ width: 1280, height: 768 });
    await expect.poll(async () => (await boxes(page)).toc.right).toBe(300);
    b = await boxes(page);
    expect(b.right.right - b.right.left).toBe(610);
    expect(b.right.right).toBe(1280);

    await page.setViewportSize({ width: 1024, height: 768 });
    await expect.poll(async () => (await boxes(page)).right.right).toBeLessThanOrEqual(1024);
    await page.context().close();
  });

  it("「拡大」の既定の幅も 1024px の窓に収まる", async () => {
    const page = await open(1024);
    await page.locator(".desk > .right .panel-tool").first().click();
    await expect.poll(() => page.evaluate(() => document.querySelector(".desk")!.classList.contains("stage-large"))).toBe(true);
    const b = await boxes(page);
    expect(b.right.right).toBeLessThanOrEqual(1024);
    expect(b.script.right - b.script.left).toBeGreaterThanOrEqual(320);
    await page.context().close();
  });
});
