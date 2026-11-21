import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import oniguruma from "vscode-oniguruma";
import textmate from "vscode-textmate";
import { beforeAll, describe, expect, it } from "vitest";

// 色分けの文法（syntaxes/lim.tmLanguage.json）を VS Code と同じ部品（vscode-textmate）で読み、行ごとのスコープを見る。

const GRAMMAR = join(dirname(fileURLToPath(import.meta.url)), "..", "syntaxes", "lim.tmLanguage.json");
let grammar: textmate.IGrammar;

beforeAll(async () => {
  const wasm = readFileSync(createRequire(import.meta.url).resolve("vscode-oniguruma/release/onig.wasm"));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (s: string[]) => new oniguruma.OnigScanner(s), createOnigString: (s: string) => new oniguruma.OnigString(s) }),
    // @script の中に埋め込む TypeScript の文法は VS Code が持っている。ここでは中身のない文法で代える
    loadGrammar: async (scope) =>
      scope === "source.liminalia"
        ? textmate.parseRawGrammar(readFileSync(GRAMMAR, "utf8"), GRAMMAR)
        : scope === "source.ts"
          ? textmate.parseRawGrammar(JSON.stringify({ scopeName: "source.ts", patterns: [{ match: "\\bconst\\b", name: "storage.type.ts" }] }), "ts.json")
          : null,
  });
  grammar = (await registry.loadGrammar("source.liminalia"))!;
});

/** 複数行を読み、[文字列, いちばん内側のスコープ] の組にする（source.liminalia だけのものは除く）。 */
function tokens(text: string): [string, string][] {
  let state = textmate.INITIAL;
  const out: [string, string][] = [];
  for (const line of text.split("\n")) {
    const r = grammar.tokenizeLine(line, state);
    for (const t of r.tokens) {
      const s = t.scopes.at(-1)!;
      if (s !== "source.liminalia") out.push([line.slice(t.startIndex, t.endIndex), s]);
    }
    state = r.ruleStack;
  }
  return out;
}

const scopeOf = (text: string, word: string) => tokens(text).find(([w]) => w === word)?.[1];

