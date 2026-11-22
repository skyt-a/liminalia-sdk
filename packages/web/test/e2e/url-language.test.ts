import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { translationKey } from "@liminalia/lang";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** 書き出したゲームでも URL の ?lang= でその回の言語を決め、コンフィグに覚えた言語は書き換えないことを、実際のブラウザで確かめる。 */

const text = (p: Page) => p.evaluate(() => document.querySelector(".message .text")?.textContent ?? "");

describe.skipIf(!e2e)("URL で言語を決める（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: "@window show\nこんにちは。\n" },
      config: { entry: "a", languages: ["ja", "en"] },
      before: (dir) => {
        mkdirSync(join(dir, "lang"), { recursive: true });
        writeFileSync(join(dir, "lang/en.json"), JSON.stringify({ language: "en", lines: { [translationKey("a", "line", "こんにちは。")]: { source: "こんにちは。", text: "Hello." } } }));
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("?lang=en なら英語で始め、languages に無い言語は使わない。覚えた言語は書き換えない", async () => {
    for (const { name, browser } of list) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "ja-JP" });
      const p = await context.newPage();
      await p.goto(`${project.url}?autostart=1&start=a&lang=en`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("Hello")`, undefined, { timeout: 30_000 });
      expect(await p.evaluate("document.documentElement.lang"), name).toBe("en");
      expect(await p.evaluate("window.__liminalia.system.language"), name).toBe("en");
      // URL に書かなければ、端末の言語（ja）で始まる（?lang= はコンフィグに覚えない）
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("こんにちは")`, undefined, { timeout: 30_000 });
      // 作品に無い言語は使わない
      await p.goto(`${project.url}?autostart=1&start=a&lang=fr`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("こんにちは")`, undefined, { timeout: 30_000 });
      expect(await text(p), name).toContain("こんにちは");
      await context.close();
    }
  });
});
