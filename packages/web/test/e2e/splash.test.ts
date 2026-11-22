import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 起動の演出（liminalia.json の ui.splash）を、実際のブラウザで確かめる。
 * 「クリックで開始」のあとにロゴと注意書きを順に出し、押すと次へ進み、時間が来れば自分で進んで、タイトルを出す。
 */

const FIXTURES = resolve(import.meta.dirname, "fixtures");

describe.skipIf(!e2e)("起動の演出 ui.splash（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: "@window show\nはじまり。\n" },
      files: { "assets/image/brand/logo.png": `${FIXTURES}/stripes.png` },
      config: {
        entry: "a",
        ui: {
          splash: {
            logos: [{ image: "brand/logo.png", background: "#ffffff", time: 60000 }],
            notice: { title: "はじめにお読みください", blocks: [{ label: "01", text: "この物語はフィクションです。\n実在のものとは関係ありません。" }], time: 800 },
            fade: 200,
          },
        },
      },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("ロゴは押して進め、注意書きは時間が来れば進み、タイトルへ渡す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(project.url);
      await p.click(".lm-gate");
      await p.waitForSelector(".lm-splash-logo.lm-splash-shown");
      expect(await p.evaluate(`document.querySelector(".lm-splash-logo img").getAttribute("src")`), name).toContain("brand/logo.png");
      expect(await p.evaluate("window.__liminalia.system.mode"), name).toBe("boot");
      await p.waitForTimeout(400);
      await p.mouse.click(640, 360);
      await p.waitForSelector(".lm-splash-notice.lm-splash-shown");
      expect(await p.evaluate(`[...document.querySelectorAll(".lm-splash-text > div")].map((d) => d.textContent)`), name).toEqual(["この物語はフィクションです。", "実在のものとは関係ありません。"]);
      // 押さなくても時間が来れば進み、タイトルを出す
      await p.waitForFunction(() => window.__liminalia!.system.mode === "title", undefined, { timeout: 10_000 });
      await p.waitForFunction(() => !document.querySelector(".lm-splash"));
      await p.close();
    }
  });
});
