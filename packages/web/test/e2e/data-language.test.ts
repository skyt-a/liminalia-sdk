import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { dataTextKey } from "@liminalia/lang";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 日本語と英語以外の言語で遊ぶとき、図鑑、調べる画面、地図の選択の作品のデータの文（data/*.json）を訳のファイル（lang/<言語>.json）の訳で出し、
 * 画面の文言は ui の訳で出すことを、実際のブラウザで確かめる（三回目の洗い出しの 28）。訳の無い文は原文のまま。
 */

const SCENARIO = {
  codex: `@bg hill_night.webp
はじまり。
@set game.met = true
@codex
@stop
`,
  inv: `@bg hill_night.webp
はじまり。
@investigate room
@stop
# desk
机。
`,
  map: `@bg hill_night.webp
はじまり。
@map-choice town result=temp.where
@stop
`,
};

const CODEX = {
  categories: [{ id: "people", label: "人物" }],
  entries: [{ id: "a", category: "people", title: "アカリ", titleEn: "Akari", if: "game.met", summary: "丘の上に住む。", sections: [{ text: "天文部。" }] }],
};
const INVESTIGATION = {
  places: { room: { title: "部屋", file: "inv", finish: "button", views: [{ id: "a", label: "部屋", background: "hill_dusk.webp", spots: [{ id: "desk", label: "机", rect: { x: 100, y: 200, width: 300, height: 300 }, target: "#desk" }] }] } },
  maps: { town: { title: "行き先", file: "map", background: "hill_dusk.webp", spots: [{ id: "station", label: "駅", rect: { x: 100, y: 300, width: 120, height: 60 }, desc: "人が多い。" }] } },
};
const tr = (file: string, source: string, text: string) => [dataTextKey(file, source), { source, text }] as const;
const KO = {
  language: "ko",
  lines: Object.fromEntries([
    tr("codex.json", "アカリ", "아카리"),
    tr("codex.json", "丘の上に住む。", "언덕 위에 산다."),
    tr("codex.json", "人物", "인물"),
    tr("investigation.json", "部屋", "방"),
    tr("investigation.json", "机", "책상"),
    tr("investigation.json", "駅", "역"),
    tr("investigation.json", "人が多い。", "사람이 많다."),
  ]),
  ui: { "codex.title": "기록", "investigate.finish": "조사 끝", "mapChoice.go": "여기로" },
};

describe.skipIf(!e2e)("作品のデータの文を日本語と英語以外の言語に訳す（ブラウザ）", { timeout: 300_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: SCENARIO,
      config: { entry: "codex", languages: ["ja", "en", "ko"] },
      before: (dir) => {
        mkdirSync(join(dir, "data"), { recursive: true });
        writeFileSync(join(dir, "data", "codex.json"), JSON.stringify(CODEX));
        writeFileSync(join(dir, "data", "investigation.json"), JSON.stringify(INVESTIGATION));
        mkdirSync(join(dir, "lang"), { recursive: true });
        writeFileSync(join(dir, "lang", "ko.json"), JSON.stringify(KO));
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  const open = async (browser: Browser, start: string, selector: string, lang = "ko"): Promise<Page> => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await p.goto(`${project.url}?autostart=1&start=${start}&lang=${lang}`);
    await p.waitForFunction(() => window.__liminalia?.host.waiting, undefined, { timeout: 60_000 });
    for (let i = 0; i < 20 && (await p.locator(selector).count()) === 0; i++) {
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(300);
    }
    await p.waitForSelector(selector, { timeout: 20_000 });
    await p.waitForTimeout(200);
    return p;
  };
  const text = (p: Page, s: string) => p.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent?.trim()).join("|"), s);

  it("韓国語: 図鑑、調べる画面、地図の選択のデータの文と画面の文言を訳で出す", async () => {
    for (const { name, browser } of list) {
      const c = await open(browser, "codex", ".lm-codex");
      expect(await text(c, ".lm-codex .lm-screen-title"), name).toBe("기록");
      expect(await text(c, ".lm-codex-title"), name).toBe("아카리");
      expect(await text(c, ".lm-codex-summary"), name).toBe("언덕 위에 산다.");
      // 訳の無い文は原文
      expect(await text(c, ".lm-codex-text"), name).toBe("天文部。");
      expect(await text(c, ".lm-tab"), name).toContain("인물");
      // 開いたときの知らせも訳の名前
      expect(await text(c, ".lm-notice"), name).toContain("아카리");
      await c.close();

      const i = await open(browser, "inv", ".lm-investigate-spot");
      expect(await text(i, ".lm-investigate-title"), name).toBe("방");
      expect(await i.locator(".lm-investigate-spot").getAttribute("aria-label"), name).toBe("책상");
      expect(await text(i, ".lm-investigate-finish"), name).toBe("조사 끝");
      await i.close();

      const m = await open(browser, "map", ".lm-map-choice-spot");
      expect(await text(m, ".lm-map-choice-label"), name).toBe("역");
      expect(await text(m, ".lm-map-choice-desc"), name).toBe("사람이 많다.");
      expect(await text(m, ".lm-map-choice-go"), name).toBe("여기로");
      await m.close();

      // 英語は英語の欄（titleEn）を使う
      const e = await open(browser, "codex", ".lm-codex", "en");
      expect(await text(e, ".lm-codex-title"), name).toBe("Akari");
      await e.close();
    }
  });
});
