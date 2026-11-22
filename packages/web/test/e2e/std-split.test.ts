import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { serveFolder } from "../../../cli/src/serve-folder.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { STD_WEB_FEATURE_NAMES } from "@liminalia/std/features";
import { runBuild } from "../../../cli/src/commands/build.ts";
import { browsers, e2e } from "./harness.ts";

/**
 * 書き出したエンジンに、作品が使わない標準の命令の描画（図鑑、調べる画面、地図、チャット、粒子など）を始めから読ませない。
 * 部品ごとに別のファイル（engine/<部品>-<鍵>.js）に分け、作品が使う部品（台本の命令、data/codex.json の図鑑）は始めに読み、
 * 書き出しのときに見えない使い方（パックで足した台本）の部品は、描くときに読む。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../../templates/default");

// 粒子は台本から、図鑑は data/codex.json から使う。図鑑は @open-screen で開く（メニューとおまけも同じ画面）
const SCENARIO = `@window show
@bg hill_dusk.webp
@particles snow
はじまり。
@open-screen codex
図鑑を閉じた。
`;
const CODEX = { categories: [{ id: "places", label: "場所" }], entries: [{ id: "hill", category: "places", title: "丘", sections: [{ text: "町の外れの丘。" }] }] };
// パックで足す台本（書き出しのときには無い）。集中線（manga）を描く
const PACK_SCENARIO = `@window show
@speedlines focus time=3000ms
足した話。
`;

/** 部品のファイルの名前（engine/<部品>-<鍵>.js）から部品の名前。 */
const featureOf = (file: string) => STD_WEB_FEATURE_NAMES.find((f) => new RegExp(`^${f}-[\\w-]+\\.js$`).test(file));

/** ページが読んだエンジンの JS（engine/ の下の名前）。 */
function watchEngine(page: Page): string[] {
  const loaded: string[] = [];
  page.on("request", (r) => {
    const m = /\/engine\/([^/?]+\.js)(?:\?|$)/.exec(r.url());
    if (m) loaded.push(m[1]!);
  });
  return loaded;
}

describe.skipIf(!e2e)("書き出したエンジンの標準の命令の描画を、使う部品だけ始めに読む", { timeout: 600_000 }, () => {
  let root: string;
  let web: string;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "liminalia-std-split-"));
    const dir = join(root, "game");
    cpSync(TEMPLATE, dir, { recursive: true });
    writeFileSync(join(dir, "scenario", "a.lim"), SCENARIO);
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "codex.json"), JSON.stringify(CODEX));
    const cfg = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    cfg.entry = "a";
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify(cfg));
    const log = console.log;
    console.log = () => undefined;
    try {
      expect(await runBuild(dir, { targets: ["browser"], import: false, verify: false })).toBe(true);
    } finally {
      console.log = log;
    }
    web = join(dir, "dist", "browser", "hoshi_wo_matsu_oka");
    // 書き出したあとに置くパック（追加の話）
    mkdirSync(join(web, "packs", "more", "scenario"), { recursive: true });
    writeFileSync(join(web, "packs", "index.json"), JSON.stringify(["more"]));
    writeFileSync(join(web, "packs", "more", "pack.json"), JSON.stringify({ id: "more", files: { scenario: ["more"], data: [], assets: [] } }));
    writeFileSync(join(web, "packs", "more", "scenario", "more.lim"), PACK_SCENARIO);
    list = await browsers();
  }, 300_000);
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("部品ごとに別のファイルに分け、CSS は一つのまま", () => {
    const files = readdirSync(join(web, "engine"));
    const parts = files.flatMap((f) => featureOf(f) ?? []);
    expect([...new Set(parts)].sort()).toEqual([...STD_WEB_FEATURE_NAMES].sort());
    // 部品の CSS は分けない（標準の CSS の並びと、テーマと作品の CSS が上書きする順を変えない）
    expect(files.filter((f) => f.endsWith(".css"))).toHaveLength(1);
  });

  it("始めは作品が使う部品（台本の粒子、データの図鑑）だけを読み、使わない部品は読まない。図鑑は @open-screen で開ける", async () => {
    const { server, url } = await serveFolder(web);
    try {
      for (const { name, browser } of list) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const loaded = watchEngine(page);
        await page.goto(`${url}?autostart=1&start=a`);
        await page.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("はじまり"), null, { timeout: 60_000 });
        expect(await page.locator("canvas.lim-particles").count(), name).toBe(1);
        expect([...new Set(loaded.flatMap((f) => featureOf(f) ?? []))].sort(), name).toEqual(["codex", "particles"]);
        // 入口と、ほかをまとめた束（core）は読み、読まなかったのは部品の束（と部品だけが使う小さな束）。始めに読んだ JS はすべてより小さい
        const size = (f: string) => statSync(join(web, "engine", f)).size;
        const all = readdirSync(join(web, "engine")).filter((f) => f.endsWith(".js"));
        const unused = all.filter((f) => !loaded.includes(f));
        expect(loaded.filter((f) => /^(index|core)-/.test(f)).length, `${name} ${loaded}`).toBeGreaterThanOrEqual(2);
        expect(unused.filter((f) => featureOf(f)).length, `${name} ${unused}`).toBe(STD_WEB_FEATURE_NAMES.length - 2);
        expect(unused.some((f) => /^(index|core)-/.test(f)), `${name} ${unused}`).toBe(false);
        expect([...new Set(loaded)].reduce((n, f) => n + size(f), 0), name).toBeLessThan(all.reduce((n, f) => n + size(f), 0));
        // 文字を出し終えてから送る（出している途中に押すと、出し切るだけで進まない）
        await page.waitForTimeout(800);
        await page.mouse.click(640, 300);
        await page.waitForSelector(".lm-codex", { timeout: 10_000 });
        expect(await page.evaluate("window.__liminalia.screen().screen"), name).toBe("codex");
        expect(errors, name).toEqual([]);
        await page.close();
      }
    } finally {
      server.close();
    }
  });

  it("書き出しのときに見えない使い方（パックの台本）の部品は、描くときに読んで描く", async () => {
    const { server, url } = await serveFolder(web);
    try {
      for (const { name, browser } of list) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const loaded = watchEngine(page);
        await page.goto(`${url}?autostart=1&start=more`);
        await page.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("足した話"), null, { timeout: 60_000 });
        expect(await page.locator("canvas.lim-speedlines").count(), name).toBe(1);
        expect(loaded.flatMap((f) => featureOf(f) ?? []), name).toContain("manga");
        expect(errors, name).toEqual([]);
        await page.close();
      }
    } finally {
      server.close();
    }
  });
});
