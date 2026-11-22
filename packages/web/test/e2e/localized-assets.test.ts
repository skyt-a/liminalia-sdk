import { mkdirSync, cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** 言語ごとの素材（assets/<種類>/@<言語>/）を、実際のブラウザで確かめる。 */

const bg = (p: Page) => p.evaluate(`decodeURIComponent(document.querySelector(".background img").getAttribute("src"))`) as Promise<string>;

describe.skipIf(!e2e)("言語ごとの素材（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: "@bg hill_dusk.webp\n@window show\nはじまり。\n@bg hill_dusk.webp\nつぎ。\n" },
      config: { entry: "a", languages: ["ja", "en"] },
      before: (dir) => {
        mkdirSync(join(dir, "assets/bgimage/@en"), { recursive: true });
        cpSync(join(dir, "assets/bgimage/hill_morning.webp"), join(dir, "assets/bgimage/@en/hill_dusk.webp"));
        mkdirSync(join(dir, "lang"), { recursive: true });
        writeFileSync(join(dir, "lang/en.json"), JSON.stringify({ language: "en", lines: {} }));
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("原文の言語ではそのまま、ほかの言語ではその言語の素材があれば差し替える", async () => {
    for (const { name, browser } of list) {
      const ja = await browser.newPage({ viewport: { width: 1280, height: 720 }, locale: "ja-JP" });
      await ja.goto(`${project.url}?autostart=1&start=a`);
      await ja.waitForSelector(".background img");
      expect(await bg(ja), name).toMatch(/assets\/bgimage\/hill_dusk\.webp/);
      await ja.close();
      const en = await browser.newPage({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
      await en.goto(`${project.url}?autostart=1&start=a`);
      await en.waitForSelector(".background img");
      expect(await bg(en), name).toMatch(/assets\/bgimage\/@en\/hill_dusk\.webp/);
      // 遊んでいる途中で原文に戻すと、次に出す絵から元の素材
      // （言語を替えると設定画面を開き直すので、閉じてから進める）
      await en.evaluate("window.__liminalia.system.updateSettings({ language: 'ja' })");
      await en.waitForTimeout(500);
      while (await en.locator(".lm-screen").count()) {
        await en.keyboard.press("Escape");
        await en.waitForTimeout(200);
      }
      await en.waitForTimeout(300);
      await en.mouse.click(640, 300);
      await en.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("つぎ")`);
      await en.waitForTimeout(300);
      expect(await bg(en), name).toMatch(/assets\/bgimage\/hill_dusk\.webp/);
      await en.close();
    }
  });
});
