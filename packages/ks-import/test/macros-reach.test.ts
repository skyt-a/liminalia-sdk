import { describe, expect, it } from "vitest";
import { compile } from "../src/compile.ts";
import { findMacros, reachableMacros } from "../src/macros.ts";

describe("本文から呼ばれるマクロだけを変換する", () => {
  it("本文が呼ぶマクロと、その中で呼ぶマクロを残し、使われないものと本文の外の定義の中だけで呼ぶものは外す", () => {
    const lib = compile(
      ["[macro name=greet][inner][endmacro]", "[macro name=inner]やあ[p][endmacro]", "[macro name=unused][orphan][endmacro]", "[macro name=orphan]x[p][endmacro]"].join("\n"),
      "system/lib.ks",
    );
    const body = compile("[greet]\n本文[p]", "chapter1.ks");
    const { used, unused } = reachableMacros(findMacros(lib, "system/lib.ks"), [body]);
    expect(used.map((m) => m.name).sort()).toEqual(["greet", "inner"]);
    expect(unused.map((m) => m.name).sort()).toEqual(["orphan", "unused"]);
  });
});
