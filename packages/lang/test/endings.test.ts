import { describe, expect, it } from "vitest";
import {
  check,
  checkEndings,
  collectTranslatable,
  CORE_COMMANDS,
  createRegistry,
  ENDING_KINDS,
  endingKindOfText,
  endingKinds,
  endingLabel,
  endingMatches,
  endingRef,
  migrateEndingSource,
  migrateEndingValue,
  parse,
  queryKind,
  type Script,
} from "../src/index.ts";

const registry = createRegistry(CORE_COMMANDS);
const scripts = (text: string): Map<string, Script> => new Map([["a", parse(text, "a")]]);

describe("エンディングの種類を文言から読む（前の書き方）", () => {
  it("種類の文言とその表記ゆれ（大文字と小文字、ENDING、全角、カタカナ）は、名前の無い種類", () => {
    for (const [text, kind] of [
      ["BAD END", "bad"],
      ["Bad End", "bad"],
      ["bad ending", "bad"],
      ["BAD-END", "bad"],
      ["ＢＡＤ　ＥＮＤ", "bad"],
      ["バッドエンド", "bad"],
      ["バッド・エンディング", "bad"],
      ["GOOD END", "good"],
      ["TRUE END", "true"],
      ["Normal End", "normal"],
      ["ノーマルエンド", "normal"],
    ] as const)
      expect(endingKindOfText(text), text).toEqual({ kind, title: "" });
  });

  it("頭が種類の文言は、続きを名前にする（区切りと囲みの括弧は外す）", () => {
    expect(endingKindOfText("BAD END 2：沈黙")).toEqual({ kind: "bad", title: "2：沈黙" });
    expect(endingKindOfText("BAD END：沈黙")).toEqual({ kind: "bad", title: "沈黙" });
    expect(endingKindOfText("バッドエンド「沈黙」")).toEqual({ kind: "bad", title: "沈黙" });
    expect(endingKindOfText("True Ending ～約束～")).toEqual({ kind: "true", title: "～約束～" });
  });

  it("種類の分からない文言と、文の頭の一語（Bad timing）は種類にしない", () => {
    expect(endingKindOfText("通り雨")).toBeNull();
    expect(endingKindOfText("Bad timing")).toBeNull();
    expect(endingKindOfText("BADEND少女")).toBeNull();
    expect(endingKindOfText("BAD")).toBeNull();
  });

  it("作品の endingKinds の文言も読む", () => {
    const kinds = endingKinds({ secret: "SECRET END" });
    expect(endingKindOfText("Secret End", kinds)).toEqual({ kind: "secret", title: "" });
    expect(endingKindOfText("SECRET END 雨", kinds)).toEqual({ kind: "secret", title: "雨" });
  });
});

describe("エンディングを引く", () => {
  it("ending= と title= から、種類と名前にする（前の書き方は legacy に文言を残す）", () => {
    expect(endingRef("bad", "沈黙")).toEqual({ kind: "bad", title: "沈黙" });
    expect(endingRef(true, undefined)).toEqual({ kind: "true" });
    expect(endingRef("BAD END", undefined)).toEqual({ kind: "bad", legacy: "BAD END" });
    expect(endingRef("通り雨", undefined)).toEqual({ kind: "other", title: "通り雨", legacy: "通り雨" });
    expect(endingRef(undefined, "名前だけ")).toEqual({ kind: "other", title: "名前だけ" });
    expect(endingRef(undefined, undefined)).toBeNull();
    expect(endingRef("", "")).toBeNull();
  });

  it("種類の名前と種類の文言は種類で、ほかの文字は名前に含むかで引く（訳ではなく原文）", () => {
    const bad = endingRef("bad", "沈黙の朝")!;
    expect(["bad", "BAD", "BAD END", "バッド", "沈黙", "朝"].map((q) => endingMatches(bad, q))).toEqual([true, true, true, true, true, true]);
    expect(["good", "true", "TRUE END", "Silence", ""].map((q) => endingMatches(bad, q))).toEqual([false, false, false, false, false]);
    // 前の書き方の文言も、読んだ種類と書いた文言で引く
    const old = endingRef("BAD END 2：沈黙", undefined)!;
    expect(endingMatches(old, "bad")).toBe(true);
    expect(endingMatches(old, "沈黙")).toBe(true);
    expect(queryKind("Bad End")).toBe("bad");
    expect(queryKind("通り雨")).toBeUndefined();
  });

  it("道具に出す名前は種類と「名前」", () => {
    expect(endingLabel({ kind: "bad", title: "沈黙" })).toBe("bad「沈黙」");
    expect(endingLabel({ kind: "good" })).toBe("good");
  });

  it("@title-screen の ending= の候補は、組み込みの種類と同じ", () => {
    const type = registry.get("title-screen")!.params.ending!.type;
    expect(type.kind === "string" ? type.suggest : null).toEqual(ENDING_KINDS);
  });
});

