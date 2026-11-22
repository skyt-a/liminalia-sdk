import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** 効果音と BGM の字幕（コンフィグの「効果音の字幕」）を、実際のブラウザで確かめる。 */

const scenario = `@window show
はじまり。
@se chime.wav caption="チャイムが鳴る"
@se gust.wav channel=1
@bgm quiet_night.wav
鳴った。
`;

describe.skipIf(!e2e)("効果音の字幕（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({
      scenario: { a: scenario },
      config: { entry: "a", ui: { captions: { sounds: { "gust.wav": "風が吹く" }, music: true } }, extra: { music: [{ file: "quiet_night.wav", title: "静かな夜" }] } },
    });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("オフなら出さず、オンなら caption=・ui.captions.sounds・曲の題名を出す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("はじまり")`);
      await p.waitForTimeout(300);
      await p.evaluate("window.__liminalia.system.updateSettings({ captions: true })");
      await p.mouse.click(640, 300);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("鳴った")`);
      expect(await p.locator(".lm-caption").allTextContents(), name).toEqual(["チャイムが鳴る", "風が吹く", "♪ 静かな夜"]);
      await p.waitForTimeout(3800);
      expect(await p.locator(".lm-caption").count(), name).toBe(0);
      await p.close();
    }
  });
});
