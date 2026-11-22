import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/**
 * 全体の音量とミュート（コンフィグの「サウンド」、M キー、パッドの RT）と、動画の音量（volume × BGM の音量 × 全体の音量）を、
 * 実際のブラウザで確かめる。
 */

const MOVIE = resolve(import.meta.dirname, "fixtures/test-movie.webm");
const SCENARIO = `@window show
はじまり。
@bg-movie m.webm volume=80
動画の上。
`;

const videoVolume = (p: Page) => p.evaluate(() => document.querySelector<HTMLVideoElement>("video")?.volume ?? null);
const settle = (p: Page) => p.waitForTimeout(150);

describe.skipIf(!e2e)("全体の音量とミュート、動画の音量（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    list = await browsers();
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" }, files: { "assets/video/m.webm": MOVIE } });
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("動画は volume × BGM の音量 × 全体の音量で鳴り、設定を変えるとすぐ合わせる。M キーでミュートを切り替える", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(() => window.__liminalia?.host.waiting);
      await p.evaluate(() => window.__liminalia!.system.updateSettings!({ bgm: 50, master: 50 }));
      await p.evaluate(() => window.__liminalia!.host.advance());
      await p.waitForSelector("video");
      await settle(p);
      // iOS 以外は要素の volume で合わせる（0.8 × 0.5 × 0.5）
      expect(await videoVolume(p), name).toBeCloseTo(0.2, 3);
      await p.evaluate(() => window.__liminalia!.system.updateSettings!({ bgm: 100 }));
      expect(await videoVolume(p), name).toBeCloseTo(0.4, 3);
      // コンフィグの「サウンド」の先頭に全体の音量とミュート
      await p.evaluate("window.__liminalia.system.openConfig()");
      await p.locator(".lm-config .lm-tab", { hasText: "サウンド" }).click();
      const labels = await p.locator(".lm-config-rows:not([hidden]) .lm-config-label").allTextContents();
      expect(labels.slice(0, 3), name).toEqual(["全体の音量", "ミュート", "BGM の音量"]);
      await p.keyboard.press("Escape");
      // M キーでミュート（全体の出口と動画を消す）、もう一度で戻す
      await p.keyboard.press("m");
      expect(await p.evaluate(() => [window.__liminalia!.system.settings!.mute, window.__liminalia!.host.audio.volume.muted]), name).toEqual([true, true]);
      expect(await p.locator(".lm-toast").last().textContent(), name).toBe("ミュートしました");
      expect(await videoVolume(p), name).toBe(0);
      await p.keyboard.press("m");
      expect(await p.evaluate(() => window.__liminalia!.system.settings!.mute), name).toBe(false);
      expect(await videoVolume(p), name).toBeCloseTo(0.4, 3);
      // ほかの操作に割り当てたキーなら、その操作が先（作品が M をバックログにした）
      await p.evaluate(() => {
        const s = window.__liminalia!.system as unknown as { env: { project: { ui: unknown } } };
        s.env.project.ui = { keys: { backlog: ["m"] } };
      });
      await p.keyboard.press("m");
      expect(await p.evaluate(() => [window.__liminalia!.system.settings!.mute, window.__liminalia!.system.screen]), name).toEqual([false, "backlog"]);
      await p.close();
    }
  });

  it("要素の volume を変えられない環境（iOS）では、Web Audio に通して音量を掛ける", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      // iOS の Safari と同じく、volume を書いても 1 のまま
      await p.addInitScript(() => Object.defineProperty(HTMLMediaElement.prototype, "volume", { get: () => 1, set: () => undefined, configurable: true }));
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(() => window.__liminalia?.host.waiting);
      // 音の値は鳴らしている AudioContext で読む（クリックで開始したのと同じに、押してから動かす）
      await p.mouse.click(5, 5, { button: "right" });
      await p.keyboard.press("Escape");
      await p.evaluate(() => window.__liminalia!.host.audio.unlock());
      await p.evaluate(() => window.__liminalia!.system.updateSettings!({ bgm: 50, master: 50 }));
      await p.evaluate(() => window.__liminalia!.host.advance());
      await p.waitForSelector("video");
      await p.waitForTimeout(400);
      const state = () =>
        p.evaluate(() => {
          const audio = window.__liminalia!.host.audio as unknown as { media: Map<HTMLMediaElement, { gain: GainNode | null }>; overall: GainNode; master: Record<string, GainNode> };
          const entry = [...audio.media.values()][0];
          return { gain: entry?.gain?.gain.value ?? null, bgm: audio.master.bgm!.gain.value, overall: audio.overall.gain.value, muted: document.querySelector("video")!.muted };
        });
      // 動画の音（0.8）→ BGM の系統（0.5）→ 全体（0.5）の順につなぐ
      expect(await state(), name).toEqual({ gain: expect.closeTo(0.8, 3), bgm: 0.5, overall: 0.5, muted: false });
      await p.keyboard.press("m");
      await p.waitForTimeout(200);
      expect((await state()).overall, name).toBe(0);
      await p.close();
    }
  });

  it("ui.sound.movie: none なら動画は全体の音量だけを掛ける", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${project.url}?autostart=1&start=a`);
      await p.waitForFunction(() => window.__liminalia?.host.waiting);
      await p.evaluate(() => {
        window.__liminalia!.host.setUi({ sound: { movie: "none" } });
        window.__liminalia!.system.updateSettings!({ bgm: 10, master: 50 });
      });
      await p.evaluate(() => window.__liminalia!.host.advance());
      await p.waitForSelector("video");
      await settle(p);
      expect(await videoVolume(p), name).toBeCloseTo(0.4, 3);
      await p.close();
    }
  });
});
