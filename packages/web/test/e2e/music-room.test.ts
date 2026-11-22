import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, startProject, type TestProject } from "./harness.ts";

/** おまけの音楽室（再生の欄、シーク、次の曲、曲の終わりで次へ、リピート、シャッフル）を、実際のブラウザで確かめる。 */

const fixture = (name: string) => resolve(import.meta.dirname, "../fixtures", name);

describe.skipIf(!e2e)("音楽室（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { start: "@window show\n@bgm a.ogg\n@bgm b.ogg\nはじめ。\n" },
      config: { extra: { music: [{ file: "a.ogg", title: "一曲目", artist: "作曲者 A", description: "説明の文" }, { file: "b.ogg", title: "二曲目" }, { file: "c.ogg", title: "まだ" }] } },
      files: { "assets/bgm/a.ogg": fixture("loop-vorbis.ogg"), "assets/bgm/b.ogg": fixture("loop-opus.ogg"), "assets/bgm/c.ogg": fixture("loop-opus.ogg") },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("聞いた曲だけ選べ、再生の欄で操作でき、曲の終わりで次へ進む", async () => {
    for (const { name, browser } of list) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(project.url);
      await p.click(".lm-gate");
      await p.waitForSelector(".lm-title-button");
      // 一度始めて a と b を聞いてから、タイトルへ戻っておまけを開く
      await p.locator(".lm-title-button").first().click();
      await p.waitForSelector(".message .text .ch");
      await p.evaluate("window.__liminalia.system.showTitle(true)");
      await p.locator(".lm-title-button", { hasText: "おまけ" }).click();
      await p.locator(".lm-tab", { hasText: "音楽" }).click();
      const state = () =>
        p.evaluate<{ title: string; artist: string; bgm: string | null; disabled: boolean[] }>(`({ title: document.querySelector(".lm-music-title").textContent, artist: document.querySelector(".lm-music-artist").textContent, bgm: window.__liminalia.host.audio.bgm?.file ?? null, disabled: [...document.querySelectorAll(".lm-extra-track")].map((b) => b.disabled) })`);
      expect(await state(), name).toEqual({ title: "曲を選んでください", artist: "", bgm: null, disabled: [false, false, true] });
      // 鳴っている曲（読み込みを待つ。音の時計の速さは機械の負荷で大きく変わるので、時間を決めて待たない）
      const playing = (file: string) => p.waitForFunction(`window.__liminalia.host.audio.bgm?.file === ${JSON.stringify(file)}`, null, { timeout: 15_000 });
      const seekTo = (at: string) => p.evaluate(`(() => { const s = document.querySelector(".lm-music-seek"); s.value = ${JSON.stringify(at)}; s.dispatchEvent(new Event("change")); })()`);
      await p.locator(".lm-extra-track").first().click();
      await playing("a.ogg");
      expect(await state(), name).toMatchObject({ title: "一曲目", artist: "作曲者 A", bgm: "a.ogg" });
      expect(await p.evaluate(`document.querySelector(".lm-music-description").textContent`), name).toBe("説明の文");
      // シーク
      await seekTo("2");
      expect((await p.evaluate("window.__liminalia.host.audio.bgmProgress().position")) as number, name).toBeGreaterThan(1.9);
      // 曲の終わりで次の曲へ（シークバーの右端へ送ると、曲の終わりの手前から鳴らす）
      await seekTo((await p.evaluate(`document.querySelector(".lm-music-seek").max`)) as string);
      await playing("b.ogg");
      // 次の曲（聞いた曲は a と b だけなので、b の次は a）
      await p.click(".lm-music-next");
      await playing("a.ogg");
      // リピートの切り替え（全曲 → 一曲 → なし）とシャッフル
      await p.click(".lm-music-repeat");
      expect(await p.evaluate(`document.querySelector(".lm-music-repeat").textContent`), name).toBe("一曲リピート");
      await p.waitForFunction("window.__liminalia.host.audio.bgm?.source.loop === true", null, { timeout: 15_000 });
      await p.click(".lm-music-shuffle");
      expect(await p.evaluate(`document.querySelector(".lm-music-shuffle").getAttribute("aria-pressed")`), name).toBe("true");
      await p.close();
    }
  });
});
