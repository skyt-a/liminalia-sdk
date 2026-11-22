import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { translationKey } from "@liminalia/lang";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * フローチャート（extra.flowchart）を、実際のブラウザで確かめる。台本から作った場面のうち、読んだものに題を出し、
 * 既読率・エンディングを数え、はじめて着いたときの控えから読み直せる。
 */

const SCENARIO = `@window show
はじまり。
@choice
- 甲 -> #a
- 乙 -> #b
@end
# a
甲の道。
@title-screen ending="GOOD END"
# b
乙の道。
@title-screen ending="BAD END"
`;

const advance = async (p: Page) => {
  await p.evaluate("window.__liminalia.host.advance()");
  await p.waitForTimeout(80);
  await p.evaluate("window.__liminalia.host.advance()");
  await p.waitForTimeout(300);
};

describe.skipIf(!e2e)("フローチャート（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a", extra: { flowchart: { titles: { "a#b": "乙の題" } } } } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("読んだ場面だけ題を出し、既読率とエンディングを数え、場面から読み直せる", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.waitForTimeout(300);
      await advance(p);
      await p.waitForSelector(".choices button");
      await p.locator(".choices button").nth(0).click();
      await p.waitForTimeout(400);
      await p.evaluate("void window.__liminalia.system.perform('flowchart')");
      await p.waitForSelector(".lm-flow-scene");
      const scenes = await p.evaluate(`[...document.querySelectorAll(".lm-flow-scene")].map((b) => [b.textContent, b.classList.contains("is-locked")])`);
      expect(scenes, name).toEqual([
        ["はじまり。", false],
        ["甲の道。GOOD END", false],
        ["？？？END", true],
      ]);
      // 3 ページのうち 2 ページ
      expect(await p.evaluate(`document.querySelector(".lm-flow-summary").textContent`), name).toBe("既読率 66%エンディング 1 / 2");
      await p.locator(".lm-tab", { hasText: "エンディング" }).click();
      expect(await p.evaluate(`[...document.querySelectorAll(".lm-flow-ending .lm-extra-name")].map((e) => e.textContent)`), name).toEqual(["GOOD END", "？？？"]);
      // はじまりの場面から読み直す
      await p.locator(".lm-tab", { hasText: "フローチャート" }).click();
      await p.locator(".lm-flow-scene").nth(0).click();
      await p.click(".lm-dialog .lm-primary");
      await p.waitForTimeout(800);
      expect(await p.evaluate(`document.querySelector(".message .text").textContent.replace("▼", "")`), name).toBe("はじまり。");
      // 乙を読むと、乙の場面は題（titles）で出る
      await advance(p);
      await p.waitForSelector(".choices button");
      await p.locator(".choices button").nth(1).click();
      await p.waitForTimeout(400);
      await p.evaluate("void window.__liminalia.system.perform('flowchart')");
      await p.waitForSelector(".lm-flow-scene");
      expect(await p.evaluate(`document.querySelectorAll(".lm-flow-scene")[2].textContent`), name).toBe("乙の題BAD END");
      await p.close();
    }
  });
});

describe.skipIf(!e2e)("フローチャートの訳（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    const entry = (kind: "line" | "option", source: string, text: string) => [translationKey("a", kind, source), { source, text }];
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a", languages: ["ja", "en"], extra: { flowchart: true } },
      before: (dir) => {
        mkdirSync(join(dir, "lang"), { recursive: true });
        writeFileSync(
          join(dir, "lang/en.json"),
          JSON.stringify({ language: "en", lines: Object.fromEntries([entry("line", "はじまり。", "The beginning."), entry("line", "甲の道。", "Path A."), entry("option", "甲", "Option A")]) }),
        );
      },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("場面の題と選択肢の文を、遊んでいる言語の訳で出す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("The beginning")`);
      await advance(p);
      await p.waitForSelector(".choices button");
      await p.locator(".choices button").nth(0).click();
      await p.waitForTimeout(400);
      await p.evaluate("void window.__liminalia.system.perform('flowchart')");
      await p.waitForSelector(".lm-flow-scene");
      const scenes = await p.evaluate(`[...document.querySelectorAll(".lm-flow-scene .lm-flow-title")].map((b) => b.textContent)`);
      expect((scenes as string[]).slice(0, 2), name).toEqual(["The beginning.", "Path A."]);
      expect(await p.evaluate(`document.querySelector(".lm-flow-scene").title`), name).toContain("Option A");
      await p.screenshot({ path: join(process.env.LIMINALIA_E2E_SHOTS ?? "/tmp", `flowchart-en-${name}.png`) }).catch(() => undefined);
      await p.close();
    }
  });
});
