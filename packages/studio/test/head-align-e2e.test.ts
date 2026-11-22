import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";

/**
 * 頭の大きさを揃える画面の、覚えた測定点（.liminalia/shared.json の heads）と差し替えた絵（2026-11-19 の X4）。
 * 測定点は画像のパスで覚えるので、同じパス、同じ大きさのまま中身の違う絵に差し替えたら、前の測定点を「確認済み」のまま使わない。
 * lim studio を立てて Chromium で確かめる。Chrome が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const TEMPLATE = join(ROOT, "templates/default");
const LIM = join(ROOT, "packages/cli/bin/lim.mjs");

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("頭の大きさを揃える画面の覚えた測定点（lim studio）", { timeout: 300_000 }, () => {
  let dir: string;
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  const showView = (id: string) => page.evaluate((v) => (window as unknown as { __liminaliaStudio: { showView(id: string): void } }).__liminaliaStudio.showView(v), id);
  const heads = () => {
    const path = join(dir, ".liminalia", "shared.json");
    return existsSync(path) ? ((JSON.parse(readFileSync(path, "utf8")) as { heads?: Record<string, { imageHash?: string }> }).heads ?? {}) : {};
  };
  /** アカリの頭の画面を開き、絵ごとの「確認済み」かどうかを返す。 */
  async function openHead(): Promise<Record<string, boolean>> {
    await showView("cast");
    const cast = page.locator('.view-surface[data-view="cast"]');
    await cast.locator(".chars-list").getByText("アカリ", { exact: true }).first().click();
    await cast.getByRole("button", { name: "頭の大きさを揃える" }).first().click();
    const cards = page.locator(".dialog.head .head-card");
    await cards.first().waitFor({ timeout: 20_000 });
    await expect.poll(() => cards.count()).toBe(3);
    const out: Record<string, boolean> = {};
    for (const card of await cards.all()) out[(await card.locator(".head-name").textContent())!] = await card.locator(".head-badge.on").isVisible();
    return out;
  }

  /** 開いていれば閉じる（「揃える」で書けたときは閉じている）。 */
  async function closeHead(): Promise<void> {
    const cancel = page.locator(".dialog.head").getByRole("button", { name: "キャンセル" });
    if (await cancel.isVisible()) await cancel.click();
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-head-align-"));
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

  it("確かめた測定点は絵の中身の印と一緒に覚え、開き直すと確認済み。同じパス、同じ大きさの違う絵に差し替えると確認済みでなくなる", async () => {
    expect(Object.values(await openHead())).toEqual([false, false, false]);
    await page.getByRole("button", { name: "すべてこれでよい" }).click();
    await page.locator(".dialog.head .primary").click();
    await expect.poll(() => Object.keys(heads()).sort()).toEqual(["akari/normal.webp", "akari/smile.webp", "akari/surprised.webp"]);
    for (const mark of Object.values(heads())) expect(mark.imageHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    await closeHead();
    expect(await openHead()).toEqual({ "akari/normal.webp": true, "akari/smile.webp": true, "akari/surprised.webp": true });
    await closeHead();
    // 外で同じ名前のまま、同じ大きさ（600×900）の別の絵に差し替える
    copyFileSync(join(dir, "assets/fgimage/akari/smile.webp"), join(dir, "assets/fgimage/akari/surprised.webp"));
    expect(await openHead()).toEqual({ "akari/normal.webp": true, "akari/smile.webp": true, "akari/surprised.webp": false });
    await closeHead();
    expect(errors).toEqual([]);
  });
});
