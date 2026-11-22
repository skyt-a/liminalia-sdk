import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/** BGM のループの位置（曲に埋め込んだもの、@bgm で書いたもの）、定位、クロスフェードを、実際のブラウザで確かめる。 */

const fixture = (name: string) => resolve(import.meta.dirname, "../fixtures", name);
const SCENARIO = `@window show
@bgm a.ogg
一。
@bgm b.ogg loop-start=500ms loop-end=1500ms pan=-100 crossfade=2s
二。
`;

describe.skipIf(!e2e)("BGM のループ、定位、クロスフェード（ブラウザ）", { timeout: 180_000 }, () => {
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

  it("埋め込みのループの位置を使い、@bgm で書いた位置と定位を優先し、クロスフェードの間は前の曲を鳴らし続ける", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await p.evaluate("window.__liminalia.host.audio.unlock()");
      await p.waitForTimeout(800);
      const state = () => p.evaluate(`(() => { const a = window.__liminalia.host.audio; return { file: a.bgm?.file, loopStart: a.bgm?.source.loopStart, loopEnd: a.bgm?.source.loopEnd, panned: a.bgm ? a.bgm.input !== a.bgm.gain : null }; })()`);
      expect(await state(), name).toEqual({ file: "a.ogg", loopStart: 1, loopEnd: 2.5, panned: false });
      // 前の曲の gain を控えておき、クロスフェードの途中で音量が下がりつつ残っていることを見る
      await p.evaluate("window.__prevGain = window.__liminalia.host.audio.bgm.gain");
      await p.mouse.click(640, 360);
      await p.waitForTimeout(700);
      expect(await state(), name).toEqual({ file: "b.ogg", loopStart: 0.5, loopEnd: 1.5, panned: true });
      const prev = (await p.evaluate("window.__prevGain.gain.value")) as number;
      expect(prev, name).toBeGreaterThan(0);
      expect(prev, name).toBeLessThan(1);
      await p.close();
    }
  });
});
