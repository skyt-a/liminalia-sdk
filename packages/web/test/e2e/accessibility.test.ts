import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/** 読み上げ・スクリーンリーダーへ渡す本文（章の扉と章末の題も）・高コントラストを、実際のブラウザで確かめる（読み上げは speechSynthesis を差し替えて見る）。 */

const SCENARIO = `@bg hill_dusk.webp alt="夕暮れの丘"
@window show
はじめ。
@describe "雨の音がする"
ソウ「おはよう」
@voice nothing.ogg caption="（笑い声）"
ソウ「ふふ」
@choice
- 外へ -> #a
- 中へ -> #a
@end
# a
終わり。
`;

/** 章の扉と章末（@chapter-card、@chapter-end）。題は liminalia.json の chapters から。 */
const CHAPTER = `@window show
はじまり。
@chapter-card time=900ms fade=200ms
扉のあと。
@chapter-end time=900ms fade=200ms text=おしまい
章末のあと。
`;

describe.skipIf(!e2e)("アクセシビリティ（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let chapter: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" } });
    chapter = await startProject({ scenario: { c: CHAPTER }, config: { entry: "c", chapters: [{ id: "ep1", number: "第一章", title: "雨の駅", subtitle: "駅の名前", files: ["c"] }] } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
    await chapter?.close();
  });

  it("章の扉と章末を出したら、題をスクリーンリーダーとテキスト読み上げに渡す", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(() => {
        const said: string[] = [];
        (window as unknown as { __said: string[] }).__said = said;
        Object.defineProperty(window, "speechSynthesis", { value: { speak: (u: { text: string }) => said.push(u.text), cancel: () => undefined }, configurable: true });
        (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
          lang = "";
          constructor(public text: string) {}
        };
      });
      await p.goto(`${chapter.url}?autostart=1&start=c`);
      await p.waitForFunction("window.__liminalia?.host.waiting");
      await p.evaluate("window.__liminalia.system.updateSettings({ selfVoicing: true })");
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForSelector(".lim-chapter--card");
      await p.waitForFunction(`document.querySelector(".lm-sr-only").textContent === "第一章 雨の駅 駅の名前"`, undefined, { timeout: 5000 });
      expect(await p.evaluate("window.__said.at(-1)"), name).toBe("第一章 雨の駅 駅の名前");
      await p.waitForFunction("window.__liminalia.host.waiting && document.querySelector('.message .text').textContent.includes('扉のあと')", undefined, { timeout: 10_000 });
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForSelector(".lim-chapter--end");
      await p.waitForFunction(`document.querySelector(".lm-sr-only").textContent === "第一章 雨の駅 おしまい"`, undefined, { timeout: 5000 });
      expect(await p.evaluate("window.__said.at(-1)"), name).toBe("第一章 雨の駅 おしまい");
      // 飛ばしている間は渡さない
      const q = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await q.goto(`${chapter.url}?autostart=1&start=c&skip=3`);
      await q.waitForFunction("window.__liminalia?.host.waiting && document.querySelector('.message .text').textContent.includes('章末のあと')", undefined, { timeout: 15_000 });
      expect(await q.evaluate(`document.querySelector(".lm-sr-only").textContent`), name).not.toContain("雨の駅");
      await q.close();
      await p.close();
    }
  });

  it("本文をライブ領域に置き、読み上げをオンにすると本文と選択肢を読む。高コントラストで枠が黒になる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(() => {
        const said: string[] = [];
        (window as unknown as { __said: string[] }).__said = said;
        Object.defineProperty(window, "speechSynthesis", { value: { speak: (u: { text: string }) => said.push(u.text), cancel: () => undefined }, configurable: true });
        (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
          lang = "";
          constructor(public text: string) {}
        };
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForSelector(".message .text .ch");
      await p.waitForFunction("window.__liminalia.host.waiting");
      // 背景の alt は、次の本文と一緒にスクリーンリーダーへ渡す（画面には出さない）
      expect(await p.evaluate(`document.querySelector(".lm-sr-only").textContent`), name).toBe("夕暮れの丘 はじめ。");
      await p.evaluate("window.__liminalia.system.updateSettings({ selfVoicing: true, highContrast: true, textSpeed: 0, captions: true })");
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForFunction("window.__liminalia.host.waiting && document.querySelector(\".message .text\").textContent.includes(\"おはよう\")");
      // 台詞の括弧は本文のまま（二重にしない）。読み上げは名前のあとで一度区切る。@describe の文は本文の前に読む
      expect(await p.evaluate(`document.querySelector(".lm-sr-only").textContent`), name).toBe("雨の音がする ソウ「おはよう」");
      expect(await p.evaluate("window.__said.at(-1)"), name).toBe("雨の音がする ソウ。「おはよう」");
      // 本文に書いていない声の字幕（@voice caption=。コンフィグの効果音の字幕）
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForFunction("window.__liminalia.host.waiting");
      expect(await p.evaluate(`[...document.querySelectorAll(".lm-caption")].map((c) => c.textContent)`), name).toContain("（笑い声）");
      expect(await p.evaluate(`document.querySelector(".lm-caption").getBoundingClientRect().width > 0`), name).toBe(true);
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForSelector(".choices button");
      await p.waitForTimeout(300);
      expect(await p.evaluate(`document.querySelector(".lm-sr-only").textContent`), name).toBe("選択肢: 外へ、中へ");
      expect(await p.evaluate("window.__said.at(-1)"), name).toBe("選択肢。外へ。中へ");
      await p.locator(".choices button").first().click();
      await p.waitForTimeout(400);
      expect(await p.evaluate(`document.querySelector(".lm-sr-only").textContent`), name).toBe("終わり。");
      expect(await p.evaluate("window.__said.at(-1)"), name).toBe("終わり。");
      expect(await p.evaluate(`getComputedStyle(document.querySelector(".message")).backgroundColor`), name).toBe("rgb(0, 0, 0)");
      await p.close();
    }
  });

  it("システム画面はダイアログ（role、aria-modal、見出し）で、Tab は画面の中を回り、閉じたら開く前のところへフォーカスを戻す", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.evaluate('void window.__liminalia.system.perform("menu")');
      await p.waitForTimeout(200);
      const menu = await p.evaluate(() => {
        const el = document.querySelector("[data-lm-screen='menu']")!;
        return { role: el.getAttribute("role"), modal: el.getAttribute("aria-modal"), focused: el.contains(document.activeElement) };
      });
      expect(menu, name).toEqual({ role: "dialog", modal: "true", focused: true });
      // コンフィグを重ねて開く（見出しで名前を付ける）。フォーカスは画面の根
      await p.evaluate('void window.__liminalia.system.perform("config")');
      await p.waitForTimeout(200);
      expect(await p.evaluate(`document.activeElement === document.querySelector("[data-lm-screen='config']")`), name).toBe(true);
      // 根にあるときのパッドの A は、画面の根を押したことにせず、最初のボタンを選ぶ
      await p.evaluate(`import("/src/system/input.ts").then((m) => { m.pressPadButton("a", true); m.pressPadButton("a", false); })`);
      await p.waitForTimeout(100);
      expect(await p.evaluate(`[window.__liminalia.screen().screen, document.activeElement?.tagName]`), name).toEqual(["config", "BUTTON"]);
      // Tab で何度回っても画面の外へ出ない
      expect(await p.evaluate(`document.getElementById(document.querySelector("[data-lm-screen='config']").getAttribute("aria-labelledby"))?.textContent`), name).toBe("コンフィグ");
      for (let i = 0; i < 40; i++) await p.keyboard.press("Tab");
      expect(await p.evaluate(`document.querySelector("[data-lm-screen='config']").contains(document.activeElement)`), name).toBe(true);
      await p.keyboard.press("Shift+Tab");
      expect(await p.evaluate(`document.querySelector("[data-lm-screen='config']").contains(document.activeElement)`), name).toBe(true);
      // 閉じるとメニューの中へ戻る
      await p.keyboard.press("Escape");
      await p.waitForTimeout(100);
      expect(await p.evaluate(`document.querySelector("[data-lm-screen='menu']").contains(document.activeElement)`), name).toBe(true);
      await p.close();
    }
  });
});
