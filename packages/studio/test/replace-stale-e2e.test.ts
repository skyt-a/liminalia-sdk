import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import { findChromium } from "../../cli/src/chromium.ts";

/**
 * 全ファイルの置換で、探し方を変えたあと新しい結果が届くまでは、前の探し方の結果で置換しない（lim studio を立てて Chromium で確かめる）。
 * Chrome が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const LIM = resolve(import.meta.dirname, "../../cli/bin/lim.mjs");

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("全ファイルの置換と探し方の変更（lim studio）", { timeout: 240_000 }, () => {
  let dir: string;
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  /** 開いている start.lim の中身（置換は書き込む前に編集中の内容へ入る）。 */
  const start = () => page.evaluate(() => (window as unknown as { __liminaliaStudioApp: { debug: { editor: { text(): string } } } }).__liminaliaStudioApp.debug.editor.text());
  /** 置換の結果の欄に出ている文（隠れていれば空）。 */
  const report = () => page.locator(".replace-report").evaluate((el: HTMLElement) => (el.hidden ? "" : (el.textContent ?? "")));

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-studio-replace-"));
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
    browser = await chromium.launch({ executablePath: findChromium() });
    const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1440, height: 900 } });
    await context.addInitScript('localStorage.setItem("liminalia.studio.tourDone", "1")');
    page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector(".cm-content", { state: "attached" });
    await page.waitForTimeout(1500);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** query を replacement に置換する見本を出す（テストごとに別の言葉を使い、前のテストの置換に左右されないようにする）。 */
  const openReplace = async (query: string, replacement: string) => {
    await page.evaluate(([q, r]) => (window as unknown as { __liminaliaStudioApp: { toc: { openReplace(q: string, r: string, f: object): void } } }).__liminaliaStudioApp.toc.openReplace(q!, r!, { regex: false, body: false }), [query, replacement]);
    await expect.poll(() => page.locator(".replace-summary").textContent()).toMatch(/ファイルの [1-9]\d* か所を置換します/);
    expect(await page.locator(".replace-run").isEnabled()).toBe(true);
  };

  /** 置換のボタンを押す（押せなければ何も起きない）。 */
  const pressReplace = () => page.locator(".replace-run").evaluate((b: HTMLButtonElement) => b.click());

  it("新しい探し方の結果が届く前に置換を押しても、前の結果では置換しない", async () => {
    await openReplace("天文台", "灯台");
    const before = await start();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const routed: Promise<void>[] = [];
    const hold = (route: Route) => {
      const sent = held.then(() => route.continue());
      routed.push(sent);
      return sent;
    };
    await page.route("**/search", hold);
    const asked = page.waitForRequest("**/search");
    await page.locator(".toc-search").fill("どこにもない言葉");
    await asked;
    const disabled = await page.locator(".replace-run").isDisabled();
    await pressReplace();
    release();
    await Promise.all(routed);
    await page.unroute("**/search", hold);
    await expect.poll(() => page.locator(".replace-summary").textContent()).toBe("見つかりませんでした");
    expect(await report()).toBe("");
    expect(await start()).toBe(before);
    expect(disabled).toBe(true);
  });

  it("探す文字を打ってすぐ（探し直す前）に置換を押しても、前の結果では置換しない", async () => {
    await openReplace("ラジオ", "無線");
    const before = await start();
    await page.locator(".toc-search").fill("どこにもない言葉");
    const disabled = await page.locator(".replace-run").isDisabled();
    await pressReplace();
    await expect.poll(() => page.locator(".replace-summary").textContent()).toBe("見つかりませんでした");
    expect(await report()).toBe("");
    expect(await start()).toBe(before);
    expect(disabled).toBe(true);
  });

  it("探している途中で打ち足し、前の探し方の結果が先に届いても、その結果では置換しない", async () => {
    await openReplace("夜明け", "朝");
    const before = await start();
    let releaseFirst!: () => void;
    let releaseRest!: () => void;
    const first = new Promise<void>((r) => (releaseFirst = r));
    const rest = new Promise<void>((r) => (releaseRest = r));
    const routed: Promise<void>[] = [];
    const hold = (route: Route) => {
      const sent = (routed.length === 0 ? first : rest).then(() => route.continue());
      routed.push(sent);
      return sent;
    };
    await page.route("**/search", hold);
    const asked = page.waitForRequest("**/search");
    await page.locator(".toc-search").fill("夜明");
    await asked;
    await page.locator(".toc-search").fill("どこにもない言葉");
    const answered = page.waitForResponse("**/search");
    releaseFirst();
    await answered;
    await page.waitForTimeout(50);
    const disabled = await page.locator(".replace-run").isDisabled();
    await pressReplace();
    releaseRest();
    await Promise.all(routed);
    await page.unroute("**/search", hold);
    await expect.poll(() => page.locator(".replace-summary").textContent()).toBe("見つかりませんでした");
    expect(await report()).toBe("");
    expect(await start()).toBe(before);
    expect(disabled).toBe(true);
  });

  it("結果が届けば、今の探し方の結果で置換する", async () => {
    await openReplace("望遠鏡", "遠眼鏡");
    await page.locator(".replace-run").click();
    await expect.poll(() => page.locator(".replace-report").textContent()).toMatch(/ファイルの \d+ か所を置換しました/);
    await expect.poll(() => start()).not.toContain("望遠鏡");
    await expect.poll(() => readFileSync(join(dir, "scenario", "start.lim"), "utf8")).not.toContain("望遠鏡");
  });
});
