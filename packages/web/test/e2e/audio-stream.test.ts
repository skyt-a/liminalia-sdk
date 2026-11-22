import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/**
 * 長い BGM の流し読み（audio-stream.ts）を、実際のブラウザで確かめる。確かめのために流し読みにする大きさ（streamBytes）を小さくし、
 * 小さな見本の曲を流し読みで鳴らす。展開しない（控えが増えない）こと、埋め込みのループの位置と @bgm の位置・定位・クロスフェード、
 * 一時停止と続き、音楽室のシークバー（bgmProgress・seekBgm）が今までどおり効くこと。
 */

const fixture = (name: string) => resolve(import.meta.dirname, "../fixtures", name);
const SCENARIO = `@window show
零。
@bgm a.ogg
一。
@bgm b.ogg loop-start=500ms loop-end=1500ms pan=-100 crossfade=2s
二。
`;

const state = (p: Page) =>
  p.evaluate(`(() => {
    const a = window.__liminalia.host.audio;
    const s = a.bgm?.source;
    return { file: a.bgm?.file, streaming: a.memory().streaming, bgmBytes: a.memory().bgm, loopStart: s?.loopStart, loopEnd: s?.loopEnd, panned: a.bgm ? a.bgm.input !== a.bgm.gain : null, time: s?.el?.currentTime ?? null, paused: s?.el?.paused ?? null };
  })()`) as Promise<{ file?: string; streaming: boolean; bgmBytes: number; loopStart?: number; loopEnd?: number; panned: boolean | null; time: number | null; paused: boolean | null }>;

/** 次のページへ送り（本文を出し切っていなければ二度押す）、その BGM が鳴るまで待つ。 */
async function next(p: Page, file: string): Promise<void> {
  await p.waitForFunction("window.__liminalia.host.waiting");
  await p.mouse.click(640, 360);
  await p.waitForFunction(`window.__liminalia.host.audio.bgm?.file === ${JSON.stringify(file)}`, null, { timeout: 10_000 });
}

describe.skipIf(!e2e)("長い BGM の流し読み（ブラウザ）", { timeout: 180_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({ scenario: { a: SCENARIO }, config: { entry: "a" }, files: { "assets/bgm/a.ogg": fixture("loop-vorbis.ogg"), "assets/bgm/b.ogg": fixture("loop-opus.ogg") } });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  it("展開せずに鳴らし、埋め込みのループの区間を繰り返し、@bgm の位置・定位・クロスフェードを効かせる", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.evaluate("(() => { const a = window.__liminalia.host.audio; a.streamBytes = 1000; return a.unlock(); })()");
      await next(p, "a.ogg");
      const first = await state(p);
      // a.ogg は小さくする前の先読みで展開済み。この先は展開した音が増えないことを見る
      expect(first, name).toMatchObject({ file: "a.ogg", streaming: true, loopStart: 1, loopEnd: 2.5, panned: false, paused: false });
      // 区間（1〜2.5 秒）を回る: 3 秒より後も区間の中にいる
      await p.waitForTimeout(3200);
      const looped = await state(p);
      expect(looped.paused, name).toBe(false);
      expect(looped.time!, name).toBeGreaterThanOrEqual(0.95);
      expect(looped.time!, name).toBeLessThanOrEqual(2.6);
      // 音楽室のシークバー
      const progress = (await p.evaluate("window.__liminalia.host.audio.bgmProgress()")) as { position: number; duration: number };
      expect(progress.duration, name).toBeGreaterThan(2.5);
      // 位置の移動が終わった（seeked）直後の位置を測る。後から読むと、CI の重い WebKit では再生が進んで区間に戻っていることがある
      const sought = (await p.evaluate(`(async () => {
        const a = window.__liminalia.host.audio;
        const el = a.bgm.source.el;
        const done = new Promise((r) => { el.addEventListener("seeked", r, { once: true }); setTimeout(r, 5000); });
        a.seekBgm(0.2);
        if (el.seeking) await done;
        return el.currentTime;
      })()`)) as number;
      expect(sought, name).toBeLessThan(0.9);
      // 一時停止と続き
      await p.evaluate("window.__liminalia.host.audio.pauseBgm()");
      const paused = (await p.evaluate("window.__liminalia.host.audio.pausedBgm?.node.source.el.paused")) as boolean;
      expect(paused, name).toBe(true);
      expect(await p.evaluate("window.__liminalia.host.audio.resumeBgm()"), name).toBe(true);
      await p.waitForTimeout(100);
      expect((await state(p)).paused, name).toBe(false);
      // クロスフェード: 前の曲は消えながら残る
      await p.evaluate("window.__prev = window.__liminalia.host.audio.bgm");
      await next(p, "b.ogg");
      await p.waitForTimeout(500);
      expect(await state(p), name).toMatchObject({ file: "b.ogg", streaming: true, bgmBytes: first.bgmBytes, loopStart: 0.5, loopEnd: 1.5, panned: true });
      const prev = (await p.evaluate("window.__prev.gain.gain.value")) as number;
      expect(prev, name).toBeGreaterThan(0);
      expect(prev, name).toBeLessThan(1);
      expect(await p.evaluate("window.__prev.source.el.paused"), name).toBe(false);
      // 消し終えたら手放す
      await p.waitForTimeout(2000);
      expect(await p.evaluate("window.__prev.source.el.getAttribute('src')"), name).toBeNull();
      await p.close();
    }
  });

  it("ui.sound.streamBgm が false なら展開して鳴らす", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.evaluate("(() => { const a = window.__liminalia.host.audio; a.streamBytes = 1000; a.setStreaming(false); return a.unlock(); })()");
      await next(p, "a.ogg");
      const s = await state(p);
      expect(s.streaming, name).toBe(false);
      expect(s.bgmBytes, name).toBeGreaterThan(0);
      await p.close();
    }
  });
});
