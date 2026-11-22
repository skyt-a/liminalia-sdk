import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectTextKey, translationKey } from "@liminalia/lang";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 英語で作った作品（liminalia.json の languages が ["en"] だけ）と、英語に訳した作品の題などを、実際のブラウザで確かめる。
 * LIMINALIA_E2E_OUT を指定すると、撮った画面をそこに残す。
 */

const OUT = process.env.LIMINALIA_E2E_OUT;
const shot = async (p: Page, name: string) => {
  if (OUT) await p.screenshot({ path: `${OUT}/${name}.png` });
};
const titleText = (p: Page) => p.evaluate(() => document.querySelector(".lm-title")?.textContent ?? "");

describe.skipIf(!e2e)("英語だけの作品（ブラウザ）", { timeout: 180_000 }, () => {
  let english: TestProject;
  let japanese: TestProject;
  let translated: TestProject;
  let englishMincho: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    english = await startProject({ scenario: { a: "@window show\nHello.\n" }, config: { title: "Starry Hill", languages: ["en"] } });
    japanese = await startProject({ scenario: { a: "@window show\nこんにちは。\n" }, config: { title: "星の丘" } });
    englishMincho = await startProject({ scenario: { a: "@window show\nHello.\n" }, config: { title: "Starry Hill", languages: ["en"], ui: { text: { font: '"Hiragino Mincho ProN", serif' } } } });
    translated = await startProject({
      scenario: { a: '@window show\n@set game.who = "ユイカ"\nこんにちは、{= game.who}。\n' },
      config: { title: "星の丘", languages: ["ja", "en"] },
      before: (dir) => {
        mkdirSync(join(dir, "lang"), { recursive: true });
        writeFileSync(
          join(dir, "lang/en.json"),
          JSON.stringify({
            language: "en",
            lines: {
              [projectTextKey("星の丘")]: { source: "星の丘", text: "Starry Hill", note: "title" },
              [translationKey("a", "arg", "ユイカ")]: { source: "ユイカ", text: "Yuika", note: "@set game.who" },
            },
          }),
        );
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await english?.close();
    await japanese?.close();
    await translated?.close();
    await englishMincho?.close();
  });

  it("原文の言語が英語だけなら、日本語の端末でもシステム画面を英語で出す。languages を書かない作品は日本語のまま", async () => {
    for (const { name, browser } of list) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "ja-JP" });
      const p = await context.newPage();
      await p.goto(`${english.url}?autostart=1`);
      await p.waitForFunction(() => window.__liminalia?.screen().mode === "title", null, { timeout: 60_000 });
      const title = await titleText(p);
      expect(title, name).toContain("New Game");
      expect(title, name).toContain("Settings");
      expect(title, name).not.toContain("はじめから");
      expect(await p.evaluate("document.documentElement.lang"), name).toBe("en");
      await shot(p, `english-only-title-${name}`);
      await p.goto(`${japanese.url}?autostart=1`);
      await p.waitForFunction(() => window.__liminalia?.screen().mode === "title", null, { timeout: 60_000 });
      expect(await titleText(p), name).toContain("はじめから");
      await context.close();
    }
  });

  it("開始の画面（起動したときと、開始位置を決めて開いたとき）も英語で出す", async () => {
    for (const { name, browser } of list) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "ja-JP" });
      const p = await context.newPage();
      await p.goto(english.url);
      await p.waitForSelector(".lm-gate", { timeout: 60_000 });
      expect(await p.textContent(".lm-gate"), name).toBe("Click to start");
      // 開始位置を決めて開く（?start=。制作画面の「ここからテストプレイ」など）
      await p.goto(`${english.url}?start=a`);
      await p.waitForSelector(".layer.start", { timeout: 60_000 });
      expect(await p.textContent(".layer.start"), name).toBe("Click to start");
      await shot(p, `english-only-start-${name}`);
      await p.click(".layer.start");
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("Hello")`, undefined, { timeout: 30_000 });
      // 日本語の作品は今までどおり
      await p.goto(`${japanese.url}?start=a`);
      await p.waitForSelector(".layer.start", { timeout: 60_000 });
      expect(await p.textContent(".layer.start"), name).toBe("クリックで開始");
      await context.close();
    }
  });

  it("作品の題の訳（訳のファイルの作品の設定の文字）を、タイトル画面とページの題に出す", async () => {
    for (const { name, browser } of list) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "ja-JP" });
      const p = await context.newPage();
      await p.goto(`${translated.url}?autostart=1&lang=en`);
      await p.waitForFunction(() => document.querySelector(".lm-title-name")?.textContent === "Starry Hill", null, { timeout: 60_000 });
      await p.waitForFunction(() => document.title === "Starry Hill", null, { timeout: 30_000 });
      expect(await titleText(p), name).toContain("New Game");
      await shot(p, `translated-title-${name}`);
      // 原文の言語では原文の題
      await p.goto(`${translated.url}?autostart=1`);
      await p.waitForFunction(() => window.__liminalia?.screen().mode === "title", null, { timeout: 60_000 });
      expect(await p.textContent(".lm-title-name"), name).toBe("星の丘");
      expect(await p.title(), name).toBe("星の丘");
      await context.close();
    }
  });

  it("`@set 変数 = \"文字\"` の文字は、遊んでいる言語の訳を変数に入れる", async () => {
    for (const { name, browser } of list) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "ja-JP" });
      const p = await context.newPage();
      await p.goto(`${translated.url}?autostart=1&start=a&lang=en`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("Yuika")`, undefined, { timeout: 30_000 });
      await p.waitForFunction(() => window.__liminalia?.host.waiting === true, null, { timeout: 30_000 });
      await shot(p, `set-translated-${name}`);
      await p.goto(`${translated.url}?autostart=1&start=a`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("こんにちは、ユイカ。")`, undefined, { timeout: 30_000 });
      await context.close();
    }
  });

  it("英語の作品の本文は欧文の書体を先に置き、日本語の作品は和文の明朝のまま。ui.text.font を書けばそれが先", async () => {
    const family = async (p: Page, url: string) => {
      await p.goto(`${url}?autostart=1&start=a`);
      await p.waitForFunction(() => window.__liminalia?.host.waiting === true, null, { timeout: 60_000 });
      return p.evaluate(() => {
        const text = document.querySelector(".message .text");
        return text ? getComputedStyle(text).fontFamily : "";
      });
    };
    for (const { name, browser } of list) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "ja-JP" });
      const p = await context.newPage();
      const en = await family(p, english.url);
      expect(en.split(",")[0]!.trim().replace(/"/g, ""), name).toBe("Iowan Old Style");
      // 和文の字は後ろの明朝で出す
      expect(en, name).toContain("Hiragino Mincho ProN");
      const ja = await family(p, japanese.url);
      expect(ja.split(",")[0]!.trim().replace(/"/g, ""), name).toBe("Hiragino Mincho ProN");
      // 前の版と同じ和文の明朝を先にしたいときは ui.text.font に書く
      const chosen = await family(p, englishMincho.url);
      expect(chosen.split(",")[0]!.trim().replace(/"/g, ""), name).toBe("Hiragino Mincho ProN");
      await context.close();
    }
  });
});
