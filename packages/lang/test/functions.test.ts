import { describe, expect, it } from "vitest";
import { checkExtra, checkProject, FUNCTION_ARITY, FUNCTION_DOCS, FUNCTION_USAGE, parse } from "../src/index.ts";

describe("式の関数の説明", () => {
  it("どの関数にも書き方と説明があり、書き方の引数の数は決まりの範囲に収まる", () => {
    for (const [name, [min, max]] of Object.entries(FUNCTION_ARITY)) {
      expect(FUNCTION_DOCS[name], name).toBeTruthy();
      const usage = FUNCTION_USAGE[name];
      expect(usage?.length, name).toBeGreaterThan(0);
      for (const u of usage!) {
        expect(u.startsWith(`${name}(`), u).toBe(true);
        const inner = u.slice(name.length + 1, -1).trim();
        const n = inner === "" ? 0 : inner.split(",").length;
        // 「a, b, …」は上限なし
        if (!inner.includes("…")) expect(n >= min && n <= max, u).toBe(true);
      }
    }
  });
});

const scripts = (files: Record<string, string>) => new Map(Object.entries(files).map(([name, src]) => [name, parse(src, name)]));

describe("進み具合の関数の検査（checkProject）", () => {
  const found = (files: Record<string, string>) => checkProject(scripts(files)).map((d) => [d.code, d.file, d.line, d.message]);

  it("visits・read のジャンプ先と、chosen の選択肢の文を確かめる", () => {
    const main = [
      "# look",
      '@if visits("#look") == 1 && read("other#end") && !chosen("北の道を行く") && lang() == "ja" && platform() == "pc" && !app() && !replaying()',
      "初めて",
      "@end",
      '@set game.x = visits("#nope") + visits("ghost") + visits("other#nope")',
      '@set game.y = read("bad target") || chosen("無い選択肢")',
      "@choice",
      "- {r 北|きた}の道を行く -> #look",
      "@end",
    ].join("\n");
    expect(found({ main, other: "# end\n終わり" })).toEqual([
      ["unknown-label", "main", 5, "ラベル #nope がこのファイルにありません"],
      ["unknown-file", "main", 5, "ファイル ghost がありません"],
      ["unknown-label", "main", 5, "ラベル #nope が other にありません"],
      ["bad-arguments", "main", 6, 'read() にはジャンプ先（#ラベル、ファイル、ファイル#ラベル）を渡します: "bad target"'],
      ["unknown-option", "main", 6, "選択肢「無い選択肢」はどのシナリオにもありません（chosen() はいつも false になります）"],
    ]);
  });
});

describe("回想に渡す変数（extra.replay の variables）", () => {
  it("game.x・temp.x → 値 の形だけを書ける", () => {
    const s = scripts({ end: "# a\n本文" });
    expect(checkExtra({ replay: [{ id: "a", target: "end#a", variables: { "game.route": "a", "temp.n": 1 } }] }, s)).toEqual([]);
    expect(checkExtra({ replay: [{ id: "a", target: "end#a", variables: { "system.x": 1, route: 2 } }] }, s).map((d) => d.message)).toEqual([
      "extra.replay a の variables の system.x は game.x か temp.x の形で書きます",
      "extra.replay a の variables の route は game.x か temp.x の形で書きます",
    ]);
    expect(checkExtra({ replay: [{ id: "a", target: "end#a", variables: [] }] }, s).map((d) => d.message)).toEqual(['extra.replay a の variables は "game.x" → 値 の形で書きます']);
  });
});
