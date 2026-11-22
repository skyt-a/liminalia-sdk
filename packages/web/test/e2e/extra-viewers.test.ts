import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** おまけの立ち絵の鑑賞とムービーの鑑賞を、実際のブラウザで確かめる。 */

const MOVIE = resolve(import.meta.dirname, "fixtures/test-movie.webm");

const scenario = `@window show
@chara アカリ normal
はじまり。
@chara アカリ smile
笑った。
@movie m.webm
@title-screen
`;

describe.skipIf(!e2e)("立ち絵とムービーの鑑賞（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: scenario },
      config: { entry: "a", extra: { characters: [{ who: "アカリ" }, { who: "ソウ" }], movies: [{ file: "m.webm", title: "オープニング" }, { file: "ed.webm", title: "エンディング" }] } },
      files: { "assets/video/m.webm": MOVIE },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("見た差分と流したムービーだけを選べる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1`);
      await p.locator(".lm-title-button").first().click();
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("はじまり")`);
      await p.waitForTimeout(300);
      await p.mouse.click(640, 300);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("笑った")`);
      await p.waitForTimeout(300);
      await p.mouse.click(640, 300);
      // 動画（2 秒）が終わるとタイトルへ
      await p.waitForSelector(".lm-title", { timeout: 20_000 });
      await p.locator(".lm-title-button", { hasText: "おまけ" }).click();
      await p.locator(".lm-tab", { hasText: "キャラクター" }).click();
      expect(await p.locator(".lm-chars-person").allTextContents(), name).toEqual(["アカリ", "？？？"]);
      const variants = await p.locator(".lm-chars-variant").evaluateAll((bs) => bs.map((b) => [b.textContent, (b as HTMLButtonElement).disabled]));
      expect(variants, name).toEqual([
        ["normal", false],
        ["smile", false],
        ["？", true],
      ]);
      await p.waitForFunction(`!!document.querySelector(".lm-chars-picture img")?.naturalWidth`);
      await p.locator(".lm-chars-variant", { hasText: "smile" }).click();
      await p.waitForFunction(`decodeURIComponent(document.querySelector(".lm-chars-picture img")?.src ?? "").includes("smile")`);
      await p.locator(".lm-tab", { hasText: "ムービー" }).click();
      expect(await p.locator(".lm-extra-tile").evaluateAll((bs) => bs.map((b) => [b.textContent, (b as HTMLButtonElement).disabled])), name).toEqual([
        ["▶オープニング", false],
        ["？？？？", true],
      ]);
      await p.locator(".lm-extra-tile").first().click();
      await p.waitForFunction(`(() => { const v = document.querySelector(".lm-extra-movie video"); return !!v && v.currentTime > 0; })()`, null, { timeout: 10_000 });
      await p.keyboard.press("Escape");
      expect(await p.locator(".lm-extra-movie").count(), name).toBe(0);
      await p.close();
    }
  });
});
