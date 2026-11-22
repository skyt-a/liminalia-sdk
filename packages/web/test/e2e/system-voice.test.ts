import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** システムボイス（ui.systemVoice）を、実際のブラウザで確かめる。 */

const voice = resolve(import.meta.dirname, "../fixtures/loop-opus.ogg");

describe.skipIf(!e2e)("システムボイス（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { start: "@window show\nはじめ。\n" },
      config: {
        ui: {
          systemVoice: {
            title: [{ file: "sys/title_a.ogg", character: "A" }, { file: "sys/title_b.ogg", character: "B" }],
            actions: { start: ["sys/start.ogg"], config: ["sys/config.ogg"] },
          },
        },
      },
      files: { "assets/voice/sys/title_a.ogg": voice, "assets/voice/sys/title_b.ogg": voice, "assets/voice/sys/start.ogg": voice, "assets/voice/sys/config.ogg": voice },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  /** 鳴らしたシステムボイスのファイルを控える（AudioPlayer.playSystemVoice を包む）。 */
  const record = (p: Page) => p.evaluate(`(() => { const a = window.__liminalia.host.audio; window.__said = []; const play = a.playSystemVoice.bind(a); a.playSystemVoice = (f, v) => { window.__said.push(f); return play(f, v); }; })()`);
  const said = (p: Page) => p.evaluate("window.__said.splice(0)") as Promise<string[]>;

  it("タイトルコールと操作の声を鳴らし、コンフィグの担当で絞り、オフなら鳴らさない", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(project.url);
      await p.waitForFunction("!!window.__liminalia?.host");
      await record(p);
      await p.click(".lm-gate");
      await p.waitForSelector(".lm-title-button");
      expect((await said(p))[0], name).toMatch(/^sys\/title_[ab]\.ogg$/);
      // 担当 B だけ
      await p.evaluate("window.__liminalia.system.updateSettings({ systemVoice: 'B' })");
      await p.evaluate("window.__liminalia.system.showTitle(true)");
      expect(await said(p), name).toEqual(["sys/title_b.ogg"]);
      // コンフィグに「システムボイス」の行（ランダム、A、B、オフ）
      await p.locator(".lm-title-button", { hasText: "コンフィグ" }).click();
      expect(await said(p), name).toEqual(["sys/config.ogg"]);
      const row = (await p.evaluate(`[...document.querySelectorAll(".lm-config-row")].map((r) => r.textContent).find((t) => t.startsWith("システムボイス"))`)) as string;
      expect(row, name).toBe("システムボイスランダムABオフ");
      // オフ
      await p.evaluate("window.__liminalia.system.updateSettings({ systemVoice: 'off' })");
      await p.evaluate("window.__liminalia.system.showTitle(true)");
      expect(await said(p), name).toEqual([]);
      await p.close();
    }
  });
});
