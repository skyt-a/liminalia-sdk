import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { check, CORE_COMMANDS, createRegistry, parse } from "@liminalia/lang";
import { saveProblem } from "@liminalia/runtime";
import { combinePlugins } from "@liminalia/plugin-host";
import std from "@liminalia/std/commands";
import { describe, expect, it } from "vitest";
import { SCREEN_CATALOG } from "../src/system/screen-catalog.ts";
import { SAMPLE_FILE, SCREEN_SAMPLES, sampleContent, sampleScript, sampleSpeakers, screenPreviewTable, type SampleContext, type SampleState } from "../src/screen-preview/samples.ts";

/**
 * 制作画面の「ゲームの画面」の見本（src/screen-preview/samples.ts）を、標準の画面の一覧（src/system/screen-catalog.ts）と突き合わせる。
 * 一覧に画面を足して見本の開き方を書き忘れたら落ちる。作り物の中身から作る見本のシナリオが、構文チェックを通ることも確かめる。
 * 画面に出したときの中身とエラー、遊ぶ人のセーブを読まず書かないことは、ブラウザのテスト（packages/studio/test/screen-preview-e2e.test.ts）で見る。
 */

const registry = createRegistry(CORE_COMMANDS, combinePlugins([std]).specs);
const contexts = (id: string): SampleContext[] => {
  const states: SampleState[] = ["filled", ...(SCREEN_SAMPLES[id]?.states ?? [])];
  return states.flatMap((state) => (["ja", "en"] as const).map((lang) => ({ lang, state, bg: "__sample__/bg" })));
};

describe("ゲームの画面の見本", () => {
  it("一覧のどの画面にも、開き方か開けない理由がある（見本の表に一覧に無い画面も無い）", () => {
    const ids = SCREEN_CATALOG.map((e) => e.id);
    expect(Object.keys(SCREEN_SAMPLES).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const s = SCREEN_SAMPLES[id]!;
      expect(!!s.how !== !!s.why, `${id} は開き方と開けない理由のどちらか一つを書く`).toBe(true);
      if (s.how === "open") expect(s.screen, `${id} は開く画面の名前を書く`).toBeTruthy();
      if (s.why) expect(s.why.ja && s.why.en, id).toBeTruthy();
    }
  });

  it("制作画面に渡す一覧は、画面の一覧と同じ並びで、開けるかと状態を添える", () => {
    const table = screenPreviewTable();
    expect(table.map((t) => t.id)).toEqual(SCREEN_CATALOG.map((e) => e.id));
    for (const t of table) {
      expect(t.opens).toBe(!!SCREEN_SAMPLES[t.id]!.how);
      if (!t.opens) expect(t.why?.ja).toBeTruthy();
    }
  });

  it("見本のシナリオは、どの画面、状態、言語でも構文チェックを通る", () => {
    for (const e of SCREEN_CATALOG) {
      if (!SCREEN_SAMPLES[e.id]!.how) continue;
      for (const c of contexts(e.id)) {
        const { guide, traveler } = sampleSpeakers(c);
        const speakers = [guide, traveler];
        const script = parse(sampleScript(e.id, c), SAMPLE_FILE, { speakers });
        const problems = [...script.diagnostics, ...check(script, { registry, speakers, sourceLanguage: c.lang })].filter((d) => d.severity === "error");
        expect(problems.map((d) => `${d.line}: ${d.message}`), `${e.id} ${c.state} ${c.lang}`).toEqual([]);
      }
    }
  });

  it("作り物のセーブは読み込める形で、空の状態では何も置かない", () => {
    for (const id of ["saveload", "title", "menu"]) {
      for (const c of contexts(id)) {
        const { slots } = sampleContent(id, c);
        if (c.state === "empty") expect(slots, `${id} ${c.lang}`).toEqual([]);
        else expect(slots.length).toBeGreaterThan(0);
        for (const [, record] of slots) expect(saveProblem(record.save)).toBeNull();
      }
    }
    // バックログは、ボイスあり、二人の同時のボイス、選んだ選択肢を持つ
    const log = sampleContent("backlog", { lang: "ja", state: "filled", bg: "" }).log;
    expect(log.some((e) => e.voice && !e.voice.also)).toBe(true);
    expect(log.some((e) => e.voice?.also?.length && e.with?.length)).toBe(true);
    expect(log.some((e) => e.choice)).toBe(true);
    expect(sampleContent("backlog", { lang: "ja", state: "empty", bg: "" }).log).toEqual([]);
  });

  it("作り物の中身に、ひな形の作品の名前と人物を持ち込まない", () => {
    const template = resolve(import.meta.dirname, "../../../templates/default");
    const cast = JSON.parse(readFileSync(resolve(template, "cast.json"), "utf8")) as { speakers: string[] };
    const title = (JSON.parse(readFileSync(resolve(template, "liminalia.json"), "utf8")) as { title: string }).title;
    const all = SCREEN_CATALOG.flatMap((e) => contexts(e.id).map((c) => sampleScript(e.id, c) + JSON.stringify(sampleContent(e.id, c)))).join("\n");
    for (const name of [title, ...cast.speakers]) expect(all.includes(name), name).toBe(false);
  });
});
