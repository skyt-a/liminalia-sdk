import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { browsers, e2e, openPlayer, startProject, type TestProject } from "./harness.ts";

/** 音のフィルター（@bgm・@voice の filter、@voice-filter）と二人の同時のボイスを、実際のブラウザの Web Audio で確かめる。セーブとロードでフィルターが戻ることも。 */

const SCENARIO = `@window show
@bgm quiet_night.wav filter=muffled filter-strength=50
こもった曲。
@bgm quiet_night.wav filter=radio filter-fade=200ms
無線の曲。
@voice y1.wav
@voice m1.wav who=ミカ
ユイ「せーの」
@voice-filter phone who=ミカ
@voice m2.wav who=ミカ
ミカ「電話の声」
おわり。
@stop
`;

const SOUND = resolve(import.meta.dirname, "../../../../templates/default/assets/sound");

describe.skipIf(!e2e)("音のフィルターと同時のボイス（ブラウザ）", { timeout: 240_000 }, () => {
  let project: TestProject;
  let list: { name: string; browser: Browser }[];
  beforeAll(async () => {
    project = await startProject({
      scenario: { a: SCENARIO },
      config: { entry: "a" },
      files: { "assets/voice/y1.wav": join(SOUND, "chime.wav"), "assets/voice/m1.wav": join(SOUND, "radio.wav"), "assets/voice/m2.wav": join(SOUND, "radio.wav") },
      // 話者に ユイ と ミカ を足す
      before: (dir) => {
        const cast = JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { speakers?: string[] };
        cast.speakers = [...new Set([...(cast.speakers ?? []), "ユイ", "ミカ"])];
        writeFileSync(join(dir, "cast.json"), JSON.stringify(cast));
      },
    });
    list = await browsers();
  });
  afterAll(async () => {
    for (const b of list ?? []) await b.browser.close();
    await project?.close();
  });

  const text = (p: Page) => p.evaluate(() => document.querySelector(".message .text")?.textContent ?? "");
  const advance = async (p: Page, until: string) => {
    for (let i = 0; i < 20 && !(await text(p)).includes(until); i++) {
      await p.evaluate("window.__liminalia.host.advance()");
      await p.waitForTimeout(250);
    }
    expect(await text(p)).toContain(until);
  };
  const filterOf = (p: Page, kind: string, channel?: number) => p.evaluate(([k, c]) => (window as unknown as { __liminalia: { host: { audio: { filterOf(k: string, c?: number): unknown } } } }).__liminalia.host.audio.filterOf(k as string, c as number | undefined), [kind, channel] as const);

  it("BGM にフィルターを掛け、同じ曲に掛け直し、セーブとロードで戻る。二人のボイスは同時に鳴り、名前欄に二人の名前を出す", async () => {
    for (const { name, browser } of list) {
      const p = await openPlayer(browser, project.url, "a");
      await advance(p, "こもった曲");
      await p.waitForFunction(() => (window as unknown as { __liminalia: { host: { audio: { filterOf(k: string): unknown } } } }).__liminalia.host.audio.filterOf("bgm") !== null, undefined, { timeout: 20_000 });
      expect(await filterOf(p, "bgm"), name).toEqual({ type: "muffled", strength: 50 });
      await advance(p, "無線の曲");
      // 同じ曲は鳴らし直さず、フィルターだけ替える
      expect(await filterOf(p, "bgm"), name).toEqual({ type: "radio", strength: 100 });
      expect(await p.evaluate("window.__liminalia.runtime().state.stage.bgm.filter"), name).toEqual({ type: "radio", strength: 100 });
      // セーブしてロードすると、同じフィルターで鳴らす
      await p.evaluate("window.__liminalia.system.saveTo(1)");
      await p.evaluate("window.__liminalia.system.loadFrom(1)");
      await p.waitForFunction(() => document.querySelector(".message .text")?.textContent?.includes("無線の曲"), undefined, { timeout: 20_000 });
      await p.waitForFunction(() => (window as unknown as { __liminalia: { host: { audio: { filterOf(k: string): unknown } } } }).__liminalia.host.audio.filterOf("bgm") !== null, undefined, { timeout: 20_000 });
      expect(await filterOf(p, "bgm"), name).toEqual({ type: "radio", strength: 100 });
      // 二人のボイス
      await advance(p, "せーの");
      expect(await p.locator(".message .name").textContent(), name).toBe("ユイ、ミカ");
      await p.waitForFunction(() => (window as unknown as { __liminalia: { host: { audio: { voiceSpeakers: unknown[] } } } }).__liminalia.host.audio.voiceSpeakers.length === 2, undefined, { timeout: 20_000 });
      expect(await p.evaluate("window.__liminalia.host.audio.voiceSpeakers"), name).toEqual(["ユイ", "ミカ"]);
      // 話者ごとのフィルター（次の台詞のボイスに掛かる）
      await advance(p, "電話の声");
      await p.waitForFunction(() => (window as unknown as { __liminalia: { host: { audio: { voiceSpeakers: unknown[] } } } }).__liminalia.host.audio.voiceSpeakers.length === 1, undefined, { timeout: 20_000 });
      expect(await filterOf(p, "voice", 1), name).toEqual({ type: "phone", strength: 100 });
      expect(await p.locator(".message .name").textContent(), name).toBe("ミカ");
      await p.close();
    }
  });
});
