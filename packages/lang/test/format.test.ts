import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CORE_COMMANDS, createRegistry, formatExpr, formatLim, parse } from "../src/index.ts";

const registry = createRegistry(CORE_COMMANDS);
const speakers = ["ユイ", "ソウ", "あかり"];

type Arg = { key: string | null };
/** 構文木から位置と引用符の有無と式の字面を除き、名前付きの引数を名前の順にしたもの（整える前と後で同じになるはず）。 */
function shape(source: string): unknown {
  const script = parse(source, "a", { speakers });
  return JSON.parse(
    JSON.stringify(script.body, (k, v: unknown) => {
      // 式の字面（source）は空白を整えるので比べない（式の構文木は比べる）
      if (k === "column" || k === "quoted" || k === "source") return undefined;
      if (k === "args" && Array.isArray(v)) {
        // 引数の書いたままの字面（text）は整えると変わるので比べない
        const args = (v as (Arg & { text?: string })[]).map(({ text: _text, ...a }) => a);
        return [...args.filter((a) => a.key === null), ...args.filter((a) => a.key !== null).sort((a, b) => a.key!.localeCompare(b.key!))];
      }
      return v;
    }),
  );
}

function format(source: string): string {
  const r = formatLim(source, "a", { registry, speakers });
  if (!r.ok) throw new Error(r.reason);
  return r.text;
}

