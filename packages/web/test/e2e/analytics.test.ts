import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { runBuild } from "../../../cli/src/commands/build.ts";
import { browsers, e2e } from "./harness.ts";

/**
 * 遊ばれ方の統計（build.analytics。任意）: はじめて起動したときに尋ね、「はい」なら選んだ選択肢とやめた場面を送り、「いいえ」なら何も送らない。
 * コンフィグに「遊び方の統計を送信」を出し、あとから変えられる。送り先は CSP で許す。
 * 止まったときの記録（build.crashReport）: 止まった次の起動で尋ね、「はい」ならどの行で何が起きたかを送る（セーブの置き場所に記録を消されない）。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../../templates/default");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".lim": "text/plain; charset=utf-8", ".webp": "image/webp", ".png": "image/png" };
const SCENARIO = "@window show\n@bg hill_dusk.webp\nはじまりの一行。\n@choice\n- 北へ -> #north\n- 南へ -> #south\n@end\n# north\n北の道。\n# south\n南の道。\nここでやめる。\n";
const SHOTS = process.env.LIMINALIA_E2E_SHOTS;

/** 書き出したものを配る。POST /analytics は受けた本文を覚える（作者の送り先の代わり）。 */
function serve(dir: string, received: unknown[], crashes: unknown[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.method === "POST" && (req.url === "/analytics" || req.url === "/crash")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        (req.url === "/crash" ? crashes : received).push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      });
      return;
    }
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    const file = join(dir, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://localhost:${(server.address() as { port: number }).port}/` })));
}

