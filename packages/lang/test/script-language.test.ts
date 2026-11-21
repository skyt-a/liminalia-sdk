import { describe, expect, it } from "vitest";
import { applyFix, check, checkProject, CORE_COMMANDS, createRegistry, formatLim, migrateCommandDefaults, migrateSource, parse, parseInline, printInline, type Diagnostic, type Statement } from "../src/index.ts";

/** 行の if=(式)、@for、@let +=、辞書、@function、本文の出し分け、前の版の命令の名前。 */

const registry = createRegistry(CORE_COMMANDS);
const errors = (src: string) => {
  const script = parse(src, "a", { speakers: ["ユイ"] });
  return [...script.diagnostics, ...check(script, { registry, speakers: ["ユイ"] })].filter((d) => d.severity === "error");
};
const codes = (src: string) => errors(src).map((d) => d.code);
const all = (src: string) => check(parse(src, "a", { speakers: ["ユイ"] }), { registry, speakers: ["ユイ"] });
const project = (files: Record<string, string>) =>
  checkProject(new Map(Object.entries(files).map(([f, t]) => [f, parse(t, f)])), { registry }).filter((d) => d.severity === "error");
const fixed = (line: string, d: Diagnostic) => {
  const r = applyFix(line, d.fix!, d.column);
  return r && !r.remove ? r.text : null;
};

describe("行の if=(式)", () => {
  it("命令と @jump、@set、@let、@return を @if で一行囲んだ形にする", () => {
    const body = parse("@bg room.jpg if=(game.night) time=1s\n@jump #a if=(game.x > 1)\n@set game.y += 1 if=(true)\n# a", "a").body;
    const guard = body[0] as Extract<Statement, { kind: "if" }>;
    expect(guard).toMatchObject({ kind: "if", guard: "game.night", line: 1 });
    expect(guard.branches[0]!.body[0]).toMatchObject({ kind: "command", name: "bg", line: 1 });
    // if= を外したあとの引数の桁は元のまま
    const bg = guard.branches[0]!.body[0] as Extract<Statement, { kind: "command" }>;
    expect(bg.args.map((a) => [a.key, a.column])).toEqual([
      [null, 5],
      ["time", 30],
    ]);
    expect((body[1] as Extract<Statement, { kind: "if" }>).branches[0]!.body[0]).toMatchObject({ kind: "jump", target: { file: null, label: "a" } });
    expect((body[2] as Extract<Statement, { kind: "if" }>).branches[0]!.body[0]).toMatchObject({ kind: "set", op: "+=" });
    expect(codes("@bg room.jpg if=(game.night)\n@let n = 1 if=(game.night)\n{= n}")).toEqual([]);
  });

  it("ブロックを開く言葉には書けず、(…) で書いていない if= は直し方を出す", () => {
    expect(codes("@choice if=(game.x)\n- a -> #a\n@end\n# a")).toContain("bad-guard");
    expect(codes("@while true if=(game.x)\n@end")).toContain("bad-guard");
    expect(codes("本文{@bg room.jpg if=(game.x)}")).toEqual(["bad-guard"]);
    const d = errors("@bg room.jpg if=game.night").find((x) => x.code === "bad-guard")!;
    expect(fixed("@bg room.jpg if=game.night", d)).toBe("@bg room.jpg if=(game.night)");
    // 条件の式の誤り、無い変数は @if と同じに見る
    expect(codes("@bg room.jpg if=(nope)")).toContain("unknown-variable");
  });

  it("式を書く行（@set、@let、@jump、@call、@return）の (…) で書いていない if= も、式の誤りにせず直し方を出す", () => {
    const cases: [string, string][] = [
      ["@set game.f = 1 if=game.f", "@set game.f = 1 if=(game.f)"],
      ["@let x = 1 if=game.f > 1", "@let x = 1 if=(game.f > 1)"],
      ["@jump #a if=game.f", "@jump #a if=(game.f)"],
      ["@call #a if=game.f", "@call #a if=(game.f)"],
      ["@return if=game.f", "@return if=(game.f)"],
    ];
    for (const [line, want] of cases) {
      const all = errors(`${line}\n{= x}\n# a\n@return`);
      expect(all.map((d) => d.code), line).toEqual(line.startsWith("@let") ? ["bad-guard"] : ["bad-guard", "unknown-variable"]);
      expect(fixed(line, all[0]!), line).toBe(want);
    }
    // "…" の中の if= と、(…) で書いたものは今のまま
    expect(codes('@set game.s = "a if=b"')).toEqual([]);
    expect(codes("@set game.f = 1 if=(game.f)")).toEqual([]);
  });

  it("lim fmt は if= を行の終わりに置く", () => {
    const r = formatLim("@bg   room.jpg   if=(game.night)   time=1s", "a", { registry });
    expect(r.ok && r.text).toBe("@bg room.jpg time=1s if=(game.night)");
    const l = formatLim("@let i = 0\n@let i+=1\n@for x  in [1]\n@end\n@function f(a)  =  a", "a", { registry });
    expect(l.ok && l.text).toBe("@let i = 0\n@let i += 1\n@for x  in [1]\n@end\n@function f(a)  =  a");
  });
});

