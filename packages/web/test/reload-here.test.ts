import { describe, expect, it } from "vitest";
import { parse } from "@liminalia/lang";
import { buildProgram } from "@liminalia/runtime";
import { relocatedLine } from "../src/system/reload-here.ts";

/** テストプレイの「この場所から読み直す」で、直したあとの台本の今のページの行を求める（system/reload-here.ts）。 */

const program = (text: string, speakers = ["アカリ"]) => buildProgram(parse(text, "a", { speakers }));

describe("この場所から読み直すときの今のページの行", () => {
  const before = ["@window show", "一ページ目。", "アカリ「二ページ目。」", "三ページ目。", "四ページ目。"].join("\n");

  it("今のページの文がそのままなら、行がずれてもその行", () => {
    const after = ["@window show", "// 足した", "// 足した", "一ページ目。", "アカリ「二ページ目。」", "三ページ目。", "四ページ目。"].join("\n");
    expect(relocatedLine(program(before), program(after), 3)).toBe(5);
  });

  it("今のページの文を直し、上に行を足したら、前の変わっていないページから数える", () => {
    const after = ["@window show", "// 足した", "一ページ目。", "@bg x.png", "アカリ「二ページ目を直した。」", "三ページ目。", "四ページ目。"].join("\n");
    expect(relocatedLine(program(before), program(after), 3)).toBe(5);
  });

  it("今のページの前にページを挿入して今のページも直したら、直したページから続ける", () => {
    const before = ["@window show", "一ページ目。", "アカリ「今のページ。」", "三ページ目。", "四ページ目。"].join("\n");
    const after = ["@window show", "一ページ目。", "挿入したページ。", "アカリ「今のページを直した。」", "三ページ目。", "四ページ目。"].join("\n");
    expect(relocatedLine(program(before), program(after), 3)).toBe(4);
  });

  it("今のページの後ろにページを挿入して今のページも直したら、直したページから続ける", () => {
    const before = ["@window show", "一ページ目。", "二ページ目。", "アカリ「今のページ。」", "五ページ目。", "六ページ目。"].join("\n");
    const after = ["@window show", "一ページ目。", "二ページ目。", "アカリ「今のページを直した。」", "アカリ「挿入したページ。」", "五ページ目。", "六ページ目。"].join("\n");
    expect(relocatedLine(program(before), program(after), 4)).toBe(4);
  });

  it("前後の変わっていないページの外にある、より似た文を選ばない", () => {
    const before = ["@window show", "一ページ目。", "アカリ「今のページです。」", "三ページ目。", "四ページ目。", "五ページ目。"].join("\n");
    const after = [
      "@window show",
      "一ページ目。",
      "挿入したページ。",
      "アカリ「今のページです。少し直しました。」",
      "三ページ目。",
      "四ページ目。",
      "アカリ「今のページです。」",
    ].join("\n");
    expect(relocatedLine(program(before), program(after), 3)).toBe(4);
  });

  it("文の類似度が区間内で同点なら、前の変わっていないページからの数え方に戻る", () => {
    const before = ["@window show", "一ページ目。", "アカリ「今のページ。」", "三ページ目。", "四ページ目。"].join("\n");
    const after = [
      "@window show",
      "一ページ目。",
      "アカリ「同じ新しい文。」",
      "アカリ「同じ新しい文。」",
      "三ページ目。",
      "四ページ目。",
    ].join("\n");
    expect(relocatedLine(program(before), program(after), 3)).toBe(3);
  });

  it("長い共通の話者名は本文の類似度に含めず、同じ話者でも本文が違えば前の目印に戻る", () => {
    const speaker = "とても長くてみんなが知っている共通の話者名";
    const speakers = ["アカリ", speaker];
    const before = ["@window show", "一ページ目。", `${speaker}「古い本文です。」`, "三ページ目。", "四ページ目。"].join("\n");
    const after = [
      "@window show",
      "一ページ目。",
      "挿入したページ。",
      `${speaker}「まったく異なる本文です。」`,
      "三ページ目。",
      "四ページ目。",
    ].join("\n");
    expect(relocatedLine(program(before, speakers), program(after, speakers), 3)).toBe(3);
  });

  it("最後のページの前にページを挿入して最後のページも直したら、直したページから続ける", () => {
    const before = ["@window show", "一ページ目。", "二ページ目。", "アカリ「最後のページ。」"].join("\n");
    const after = ["@window show", "一ページ目。", "二ページ目。", "挿入したページ。", "アカリ「最後のページを直した。」"].join("\n");
    expect(relocatedLine(program(before), program(after), 4)).toBe(5);
  });

  it("今のページを大きく書き換えて原文から照合できなければ、前の変わっていないページから数える", () => {
    const before = ["@window show", "一ページ目。", "アカリ「今のページ。」", "三ページ目。"].join("\n");
    const after = ["@window show", "一ページ目。", "挿入したページ。", "アカリ「まったく違う内容に書き換えた。」", "三ページ目。"].join("\n");
    expect(relocatedLine(program(before), program(after), 3)).toBe(3);
  });

  it("原文が似ておらず前のページも変わっていれば、後ろの変わっていないページから数える", () => {
    const before = ["最初のページ。", "二ページ目。", "三ページ目。", "四ページ目。"].join("\n");
    const after = ["別の話へ移る。", "二ページ目。", "三ページ目。", "四ページ目。"].join("\n");
    expect(relocatedLine(program(before), program(after), 1)).toBe(1);
  });

  it("前のページも直していれば、後ろの変わっていないページから数える", () => {
    const after = ["一ページ目を直した。", "アカリ「二ページ目も直した。」", "三ページ目。", "四ページ目。"].join("\n");
    expect(relocatedLine(program(before), program(after), 3)).toBe(2);
  });

  it("手がかりが無い・数えた先にページが無い・今のページが本文でなければ null（ロードと同じ探し方に任せる）", () => {
    expect(relocatedLine(program(before), program("まったく別の文。"), 3)).toBeNull();
    expect(relocatedLine(program(before), program(["一ページ目。"].join("\n")), 3)).toBeNull();
    expect(relocatedLine(program(before), program(before), 1)).toBeNull();
  });

  it("同じ文のページがいくつあっても（ページの鍵は何度目かで分かれる）、前のページから数える", () => {
    const twice = ["はい。", "アカリ「二ページ目。」", "はい。"].join("\n");
    const after = ["はい。", "// 足した", "アカリ「直した。」", "はい。"].join("\n");
    expect(relocatedLine(program(twice), program(after), 2)).toBe(3);
  });
});
