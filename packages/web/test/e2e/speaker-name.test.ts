import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/** 名前欄の表示名（{name …} と @name）を、実際のブラウザで確かめる。名前欄とバックログは表示名、名前の色は話者のまま。 */

const SCENARIO = `@window show
アカリ{name ？？？}「……誰？」
アカリ「わたし」
@name アカリ as=謎の少女
アカリ「まだ名乗らない」
@name-off アカリ
アカリ「アカリだよ」
`;

const nameBox = (p: Page) => p.evaluate(`[document.querySelector(".message .name").textContent, getComputedStyle(document.querySelector(".message .name")).color]`) as Promise<[string, string]>;
const next = async (p: Page) => {
  await p.waitForTimeout(400);
  await p.evaluate("window.__liminalia.host.advance()");
  await p.waitForTimeout(300);
};

describe.skipIf(!e2e)("名前欄の表示名（ブラウザ）", { timeout: 180_000 }, () => {
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

  it("名前欄とバックログは表示名、名前の色は話者のまま", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      const shown: [string, string][] = [await nameBox(p)];
      for (let i = 0; i < 3; i++) {
        await next(p);
        shown.push(await nameBox(p));
      }
      expect(shown.map((s) => s[0]), name).toEqual(["？？？", "アカリ", "謎の少女", "アカリ"]);
      expect(new Set(shown.map((s) => s[1])).size, name).toBe(1);
      await p.evaluate(`void window.__liminalia.system.perform("backlog")`);
      await p.waitForSelector(".lm-log-entry");
      expect(await p.evaluate(`[...document.querySelectorAll(".lm-log-name")].map((n) => n.textContent)`), name).toEqual(["？？？", "アカリ", "謎の少女", "アカリ"]);
      await p.close();
    }
  });
});

/** 二人が同時に話すページ（二つ目の @voice の who）。名前欄、バックログ、プラグインの backlog、聞いた話者（コンフィグの話者ごとの音量）に二人とも入る。 */
const TOGETHER = `@window show
@voice a1.wav
@voice s1.wav who=ソウ
アカリ「せーの」
@name ソウ as=少年
@voice a2.wav
@voice s2.wav who=ソウ
アカリ「もう一回」
`;
const VOICE = new URL("../../../../templates/default/assets/sound/chime.wav", import.meta.url).pathname;

describe.skipIf(!e2e)("二人の同時のボイスの名前（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: TOGETHER },
      config: { entry: "a" },
      files: { "assets/voice/a1.wav": VOICE, "assets/voice/a2.wav": VOICE, "assets/voice/s1.wav": VOICE, "assets/voice/s2.wav": VOICE },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  const waitPage = (p: Page, text: string) =>
    p.waitForFunction(`window.__liminalia?.host.waiting === true && document.querySelector(".message .text")?.textContent.includes(${JSON.stringify(text)})`, null, { timeout: 60_000 });

  it("名前欄とバックログに二人の名前を同じつなぎで出し、二人ともコンフィグの話者ごとの音量に出す", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await waitPage(p, "せーの");
      const first = await nameBox(p);
      await p.evaluate("window.__liminalia.host.advance()");
      await waitPage(p, "もう一回");
      const second = await nameBox(p);
      expect([first[0], second[0]], name).toEqual(["アカリ、ソウ", "アカリ、少年"]);
      expect(await p.evaluate("window.__liminalia.system.backlog.map((e) => e.label)"), name).toEqual(["アカリ、ソウ", "アカリ、少年"]);
      expect(await p.evaluate("[...window.__liminalia.system.settings.voiceSpeakers]"), name).toEqual(["アカリ", "ソウ"]);
      await p.evaluate(`void window.__liminalia.system.perform("backlog")`);
      await p.waitForSelector(".lm-log-entry");
      expect(await p.evaluate(`[...document.querySelectorAll(".lm-log-name")].map((n) => n.textContent)`), name).toEqual(["アカリ、ソウ", "アカリ、少年"]);
      await p.close();
    }
  });
});