describe("@for と @let +=", () => {
  it("@for の名前は局所変数で、@end の後ろでも最後の値のまま読める（実行器の局所変数はブロックで分かれない）", () => {
    expect(codes("@for item in game.items\n{= item}\n@end")).toEqual([]);
    expect(codes("@for item in game.items\n@end\n{= item}")).toEqual([]);
    expect(codes("@if game.a\n@for item in game.items\n@end\n{= item}\n@end")).toEqual([]);
    // 外側のブロックの後ろでは、今までどおり知らせる
    expect(codes("@if game.a\n@for item in game.items\n@end\n@end\n{= item}")).toContain("unknown-variable");
    expect(codes("@for item game.items\n@end")).toContain("bad-for");
    expect(codes("@for game in [1]\n@end")).toContain("bad-for");
    expect(codes("@for item in game.items")).toContain("unclosed-block");
    expect(codes("@for x in [1, 2]\n# inside\n@end")).toContain("label-in-if");
  });

  it("@let += は @let i = i + 1 と同じ", () => {
    const s = parse("@let i = 0\n@let i += 2", "a").body[1];
    expect(s).toMatchObject({ kind: "let", name: "i", value: { kind: "binary", op: "+", left: { kind: "name", name: "i" }, right: { kind: "literal", value: 2 } } });
  });
});

describe("辞書と @function", () => {
  it("辞書のリテラルは本文の {= …} にも書け、__proto__ のキーはエラー", () => {
    expect(codes('@set game.d = {"a": 1, b: [2]}\n{= {"a": 1}["a"]}')).toEqual([]);
    expect(codes('@set game.d = {"__proto__": 1}')).toContain("forbidden-property");
    expect(codes('@set game.d = {"a": 1, "a": 2}')).toContain("bad-expression");
  });

  it("@function は引数だけを読み、組み込みと同じ名前と引数の数の違いはエラー", () => {
    expect(codes('@function rank(s) = s >= 80 ? "A" : "B"\n{= rank(game.score)}')).toEqual([]);
    expect(codes("@let x = 1\n@function f(a) = a + x")).toContain("unknown-variable");
    expect(codes("@function f(a) = a\n{= f(1, 2)}")).toContain("bad-arguments");
    expect(codes("@function max(a) = a")).toContain("duplicate-function");
    expect(codes("@function f(a) = a\n@function f(b) = b")).toContain("duplicate-function");
    expect(codes("@if true\n@function f(a) = a\n@end")).toContain("nested-function");
    expect(codes("@function f(a a) = a")).toContain("bad-function");
  });

  it("@use したファイルの @function を呼べ、@use し忘れは直し方を出す", () => {
    expect(project({ a: "@use common\n{= double(2)}", common: "@function double(n) = n * 2" })).toEqual([]);
    const d = project({ a: "{= double(2)}", common: "@function double(n) = n * 2" });
    expect(d.map((x) => [x.code, x.hint])).toEqual([["unknown-function", "ファイルの先頭に @use common を書きます"]]);
    expect(project({ a: "@function f(n) = n", b: "@function f(n) = n" }).map((x) => x.code)).toContain("duplicate-function");
    // 宣言なので、@jump の後ろに書いても届かない行にしない
    const all = checkProject(new Map([["a", parse("@jump #b\n@function f(n) = n\n# b\n{= f(1)}", "a")]]), { registry });
    expect(all.filter((d) => d.code === "unreachable-line")).toEqual([]);
  });
});

describe("本文の出し分け", () => {
  it("| で区切って読み、元の書き方に戻せる（ルビの | と \\| はそのまま）", () => {
    const src = "{seq {r 星|ほし}が{= n}つ|a\\|b|}と{shuffle x|y}";
    const { content, errors: e } = parseInline(src);
    expect(e).toEqual([]);
    expect(content[0]).toMatchObject({ kind: "variants", mode: "seq" });
    const v = content[0] as Extract<(typeof content)[number], { kind: "variants" }>;
    expect(v.items.map((i) => printInline(i))).toEqual(["{r 星|ほし}が{= n}つ", "a|b", ""]);
    expect(printInline(content)).toBe(src);
    expect(parseInline("{seq a|b").errors.map((x) => x.code)).toEqual(["unclosed-inline"]);
  });

  it("中の式と命令も検査する", () => {
    expect(codes("{seq {= nope}|b}")).toContain("unknown-variable");
    expect(codes("{once {@nope}|b}")).toContain("unknown-command");
  });
});

