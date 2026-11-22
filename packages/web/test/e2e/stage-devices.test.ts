import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

describe.skipIf(!e2e)("舞台の PC とスマホの向き", { timeout: 120_000 }, () => {
  let projects: TestProject[] = [];
  let list: { name: string; browser: Browser }[] = [];
  beforeAll(async () => {
    projects.push(await startProject({ scenario: { a: "本文。\n@stop\n" } }));
    projects.push(await startProject({ scenario: { a: "本文。\n@stop\n" }, config: { screen: { width: 720, height: 1280 } } }));
    projects.push(await startProject({ scenario: { a: "本文。\n@stop\n" }, config: { screen: { width: 1024, height: 768 } } }));
    list = await browsers();
  }, 60_000);
  afterAll(async () => {
    for (const p of projects) await p.close();
    for (const b of list) await b.browser.close();
  });

  const open = async (browser: Browser, project: TestProject): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "ja-JP" });
    await page.addInitScript(() => {
      localStorage.setItem("liminalia.studio.tourDone", "1");
      if (!localStorage.getItem("liminalia.studio.stageDevice")) localStorage.setItem("liminalia.studio.stageDevice", "none");
    });
    await page.goto(`${project.url}__liminalia/studio`);
    await page.locator(".stage-device").waitFor({ state: "visible" });
    return page;
  };

  it("横と縦を選べ、PC ではスマホ用 UI を出さない", async () => {
    for (const { browser } of list) {
      const page = await open(browser, projects[0]!);
      const select = page.locator(".stage-device");
      expect(await select.locator("option").allTextContents()).toEqual(["PC横", "PC縦", "スマホ横", "スマホ縦"]);
      expect(await select.inputValue()).toBe("pc-landscape");
      for (const [id, width, height, phone] of [
        ["pc-portrait", 720, 1280, false], ["pc-landscape", 1280, 720, false],
        ["phone-portrait", 390, 844, true], ["phone-landscape", 844, 390, true],
      ] as const) {
        await select.selectOption(id);
        await expect.poll(async () => page.frameLocator(".stage-frame").locator("html").evaluate(() => [innerWidth, innerHeight, document.documentElement.classList.contains("lm-emulate-touch")]).catch(() => null), { timeout: 30_000 }).toEqual([width, height, phone]);
        const size = await page.locator(".stage-box").evaluate((e) => { const r = e.getBoundingClientRect(); return r.width / r.height; });
        expect(size).toBeCloseTo(width / height, 2);
        if (id === "pc-portrait") {
          await page.locator(".stage-fullscreen").click();
          await page.waitForFunction(() => !!document.fullscreenElement);
          const full = await page.locator(".stage-box").evaluate((e) => { const r = e.getBoundingClientRect(); return { ratio: r.width / r.height, bottom: r.bottom, height: innerHeight }; });
          expect(full.ratio).toBeCloseTo(9 / 16, 2);
          expect(full.bottom).toBeLessThanOrEqual(full.height + 1);
          await page.locator(".stage-fullscreen").click();
          await page.waitForFunction(() => !document.fullscreenElement);
        }
      }
      await select.selectOption("pc-portrait");
      await page.reload();
      expect(await select.inputValue()).toBe("pc-portrait");
      await page.close();
    }
  });

  it("旧設定の『そのまま』は縦長作品では PC 縦になる", async () => {
    for (const { browser } of list) {
      const page = await open(browser, projects[1]!);
      expect(await page.locator(".stage-device").inputValue()).toBe("pc-portrait");
      await expect.poll(async () => page.frameLocator(".stage-frame").locator("html").evaluate(() => [innerWidth, innerHeight]).catch(() => null), { timeout: 30_000 }).toEqual([720, 1280]);
      await page.close();
    }
  });

  it("16:9 でない作品の PC は、同じ向きなら作品の縦横比で描く", async () => {
    for (const { browser } of list) {
      const page = await open(browser, projects[2]!);
      expect(await page.locator(".stage-device").inputValue()).toBe("pc-landscape");
      await expect.poll(async () => page.frameLocator(".stage-frame").locator("html").evaluate(() => [innerWidth, innerHeight]).catch(() => null), { timeout: 30_000 }).toEqual([1280, 960]);
      const size = await page.locator(".stage-box").evaluate((e) => { const r = e.getBoundingClientRect(); return r.width / r.height; });
      expect(size).toBeCloseTo(4 / 3, 2);
      await page.close();
    }
  });
});