describe("lim fmt", () => {
  it("命令の行だけを整え、本文は変えない", () => {
    const src = [
      "@bg   room   time=1s  method=fadeIn",
      '@bg room wait=false time=500ms method="fadeIn"  ',
      '@chara at=left  ユイ "smile"',
      "  　字下げした本文 @bg room   は本文のまま   ",
      'ユイ「"そのまま"   」',
      "@set game.n+=1",
      "@let  count=0",
      "@if   game.n >= 1  ",
      "  地の文。",
      "@end",
      "@choice",
      '  - 北へ   行く -> #north  if=(game.n  > 0)   label="ok"',
      "  - 南へ -> #south",
      "@end",
      "@script",
      "  const a = 1;   ",
      "@end",
      "# north",
      "# south",
    ].join("\n");
    expect(format(src).split("\n")).toEqual([
      "@bg room time=1s method=fadeIn",
      "@bg room time=500ms method=fadeIn wait=false",
      "@chara ユイ smile at=left",
      "  　字下げした本文 @bg room   は本文のまま",
      'ユイ「"そのまま"   」',
      "@set game.n += 1",
      "@let count = 0",
      "@if game.n >= 1",
      "  地の文。",
      "@end",
      "@choice",
      "  - 北へ   行く -> #north if=(game.n > 0) label=ok",
      "  - 南へ -> #south",
      "@end",
      "@script",
      "  const a = 1;   ",
      "@end",
      "# north",
      "# south",
    ]);
    expect(shape(format(src))).toEqual(shape(src));
  });

  it("式の演算子の前後を空白一つにする（文字列の中、単項の - と !、関数の呼び出しはそのまま）", () => {
    const src = [
      "@set game.n=game.n+1",
      '@set game.name = game.first+" "+game.last',
      "@let x=-game.a*(2-1)",
      "@if !game.ok&&len(game.list)>=2",
      "@elif game.n==1?game.a:game.b",
      "@end",
      "@while game.n<3",
      "@set game.n = game.n+1",
      "@end",
      '@bg (game.bg+".jpg") time=(game.t*2)',
      '@jump (game.n>1 ? "#a" : "#b") to=#a,#b',
      "# a",
      "# b",
    ].join("\n");
    expect(format(src).split("\n")).toEqual([
      "@set game.n = game.n + 1",
      '@set game.name = game.first + " " + game.last',
      "@let x = -game.a * (2 - 1)",
      "@if !game.ok && len(game.list) >= 2",
      "@elif game.n == 1 ? game.a : game.b",
      "@end",
      "@while game.n < 3",
      "@set game.n = game.n + 1",
      "@end",
      '@bg (game.bg + ".jpg") time=(game.t * 2)',
      '@jump (game.n > 1 ? "#a" : "#b") to=#a,#b',
      "# a",
      "# b",
    ]);
    expect(shape(format(src))).toEqual(shape(src));
  });

  it("indent を決めたら、ブロックの深さで字下げをそろえる（本文の行も。全角の空白は本文のまま）", () => {
    const src = ["@if game.a", "地の文", "    @if game.b", "　字下げした本文", "@else", "// メモ", "ユイ「はい」", "@end", "@end", "@choice", "- 行く -> #a", "@end", "@define pose(who: cast)", "@chara (who)", "@end", "@html", "   <p>そのまま</p>", "@end", "# a"].join("\n");
    const two = formatLim(src, "a", { registry, speakers, indent: 2 });
    expect(two.ok && two.text.split("\n")).toEqual(["@if game.a", "  地の文", "  @if game.b", "    　字下げした本文", "  @else", "    // メモ", "    ユイ「はい」", "  @end", "@end", "@choice", "  - 行く -> #a", "@end", "@define pose(who: cast)", "  @chara (who)", "@end", "@html", "   <p>そのまま</p>", "@end", "# a"]);
    const tab = formatLim(src, "a", { registry, speakers, indent: "tab" });
    expect(tab.ok && tab.text.split("\n")[1]).toBe("\t地の文");
    expect(two.ok && shape(two.text)).toEqual(shape(src));
    // 決めなければ字下げは変えない
    expect(format(src).split("\n")[2]).toBe("    @if game.b");
  });

  it("@for の中も一段深く字下げする", () => {
    const src = ["@for item in game.items", "@wait 1s", "地の文", "@end"].join("\n");
    const r = formatLim(src, "a", { registry, speakers, indent: 2 });
    expect(r.ok && r.text.split("\n")).toEqual(["@for item in game.items", "  @wait 1s", "  地の文", "@end"]);
    expect(r.ok && shape(r.text)).toEqual(shape(src));
  });

  it("外すと意味が変わる引用符は残す", () => {
    const src = ['@chara-config ユイ name="ユイ さん"', '@bg "300"', '@bg "true"', '@bg "a=b"', '@bg "#abc"', '@bg ""', '@bg "{r 漢|かん}"'].join("\n");
    expect(format(src)).toBe(src);
  });

  it.each(["solo", "wait"])("真偽値の省略形になる差分 %s の引用符は残す", (flag) => {
    const src = `@chara Yuika "${flag}"`;
    expect(format(src)).toBe(src);
    expect(format(`@chara Yuika ${flag}`)).toBe(`@chara Yuika ${flag}`);
    expect(format(`@chara "${flag}" smile`)).toBe(`@chara ${flag} smile`);
    expect(format(`@chara Yuika variant="${flag}"`)).toBe(`@chara Yuika variant=${flag}`);
  });

  it("真偽値の省略形があっても安全な引用符は外す", () => {
    expect(format('@chara Yuika "smile" wait')).toBe("@chara Yuika smile wait");
    expect(format('@chara Yuika "solo" wait')).toBe('@chara Yuika "solo" wait');
    expect(format('@chara Yuika "wait" solo')).toBe('@chara Yuika "wait" solo');
  });

  it.each(['name=night.png', 'name＝night.png', '"night', 'a b', '', '(game.bg)', 'true'])("引数の読み方が変わる文字列 %j の引用符は残す", (value) => {
    const src = `@bg ${JSON.stringify(value)}`;
    expect(format(src)).toBe(src);
    expect(shape(format(src))).toEqual(shape(src));
  });

  it("同じ名前の引数が二度あるときは並べ替えない・構文の誤りがあるファイルは整えない", () => {
    expect(format("@bg room wait=false time=1s wait=true")).toBe("@bg room wait=false time=1s wait=true");
    expect(formatLim('@bg "room', "a").ok).toBe(false);
  });

  it("引数の読み取りに警告があるときは引用符を外さない", () => {
    const src = '@bg "room" time＝1s';
    expect(format(src)).toBe(src);
  });

  it("expressions: false なら式の空白は変えない（前の lim fmt の動き）", () => {
    const r = formatLim("@set game.n=game.n+1\n@if game.a==1\n@end", "a", { registry, speakers, expressions: false });
    expect(r.ok && r.text).toBe("@set game.n = game.n+1\n@if game.a==1\n@end");
  });

  it("読めない式と、整えると読み方が変わる式はそのまま", () => {
    expect(formatExpr("game.a +")).toBe("game.a +");
    expect(formatExpr("a-b")).toBe("a - b");
    expect(formatExpr("a - -b")).toBe("a - -b");
    expect(formatExpr("f( a )[ 0 ].b")).toBe("f(a)[0].b");
  });

  it("整えたら二度目は変わらず、構文木は同じ（ひな形）", () => {
    const dir = new URL("../../../templates/default/scenario/", import.meta.url);
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".lim"))) {
      const src = readFileSync(new URL(f, dir), "utf8");
      const once = format(src);
      expect(shape(once)).toEqual(shape(src));
      expect(format(once)).toBe(once);
      // 字下げをそろえても同じ構文木で、二度目は変わらない
      const indented = formatLim(src, f, { registry, speakers, indent: 2 });
      if (!indented.ok) throw new Error(indented.reason);
      expect(shape(indented.text)).toEqual(shape(src));
      const again = formatLim(indented.text, f, { registry, speakers, indent: 2 });
      expect(again.ok && again.text).toBe(indented.text);
    }
  });
});
