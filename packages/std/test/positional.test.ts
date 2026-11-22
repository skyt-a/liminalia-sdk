import { describe, expect, it } from "vitest";
import { CORE_COMMANDS } from "@liminalia/lang";
import { combinePlugins } from "@liminalia/plugin-host";
import std from "../src/commands/index.ts";

/**
 * 位置引数の決まり: 同じ型の位置引数を二つ並べない（並べ違えても検査で見つからないため。二つ目からは名前付きにする）。
 * 組み込みと標準の命令すべてで確かめる。
 */
describe("位置引数", () => {
  it("同じ型の位置引数を二つ持つ命令はない", () => {
    const bad = [...CORE_COMMANDS, ...combinePlugins([std]).specs].flatMap((c) => {
      const kinds = c.positional.map((p) => c.params[p]?.type.kind);
      return new Set(kinds).size === kinds.length ? [] : [`${c.name}(${c.positional.join(", ")})`];
    });
    expect(bad).toEqual([]);
  });
});
