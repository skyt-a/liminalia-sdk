import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * オート中に、確かめの枠の OK や選択肢などのボタンを押したとき、一度で働くこと（前は舞台の受け口がオートを切るだけで押しを捨て、二度押すことになった）。
 * ボタンでない所（本文の上など）を押したときは、今までどおりオートを切るだけで本文は送らない。
 */

const SCENARIO = `@bg hill_night.webp
はじまり。
@dialog "確かめます"
後の文。
@choice
- 一つ目 -> #one
- 二つ目 -> #two
@end
# one
一つ目だ。
@stop
# two
二つ目だ。
@stop
`;

describe.skipIf(!e2e)("オート中のボタン（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  const autoOn = (p: import("playwright-core").Page) => p.evaluate(() => (window as unknown as { __liminalia: { system: { status: { auto: boolean } } } }).__liminalia.system.status.auto);

  it("オートのまま確かめの枠の OK と選択肢を一度押せば進み、オートは切れない", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.evaluate(() => (window as unknown as { __liminalia: { system: { perform(a: string): void } } }).__liminalia.system.perform("auto"));
      expect(await autoOn(p), name).toBe(true);
      // 確かめの枠が出たら、OK を一度だけ押す
      const ok = p.locator(".lm-panel .lm-panel-buttons button").first();
      await ok.waitFor({ timeout: 30_000 });
      await ok.click();
      await p.waitForFunction(() => !document.querySelector(".lm-panel"), null, { timeout: 5_000 });
      expect(await autoOn(p), name).toBe(true);
      // 選択肢も一度で選べる
      const second = p.locator(".choices button", { hasText: "二つ目" });
      await second.waitFor({ timeout: 30_000 });
      await second.click();
      await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("二つ目だ"), null, { timeout: 10_000 });
      await p.close();
    }
  });

  it("ボタンでない所を押すと、今までどおりオートを切るだけ", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.evaluate(() => (window as unknown as { __liminalia: { system: { perform(a: string): void } } }).__liminalia.system.perform("auto"));
      const pages = await p.evaluate(() => (window as unknown as { __liminalia: { pages(): number } }).__liminalia.pages());
      await p.mouse.click(640, 200);
      await p.waitForTimeout(200);
      expect(await autoOn(p), name).toBe(false);
      expect(await p.evaluate(() => (window as unknown as { __liminalia: { pages(): number } }).__liminalia.pages()), name).toBe(pages);
      await p.close();
    }
  });
});