describe("色分け", () => {
  it("@for と @function、本文の出し分けの区切り", () => {
    expect(scopeOf("@for item in game.items", "for")).toBe("keyword.control.conditional.liminalia");
    expect(scopeOf("@function rank(s) = s", "function")).toBe("keyword.control.conditional.liminalia");
    expect(scopeOf("{seq 一度目|二度目}", "seq")).toBe("keyword.other.markup.liminalia");
    expect(scopeOf("{seq 一度目|二度目}", "|")).toBe("punctuation.separator.variants.liminalia");
  });

  it("行末の固定の行 ID（#line:）", () => {
    expect(scopeOf("ユイ「おはよう」 #line:a1b2c3d4", "#line:a1b2c3d4")).toBe("comment.other.line-id.liminalia");
    expect(scopeOf("窓の外。\t#line:intro-1", "#line:intro-1")).toBe("comment.other.line-id.liminalia");
    expect(scopeOf("@choice\n  - 行く -> #north #line:c_1\n@end", "#line:c_1")).toBe("comment.other.line-id.liminalia");
    expect(scopeOf("本文#line:x1", "#line:x1")).toBeUndefined();
  });

  it("ラベル・コメント", () => {
    expect(scopeOf("# north_road", "north_road")).toBe("entity.name.section.label.liminalia");
    expect(scopeOf("// ここから回想", " ここから回想")).toBe("comment.line.double-slash.liminalia");
    expect(scopeOf("#north_road", "#north_road")).toBe("invalid.illegal.label.liminalia");
  });

  it("命令と引数", () => {
    const line = '@chara ユイカ smile at=left time=300ms flip=true text="二つの 語" if=(game.trust)';
    expect(scopeOf(line, "chara")).toBe("entity.name.function.command.liminalia");
    expect(scopeOf(line, "at")).toBe("variable.parameter.liminalia");
    expect(scopeOf(line, "300")).toBe("constant.numeric.duration.liminalia");
    expect(scopeOf(line, "ms")).toBe("keyword.other.unit.liminalia");
    expect(scopeOf(line, "true")).toBe("constant.language.boolean.liminalia");
    expect(scopeOf(line, "二つの 語")).toBe("string.quoted.double.liminalia");
    expect(scopeOf(line, "game")).toBe("variable.language.scope.liminalia");
    expect(scopeOf("@mask color=#cc3333", "#cc3333")).toBe("constant.other.color.liminalia");
  });

  it("制御と飛び先", () => {
    expect(scopeOf("@if game.trust >= 2", "if")).toBe("keyword.control.conditional.liminalia");
    expect(scopeOf("@if game.trust >= 2", ">=")).toBe("keyword.operator.liminalia");
    expect(scopeOf("@jump chapter2#start", "chapter2")).toBe("entity.name.namespace.file.liminalia");
    expect(scopeOf("@jump chapter2#start", "start")).toBe("entity.name.section.label.liminalia");
    expect(scopeOf("@define title-card(text: string, time: duration = 1s)", "title-card")).toBe("entity.name.function.liminalia");
    expect(scopeOf("@define title-card(text: string, time: duration = 1s)", "duration")).toBe("support.type.liminalia");
  });

  it("台詞の話者と本文の中の書き方", () => {
    expect(scopeOf("ユイ「おはよう」", "ユイ")).toBe("entity.name.tag.speaker.liminalia");
    expect(scopeOf("　窓の外では「雨」が", "　窓の外では")).toBeUndefined();
    // 英語の台詞（話者名の後ろの " “。半角の空白を一つ挟んでもよい）
    expect(scopeOf('Yui "Hello."', "Yui")).toBe("entity.name.tag.speaker.liminalia");
    expect(scopeOf("Yui“Wait!”", "Yui")).toBe("entity.name.tag.speaker.liminalia");
    expect(scopeOf('Note: "x"', "Note:")).toBeUndefined();
    expect(scopeOf('He said "hi".', "He")).toBeUndefined();
    const line = "今夜は{r 流星群|りゅうせいぐん}が来る。{br}{= game.name}{b 太字}{@chara ユイカ smile}\\{";
    expect(scopeOf(line, "りゅうせいぐん")).toBe("string.unquoted.ruby.liminalia");
    expect(scopeOf(line, "br")).toBe("keyword.other.markup.liminalia");
    expect(scopeOf(line, "太字")).toBe("markup.bold.liminalia");
    expect(scopeOf(line, "chara")).toBe("entity.name.function.command.liminalia");
    expect(scopeOf(line, "\\{")).toBe("constant.character.escape.liminalia");
  });

  it("選択肢の行", () => {
    const text = "@choice\n- 北の道を行く -> #north_road if=(game.has_key) x=120\n- -> chapter2#south image=button/door.png\n@end\n- 地の文";
    const t = tokens(text);
    expect(t).toContainEqual(["->", "keyword.operator.arrow.liminalia"]);
    expect(t).toContainEqual(["north_road", "entity.name.section.label.liminalia"]);
    expect(t).toContainEqual(["x", "variable.parameter.liminalia"]);
    expect(t).toContainEqual(["chapter2", "entity.name.namespace.file.liminalia"]);
    expect(t).toContainEqual(["end", "keyword.control.end.liminalia"]);
    // @choice の外の - は地の文
    expect(t.filter(([, s]) => s === "punctuation.definition.list.begin.liminalia")).toHaveLength(2);
  });

  it("@script の中は TypeScript、@end で戻る", () => {
    const t = tokens("@script\nconst a = 1 // @chara\n@end\n# after");
    expect(t).toContainEqual(["script", "keyword.control.script.liminalia"]);
    expect(t).toContainEqual(["const", "storage.type.ts"]);
    expect(t.find(([w]) => w.includes("@chara"))?.[1]).toBe("meta.embedded.block.typescript");
    expect(t).toContainEqual(["after", "entity.name.section.label.liminalia"]);
  });
});
