import { describe, expect, it } from "vitest";
import { applyFix, check, checkPunctuation, nearestAsset, parse, punctuationCodes, punctuationProblems, PUNCTUATION_CODES, type PunctuationConfig } from "../src/index.ts";

const all = punctuationCodes(undefined);
const codes = (text: string) => punctuationProblems(text, all).map((p) => p.code);

describe("約物の検査", () => {
  it("括弧の閉じ忘れ・開き忘れ・食い違いを見つける", () => {
    expect(codes("「こんにちは")).toEqual(["bracket-mismatch"]);
    expect(codes("こんにちは」")).toEqual(["bracket-mismatch"]);
    expect(codes("「『こんにちは」』")).toEqual(["bracket-mismatch"]);
    expect(punctuationProblems("（心の声", all)[0]?.message).toBe("（ の閉じ括弧 ） がありません");
    expect(codes("「『それは』と言った（小声で）」")).toEqual([]);
  });

  it("同じ句読点の重なりを見つける", () => {
    expect(punctuationProblems("そうだね。。", all).map((p) => [p.code, p.hint])).toEqual([["doubled-punctuation", "。。 を 。 にします"]]);
    expect(codes("そう、、だね")).toEqual(["doubled-punctuation"]);
    expect(codes("そう、だね。")).toEqual([]);
  });

  it("文の途中の！？の後に全角の空白が無いことを知らせる（閉じ括弧や続く記号、行の終わりの前は要らない）", () => {
    expect(punctuationProblems("本当？うそ", all).map((p) => [p.code, p.severity, p.hint])).toEqual([["space-after-exclamation", "info", "？う を ？　う にします"]]);
    expect(codes("本当？　うそ")).toEqual([]);
    expect(codes("「本当！？」")).toEqual([]);
    expect(codes("本当！")).toEqual([]);
    expect(codes("えっ！……")).toEqual([]);
  });

  it("「と」「って」などで受けるときは空白を求めず、一行の中の一つずつを知らせる", () => {
    expect(codes("都会！ってことしか知らない")).toEqual([]);
    expect(codes("危ない！と叫んだ")).toEqual([]);
    expect(codes("本当？なんて聞かないで")).toEqual([]);
    expect(punctuationProblems("じゃん！ もしかして", all).map((p) => [p.hint, p.fix])).toEqual([["！ の後の空白を全角にします", { kind: "replace", find: "！ も", with: "！　も" }]]);
    expect(codes("「本当！ 」")).toEqual([]);
    expect(punctuationProblems("見ました！ドラマみたい！すごい？うん", all).map((p) => p.hint)).toEqual(["！ド を ！　ド にします", "！す を ！　す にします", "？う を ？　う にします"]);
  });

  it("三点リーダーとダッシュが一つだけのものを知らせる", () => {
    expect(codes("そう…")).toEqual(["single-ellipsis"]);
    expect(codes("そう――")).toEqual([]);
    expect(codes("そう―")).toEqual(["single-ellipsis"]);
    expect(codes("そう……")).toEqual([]);
  });

  it("構文チェックで台詞・地の文・選択肢を見て、作品の設定で外せる", () => {
    const script = parse("ユイ「こんにちは\n　そうだね。。\n@choice\n- 本当？うそ -> #a\n# a\n", "a", { speakers: ["ユイ"] });
    const found = (punctuation?: PunctuationConfig) =>
      check(script, punctuation === undefined ? {} : { punctuation })
        .filter((d) => (PUNCTUATION_CODES as readonly string[]).includes(d.code))
        .map((d) => [d.line, d.code]);
    expect(found()).toEqual([
      [1, "bracket-mismatch"],
      [2, "doubled-punctuation"],
      [4, "space-after-exclamation"],
    ]);
    expect(found(false)).toEqual([]);
    expect(found({ off: ["space-after-exclamation", "bracket-mismatch"] })).toEqual([[2, "doubled-punctuation"]]);
  });

  it("原文が日本語でない作品には、日本語の組版の決まり（…を二つ重ねる、！？の後の全角の空白）をかけない", () => {
    expect([...punctuationCodes(undefined, "en")].sort()).toEqual(["bracket-mismatch", "doubled-punctuation"]);
    expect(punctuationCodes(undefined, "ja")).toEqual(all);
    const script = parse("Wait… is that you?\nYui「Hmm―」\nそうだね。。\n@choice\n- Really？Yes -> #a\n# a\n", "a", { speakers: ["Yui"] });
    const found = (sourceLanguage?: string) =>
      check(script, sourceLanguage === undefined ? {} : { sourceLanguage })
        .filter((d) => (PUNCTUATION_CODES as readonly string[]).includes(d.code))
        .map((d) => [d.line, d.code]);
    expect(found("en")).toEqual([[3, "doubled-punctuation"]]);
    // 日本語の作品（languages を書いていない作品を含む）は、「…」だけの行のような日本語の字の無い行も見る
    expect(found()).toEqual([
      [1, "single-ellipsis"],
      [2, "single-ellipsis"],
      [3, "doubled-punctuation"],
      [5, "space-after-exclamation"],
    ]);
    expect(found("ja")).toEqual(found());
  });
});

