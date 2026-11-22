import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { serveFolder } from "../../../cli/src/serve-folder.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { runBuild } from "../../../cli/src/commands/build.ts";
import { browsers, e2e } from "./harness.ts";

/**
 * 書き出したブラウザ版を、一度開いたあとオフラインで遊べること（build.browser.offline。Service Worker の lm-sw.js）を、実際のブラウザで確かめる。
 * 暗号化した書き出し（build.browser.encrypt）も、同じ Service Worker で戻しながらオフラインで遊べること。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../../templates/default");

describe.skipIf(!e2e)("オフラインで遊ぶ（書き出したブラウザ版）", { timeout: 600_000 }, () => {
  let root: string;
  let list: { name: string; browser: Browser }[];
  const builds: Record<string, string> = {};
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "liminalia-offline-"));
    for (const kind of ["plain", "encrypted"] as const) {
      const dir = join(root, kind);
      cpSync(TEMPLATE, dir, { recursive: true });
      const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as { id: string; build?: Record<string, unknown> };
      cfg.build = { ...cfg.build, browser: { ...(kind === "encrypted" ? { encrypt: true } : {}), offline: "all" } };
      writeFileSync(join(dir, "liminalia.json"), JSON.stringify(cfg));
      const log = console.log;
      console.log = () => undefined;
      try {
        expect(await runBuild(dir, { targets: ["browser"], import: false, verify: false })).toBe(true);
      } finally {
        console.log = log;
      }
      builds[kind] = join(dir, "dist", "browser", cfg.id);
    }
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  for (const kind of ["plain", "encrypted"] as const) {
    it(`${kind === "plain" ? "暗号化しない" : "暗号化した"}書き出しを一度開いたら、オフラインで開き直してタイトルまで進む`, async () => {
      const { server, url } = await serveFolder(builds[kind]!);
      try {
        expect(readFileSync(join(builds[kind]!, "lm-sw.js"), "utf8"), kind).toContain("const OFFLINE = {");
        for (const { name, browser } of list) {
          const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
          const p = await context.newPage();
          await p.goto(url);
          await p.waitForFunction(() => !!window.__liminalia, null, { timeout: 60_000 });
          // 控え終わるまで待つ（入れたときにすべて控える）
          await p.waitForFunction(() => navigator.serviceWorker?.controller !== null && navigator.serviceWorker?.controller !== undefined, null, { timeout: 30_000 }).catch(() => undefined);
          await p.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
          await p.waitForFunction(
            async () => {
              const names = await caches.keys();
              const name = names.find((n) => n.startsWith("lm-"));
              return !!name && (await (await caches.open(name)).keys()).length > 10;
            },
            null,
            { timeout: 30_000, polling: 500 },
          );
          await p.waitForTimeout(1500);
          await context.setOffline(true);
          const errors: string[] = [];
          p.on("pageerror", (e) => errors.push(e.message));
          // Playwright の WebKit は、オフラインにした文脈の移動を Service Worker が答えても失敗として返すことがある（ページは開く）ので、Chromium だけ見る
          await p.goto(url).catch((e: Error) => (name === "chromium" ? errors.push(e.message) : undefined));
          await p.waitForFunction(() => !!window.__liminalia, null, { timeout: 30_000 });
          await p.evaluate(() => void window.__liminalia!.system.boot());
          await p.waitForFunction(() => ["title", "game"].includes(window.__liminalia!.screen().mode), null, { timeout: 30_000 });
          // 素材も読める（タイトルの背景など。読めなかった画像が無い）
          const broken = (await p.evaluate(() => [...document.querySelectorAll("img")].filter((i) => i.complete && i.naturalWidth === 0 && i.src).map((i) => i.src))) as string[];
          expect(broken, `${name} ${kind}`).toEqual([]);
          expect(errors, `${name} ${kind}`).toEqual([]);
          await context.close();
        }
      } finally {
        server.close();
      }
    });
  }

  it("遊んでいる途中に新しい版を置くと、前の版の台本のまま遊べ、「新しいバージョンがあります」から読み直すと新しい版になる", async () => {
    // 書き出したものを写して置き換える（ほかのテストの書き出しは変えない）
    const dir = join(root, "update");
    cpSync(builds.plain!, dir, { recursive: true });
    const cfg = JSON.parse(readFileSync(join(dir, "project/build.json"), "utf8")) as { date: string };
    const scenario = readdirSync(join(dir, "project/scenario")).find((f) => f.endsWith(".lim"))!;
    const before = readFileSync(join(dir, "project/scenario", scenario), "utf8");
    const { server, url } = await serveFolder(dir);
    try {
      for (const { name, browser } of list) {
        // 前の版に戻す（ブラウザごとに、はじめて開くところから）
        writeFileSync(join(dir, "project/build.json"), JSON.stringify({ ...cfg }));
        writeFileSync(join(dir, "project/scenario", scenario), before);
        writeFileSync(join(dir, "lm-sw.js"), readFileSync(join(builds.plain!, "lm-sw.js"), "utf8"));
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const p = await context.newPage();
        await p.goto(url);
        await p.waitForFunction(() => !!window.__liminalia, null, { timeout: 60_000 });
        await p.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 30_000 });
        await p.waitForFunction(
          async (file) => {
            const names = await caches.keys();
            const n = names.find((x) => x.startsWith("lm-"));
            return !!n && !!(await (await caches.open(n)).match(new URL(`project/scenario/${file}`, location.href).toString()));
          },
          scenario,
          { timeout: 30_000, polling: 500 },
        );
        expect(await p.evaluate(() => window.__liminalia!.checkBuild!()), name).toBe(false);
        // 新しい版を置く（版の印、台本、Service Worker）
        writeFileSync(join(dir, "project/build.json"), JSON.stringify({ ...cfg, date: new Date(Date.now() + 60_000).toISOString() }));
        writeFileSync(join(dir, "project/scenario", scenario), `${before}\n新しい版の行。\n`);
        writeFileSync(join(dir, "lm-sw.js"), `${readFileSync(join(builds.plain!, "lm-sw.js"), "utf8").replace(/const OFFLINE = \{"cache":"([^"]+)"/, 'const OFFLINE = {"cache":"$1-next"')}\n`);
        const read = () => p.evaluate((file) => fetch(`project/scenario/${file}`).then((r) => r.text()), scenario);
        expect(await p.evaluate(() => window.__liminalia!.checkBuild!()), name).toBe(true);
        expect(await p.locator(".lm-update").isVisible(), name).toBe(true);
        // 前の版の Service Worker が動いている間は、台本も前の版のまま
        await p.waitForFunction(() => navigator.serviceWorker.getRegistration().then((r) => !!r?.waiting), null, { timeout: 30_000, polling: 300 });
        expect(await read(), name).toBe(before);
        // 読み直すと、新しい版の Service Worker に替わって新しい台本を読む
        await Promise.all([p.waitForEvent("load", { timeout: 30_000 }), p.locator(".lm-update-reload").click()]);
        await p.waitForFunction(() => !!window.__liminalia, null, { timeout: 60_000 });
        expect(await read(), name).toContain("新しい版の行。");
        expect(await p.evaluate(() => window.__liminalia!.checkBuild!()), name).toBe(false);
        await context.close();
      }
    } finally {
      server.close();
    }
  });
});
