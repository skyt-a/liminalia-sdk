import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { serveFolder } from "../../../cli/src/serve-folder.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { runBuild } from "../../../cli/src/commands/build.ts";
import { browsers, e2e, TEST_FONT } from "./harness.ts";

/**
 * 書き出したブラウザ版のページ（index.html）: Content Security Policy の中で、絵、立ち絵、SVG（<object>）、HTML の部品、書体、音、
 * セーブの縮小画像とロードが止められずに動くこと。題と説明とホーム画面の絵が作品のものになり、拡大を止める指定（user-scalable=no）を外しても、
 * スマホでの二度押しやつまみで画面が拡大されず、押せば文が進むこと。暗号化した書き出し（Service Worker を入れてから読む）も CSP の中で動くこと。
 * ページの言語と Open Graph、作品の版とエンジンの版の記録（project/build.json と書き出し先の build-history.jsonl）。
 * 図鑑の地図と地図の選択の地図は、bgimage に無ければ前の置き場所の image から読む（書き出したものは無い素材が 404 になる）。
 * index.html をファイルのまま（file://）開くと、開けない理由と遊び方を画面に出す（Web に置いたときは出さない）。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../../templates/default");
const ICON = resolve(import.meta.dirname, "fixtures/layer-top.png");

/** 図鑑の地図（前の置き場所の image）と地図の選択の地図（bgimage）。 */
const MAPS = `@set game.met = true
@codex
@map-choice town result=temp.where
おわり。
@stop
`;
const CODEX = { categories: [{ id: "town", label: "地図", type: "map", map: "maps/before.png" }], entries: [{ id: "a", category: "town", title: "駅", x: 40, y: 30, if: "game.met" }] };
const INVESTIGATION = { maps: { town: { background: "maps/now.png", spots: [{ id: "s", label: "駅", rect: { x: 100, y: 300, width: 120, height: 60 } }] } } };

const SCENARIO = `@window show
@bg hill_dusk.webp
@bgm quiet_night.wav volume=10
@chara アカリ normal at=center
@image s.svg folder=image name=svg x=10 y=10 wait=false
@html card x=100 y=80 width=300
<div class="card"><img src="sun.png" alt=""> 晴れ</div>
@end
はじまり。
二つめ。
三つめ。
四つめ。
五つめ。
おわり。
`;

/** CSP に止められたものを集める（ページのスクリプトより先に入れる）。 */
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  const refused: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) refused.push(m.text());
  });
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return async () => [...refused, ...((await page.evaluate("window.__csp")) as string[])];
}