describe("前の版の命令の名前", () => {
  it("@scene などは renamed-command で今の名前を修正案に出し、同じ名前のマクロがあれば知らせない", () => {
    const d = errors("@scene room.jpg fade=1s").find((x) => x.code === "renamed-command")!;
    expect(d.message).toBe("@scene は @scene-change という名前になりました");
    expect(fixed("@scene room.jpg fade=1s", d)).toBe("@scene-change room.jpg fade=1s");
    expect(codes("@hide-all")).toEqual(["renamed-command"]);
    expect(codes("@define scene(image: string)\n@bg (image)\n@end\n@scene image=room.jpg")).toEqual([]);
  });

  it("migrateSource は行の頭と本文の中の命令だけを置き換え、マクロと @script の中は変えない", () => {
    const src = ["@show ユイ smile", "ユイ「{@hide ユイ}またね」", "// @scene room.jpg", "@script", "@scene x", "@end", "@sprite-config focus=dim", "@scene-change room.jpg"].join("\r\n");
    const r = migrateSource(src);
    expect(r.text).toBe(["@chara ユイ smile", "ユイ「{@chara-hide ユイ}またね」", "// @scene room.jpg", "@script", "@scene x", "@end", "@chara-config focus=dim", "@scene-change room.jpg"].join("\r\n"));
    expect(r.changes).toEqual([
      { line: 1, from: "show", to: "chara" },
      { line: 2, from: "hide", to: "chara-hide" },
      { line: 7, from: "sprite-config", to: "chara-config" },
    ]);
    expect(migrateSource("@scene room.jpg", new Set(["scene"])).changes).toEqual([]);
    expect(migrateCommandDefaults({ scene: { fade: "1s" }, bg: {} }).defaults).toEqual({ "scene-change": { time: "1s" }, bg: {} });
  });

  it("版 4: 動きの時間の fade= を time= に移す（命令の行、本文の中、@define の中、中身を持つ命令の行）。ほかの fade は変えない", () => {
    const src = [
      "@bg room.jpg fade=1s method=crossfade",
      "@chara ユイ exit=fade fade=300ms",
      "ユイ「{@chara-hide ユイ fade=200ms}またね」",
      "@define scene(image: string, time: duration = 800ms)",
      "@mask fade=(time)",
      "@end",
      '@html note fade=300ms',
      "<p>fade=1s のまま</p>",
      "@end",
      "@effect glitch fade=500ms time=2s",
      "@scene-change b.jpg fade=1s hide-fade=300ms bgm-fade=1s",
      '@layer-text "a fade=1s" fade=600ms',
      "// @bg x.jpg fade=1s",
      "@show ユイ fade=400ms",
    ].join("\n");
    const r = migrateSource(src);
    expect(r.text.split("\n")).toEqual([
      "@bg room.jpg time=1s method=crossfade",
      "@chara ユイ exit=fade time=300ms",
      "ユイ「{@chara-hide ユイ time=200ms}またね」",
      "@define scene(image: string, time: duration = 800ms)",
      "@mask time=(time)",
      "@end",
      "@html note time=300ms",
      "<p>fade=1s のまま</p>",
      "@end",
      "@effect glitch fade=500ms time=2s",
      "@scene-change b.jpg time=1s hide-fade=300ms bgm-fade=1s",
      '@layer-text "a fade=1s" time=600ms',
      "// @bg x.jpg fade=1s",
      "@chara ユイ time=400ms",
    ]);
    expect(r.changes).toContainEqual({ line: 1, from: "bg fade=", to: "bg time=" });
    // 同じ名前のマクロの引数は変えない
    expect(migrateSource("@define bg(fade: duration = 1s)\n@wait (fade)\n@end\n@bg fade=2s", new Set(["bg"])).text).toBe("@define bg(fade: duration = 1s)\n@wait (fade)\n@end\n@bg fade=2s");
    // commandDefaults の引数の名前。今の名前も書いていれば、使われていない前の名前を外す（2026-11-19 の L11）
    expect(migrateCommandDefaults({ chara: { fade: "400ms", appearance: "a" }, effect: { fade: "1s" }, mask: { fade: "1s", time: "2s" } })).toEqual({
      defaults: { chara: { time: "400ms", appearance: "a" }, effect: { fade: "1s" }, mask: { time: "2s" } },
      changes: [{ from: "chara.fade", to: "chara.time" }],
      dropped: [{ from: "mask.fade", kept: "mask.time" }],
    });
  });

  it("版 4: 前の fade= も time として動き、renamed-param で知らせて直し方を付ける。対象を取らない命令は名前なしの時間を読む", () => {
    const d = all("@bg room.jpg fade=1s").find((x) => x.code === "renamed-param")!;
    expect(d).toMatchObject({ severity: "warning", message: "@bg の fade= は time= という名前になりました" });
    expect(fixed("@bg room.jpg fade=1s hide-window=true", d)).toBe("@bg room.jpg time=1s hide-window=true");
    expect(codes("@bg room.jpg fade=1s time=2s")).toContain("duplicate-param");
    // 同じ名前のマクロの fade は知らせない
    expect(all("@define mask(fade: duration = 1s)\n@wait (fade)\n@end\n@mask fade=2s").map((x) => x.code)).not.toContain("renamed-param");
    expect(codes("@mask 600ms\n@mask-off 600ms\n@chara-hide-all 300ms wait\n@stop-bgm 1s\n@stop-se 1s")).toEqual([]);
    expect(codes("@mask 600ms time=1s")).toContain("duplicate-param");
    expect(codes("@mask 600ms 1s")).toContain("too-many-positional");
  });
});
