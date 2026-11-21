import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import oniguruma from "vscode-oniguruma";
import textmate from "vscode-textmate";
import { beforeAll, describe, expect, it } from "vitest";

// 台本のテスト（.limtest）の色分けの文法を、VS Code と同じ部品（vscode-textmate）で読み、行ごとのスコープを見る。

const GRAMMAR = join(dirname(fileURLToPath(import.meta.url)), "..", "syntaxes", "limtest.tmLanguage.json");
let grammar: textmate.IGrammar;

beforeAll(async () => {
  const wasm = readFileSync(createRequire(import.meta.url).resolve("vscode-oniguruma/release/onig.wasm"));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (s: string[]) => new oniguruma.OnigScanner(s), createOnigString: (s: string) => new oniguruma.OnigString(s) }),
    loadGrammar: async (scope) => (scope === "source.liminalia-test" ? textmate.parseRawGrammar(readFileSync(GRAMMAR, "utf8"), GRAMMAR) : null),
  });
  grammar = (await registry.loadGrammar("source.liminalia-test"))!;
});

/** 一行を読み、[文字列, いちばん内側のスコープ] の組にする（空白と、source だけのものは除く）。 */
function scopes(line: string): [string, string][] {
  const r = grammar.tokenizeLine(line, textmate.INITIAL);
  return r.tokens.map((t) => [line.slice(t.startIndex, t.endIndex), t.scopes.at(-1)!] as [string, string]).filter(([text, scope]) => text.trim() !== "" && scope !== "source.liminalia-test");
}

describe(".limtest の色分け", () => {
  it("見出し、コメント、命令、expect の種類、文字と変数と数", () => {
    expect(scopes("# 北の道")).toEqual([
      ["#", "punctuation.definition.heading.liminalia-test"],
      ["北の道", "entity.name.section.liminalia-test"],
    ]);
    expect(scopes("// メモ")).toEqual([["// メモ", "comment.line.double-slash.liminalia-test"]]);
    expect(scopes("choose 2")).toEqual([
      ["choose", "keyword.control.liminalia-test"],
      ["2", "constant.numeric.liminalia-test"],
    ]);
    expect(scopes('expect not text "星"')).toEqual([
      ["expect", "keyword.control.liminalia-test"],
      ["not", "keyword.operator.logical.liminalia-test"],
      ["text", "support.function.liminalia-test"],
      ['"星"', "string.quoted.double.liminalia-test"],
    ]);
    expect(scopes("expect game.trust >= 2").map(([, s]) => s)).toEqual(["keyword.control.liminalia-test", "variable.other.liminalia-test", "constant.numeric.liminalia-test"]);
  });
});
