import { describe, expect, it } from "vitest";
import { parseExpr } from "@liminalia/lang";
import { equals, evaluate, HeadlessHost, Runtime, type HeadlessOptions, type SaveData, type TraceEntry, type Value } from "../src/index.ts";

/** 行の if=(式)、@for、@let の +=、辞書のリテラル、@function、本文の出し分け（{seq …} など）。 */

const speakers = ["ユイ"];

function setup(files: Record<string, string>, options: Partial<HeadlessOptions> = {}) {
  const host = new HeadlessHost({
    loadSource: async (f) => {
      const src = files[f];
      if (src === undefined) throw new Error(`no file ${f}`);
      return src;
    },
    ...options,
  });
  const runtime = new Runtime(host, { speakers });
  return { host, runtime };
}

const pages = (trace: TraceEntry[]) => trace.flatMap((t) => (t.type === "page" ? [t.text] : []));
const errors = (trace: TraceEntry[]) => trace.flatMap((t) => (t.type === "diagnostic" ? [t.diagnostic.message] : []));

describe("sparse array equality", () => {
  it("treats holes as null in either operand, including nested arrays", () => {
    const sparse: Value[] = [];
    sparse[1] = 1;
    expect([equals(sparse, [null, 1]), equals([null, 1], sparse)]).toEqual([true, true]);
    expect([equals(sparse, [2, 1]), equals([2, 1], sparse)]).toEqual([false, false]);
    expect(equals([sparse], [[null, 1]])).toBe(true);
    expect(equals([[null, 1]], [sparse])).toBe(true);
    expect(equals([], [])).toBe(true);
    expect(equals(sparse, [])).toBe(false);
    expect(equals([], sparse)).toBe(false);
    expect(equals(new Array<Value>(1), [null])).toBe(true);
    expect(equals([null], new Array<Value>(1))).toBe(true);
  });

  it("compares arrays created by assigning past the end symmetrically in scripts", async () => {
    const src = [
      "@set game.a = []",
      "@set game.a[1] = 1",
      "@set game.b = [null, 1]",
      "{= game.a[0] == null}",
      "{= game.a == game.b}",
      "{= game.b == game.a}",
      "@set game.b[0] = 2",
      "{= game.a == game.b}",
      "{= game.b == game.a}",
    ].join("\n");
    const { host, runtime } = setup({ a: src });
    await runtime.start("a");
    expect(errors(host.trace)).toEqual([]);
    const sparse = runtime.state.game.a;
    expect(Array.isArray(sparse)).toBe(true);
    if (!Array.isArray(sparse)) throw new Error("expected an array");
    expect(Object.hasOwn(sparse, 0)).toBe(false);
    expect(pages(host.trace)).toEqual(["true", "true", "true", "false", "false"]);
  });
});

describe("行の if=(式)", () => {
  it("偽なら命令、@set、@jump、@call、@return を飛ばす", async () => {
    const src = [
      "@set game.night = true",
      "@set game.a = 1 if=(game.night)",
      "@set game.b = 1 if=(!game.night)",
      "@let n = 5 if=(game.a == 1)",
      "{= n}",
      "@jump #skip if=(game.b == 1)",
      "飛ばさない",
      "@call #sub if=(game.night)",
      "@jump #end",
      "# skip",
      "飛んだ",
      "# sub",
      "呼んだ",
      "@return if=(game.night)",
      "戻らない",
      "# end",
      "終わり",
    ].join("\n");
    const { host, runtime } = setup({ a: src });
    await runtime.start("a");
    expect(runtime.state.game).toEqual({ night: true, a: 1 });
    expect(pages(host.trace)).toEqual(["5", "飛ばさない", "呼んだ", "終わり"]);
    expect(errors(host.trace)).toEqual([]);
  });

  it("命令の if= は引数の途中にも書ける", async () => {
    const { host, runtime } = setup({ a: "@set game.x = 0\n@wait 10ms if=(game.x == 1) wait=true\n@bg room.jpg if=(game.x == 0)\nおわり" });
    await runtime.start("a");
    const commands = host.trace.flatMap((t) => (t.type === "command" ? [t.name] : []));
    expect(commands).toContain("bg");
    expect(commands).not.toContain("wait");
  });
});

describe("@set /=", () => {
  it.each(["x", "game.x", "game.nested.x", "game.items[0]"])("%s は 0 で割る前に止まり、値を変えない", async (target) => {
    const run = async (assignment: string) => {
      const { host, runtime } = setup({ a: `@let x = 12\n@set game.items = [12]\n@set ${target} = 12\n@set ${target} ${assignment}\n続かない` });
      await runtime.start("a");
      return { host, runtime };
    };
    const regular = await run(`= ${target} / 0`);
    expect(errors(regular.host.trace)).toEqual(["0 で割ることはできません（数値 12 / 0）"]);
    const compound = await run("/= 0");
    expect(errors(compound.host.trace)).toEqual(errors(regular.host.trace));
    expect(compound.runtime.eval(parseExpr(target))).toBe(12);
    expect(pages(compound.host.trace)).toEqual([]);
  });

  it("数値を割り、未定義の値は 0 として扱う", async () => {
    const { host, runtime } = setup({ a: "@set game.x = 12\n@set game.x /= 3\n@set game.empty /= 2" });
    await runtime.start("a");
    expect(runtime.state.game).toEqual({ x: 4, empty: 0 });
    expect(errors(host.trace)).toEqual([]);
  });
});

