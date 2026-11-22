import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

describe.skipIf(!e2e)("対象を先に選ぶ画面", { timeout: 120_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: "# one\n最初の行。\n次の行。\n\n# two\n別のシーン。\n@stop\n" } });
    list = await browsers();
  }, 60_000);
  afterAll(async () => {
    await project?.close();
    for (const b of list ?? []) await b.browser.close();
  });

  const open = async (browser: Browser): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "ja-JP" });
    await page.addInitScript(() => localStorage.setItem("liminalia.studio.tourDone", "1"));
    await page.goto(`${project.url}__liminalia/studio`);
    await page.locator(".ed-title").waitFor();
    await page.locator(".toc-file").first().waitFor();
    return page;
  };
  const menu = (page: Page) => page.locator(".ctx-menu .ctx-item").allTextContents();

  it("欄は見出しから閉じ、端の跡から同じ場所に開く", async () => {
    for (const { browser } of list) {
      const page = await open(browser);
      for (const [id, pane] of [["toc", ".toc"], ["right", ".right"]] as const) {
        expect(await page.locator(`.panel-head[data-panel="${id}"] .panel-title`).isVisible()).toBe(true);
        await page.locator(`.panel-head[data-panel="${id}"] .panel-close`).click();
        expect(await page.locator(`.desk > ${pane}`).isVisible()).toBe(false);
        await page.locator(`.panel-rail[data-panel="${id}"]`).click();
        expect(await page.locator(`.desk > ${pane}`).isVisible()).toBe(true);
        expect(await page.locator(`.panel-rail[data-panel="${id}"]`).isVisible()).toBe(false);
      }
      await page.locator(".film-close").click();
      expect(await page.locator(".desk > .filmstrip").isVisible()).toBe(false);
      await page.locator('.panel-rail[data-panel="filmstrip"]').click();
      expect(await page.locator(".desk > .filmstrip").isVisible()).toBe(true);
      await page.locator('.panel-rail[data-panel="parts"]').click();
      expect(await page.locator(".blk-palette").isVisible()).toBe(true);
      await page.locator('.panel-head[data-panel="parts"] .panel-close').click();
      expect(await page.locator(".blk-palette").isVisible()).toBe(false);
      await page.close();
    }
  });

  it("開閉のボタンはシナリオの帯に出さない", async () => {
    for (const { browser } of list) {
      const page = await open(browser);
      expect(await page.locator(".panel-toggles").isVisible()).toBe(false);
      await page.close();
    }
  });

  it("シナリオの見出しは開いているファイルのメニューを出す", async () => {
    for (const { browser } of list) {
      const page = await open(browser);
      await page.locator(".ed-title").click();
      const items = await menu(page);
      for (const label of ["テキストをインポート", "変更履歴", "シーンを追加", "名前を変更", "ごみ箱に入れる"]) expect(items.join(" ")).toContain(label);
      expect(await page.locator(".ed-title").getAttribute("data-open")).not.toBeNull();
      await page.keyboard.press("Escape");
      expect(await page.locator(".ed-title").getAttribute("data-open")).toBeNull();
      await page.close();
    }
  });

  it("ファイル・シーン・行は「…」から右クリックと同じメニューを出す", async () => {
    for (const { browser } of list) {
      const page = await open(browser);
      const file = page.locator(".toc-file").first();
      await file.hover();
      await file.locator(".toc-file-more").click();
      expect((await menu(page)).join(" ")).toContain("複製");
      await page.keyboard.press("Escape");

      if ((await page.locator(".scene-row").count()) === 0) await page.locator(".toc-file-fold").first().click();
      const scene = page.locator(".scene-item").first();
      await scene.hover();
      await scene.locator(".scene-more").click();
      expect((await menu(page)).join(" ")).toContain("シーンの名前を変更");
      await page.keyboard.press("Escape");

      const row = page.locator(".blk-text-row").first();
      await row.hover();
      await row.locator(".blk-more").click();
      expect((await menu(page)).join(" ")).toContain("コメント");
      await page.keyboard.press("Escape");
      await page.close();
    }
  });

  it("フローチャートのカードは「…」でメニューを出し、カードを開かない", async () => {
    for (const { browser } of list) {
      const page = await open(browser);
      await page.locator(".tabs-main .tab", { hasText: "フローチャート" }).click();
      const card = page.locator(".map-card").first();
      await card.waitFor();
      await card.hover();
      await card.locator(".map-card-more").click();
      expect((await menu(page)).join(" ")).toContain("シーンを開く");
      expect(await page.locator(".map-card").first().isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await page.close();
    }
  });
});
