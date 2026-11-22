import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 横長の作品を縦に持ったときの知らせを、実際のブラウザで確かめる。
 * - 収まる舞台の幅が狭い（スマホ）なら画面全体を覆い、覆っている間はオートと選択肢の制限時間を止める（裏へ回したときと同じ）
 * - 広い（タブレット）なら上に知らせだけを出し、「このまま遊ぶ」で閉じて遊べる
 */

const state = (p: Page) =>
  p.evaluate(() => {
    const r = document.querySelector(".lm-rotate")!;
    return { cover: r.classList.contains("is-cover"), notice: r.classList.contains("is-notice"), paused: document.querySelector(".stage")!.classList.contains("lm-timers-paused") };
  });

describe.skipIf(!e2e)("縦持ちの知らせ（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: "@window show\n一。\n二。\n" } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  for (const [label, size, expected] of [
    ["スマホは覆って止める", { width: 390, height: 844 }, { cover: true, notice: false, paused: true }],
    ["タブレットは知らせだけ", { width: 820, height: 1180 }, { cover: false, notice: true, paused: false }],
  ] as const) {
    it(label, async () => {
      for (const { name, browser } of list) {
        const context = await browser.newContext({ viewport: size, hasTouch: true, isMobile: name === "chromium" });
        const p = await context.newPage();
        await p.goto(`${project.url}?autostart=1&start=a`);
        await p.waitForSelector(".message .text .ch", { timeout: 60_000 });
        await p.waitForTimeout(200);
        expect(await state(p), name).toEqual(expected);
        if (expected.notice) {
          // 「このまま遊ぶ」で閉じ、出し直さない
          await p.locator(".lm-rotate-keep").click();
          expect(await state(p), name).toEqual({ cover: false, notice: false, paused: false });
          await p.setViewportSize({ width: 821, height: 1180 });
          await p.waitForTimeout(100);
          expect((await state(p)).notice, name).toBe(false);
        } else {
          // 横にすると外れて続ける
          await p.setViewportSize({ width: 844, height: 390 });
          await p.waitForTimeout(200);
          expect(await state(p), name).toEqual({ cover: false, notice: false, paused: false });
        }
        await context.close();
      }
    });
  }
});
