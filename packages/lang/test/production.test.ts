import { describe, expect, it } from "vitest";
import { applyTranslationTable, parse, parseCsv, toCsv, translationCount, translationToCsv, translationToXliff, voiceLines, voiceRowKey, voiceScript, type TranslationFile } from "../src/index.ts";

/** 制作の道具: 収録用の台本と、訳の受け渡し（表・XLIFF）。 */

describe("収録用の台本", () => {
  it("ボイスのファイル（@voice か番号の固定）・ルビ・演技のメモ・前の行・場面", () => {
    const text = `@voice-auto ユイ pattern=yui_{n:3}.ogg
地の文。
//! 小声で
// ただのコメントは演技のメモに入れない
//! 少し笑って
ユイ「{r 星|ほし}が見える」
# night
@voice ext/yui_special.ogg
ユイ「特別」
ミナ「こんばんは」
`;
    const script = parse(text, "a", { speakers: ["ユイ", "ミナ"] });
    const keys = new Map(voiceLines(script).map((l) => [`a:${l.line}`, l.key]));
    const firstKey = keys.get("a:6")!;
    const rows = voiceScript({
      scripts: new Map([["a", { script, text }]]),
      lock: { lines: { [firstKey]: { speaker: "ユイ", n: 7, source: "" } } },
      patterns: new Map([["ユイ", "yui_{n:3}.ogg"]]),
      keyAt: (file, line) => keys.get(`${file}:${line}`),
    });
    expect(rows.map((r) => [r.voice, r.speaker, r.text, r.note, r.previous, r.scene])).toEqual([
      ["yui_007.ogg", "ユイ", "「星《ほし》が見える」", "小声で 少し笑って", "地の文。", "a"],
      ["ext/yui_special.ogg", "ユイ", "「特別」", "", "ユイ「星《ほし》が見える」", "a#night"],
      ["", "ミナ", "「こんばんは」", "", "ユイ「特別」", "a#night"],
    ]);
    // 前の動き（liminalia.json の voiceScript.notes が "comments"）は、すぐ上のすべての // の行
    const all = voiceScript({ scripts: new Map([["a", { script, text }]]), lock: null, patterns: new Map(), keyAt: (file, line) => keys.get(`${file}:${line}`), notes: "comments" });
    expect(all[0]!.note).toBe("! 小声で ただのコメントは演技のメモに入れない ! 少し笑って");
  });

  it("同じ台詞で同時に鳴らす二つ目の @voice（who=、channel=）も行にし、鍵で見分ける", () => {
    const text = `@voice yui/010.ogg
//! せーので合わせる
@voice mika/010.ogg who=ミカ
ユイ「せーの」
@voice yui/011.ogg
@voice yui/011b.ogg channel=2
ユイ「重ねて」
@voice yui/012.ogg
@voice yui/013.ogg
ユイ「置き換え」
`;
    const script = parse(text, "a", { speakers: ["ユイ", "ミカ"] });
    const rows = voiceScript({ scripts: new Map([["a", { script, text }]]), lock: null, patterns: new Map(), keyAt: () => undefined });
    expect(rows.map((r) => [r.voice, r.speaker, r.line, r.voiceLine, r.note, r.also ?? false, r.speakerOfLine ?? ""])).toEqual([
      ["yui/010.ogg", "ユイ", 4, 1, "せーので合わせる", false, ""],
      ["mika/010.ogg", "ミカ", 4, 3, "せーので合わせる", true, "ユイ"],
      ["yui/011.ogg", "ユイ", 7, 5, "", false, ""],
      ["yui/011b.ogg", "ユイ", 7, 6, "", true, ""],
      // 同じ話者、同じチャンネルの二つ目は前のものを置き換える（実行器と同じ）
      ["yui/013.ogg", "ユイ", 10, 9, "", false, ""],
    ]);
    expect(new Set(rows.map(voiceRowKey)).size).toBe(rows.length);
    expect(voiceRowKey(rows[1]!)).toBe("a:4@3");
  });

  it("CSV は , \" 改行を囲み、読み戻せる", () => {
    const table = [["a", 'b"c', "d,e"], ["改\n行", "", "x"]];
    expect(parseCsv(`﻿${toCsv(table)}`)).toEqual(table);
  });

  it.each(["\n", "\r\n", "\r"])("CSV の閉じていない引用符は開始行を知らせる（%j）", (newline) => {
    expect(() => parseCsv(`key,text${newline}a,"first${newline}second"${newline}b,"unfinished${newline}rest`)).toThrow("CSV の 4 行目で始まる引用符が閉じられていません");
    expect(() => parseCsv('"')).toThrow("CSV の 1 行目で始まる引用符が閉じられていません");
    expect(parseCsv("")).toEqual([]);
  });
});

