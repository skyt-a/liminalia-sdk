import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";

/**
 * 制作画面のデータの欄（data-form.ts）を、lim studio を立てて Chromium で確かめる。
 * - 素材の欄は、前の置き場所（d.asset の also）の素材も一覧に出し、その絵を出す
 * - 絵の上の点（d.point）は、絵を出して、押した所と引きずった所に点を置く
 * Chrome が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const LIM = resolve(import.meta.dirname, "../../cli/bin/lim.mjs");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const CODEX = {
  categories: [{ id: "town", label: "町", type: "map", map: "maps/old.png" }],
  entries: [{ id: "station", category: "town", title: "駅", x: 10, y: 20 }],
};

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("制作画面のデータの欄（lim studio）", { timeout: 300_000 }, () => {
  let dir: string;
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const showView = (id: string) => page.evaluate((v) => (window as unknown as { __liminaliaStudio: { showView(id: string): void } }).__liminaliaStudio.showView(v), id);
  const codex = () => JSON.parse(readFileSync(join(dir, "data/codex.json"), "utf8")) as typeof CODEX;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-studio-data-"));
    cpSync(TEMPLATE, dir, { recursive: true });
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data/codex.json"), `${JSON.stringify(CODEX, null, 2)}\n`);
    // 前の置き場所（image）にだけある地図の絵
    mkdirSync(join(dir, "assets/image/maps"), { recursive: true });
    writeFileSync(join(dir, "assets/image/maps/old.png"), PNG);
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
    await page.waitForTimeout(1000);
    await showView("plugins");
    await page.locator(".plg-nav", { hasText: "図鑑" }).first().click();
    await page.locator(".dform-view .dform-body .dform-record").first().waitFor();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** 図鑑の区分の一つ目と項目の一つ目を開く。 */
  const openItems = async () => {
    for (const d of await page.locator(".dform-view details.dform-item").all()) {
      if (!(await d.evaluate((x) => (x as HTMLDetailsElement).open))) await d.locator("> summary").click();
    }
  };

  it("素材の欄は、前の置き場所（also）の素材も一覧に出し、その絵を出す", async () => {
    await openItems();
    // 地図の絵の欄（値が maps/old.png の素材の欄）
    const found = await page.evaluate(() => {
      const field = [...document.querySelectorAll<HTMLElement>(".dform-view .dform-asset")].find((f) => f.querySelector("input")?.value === "maps/old.png");
      if (!field) return null;
      return { options: [...field.querySelectorAll("datalist option")].map((o) => (o as HTMLOptionElement).value), src: field.querySelector("img.dform-thumb")?.getAttribute("src") ?? "" };
    });
    expect(found).not.toBeNull();
    expect(found!.options).toContain("maps/old.png");
    const src = found!.src;
    expect(src).toContain("image");
    expect(src).not.toContain("bgimage");
  });

  it("絵の上の点（d.point）は、区分の地図の絵を出し、押した所に点を置いて x と y に書く", async () => {
    await openItems();
    const board = page.locator(".dform-view .dform-point-board").first();
    await board.waitFor();
    // 項目の区分（category）が指す区分の地図の絵（前の置き場所の image にある）
    expect(await board.locator("img.dform-board-bg").getAttribute("src")).toContain("maps/old.png");
    await board.scrollIntoViewIfNeeded();
    // 今の点（10, 20）
    const dot = board.locator(".dform-point-dot");
    const b = (await board.boundingBox())!;
    const d0 = (await dot.boundingBox())!;
    expect(Math.abs(d0.x + d0.width / 2 - (b.x + b.width * 0.1))).toBeLessThan(3);
    expect(Math.abs(d0.y + d0.height / 2 - (b.y + b.height * 0.2))).toBeLessThan(3);
    // 押した所へ置く
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.75);
    await expect.poll(() => codex().entries[0], { timeout: 10_000 }).toMatchObject({ x: 50, y: 75 });
    // 引きずって動かす
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.75);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.4, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => codex().entries[0], { timeout: 10_000 }).toMatchObject({ x: 30, y: 40 });
  });

  it("ページの例外が出ていない", () => {
    expect(errors).toEqual([]);
  });
});
