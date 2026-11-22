import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** スタッフロール（@staff-roll）を実際のブラウザで確かめる。ブロックと data の JSON の両方で書け、クリックで飛ばせる。 */

const scenario = `@window show
はじまり。
@staff-roll time=20s fade=200ms bg=#000000
# シナリオ
ユイ

# 音楽
レン
@end
次へ。
@staff-roll file=credits time=20s fade=200ms
終わり。
`;

describe.skipIf(!e2e)("スタッフロール（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: scenario }, config: { entry: "a" }, before: async (dir) => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(`${dir}/data`, { recursive: true });
      writeFileSync(`${dir}/data/credits.json`, JSON.stringify(["# 原画", "ハル"]));
    } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("中身を下から流し、クリックで終わりまで飛ばして次へ進む（file= は data の JSON）", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      const text = (t: string) => p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(t)})`, null, { timeout: 5000 });
      await text("はじまり");
      await p.waitForTimeout(400);
      await p.mouse.click(640, 80);
      await p.waitForSelector(".lim-staffroll");
      expect(await p.evaluate(`[...document.querySelectorAll(".lim-staffroll-heading, .lim-staffroll-line")].map((e) => e.textContent)`), name).toEqual(["シナリオ", "ユイ", "音楽", "レン"]);
      await p.waitForTimeout(500);
      await p.mouse.click(640, 80);
      await text("次へ");
      expect(await p.evaluate(`document.querySelectorAll(".lim-staffroll").length`), name).toBe(0);
      await p.waitForTimeout(400);
      await p.mouse.click(640, 80);
      await p.waitForSelector(".lim-staffroll-line");
      expect(await p.evaluate(`[...document.querySelectorAll(".lim-staffroll-heading, .lim-staffroll-line")].map((e) => e.textContent)`), name).toEqual(["原画", "ハル"]);
      await p.waitForTimeout(500);
      await p.mouse.click(640, 80);
      await text("終わり");
      await p.close();
    }
  });
});