describe("訳の受け渡し", () => {
  const file: TranslationFile = {
    language: "en",
    speakers: { ユイ: "" },
    lines: {
      k1: { source: "ユイ「こんにちは」", text: "", speaker: "ユイ" },
      k2: { source: "はい", text: "Yes", speaker: "choice" },
      k3: { source: "古い原文", text: "" },
    },
  };

  it("表に書き出し、訳を書き込んで読み戻す（原文が変わった行は書かない）", () => {
    const rows = parseCsv(translationToCsv(file));
    expect(rows[0]).toEqual(["key", "kind", "speaker", "source", "translation", "previous_source", "previous_translation", "context"]);
    expect(rows.slice(1).map((r) => [r[0], r[1]])).toEqual([["speaker:ユイ", "speaker"], ["k1", "line"], ["k2", "choice"], ["k3", "line"]]);
    const edited = rows.map((r) => (r[0] === "k1" ? [...r.slice(0, 4), "Yui: Hello", ...r.slice(5)] : r[0] === "speaker:ユイ" ? [...r.slice(0, 4), "Yui", ...r.slice(5)] : r[0] === "k3" ? [r[0]!, r[1]!, r[2]!, "書き換えた原文", "Changed"] : r));
    const back = applyTranslationTable(file, toCsv(edited));
    expect([back.applied, back.changedSource]).toEqual([2, 1]);
    expect(back.file.lines!.k1!.text).toBe("Yui: Hello");
    expect(back.file.speakers!.ユイ).toBe("Yui");
    expect(back.file.lines!.k3!.text).toBe("");
  });

  it("XLIFF に書き出して読み戻す。文字数を数える", () => {
    const xliff = translationToXliff(file, "ja");
    expect(xliff).toContain('<trans-unit id="k1" xml:space="preserve">');
    const back = applyTranslationTable(file, xliff.replace("<target state=\"needs-translation\"></target>", "<target>Hi &amp; hello</target>"));
    expect(back.file.speakers!.ユイ).toBe("Hi & hello");
    expect(translationCount(file)).toEqual({ lines: 4, chars: 2 + 9 + 2 + 4, untranslatedLines: 3, untranslatedChars: 2 + 9 + 4 });
  });

  it("XLIFF の診断は先頭行と複数行の項目の後でも 1 始まりの行番号を返す", () => {
    const unit = (key: string, source: string, target: string) => `<trans-unit id="${key}"><source>${source}</source><target>${target}</target></trans-unit>`;
    const bad = '<g id="99">bad</g>';
    const text = `<xliff>${unit("k1", "ユイ「こんにちは」", bad)}\n${unit("k2", "はい", "Yes\nindeed")}\n\n${unit("k3", "古い原文", bad)}${unit("k1", "ユイ「こんにちは」", bad)}</xliff>`;
    const back = applyTranslationTable(file, text);
    expect(back.rejected.map(({ key, at }) => ({ key, at }))).toEqual([
      { key: "k1", at: { line: 5 } },
      { key: "k3", at: { line: 5 } },
    ]);
    expect(applyTranslationTable(file, `<xliff>${unit("k1", "ユイ「こんにちは」", bad)}</xliff>`).rejected[0]?.at).toEqual({ line: 1 });
    expect(applyTranslationTable(file, "<xliff></xliff>").rejected).toEqual([]);
  });
});
