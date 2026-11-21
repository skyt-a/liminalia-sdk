import { describe, expect, it } from "vitest";
import { applyFix, check, CORE_COMMANDS, createRegistry, parse } from "../src/index.ts";

/** 直し方を当てる所（fix.ts の applyFix）。診断の桁が指す所にだけ当て、同じ行のほかの同じ字面には当てない（2026-11-19 の L1）。 */

const registry = createRegistry(CORE_COMMANDS);
/** 一行を検査して、code の診断の直し方を桁の順にすべて当てた行（一つずつ別に当てる）。 */
const fixedEach = (line: string, code: string): string[] =>
  check(parse(line, "a", { speakers: ["アカリ"] }), { registry })
    .filter((d) => d.code === code && d.fix)
    .sort((a, b) => (a.column ?? 0) - (b.column ?? 0))
    .map((d) => {
      const r = applyFix(line, d.fix!, d.column);
      return r && !r.remove ? r.text : "";
    });

describe("applyFix", () => {
  it("頭に空白のある find（\" 1s\"）も、桁の指す引数に当てる。後ろの命令の同じ字面には当てない", () => {
    expect(fixedEach("地の文{@chara-hide アカリ 1s}と{@chara-hide アカリ 1s}です。", "too-many-positional")).toEqual([
      "地の文{@chara-hide アカリ}と{@chara-hide アカリ 1s}です。",
      "地の文{@chara-hide アカリ 1s}と{@chara-hide アカリ}です。",
    ]);
  });

  it("前の名前（fade=）は名前だけを置き換え、値の字面は書いたまま（式の中の空白も）", () => {
    expect(fixedEach("地の文{@chara-hide アカリ fade=( 1000 )}と{@chara-hide アカリ fade=( 1000 )}", "renamed-param")).toEqual([
      "地の文{@chara-hide アカリ time=( 1000 )}と{@chara-hide アカリ fade=( 1000 )}",
      "地の文{@chara-hide アカリ fade=( 1000 )}と{@chara-hide アカリ time=( 1000 )}",
    ]);
  });

  it("台詞と半角の字下げの行の中の {@…} も、行の桁で指す", () => {
    expect(fixedEach("アカリ「声{@chara-hide アカリ fade=1s}と{@chara-hide アカリ fade=1s}」", "renamed-param")[1]).toBe("アカリ「声{@chara-hide アカリ fade=1s}と{@chara-hide アカリ time=1s}」");
    expect(fixedEach("    地の文{@bgg x}と{@bgg x}", "unknown-command")).toEqual(["    地の文{@bg x}と{@bgg x}", "    地の文{@bgg x}と{@bg x}"]);
  });

  it("名前なしの時間と前の名前の値の誤り（bad-value）は、書いた字面に当て、文も書いた名前で言う（L7）", () => {
    expect(fixedEach("@chara-hide-all 300", "bad-value")).toEqual(["@chara-hide-all 300ms"]);
    expect(fixedEach("@chara-hide アカリ fade=300", "bad-value")).toEqual(["@chara-hide アカリ fade=300ms"]);
    const [d] = check(parse("@chara-hide アカリ fade=300", "a"), { registry }).filter((x) => x.code === "bad-value");
    expect(d!.message).toMatch(/^fade: /);
  });

  it("桁の指す所に find が無ければ、行のほかの所へは当てない（書いたあとに変わった行）", () => {
    const fix = { kind: "replace" as const, find: "fade=", with: "time=" };
    expect(applyFix("{@flash fade=1s}と{@bg x time=1s}", fix, 25)).toBeNull();
    // 桁の無い直し方は行の最初のもの
    expect(applyFix("{@flash fade=1s}と{@bg x fade=1s}", fix)).toMatchObject({ at: 8 });
  });
});
