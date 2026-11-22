import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** コンフィグのウィンドウの大きさ・確認のメッセージ・カーソルを隠す、を実際のブラウザで確かめる。 */

describe.skipIf(!e2e)("コンフィグの画面まわり（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: "@window show\nはじまり。\nつぎ。\n" }, config: { entry: "a" } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("デスクトップ版ではウィンドウの大きさを選べ、確認を省け、動かさないカーソルを隠す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      // デスクトップ版の口のうち、ウィンドウの大きさだけを真似る（画面は 1920×1080 とする）
      await p.addInitScript(() => {
        Object.defineProperty(window.screen, "availWidth", { get: () => 1920 });
        Object.defineProperty(window.screen, "availHeight", { get: () => 1080 });
        (window as unknown as { liminaliaDesktop: unknown }).liminaliaDesktop = { platform: "test", setWindowScale: (k: number) => ((window as unknown as { __scales: number[] }).__scales ??= []).push(k) };
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("はじまり")`);
      await p.evaluate("window.__liminalia.system.openConfig()");
      await p.locator(".lm-tab", { hasText: "画面" }).click();
      const row = p.locator(".lm-config-row", { hasText: "ウィンドウの大きさ" });
      // 1920×1080 の画面に枠ごと収まるもの（1920×1080 と 2560×1440 は出さない）
      expect(await row.locator(".lm-toggle").allTextContents(), name).toEqual(["標準", "640×360", "960×540", "1280×720", "1600×900"]);
      await row.locator(".lm-toggle", { hasText: "1600×900" }).click();
      expect(await p.evaluate("window.__scales"), name).toEqual([1.25]);
      // 確認のメッセージをオフにすると、タイトルへ戻るときに尋ねない
      await p.locator(".lm-config-row", { hasText: "確認のメッセージ" }).locator(".lm-toggle", { hasText: "オフ" }).click();
      await p.locator(".lm-config-row", { hasText: "カーソルを隠す" }).locator(".lm-toggle", { hasText: "オン" }).click();
      // 色覚の補正は舞台全体にかかり、書体に UD がある
      await p.locator(".lm-config-row", { hasText: "色覚の補正" }).locator(".lm-toggle", { hasText: "2 型" }).click();
      expect(await p.evaluate(`getComputedStyle(document.querySelector(".stage")).filter`), name).toMatch(/url\("?#lm-color-vision-deutan"?\)/);
      expect(await p.locator(".lm-config-row", { hasText: "フォント" }).locator(".lm-toggle", { hasText: "UD" }).count(), name).toBe(1);
      await p.locator(".lm-config-row", { hasText: "色覚の補正" }).locator(".lm-toggle", { hasText: "しない" }).click();
      expect(await p.evaluate(`getComputedStyle(document.querySelector(".stage")).filter`), name).toBe("none");
      await p.locator(".lm-config .lm-close").click();
      // 動かさずに 3 秒でカーソルが消え、動かすと出る
      await p.mouse.move(400, 300);
      await p.waitForTimeout(3300);
      expect(await p.evaluate(`document.querySelector(".stage").classList.contains("lm-cursor-idle")`), name).toBe(true);
      await p.mouse.move(420, 320);
      expect(await p.evaluate(`document.querySelector(".stage").classList.contains("lm-cursor-idle")`), name).toBe(false);
      await p.evaluate("window.__liminalia.system.act('title')");
      await p.waitForSelector(".lm-title");
      expect(await p.locator(".lm-dialog").count(), name).toBe(0);
      await p.close();
    }
  });
});
