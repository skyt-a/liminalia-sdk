import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * デスクトップ版の殻（preload の window.liminaliaDesktop）とゲームの画面の受け渡しを、実際のブラウザで確かめる。
 * 殻の口は真似る（Electron は使わない）。
 */
describe.skipIf(!e2e)("デスクトップ版の殻との受け渡し（ブラウザ）", { timeout: 180_000 }, () => {
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

  it("最小化したときとほかのウィンドウを選んだときの動きを選べ、言語を殻へ知らせ、覚えたウィンドウの大きさを当て直さない", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(() => {
        const w = window as unknown as Record<string, unknown> & { __calls: string[]; __visible?: (v: boolean) => void };
        w.__calls = [];
        const files: Record<string, string> = { "liminalia:hoshi_wo_matsu_oka:config": JSON.stringify({ windowScale: 1.25 }) };
        w.liminaliaDesktop = {
          platform: "test",
          windowRestored: true,
          setWindowScale: (k: number) => w.__calls.push(`scale ${k}`),
          setLanguage: (l: string) => w.__calls.push(`language ${l}`),
          setBackgroundThrottling: (on: boolean) => w.__calls.push(`throttle ${on}`),
          onWindowVisible: (l: (v: boolean) => void) => (w.__visible = l),
          storage: { load: () => files, set: (k: string, v: string) => ((files[k] = v), Promise.resolve({ ok: true })), remove: () => Promise.resolve({ ok: true }) },
        };
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("はじまり")`);
      const calls = () => p.evaluate("window.__calls") as Promise<string[]>;
      // 覚えた大きさで起動したので、設定のウィンドウの大きさ（1.25 倍）を当て直さない。作品は言語を決めていない（空）
      expect(await calls(), name).not.toContain("scale 1.25");
      expect(await calls(), name).toContain("language ");
      // 最小化したときの既定は一時停止（描画と時計を絞る）
      expect((await calls()).filter((c) => c.startsWith("throttle")).at(-1), name).toBe("throttle true");
      const muted = () => p.evaluate("window.__liminalia.host.audio.volume.muted") as Promise<boolean>;
      expect(await muted(), name).toBe(false);

      await p.evaluate("window.__liminalia.system.openConfig()");
      await p.locator(".lm-tab", { hasText: "サウンド" }).click();
      const hiddenRow = p.locator(".lm-config-row", { hasText: "最小化したとき" });
      const unfocusedRow = p.locator(".lm-config-row", { hasText: "前面にないとき" });
      expect(await hiddenRow.locator(".lm-toggle").allTextContents(), name).toEqual(["一時停止", "ミュート", "再生を続ける"]);
      expect(await hiddenRow.locator('.lm-toggle[aria-pressed="true"]').textContent(), name).toBe("一時停止");
      expect(await unfocusedRow.locator('.lm-toggle[aria-pressed="true"]').textContent(), name).toBe("再生を続ける");
      // ほかのウィンドウを選んだらミュート
      await unfocusedRow.locator(".lm-toggle", { hasText: "ミュート" }).click();
      // 最小化したら音だけ消して進める（描画を絞らない）
      await hiddenRow.locator(".lm-toggle", { hasText: "ミュート" }).click();
      expect((await calls()).filter((c) => c.startsWith("throttle")).at(-1), name).toBe("throttle false");
      await p.locator(".lm-config .lm-close").click();

      await p.evaluate(`window.dispatchEvent(new Event("blur"))`);
      expect(await muted(), name).toBe(true);
      await p.evaluate(`window.dispatchEvent(new Event("focus"))`);
      expect(await muted(), name).toBe(false);
      await p.evaluate("window.__visible(false)");
      expect(await muted(), name).toBe(true);
      await p.evaluate("window.__visible(true)");
      expect(await muted(), name).toBe(false);
      // コンフィグのミュートは、戻っても消えない
      await p.evaluate("window.__liminalia.system.updateSettings({ mute: true })");
      await p.evaluate(`window.dispatchEvent(new Event("blur"))`);
      await p.evaluate(`window.dispatchEvent(new Event("focus"))`);
      expect(await muted(), name).toBe(true);
      await p.close();
    }
  });

  it("セーブのファイルを書けなければ「セーブできませんでした」と知らせる", async () => {
    for (const { browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.addInitScript(() => {
        (window as unknown as Record<string, unknown>).liminaliaDesktop = {
          platform: "test",
          storage: { load: () => ({}), set: () => Promise.resolve({ ok: false, code: "EPERM", message: "operation not permitted" }), remove: () => Promise.resolve({ ok: true }) },
        };
      });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(`document.querySelector(".message .text")?.textContent.includes("はじまり")`);
      await p.evaluate("window.__liminalia.system.act('quick-save')");
      await p.waitForFunction(`document.querySelector(".lm-toast")?.textContent === "セーブできませんでした"`, undefined, { timeout: 5000 });
      await p.close();
    }
  });
});