describe("修正案をそのまま当てる直し方", () => {
  it("約物の直し方を行に当てる（三点リーダーは前後の字ごと探し、同じ行の「……」を三つにしない）", () => {
    const fixOf = (text: string) => punctuationProblems(text, all).find((p) => p.fix)!.fix!;
    expect(applyFix("そうだね。。", fixOf("そうだね。。"))).toMatchObject({ text: "そうだね。" });
    expect(applyFix("……そう…だね", fixOf("……そう…だね"))).toMatchObject({ text: "……そう……だね" });
    expect(applyFix("本当？うそ", fixOf("本当？うそ"))).toMatchObject({ text: "本当？　うそ" });
    // 書いたあとに変わっていれば当てない
    expect(applyFix("そうだね。", fixOf("そうだね。。"))).toBeNull();
    expect(applyFix("@cg-unlock  a.png", { kind: "delete-line", text: "@cg-unlock a.png" })).toEqual({ remove: true });
  });

  it("綴りの近い候補と無い素材の近い候補に、置き換える直し方を付ける", () => {
    const script = parse("@bgg hill.png\n@jump #ed\n# end\n", "a", { speakers: [] });
    const d = check(script).filter((x) => x.fix);
    expect(d.map((x) => [x.code, x.fix])).toEqual([
      ["unknown-command", { kind: "replace", find: "@bgg", with: "@bg" }],
      ["unknown-label", { kind: "replace", find: "#ed", with: "#end" }],
    ]);
    expect(nearestAsset("hill_dsk.webp", ["hill_dusk.webp", "room.png"])).toBe("hill_dusk.webp");
    expect(nearestAsset("hill_dusk.png", ["hill_dusk.webp", "room.png"])).toBe("hill_dusk.webp");
    expect(nearestAsset("forest.png", ["hill_dusk.webp", "room.png"])).toBeNull();
  });
});

describe("同じ台本の検査の控え", () => {
  it("同じ台本と設定なら同じ結果を返し、返した診断を書き換えても次の結果は変わらない", () => {
    const script = parse("「閉じない括弧。\n…一つだけ。\n", "s");
    const first = checkPunctuation(script, undefined);
    expect(first.length).toBeGreaterThan(0);
    first[0]!.severity = "error";
    first.length = 0;
    const again = checkPunctuation(script, undefined);
    expect(again).toEqual(checkPunctuation(parse("「閉じない括弧。\n…一つだけ。\n", "s"), undefined));
    expect(again[0]!.severity).not.toBe("error");
    // 見る約物を変えれば数え直す
    expect(checkPunctuation(script, { off: ["single-ellipsis"] }).length).toBeLessThan(again.length);
  });
});
