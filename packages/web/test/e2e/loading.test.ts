import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 読み込みの表示を、実際のブラウザで確かめる。
 * - index.html の読み込みの表示は、ゲームの画面が出たら外す
 * - 表示する素材の読み込みを 0.5 秒より長く待つときは舞台の隅に待ちの印を出し、読み終えたら消す（すぐ読めるものには出さない）
 */

describe.skipIf(!e2e)("読み込みの表示（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: "@window show\n一。\n@bg hill_night.webp\n二。\n" } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("起動の表示を外し、遅い素材を待つ間だけ待ちの印を出す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      // 夜の背景だけ 1.5 秒遅らせる
      await p.route(/hill_night\.webp/, async (route) => {
        await new Promise((r) => setTimeout(r, 1500));
        await route.continue();
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".message .text .ch", { timeout: 60_000 });
      expect(await p.evaluate(`!!document.getElementById("lm-boot")`), name).toBe(false);
      expect(await p.evaluate(`!!document.querySelector(".lm-busy:not([hidden])")`), name).toBe(false);
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(100);
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForSelector(".lm-busy:not([hidden])", { timeout: 3000 });
      await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("二"), null, { timeout: 10_000 });
      expect(await p.evaluate(`!!document.querySelector(".lm-busy:not([hidden])")`), name).toBe(false);
      await p.close();
    }
  });
});
