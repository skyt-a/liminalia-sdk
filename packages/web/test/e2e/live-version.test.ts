import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 開発サーバー（lim dev、Studio のテストプレイ）で liminalia.json の version を書き換えると、開き直さずに次の「はじめから」から新しい版で遊ぶ
 * （前は作品の情報のモジュールを読み直すまで前の版のままだった。2026-11-19 の rest-q）。
 */

const v = `@window show
版{= save.version}。
`;

describe.skipIf(!e2e)("開発中に書き換えた作品の版（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { v }, config: { entry: "v", version: "1.0.0" } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("書き換えた版が、読み直さずに次の「はじめから」の save.version に効く", async () => {
    const file = join(project.dir, "liminalia.json");
    const original = readFileSync(file, "utf8");
    for (const { name, browser } of list) {
      writeFileSync(file, original);
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=v`);
      await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("版1.0.0"));
      await p.evaluate(() => ((window as unknown as { __notReloaded: boolean }).__notReloaded = true));
      writeFileSync(file, JSON.stringify({ ...JSON.parse(original), version: "2.0.0" }));
      // 書き換えの知らせが届くまで、はじめから流し直す
      const deadline = Date.now() + 30_000;
      let text = "";
      while (Date.now() < deadline) {
        // startAt は出したページの数を 0 から数え直すので、流し直した一ページ目を出し終えるまで待つ
        await p.evaluate(() => window.__liminalia!.system.startAt("v"));
        await p.waitForFunction(() => window.__liminalia!.pages() >= 1 && window.__liminalia!.host.waiting && /版[\d.]*。/.test(document.querySelector(".message .text")?.textContent ?? ""), undefined, { timeout: 10_000 });
        text = await p.evaluate(() => document.querySelector(".message .text")?.textContent ?? "");
        if (text.includes("版2.0.0")) break;
        await p.waitForTimeout(300);
      }
      expect(text, name).toContain("版2.0.0");
      expect(await p.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded === true), name).toBe(true);
      await p.close();
    }
    writeFileSync(file, original);
  });
});