describe.skipIf(!e2e)("遊ばれ方の統計", { timeout: 900_000 }, () => {
  let root: string;
  let list: { name: string; browser: Browser }[];
  const received: unknown[] = [];
  const crashes: unknown[] = [];
  let receiver: { server: Server; url: string };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "liminalia-analytics-"));
    const dir = join(root, "game");
    receiver = await serve(join(dir, "dist", "browser", "hoshi_wo_matsu_oka"), received, crashes);
    cpSync(TEMPLATE, dir, { recursive: true });
    writeFileSync(join(dir, "scenario", "a.lim"), SCENARIO);
    const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown> & { build?: Record<string, unknown> };
    cfg.entry = "a";
    cfg.build = { ...cfg.build, browser: { offline: false }, analytics: { url: `${receiver.url}analytics` }, crashReport: { url: `${receiver.url}crash` } };
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify(cfg));
    const log = console.log;
    console.log = () => undefined;
    try {
      expect(await runBuild(dir, { targets: ["browser"], import: false, verify: false })).toBe(true);
    } finally {
      console.log = log;
    }
    list = await browsers();
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  }, 600_000);

  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    receiver?.server.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** 遊ぶ人のブラウザとして開く（自動操作の印 navigator.webdriver を隠す。隠さなければ尋ねも送りもしない）。 */
  const open = async (browser: Browser): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    // 関数で渡すと、テストの変換が足す名前の助け（__name）がページに無くて動かないので、文字で渡す
    await page.addInitScript({ content: 'Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });' });
    await page.goto(receiver.url);
    await page.click(".lm-gate");
    return page;
  };

  it("送り先は CSP で取り寄せを許す", () => {
    expect(readFileSync(join(root, "game", "dist", "browser", "hoshi_wo_matsu_oka", "index.html"), "utf8")).toMatch(/connect-src[^;"]*http:\/\/localhost:\d+/);
  });

  it("はじめて起動したときに尋ね、「はい」なら選んだ選択肢と、やめた場面を送る", async () => {
    for (const { name, browser } of list) {
      received.length = 0;
      const page = await open(browser);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const dialog = page.locator(".lm-dialog", { hasText: "プレイ統計" });
      await dialog.waitFor({ timeout: 60_000 });
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `analytics-ask-${name}.png`) });
      await dialog.locator(".lm-primary").click();
      await page.locator("button", { hasText: "はじめから" }).first().click();
      // 一つ目のページを送って選択肢まで進める（一度目の押しは文字を出し切るだけのことがある）
      await page.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("はじまり"), null, { timeout: 60_000 });
      for (let i = 0; i < 10 && (await page.locator(".choices button").count()) === 0; i++) {
        await page.locator(".message").click();
        await page.waitForTimeout(500);
      }
      await page.locator(".choices button").nth(1).waitFor({ timeout: 30_000 });
      await page.locator(".choices button").nth(1).click();
      await page.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("南の道"), null, { timeout: 30_000 });
      // 閉じる（pagehide）と、溜めたものを送る
      await page.goto("about:blank");
      for (let i = 0; i < 40 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
      expect(received, name).toHaveLength(1);
      const batch = received[0] as { project: string; session: string; platform: string; events: { type: string; at: string; option?: number; options?: number; target?: string }[] };
      expect(batch, name).toMatchObject({ project: "hoshi_wo_matsu_oka", platform: "browser" });
      expect(batch.events[0], name).toMatchObject({ type: "choice", at: "a:4", option: 1, options: 2, target: "a#south" });
      expect(batch.events.at(-1), name).toMatchObject({ type: "leave", at: "a:11" });
      // 本文は送らない
      expect(JSON.stringify(batch), name).not.toContain("南の道");
      expect(errors, name).toEqual([]);
      await page.close();
    }
  });

  it("「いいえ」なら何も送らず、コンフィグであとから変えられる", async () => {
    const { name, browser } = list[0]!;
    received.length = 0;
    const page = await open(browser);
    const dialog = page.locator(".lm-dialog", { hasText: "プレイ統計" });
    await dialog.waitFor({ timeout: 60_000 });
    await dialog.locator(".lm-button").first().click();
    await page.locator("button", { hasText: "はじめから" }).first().waitFor();
    await page.evaluate("window.__liminalia.system.openConfig()");
    await page.locator(".lm-tab", { hasText: "画面" }).click();
    const row = page.locator(".lm-config-row", { hasText: "プレイ統計を送信" });
    await row.waitFor();
    await row.scrollIntoViewIfNeeded();
    expect(await row.locator(".lm-toggle[aria-pressed='true']").textContent(), name).toBe("オフ");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `analytics-config-${name}.png`) });
    await page.goto("about:blank");
    await new Promise((r) => setTimeout(r, 1500));
    expect(received, name).toEqual([]);
    // 開き直しても尋ねない（答えを覚える）
    await page.goto(receiver.url);
    await page.click(".lm-gate");
    await page.waitForTimeout(3000);
    expect(await page.locator(".lm-dialog", { hasText: "プレイ統計" }).count(), name).toBe(0);
    await page.close();
  });

  it("止まったら記録を残し、次の起動で尋ねて、どの行で何が起きたかを送る", async () => {
    for (const { name, browser } of list) {
      crashes.length = 0;
      const page = await open(browser);
      await page.locator(".lm-dialog", { hasText: "プレイ統計" }).locator(".lm-button").first().click();
      await page.locator("button", { hasText: "はじめから" }).first().click();
      await page.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("はじまり"), null, { timeout: 60_000 });
      // 捕まえていない例外
      await page.evaluate("setTimeout(() => { throw new Error('試しの例外'); }, 0)");
      await page.waitForTimeout(500);
      await page.goto(receiver.url);
      await page.click(".lm-gate");
      const ask = page.locator(".lm-dialog", { hasText: "クラッシュレポート" });
      await ask.waitFor({ timeout: 30_000 });
      await ask.locator(".lm-primary").click();
      for (let i = 0; i < 40 && crashes.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
      expect(crashes, name).toHaveLength(1);
      const r = crashes[0] as Record<string, unknown>;
      expect(r, name).toMatchObject({ project: "hoshi_wo_matsu_oka", kind: "error", at: "a:3", platform: "browser", trail: ["a:3"] });
      expect(String(r.message), name).toContain("試しの例外");
      expect(typeof r.build, name).toBe("string");
      await page.close();
    }
  });
});
