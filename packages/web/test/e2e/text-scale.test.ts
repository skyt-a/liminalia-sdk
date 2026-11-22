import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * コンフィグの「文字サイズ」（80〜200%）が、本文と選択肢のほか、名前欄・バックログ・システム画面にも効くことを、実際のブラウザで確かめる。
 * 大きくしたときはシステム画面の並べ方を詰め（舞台に lm-text-large）、画面からはみ出さない。ui.screen.textScale: message なら本文と選択肢だけ。
 */

const size = (p: Page, selector: string) => p.evaluate((s) => parseFloat(getComputedStyle(document.querySelector(s)!).fontSize), selector);
/** 要素が舞台（1280×720）の中に収まっているか。 */
const inside = (p: Page, selector: string) =>
  p.evaluate((s) => [...document.querySelectorAll(s)].every((e) => {
    const r = e.getBoundingClientRect();
    return r.left >= -1 && r.top >= -1 && r.right <= 1281 && r.bottom <= 721;
  }), selector);

describe.skipIf(!e2e)("文字サイズの設定を全体に効かせる（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: "@window show\nアカリ「名前欄のある台詞。」\n" }, config: { entry: "a" } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("200% まで選べ、名前欄・バックログ・コンフィグ・メニューの文字も大きくなり、画面に収まる", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(() => window.__liminalia?.host.waiting);
      const nameAt100 = await size(p, ".message .name");
      const bottom = () => p.evaluate(() => document.querySelector(".message .name")!.getBoundingClientRect().bottom);
      const bottomAt100 = await bottom();
      expect(await p.evaluate(() => window.__liminalia!.system.updateSettings!({ textScale: 250 }).textScale), name).toBe(200);
      expect(await size(p, ".message .name"), name).toBeCloseTo(nameAt100 * 2, 0);
      expect(await p.evaluate(() => document.querySelector(".stage")!.classList.contains("lm-text-large")), name).toBe(true);
      // 名前欄の下の端は、大きくしても同じところ（上へ伸ばす）
      expect(Math.abs((await bottom()) - bottomAt100), name).toBeLessThan(3);
      await p.evaluate("window.__liminalia.system.openBacklog()");
      expect(await size(p, ".lm-log-text"), name).toBe(42);
      await p.keyboard.press("Escape");
      await p.evaluate("window.__liminalia.system.openConfig()");
      expect(await size(p, ".lm-config-label"), name).toBe(36);
      // 画面ごと縦に送れる（見出しと閉じるボタンは上に残る）
      expect(await p.evaluate(() => { const c = document.querySelector(".lm-config")!; return c.scrollHeight > c.clientHeight; }), name).toBe(true);
      await p.evaluate(() => document.querySelector(".lm-config")!.scrollTo(0, 10_000));
      expect(await inside(p, ".lm-config .lm-close"), name).toBe(true);
      await p.keyboard.press("Escape");
      await p.evaluate("window.__liminalia.system.openMenu()");
      expect(await inside(p, ".lm-menu-panel"), name).toBe(true);
      await p.keyboard.press("Escape");
      await p.evaluate("window.__liminalia.system.openSaveLoad('save')");
      expect(await inside(p, ".lm-saveload .lm-tab"), name).toBe(true);
      await p.keyboard.press("Escape");
      // 作品が本文と選択肢だけにする
      await p.evaluate(() => {
        const s = window.__liminalia!.system as unknown as { env: { project: { ui: unknown } } };
        s.env.project.ui = { screen: { textScale: "message" } };
        window.__liminalia!.system.updateSettings!({ textScale: 200 });
      });
      expect(await size(p, ".message .name"), name).toBeCloseTo(nameAt100, 0);
      expect(await p.evaluate(() => document.querySelector(".stage")!.classList.contains("lm-text-large")), name).toBe(false);
      await p.close();
    }
  });
});
