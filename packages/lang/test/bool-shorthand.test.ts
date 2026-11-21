import { describe, expect, it } from "vitest";
import { booleanShorthandConflicts, check, CORE_COMMANDS, createRegistry, normalizeBooleanArgs, parse, parseArgs, type CommandSpec } from "../src/index.ts";

const registry = createRegistry(CORE_COMMANDS);
const spec = registry.get("chara")!;

describe("真偽値の省略形", () => {
  it("必須の位置引数は名前のまま、真偽値を名前と値に直す", () => {
    const args = normalizeBooleanArgs(spec, parseArgs("solo solo smile wait", 1).args);
    expect(args.map((a) => [a.key, a.value.kind, "value" in a.value ? a.value.value : null])).toEqual([
      [null, "string", "solo"], ["solo", "bool", true], [null, "string", "smile"], ["wait", "bool", true],
    ]);
    const quoted = normalizeBooleanArgs(spec, parseArgs('ユイ "solo"', 1).args);
    expect(quoted[1]).toMatchObject({ key: null, value: { kind: "string", value: "solo", quoted: true } });
  });

  it("構文チェックで省略形と明示形を読み、二重指定は報告する", () => {
    const diagnostics = (text: string) => check(parse(text, "start"), { registry }).filter((d) => d.severity === "error");
    expect(diagnostics("@chara ユイ solo smile wait\n")).toEqual([]);
    expect(diagnostics("@chara ユイ solo=false wait=false\n")).toEqual([]);
    expect(diagnostics("@chara ユイ solo solo=true\n").map((d) => d.code)).toContain("duplicate-param");
  });

  it("実在する差分名と衝突するときだけ明示を求める", () => {
    const castEntries = { ユイ: { appearances: { default: { variants: { solo: { image: "solo.png" }, smile: { image: "smile.png" } } } } } };
    const errors = (text: string) => check(parse(text, "start"), { registry, castEntries }).filter((d) => d.severity === "error");
    expect(errors("@chara ユイ solo").map((d) => d.code)).toContain("ambiguous-bool-shorthand");
    expect(errors("@chara ユイ solo=true")).toEqual([]);
    expect(errors('@chara ユイ "solo"')).toEqual([]);
    expect(errors("@chara ユイ solo smile")).toEqual([]);
    expect(errors("@chara ユイ wait")).toEqual([]);
    expect(errors("@chara (game.who) solo").map((d) => d.code)).toContain("ambiguous-bool-shorthand");
  });

  it("省略できる最初の位置引数に読めない真偽値の名前は、省略形として読む", () => {
    const named = (command: string, text: string) => normalizeBooleanArgs(registry.get(command)!, parseArgs(text, 1).args).map((a) => [a.key, a.value.kind]);
    const errors = (text: string) => check(parse(text, "start"), { registry }).filter((d) => d.severity === "error").map((d) => d.code);
    // color= を書けば image は書けないので、wait は画像の名前ではない
    expect(named("bg", "color=#000000 wait")).toEqual([["color", "color"], ["wait", "bool"]]);
    expect(named("bg", "wait color=#000000")).toEqual([["wait", "bool"], ["color", "color"]]);
    expect(errors("@bg color=#000000 wait\n")).toEqual([]);
    expect(errors("@bg color=#000000 time=1s wait\n")).toEqual([]);
    // on は background / sprites / none のどれかなので、wait は on の値ではない
    expect(named("dof", "who=ユイ wait")).toEqual([["who", "string"], ["wait", "bool"]]);
    expect(errors("@dof who=ユイ wait\n")).toEqual([]);
    expect(errors("@dof sprites wait\n")).toEqual([]);
    // 名前として読める位置引数は、これまでどおり位置引数として読む
    expect(named("bg", "wait")).toEqual([[null, "string"]]);
    expect(named("plane-hide", "wait")).toEqual([[null, "string"]]);
    // 引数表が継承したプロパティ（constructor など）は真偽値の引数ではない
    expect(errors("@dof constructor\n")).toContain("bad-value");
    expect(named("chara", "ユイ normal constructor")).toEqual([[null, "string"], [null, "string"], [null, "string"]]);
  });

  it("列挙値や任意文字列の位置引数と衝突するときは明示を求める", () => {
    const custom: CommandSpec = { name: "example", summary: "", positional: ["id", "mode"], params: { id: { type: { kind: "string" }, required: true, doc: "" }, mode: { type: { kind: "enum", values: ["fast", "slow"] }, doc: "" }, fast: { type: { kind: "bool" }, doc: "" } }, example: "" };
    expect(booleanShorthandConflicts(custom, parseArgs("a fast", 1).args)).toMatchObject([{ name: "fast", positional: "mode" }]);
    expect(booleanShorthandConflicts(custom, parseArgs("a fast slow", 1).args)).toEqual([]);
    expect(booleanShorthandConflicts(custom, parseArgs("a fast=true", 1).args)).toEqual([]);
  });
});