describe("lim migrate の移し方", () => {
  it("種類ならそのまま（null）、種類の文言は種類だけ、分からないものは other と title", () => {
    expect(migrateEndingValue("bad")).toBeNull();
    expect(migrateEndingValue("BAD END")).toEqual({ kind: "bad", whole: true });
    expect(migrateEndingValue("通り雨")).toEqual({ kind: "other", title: "通り雨", whole: false });
    expect(migrateEndingValue("BAD END 2：沈黙")).toEqual({ kind: "bad", title: "2：沈黙", whole: false });
  });

  it("台本の行を書き換える（title= は ending= のすぐ後ろ。ほかのパラメータ、字下げ、改行の形はそのまま）", () => {
    const source = ['@if game.x', '  @title-screen ending="BAD END" card=false', "@end", '@title-screen text="完" ending="通り雨"', '@title-screen ending="Bad End" title="沈黙"', '@title-screen ending="say \\"hi\\""', "@title-screen ending=good", ""].join("\r\n");
    const r = migrateEndingSource(source, parse(source, "a"), registry);
    expect(r.text.split("\r\n")).toEqual(["@if game.x", "  @title-screen ending=bad card=false", "@end", '@title-screen text="完" ending=other title="通り雨"', '@title-screen ending=bad title="沈黙"', '@title-screen ending=other title="say \\"hi\\""', "@title-screen ending=good", ""]);
    expect(r.changes.map((c) => [c.line, c.kind, c.title ?? null, c.phrase ?? null])).toEqual([
      [2, "bad", null, "BAD END"],
      [4, "other", "通り雨", null],
      [5, "bad", null, "Bad End"],
      [6, "other", 'say "hi"', null],
    ]);
    // 移したものは読み直しても同じ種類と名前
    expect(migrateEndingSource(r.text, parse(r.text, "a"), registry).changes).toEqual([]);
  });

  it("訳す文: 種類は訳さず、title= と移していない文言は訳す", () => {
    const keys = (text: string) => collectTranslatable(parse(text, "a"), registry).map((t) => t.source);
    expect(keys('@title-screen ending=bad title="沈黙"\n')).toEqual(["沈黙"]);
    expect(keys('@title-screen ending="BAD END"\n')).toEqual(["BAD END"]);
    expect(keys("@title-screen ending=other\n")).toEqual([]);
  });
});

describe("エンディングの検査", () => {
  it("ending=true は真偽でなく種類として通す", () => {
    expect(check(parse("@title-screen ending=true\n", "a"), { registry })).toEqual([]);
  });

  it("書式の版 2 までは前の書き方の警告（直し方つき）、3 からは種類でない値をエラーにする", () => {
    const text = '@title-screen ending="BAD END"\n@title-screen ending=happy\n@title-screen ending=bda\n@title-screen ending=bad title="沈黙"\n';
    const old = checkEndings({ scripts: scripts(text), registry, format: 2 });
    expect(old.map((d) => [d.code, d.severity, d.line])).toEqual([
      ["legacy-ending", "warning", 1],
      ["legacy-ending", "warning", 2],
      ["legacy-ending", "warning", 3],
    ]);
    expect(old[0]!.fix).toEqual({ kind: "replace", find: 'ending="BAD END"', with: "ending=bad" });
    const now = checkEndings({ scripts: scripts(text), registry, format: 3 });
    expect(now.map((d) => [d.code, d.severity, d.line])).toEqual([
      ["unknown-ending-kind", "error", 1],
      ["unknown-ending-kind", "error", 2],
      ["unknown-ending-kind", "error", 3],
    ]);
    expect(now[2]!.fix).toEqual({ kind: "replace", find: "ending=bda", with: "ending=bad" });
    // 作品が足した種類は通る
    expect(checkEndings({ scripts: scripts("@title-screen ending=happy\n"), registry, format: 3, endingKinds: { happy: "HAPPY END" } })).toEqual([]);
  });

  it("endingKinds の形、避ける指定、実績の endings、式の endings() の種類を確かめる", () => {
    const text = '@title-screen ending=bad title="沈黙"\n@if endings("good") > 0 && endings("gud") > 0\n@end\n';
    const found = checkEndings({
      scripts: scripts(text),
      registry,
      format: 3,
      endingKinds: { Secret: "X", ok: 1 },
      playtest: { avoidEndings: ["bad", "BAD END", "沈黙", "通り雨"] },
      extra: { achievements: [{ id: "a", title: "A", endings: "bad", goal: 2 }, { id: "b", title: "B", endings: "nope" }] },
    });
    expect(found.map((d) => d.message)).toEqual([
      "endingKinds の Secret は種類の名前に使えません（英小文字で始め、英小文字、数字、-、_ で書きます）",
      "endingKinds の ok は文言の文字列で書きます",
      "playtest.avoidEndings の 通り雨 に当たるエンディングがありません",
      'extra.achievements b の endings は種類の名前か "*" で書きます',
      "extra.achievements b に endings を書くときは goal（見る数）も書きます",
      "endings() のエンディングの種類 gud はありません",
    ]);
  });
});