describe("@for と @let +=", () => {
  it("配列の要素を一つずつ回し、辞書はキーを回す", async () => {
    const src = [
      '@set game.items = ["鍵", "地図"]',
      "@let total = 0",
      "@for item in game.items",
      "{= item}",
      "@let total += 1",
      "@end",
      "{= total}",
      '@for k in {"a": 1, "b": 2}',
      "{= k}",
      "@end",
      "@for x in []",
      "通らない",
      "@end",
    ].join("\n");
    const { host, runtime } = setup({ a: src });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual(["鍵", "地図", "2", "a", "b"]);
    expect(errors(host.trace)).toEqual([]);
  });

  it("入れ子にでき、回せないものは実行時のエラー", async () => {
    const { host, runtime } = setup({ a: "@for a in [1, 2]\n@for b in [10, 20]\n{= a * b}\n@end\n@end\n@for c in 3\n{= c}\n@end" });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual(["10", "20", "20", "40"]);
    expect(errors(host.trace).join("\n")).toMatch(/@for で回せるのは配列か辞書です/);
  });
});

describe("辞書のリテラルと @function", () => {
  it("辞書を作って読む", () => {
    const ev = (src: string) => evaluate(parseExpr(src), { lookup: () => null, random: () => 0 });
    expect(ev('{"a": 1, b: [2, 3]}')).toEqual({ a: 1, b: [2, 3] });
    expect(ev('{"a": 1}["a"] + {b: 2}.b')).toBe(3);
    expect(ev("{}")).toEqual({});
    expect(() => parseExpr('{"a": 1, "a": 2}')).toThrow(/二回/);
  });

  it("@function を式で呼ぶ（引数と game だけを読み、@use したファイルの関数も呼べる）", async () => {
    const common = '@function rank(score) = score >= 80 ? "A" : score >= 50 ? "B" : "C"\n@function bonus(n) = n + game.extra';
    const src = "@use common\n@function twice(x) = x * 2\n@set game.extra = 1\n@let x = 99\n{= rank(twice(45))}{= rank(10)}{= bonus(1)}";
    const { host, runtime } = setup({ a: src, common });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual(["AC2"]);
    expect(errors(host.trace)).toEqual([]);
  });

  it("自分を呼び続ける関数は止める", async () => {
    const { host, runtime } = setup({ a: "@function loop(n) = loop(n + 1)\n{= loop(0)}" });
    await runtime.start("a");
    expect(errors(host.trace).join("\n")).toMatch(/200 段を超えました/);
  });
});

describe("本文の出し分け", () => {
  it("seq は最後で止まり、cycle は戻り、once は出し終えたら出さない", async () => {
    const src = "@let i = 0\n@while i < 4\n{seq 一|二|三}、{cycle a|b}、{once x|y}。\n@let i += 1\n@end";
    const { host, runtime } = setup({ a: src });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual(["一、a、x。", "二、b、y。", "三、a、。", "三、b、。"]);
  });

  it("shuffle は同じものを続けて出さない。数はセーブに入り、ロードしても進めない", async () => {
    const src = "@let i = 0\n@while i < 6\n{shuffle 赤|青|黄}\n@let i += 1\n@end";
    const { host, runtime } = setup({ a: src });
    await runtime.start("a");
    const shown = pages(host.trace);
    expect(shown).toHaveLength(6);
    for (let i = 1; i < shown.length; i++) expect(shown[i]).not.toBe(shown[i - 1]);

    // 同じ所をまた通ると進む。そのページ（クリックを待っている間）でセーブしてロードすると、同じ文が出る（数は進めない）
    const src2 = "# top\n{seq 一|二|三}A\n@jump #top if=(visits(\"#top\") < 2)\n終わり";
    const two = setup({ a: src2 });
    let save: SaveData | null = null;
    two.host.waitClick = async () => {
      if (pages(two.host.trace).length === 2 && !save) save = two.runtime.save();
    };
    await two.runtime.start("a");
    expect(pages(two.host.trace)).toEqual(["一A", "二A", "終わり"]);
    expect(Object.values(save!.variants ?? {})).toEqual([[1, 0]]);
    const again = setup({ a: src2 });
    await again.runtime.load(save!);
    expect(pages(again.host.trace)).toEqual(["二A", "終わり"]);
  });

  it("中にルビと式を書け、| は \\| で文字になる", async () => {
    const { host, runtime } = setup({ a: '@let n = 3\n{seq {r 星|ほし}が{= n}つ|a\\|b}\n' });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual(["星が3つ"]);
  });
});

describe("@define の中のラベルへのジャンプ", () => {
  it("「ありません」ではなく @define の中にあると知らせて止まる", async () => {
    const { host, runtime } = setup({ a: "@define f()\n# inner\nx\n@end\n@jump #inner" });
    await runtime.start("a");
    expect(errors(host.trace).join("\n")).toMatch(/#inner は @define f の中にあるため、ジャンプできません/);
  });
});