describe.skipIf(!e2e)("書き出したブラウザ版のページ（CSP、題、ホーム画面の絵、拡大）", { timeout: 600_000 }, () => {
  let root: string;
  let list: { name: string; browser: Browser }[];
  const builds: Record<string, string> = {};
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "liminalia-export-page-"));
    for (const kind of ["plain", "encrypted"] as const) {
      const dir = join(root, kind);
      cpSync(TEMPLATE, dir, { recursive: true });
      writeFileSync(join(dir, "scenario", "a.lim"), SCENARIO);
      writeFileSync(join(dir, "scenario", "maps.lim"), MAPS);
      mkdirSync(join(dir, "data"), { recursive: true });
      writeFileSync(join(dir, "data", "codex.json"), JSON.stringify(CODEX));
      writeFileSync(join(dir, "data", "investigation.json"), JSON.stringify(INVESTIGATION));
      mkdirSync(join(dir, "assets", "image", "maps"), { recursive: true });
      mkdirSync(join(dir, "assets", "bgimage", "maps"), { recursive: true });
      cpSync(ICON, join(dir, "assets", "image", "maps", "before.png"));
      cpSync(ICON, join(dir, "assets", "bgimage", "maps", "now.png"));
      mkdirSync(join(dir, "assets", "image"), { recursive: true });
      mkdirSync(join(dir, "assets", "others"), { recursive: true });
      writeFileSync(join(dir, "assets", "image", "s.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>');
      cpSync(ICON, join(dir, "assets", "image", "sun.png"));
      cpSync(TEST_FONT, join(dir, "assets", "others", "test-font.ttf"));
      const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown> & { build?: Record<string, unknown> };
      cfg.entry = "a";
      cfg.description = "丘の上で流星群を待つ短い物語 & <test>";
      cfg.ui = { text: { fontFile: "test-font.ttf" } };
      cfg.build = { ...cfg.build, browser: kind === "encrypted" ? { encrypt: true } : {} };
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

  it("index.html に CSP、作品の題と説明、ホーム画面の絵があり、拡大を止める指定は無い", () => {
    const html = readFileSync(join(builds.plain!, "index.html"), "utf8");
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'sha256-[^']+'/);
    expect(html).toContain("<title>星を待つ丘</title>");
    expect(html).toContain('<meta name="description" content="丘の上で流星群を待つ短い物語 &amp; &lt;test&gt;" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="apple-touch-icon.png" />');
    expect(html).not.toContain("user-scalable");
    const manifest = JSON.parse(readFileSync(join(builds.plain!, "manifest.webmanifest"), "utf8")) as { name: string; description: string; icons: { src: string; sizes: string; purpose?: string }[] };
    expect(manifest.name).toBe("星を待つ丘");
    expect(manifest.description).toContain("流星群");
    expect(manifest.icons.map((i) => `${i.src} ${i.sizes} ${i.purpose ?? "any"}`)).toEqual(["icon-192.png 192x192 any", "icon-512.png 512x512 any", "icon-maskable-512.png 512x512 maskable"]);
    for (const f of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) expect(existsSync(join(builds.plain!, f)), f).toBe(true);
  });

  it("ページの言語と Open Graph があり、作品の版とエンジンの版を書き出したものと書き出し先の記録に残す（プログラムには埋めない）", () => {
    const html = readFileSync(join(builds.plain!, "index.html"), "utf8");
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('<meta property="og:title" content="星を待つ丘" />');
    expect(html).toContain('<meta property="og:description" content="丘の上で流星群を待つ短い物語 &amp; &lt;test&gt;" />');
    const manifest = JSON.parse(readFileSync(join(builds.plain!, "manifest.webmanifest"), "utf8")) as { lang: string };
    expect(manifest.lang).toBe("ja");
    const engine = (JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../cli/package.json"), "utf8")) as { version: string }).version;
    expect(JSON.parse(readFileSync(join(builds.plain!, "project/build.json"), "utf8"))).toMatchObject({ id: "hoshi_wo_matsu_oka", version: "1.0.0", engine });
    expect(html).not.toContain(engine);
    const history = readFileSync(join(root, "plain", "dist", "build-history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: "hoshi_wo_matsu_oka", version: "1.0.0", engine, targets: ["browser"], outputs: ["browser/hoshi_wo_matsu_oka"] });
  });

  for (const kind of ["plain", "encrypted"] as const) {
    it(`${kind === "plain" ? "暗号化しない" : "暗号化した"}書き出しで、CSP に止められずに絵、SVG、HTML、書体、音、セーブとロードが動く`, async () => {
      const { server, url } = await serveFolder(builds[kind]!);
      try {
        for (const { name, browser } of list) {
          const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
          const page = await context.newPage();
          const refused = await watchCsp(page);
          const errors: string[] = [];
          page.on("pageerror", (e) => errors.push(e.message));
          await page.goto(`${url}?autostart=1&start=a`);
          await page.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("はじまり"), null, { timeout: 60_000 });
          await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".sprite img, .background img, .lim-html img")].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30_000 });
          await page.evaluate("document.fonts.ready.then(() => undefined)");
          const look = (await page.evaluate(`(() => ({
            sprite: !!document.querySelector(".sprite img"),
            svg: !!document.querySelector("object.lim-img"),
            html: document.querySelector(".lim-html .card")?.textContent ?? "",
            font: [...document.fonts].some((f) => f.status === "loaded"),
          }))()`)) as { sprite: boolean; svg: boolean; html: string; font: boolean };
          expect(look, `${name} ${kind}`).toEqual({ sprite: true, svg: true, html: " 晴れ", font: true });
          // セーブ（縮小画像は data: の絵）とロード
          await page.evaluate("window.__liminalia.system.saveTo(1)");
          // 一度目は文を出し終え、二度目で次へ（押しても進まなければ押し直す）
          for (let i = 0; i < 10 && !((await page.evaluate(() => document.querySelector(".message .text")?.textContent ?? "")) as string).includes("二つめ"); i++) {
            await page.mouse.click(1000, 600);
            await page.waitForTimeout(400);
          }
          await page.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("二つめ"), null, { timeout: 30_000 });
          await page.evaluate("window.__liminalia.system.loadFrom(1)");
          await page.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("はじまり"), null, { timeout: 30_000 });
          expect(await refused(), `${name} ${kind}`).toEqual([]);
          expect(errors, `${name} ${kind}`).toEqual([]);
          // CSP は効いている（外の絵は止める）
          await page.evaluate(() => document.body.append(Object.assign(new Image(), { src: "https://example.invalid/x.png" })));
          await page.waitForFunction(() => (window as unknown as { __csp: string[] }).__csp.length > 0, null, { timeout: 10_000 });
          expect((await refused()).some((r) => r.includes("img-src")), `${name} ${kind}`).toBe(true);
          await context.close();
        }
      } finally {
        server.close();
      }
    });
  }

  it("図鑑の地図（前の置き場所の image）と地図の選択の地図（bgimage）が出る", async () => {
    const { server, url } = await serveFolder(builds.plain!);
    try {
      for (const { name, browser } of list) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await page.goto(`${url}?autostart=1&start=maps`);
        const loaded = (selector: string) =>
          page.waitForFunction((s) => {
            const img = document.querySelector<HTMLImageElement>(s);
            return img && img.complete && img.naturalWidth > 0 ? img.currentSrc || img.src : null;
          }, selector, { timeout: 30_000 }).then((h) => h.jsonValue() as Promise<string>);
        await page.waitForSelector(".lm-codex", { timeout: 60_000 });
        expect(await loaded(".lm-codex-board-image"), name).toContain("/image/maps/before.png");
        await page.locator(".lm-codex .lm-close").click();
        await page.waitForSelector(".lm-map-choice", { timeout: 30_000 });
        expect(await loaded(".lm-map-choice-bg"), name).toContain("/bgimage/maps/now.png");
        await page.close();
      }
    } finally {
      server.close();
    }
  });

  it("ファイルのまま（file://）開くと、開けない理由と遊び方を出す（暗号化した書き出しも）。Web に置いたときは出さない", async () => {
    for (const kind of ["plain", "encrypted"] as const) {
      for (const { name, browser } of list) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await page.goto(pathToFileURL(join(builds[kind]!, "index.html")).href);
        const notice = page.locator("#lm-file-notice");
        await notice.waitFor({ state: "visible", timeout: 10_000 });
        const text = (await notice.textContent()) ?? "";
        expect(text, `${name} ${kind}`).toContain("ファイルを直接開いても遊べません");
        expect(text, `${name} ${kind}`).toContain("ブラウザで開く");
        // 文字は 12px 以上で、読み込みの表示は止める
        expect(await notice.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)), `${name} ${kind}`).toBeGreaterThanOrEqual(12);
        expect(await page.locator("#lm-boot").count(), `${name} ${kind}`).toBe(0);
        await page.close();
      }
    }
    const { server, url } = await serveFolder(builds.plain!);
    try {
      for (const { name, browser } of list) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await page.goto(`${url}?autostart=1&start=a`);
        await page.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("はじまり"), null, { timeout: 60_000 });
        expect(await page.locator("#lm-file-notice").count(), name).toBe(0);
        await page.close();
      }
    } finally {
      server.close();
    }
  });

  it("スマホで二度押しやつまみでは拡大されず、押せば文が進む（user-scalable=no を外しても）", async () => {
    const chromium = list.find((b) => b.name === "chromium")!.browser;
    const { server, url } = await serveFolder(builds.plain!);
    try {
      const context = await chromium.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      await page.goto(`${url}?autostart=1&start=a`);
      await page.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("はじまり"), null, { timeout: 60_000 });
      const text = () => page.evaluate(() => document.querySelector(".message .text")?.textContent ?? "");
      // 二度押し（すばやく二回）。拡大されず、文が進む
      await page.touchscreen.tap(600, 300);
      await page.waitForTimeout(80);
      await page.touchscreen.tap(600, 300);
      await page.waitForTimeout(800);
      expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
      expect(await text()).not.toContain("はじまり");
      // 二本の指でつまんで広げても拡大されない
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.synthesizePinchGesture", { x: 400, y: 200, scaleFactor: 2.5, gestureSourceType: "touch" });
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
      await context.close();
    } finally {
      server.close();
    }
  });
});

