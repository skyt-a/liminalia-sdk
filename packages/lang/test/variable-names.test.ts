import { describe, expect, it } from "vitest";
import { applyFix, checkProject, CORE_COMMANDS, createRegistry, parse, type Script } from "../src/index.ts";

const registry = createRegistry(CORE_COMMANDS);
const scripts = (files: Record<string, string>) => new Map<string, Script>(Object.entries(files).map(([name, text]) => [name, parse(text, name)]));
const variableDiagnostics = (files: Record<string, string>, o: Parameters<typeof checkProject>[1] = {}) =>
  checkProject(scripts(files), { registry, ...o }).filter((d) => d.code === "unset-variable" || d.code === "undeclared-variable");

describe("game. と system. の変数の綴り違い", () => {
  it("読むだけで値の入らない変数を、値の入る変数に綴りの近いものがあれば、置き換える直し方つきで警告する", () => {
    const d = variableDiagnostics({ a: "@set game.score = 1\n@if game.socre > 0\n点{= game.score}\n@end\n" });
    expect(d.map((x) => [x.line, x.code, x.hint])).toEqual([[2, "unset-variable", "game.score のことですか？"]]);
    expect(applyFix("@if game.socre > 0", d[0]!.fix!)).toMatchObject({ text: "@if game.score > 0" });
  });

  it("@choice のパラメータや @set の添字の式の中の変数も読む所として数える", () => {
    const a = ["@choice timeout=(game.limit)", "- あ -> #a", "@end", "# a", "あ", "@set game.limits = 10", "@set game.a[game.ide] = 1", "@set game.id = 1"].join("\n");
    expect(variableDiagnostics({ a }).map((x) => [x.line, x.code, x.hint])).toEqual([
      [1, "unset-variable", "game.limits のことですか？"],
      [7, "unset-variable", "game.id のことですか？"],
    ]);
  });

  it("値を入れる所（@set、命令の結果、variables、プラグインの宣言、データのフラグ、エンジン）を集めて判断する", () => {
    const files = {
      a: [
        "@text-input game.name",
        "@if game.nama == game.trusts",
        "@end",
        "@if system.claer && system.variant == \"demo\"",
        "@end",
        "@if game.codex_page > 0 && game.flagz",
        "@end",
      ].join("\n"),
    };
    const d = variableDiagnostics(files, { variables: { "game.trust": 0, "system.clear": false }, writtenVariables: ["game.codex.*", "game.flags"] });
    // game.nama → game.name（命令の結果）、game.trusts → game.trust（variables）、system.claer → system.clear、game.flagz → game.flags（プラグインの宣言）
    // system.variant はエンジンが入れ、game.codex_page は近い名前が無いので知らせない
    expect(d.map((x) => x.hint)).toEqual(["game.name のことですか？", "game.trust のことですか？", "system.clear のことですか？", "game.flags のことですか？"]);
  });

  it("近い名前の無い読むだけの変数は知らせない（プラグインが黙って値を入れる変数を誤って知らせない）", () => {
    expect(variableDiagnostics({ a: "@if game.from_plugin\n@end" })).toEqual([]);
  });

  it("check.variables が declared なら、variables に書いていない変数をすべて知らせる", () => {
    const d = variableDiagnostics({ a: "@set game.trust = 1\n@set game.trsut += 1\n@if system.variant == \"x\"\n@end" }, { variables: { "game.trust": 0 }, variableCheck: "declared" });
    expect(d.map((x) => [x.line, x.code, x.hint])).toEqual([[2, "undeclared-variable", "game.trust のことですか？"]]);
  });
});

describe("初期値の無い変数（uninitialized-variable）", () => {
  const uninitialized = (files: Record<string, string>, o: Parameters<typeof checkProject>[1] = {}) =>
    checkProject(scripts(files), { registry, ...o })
      .filter((d) => d.code === "uninitialized-variable")
      .map((d) => [d.file, d.line, d.hint]);
  /** 選んだときだけ += で足し、最後に比べる（足す選択肢を選ばなかったルートでは、値の無いまま比べる）。 */
  const story = ["@choice", "- 本を選ぶ -> #book", "- 地図を選ぶ -> #map", "@end", "# book", "@set game.bond += 1", "@jump #check", "# map", "@jump #check", "# check", "@if game.bond >= 1", "仲良くなった", "@end", "{= game.bond}"].join("\n");

  it("+= などでしか値を入れない変数を読む所を、初期値を書く直し方つきで知らせる", () => {
    expect(uninitialized({ a: story })).toEqual([
      ["a", 11, 'liminalia.json の variables に "game.bond": 0 と初期値を書きます'],
      ["a", 14, 'liminalia.json の variables に "game.bond": 0 と初期値を書きます'],
    ]);
    // 別のファイルで読んでも知らせる。文字を足す変数は空の文字を初期値に
    expect(uninitialized({ a: '@set game.log += "a"', b: "{= game.log}" })).toEqual([["b", 1, 'liminalia.json の variables に "game.log": "" と初期値を書きます']]);
  });

  it("初期値か、= で値を入れる所か、ほかに値を入れるものがあれば知らせない", () => {
    expect(uninitialized({ a: story }, { variables: { "game.bond": 0 } })).toEqual([]);
    expect(uninitialized({ a: `@set game.bond = 0\n${story}` })).toEqual([]);
    expect(uninitialized({ a: story }, { writtenVariables: ["game.bond"] })).toEqual([]);
    expect(uninitialized({ a: story }, { writtenVariables: ["game.*"] })).toEqual([]);
    // 足すだけで読まなければ知らせない
    expect(uninitialized({ a: "@set game.count += 1" })).toEqual([]);
  });

  it("temp. は liminalia.json に書けないので、先に = で値を入れる直し方にする。declared のときは game. と system. を undeclared-variable に任せる", () => {
    expect(uninitialized({ a: "@set temp.n += 1\n@if temp.n > 1\n@end" })).toEqual([["a", 2, "先に @set temp.n = 0 で値を入れます"]]);
    expect(uninitialized({ a: `${story}\n@set temp.n += 1\n@if temp.n > 1\n@end` }, { variableCheck: "declared" })).toEqual([["a", 16, "先に @set temp.n = 0 で値を入れます"]]);
  });
});
