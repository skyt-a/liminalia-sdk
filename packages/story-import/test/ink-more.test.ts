import { describe, expect, it } from "vitest";
import { importInk } from "../src/index.ts";
import { printExpr, truncateIntDivision } from "../src/int-division.ts";
import { parseExpr } from "@liminalia/lang";
import { limCheckErrors, play } from "./helpers.ts";

describe("Ink の整数どうしの割り算", () => {
  it("整数どうしと分かる割り算は切り捨て、小数が混じれば小数、分からなければ報告する", async () => {
    const src = [
      "VAR a = 7",
      "VAR f = 1.5",
      "~ temp t = 5",
      "~ temp half = a / 2",
      "{a / 2} {f / 2} {t / 2} {FLOAT(a) / 2} {7.0 / 2} {half}",
      "~ a = a / 2",
      "a は {a}。",
      "-> END",
    ].join("\n");
    const r = importInk(src, { file: "t.ink" });
    expect(limCheckErrors(r)).toEqual([]);
    const text = r.files[0]!.text;
    expect(text).toContain("{= floor(game.a / 2)}");
    expect(text).toContain("{= game.f / 2}");
    expect(text).toContain("{= floor(t / 2)}");
    expect(text).toContain("@set game.a = floor(game.a / 2)");
    expect((await play(r, "t", [])).pages).toEqual(["3 0.75 2 3.5 3.5 3", "a は 3。"]);
    expect(r.issues.filter((i) => i.code === "ink-division")).toEqual([]);
  });

  it("整数どうしか分からない割り算は小数のままにして、報告の情報に出す", () => {
    const r = importInk("=== knot ===\n~ temp x = RANDOM(1, 6)\n~ temp y = x\n{y / 2}\n-> inner\n= inner\n{x / 2}\n-> END", { file: "t.ink" });
    // RANDOM は整数を返すので切り捨て。ステッチはノットの temp の種類を引き継ぐ
    expect(r.files[0]!.text).toContain("{= floor(y / 2)}");
    expect(r.files[0]!.text).toContain("{= floor(x / 2)}");
    const r2 = importInk("VAR b = true\n~ temp s = b\n{s / 2}\n-> END", { file: "t.ink" });
    expect(r2.files[0]!.text).toContain("{= s / 2}");
    expect(r2.issues.filter((i) => i.code === "ink-division").map((i) => i.message)).toEqual(["割り算 s / 2 は整数どうしか分からないので、小数の割り算のままにしました（Ink では整数どうしなら切り捨て）"]);
  });

  it("式の書き換えは括弧を要るところだけに保つ", () => {
    const kinds = () => "int" as const;
    expect(truncateIntDivision("game.a / 2 + 1", kinds).expr).toBe("floor(game.a / 2) + 1");
    expect(truncateIntDivision("(game.a + 1) / (game.b - 1) * 3", kinds).expr).toBe("floor((game.a + 1) / (game.b - 1)) * 3");
    expect(truncateIntDivision('game.a / 2 > 1 ? "x" : "y\\"z"', kinds).expr).toBe('floor(game.a / 2) > 1 ? "x" : "y\\"z"');
    expect(truncateIntDivision("game.a / 2.5", kinds).expr).toBe("game.a / 2.5");
    expect(printExpr(parseExpr("-(a - b) - (c - d)"))).toBe("-(a - b) - (c - d)");
    expect(printExpr(parseExpr("!(a && b) || c"))).toBe("!(a && b) || c");
  });
});

const lines = (...l: string[]) => l.join("\n");

describe("Ink の関数", () => {
  const src = lines(
    "VAR gold = 3",
    "~ temp d = double(gold) + 1",
    '金は {d}。{greet("旅人")}',
    "~ add_gold(2)",
    "{fact(4)} と {half(7)}",
    "* {double(gold) > 8} [大金持ち] 大金だ。",
    "* [帰る]",
    "- おわり。",
    "-> END",
    "",
    "=== function double(x) ===",
    "~ return x * 2",
    "",
    "=== function greet(who) ===",
    "こんにちは、{who}。",
    '~ return ""',
    "",
    "=== function add_gold(n) ===",
    "~ gold += n",
    "",
    "=== function fact(n) ===",
    "{ n <= 1:",
    "  ~ return 1",
    "- else:",
    "  ~ return n * fact(n - 1)",
    "}",
    "",
    "=== function half(maxHP) ===",
    "~ maxHP = maxHP / 2",
    "~ return maxHP",
  );

  it("関数は戻り値のあるマクロ（@define と @return (式)）にし、式の中の呼び出しは前の行のマクロの呼び出しにする", () => {
    const r = importInk(src, { file: "t.ink" });
    expect(limCheckErrors(r)).toEqual([]);
    expect(r.totals.manual).toBe(0);
    const text = r.files[0]!.text;
    expect(text).toContain("@ink-double x=(game.gold) ink-result=temp.ink_ret\n@let ink_r1 = temp.ink_ret\n@let d = ink_r1 + 1");
    // 値を使わない呼び出しはマクロの呼び出しだけ
    expect(text).toContain("@ink-add-gold n=(2) ink-result=temp.ink_ret\n@ink-fact");
    expect(text).toContain("@define ink-double(x: number, ink-result: variable)\n  @return (x * 2)\n@end");
    expect(text).toContain("@define ink-greet(who: string, ink-result: variable)");
    // 再帰と、引数への代入（引数を写した局所変数を使う）
    expect(text).toContain("    @ink-fact n=(n - 1) ink-result=temp.ink_ret");
    expect(text).toContain("@define ink-half(max-hp: number, ink-result: variable)\n  @let v_max_hp = max_hp\n  @let v_max_hp = floor(v_max_hp / 2)");
    expect(r.issues.map((i) => i.code)).toContain("ink-function-text");
  });

  it("Ink と同じ値になる（選択肢の条件の中の呼び出しも、選択肢の前で呼ぶ）", async () => {
    const r = importInk(src, { file: "t.ink" });
    const p = await play(r, "t", [0]);
    expect(p.diagnostics).toEqual([]);
    expect(p.pages).toEqual(["こんにちは、旅人。", "金は 7。", "24 と 3", "大金だ。", "おわり。"]);
    expect(p.shown).toEqual([["大金持ち", "帰る"]]);
    expect(p.game).toMatchObject({ gold: 5 });
  });

  it("呼び出しの引数が整数と小数のどちらもあれば、関数の中の割り算は小数のままにして報告する", () => {
    const r = importInk("{f(3.5)} {f(2)}\n-> END\n=== function f(n) ===\n~ return n / 2", { file: "t.ink" });
    expect(r.files[0]!.text).toContain("@return (n / 2)");
    expect(r.issues.some((i) => i.code === "ink-division")).toBe(true);
  });
});

describe("Ink の LIST", () => {
  const src = lines(
    "LIST kettle = cold, (boiling), recently_boiled",
    "LIST items = (key), lamp = 5, (map)",
    "LIST extra = rope, torch",
    "やかんは {kettle}。持ち物は {items}（{LIST_COUNT(items)} 個）。",
    "{kettle == boiling: 沸いている。|沸いていない。}",
    "~ kettle = cold",
    "{kettle == boiling: 沸いている。|冷めた。}",
    "~ items += lamp",
    "~ items -= key",
    "{items ? lamp: ランプがある。}",
    "{items hasnt key: 鍵は無い。}",
    "{items has (lamp, map): ランプと地図。}",
    "~ extra = (rope, torch)",
    "~ items += extra",
    "持ち物は {items}。",
    "~ items = ()",
    "{items: 何か持っている。|空っぽ。}",
    "ランプの値は {LIST_VALUE(lamp)}。",
    "-> END",
  );

  it("LIST は項目の名前の配列の変数にし、?・has・==・+=・-=・LIST_COUNT を配列の関数にする", async () => {
    const r = importInk(src, { file: "t.ink" });
    expect(limCheckErrors(r)).toEqual([]);
    expect(r.totals.manual).toBe(0);
    expect(r.variables).toMatchObject({ "game.kettle": ["boiling"], "game.items": ["key", "map"], "game.extra": [] });
    const text = r.files[0]!.text;
    expect(text).toContain('@set game.items = unique(push(game.items, "lamp"))');
    expect(text).toContain('{= (includes(game.items, "lamp")) ? "ランプがある。" : ""}');
    // 別のリストの項目をまとめて足すのは @while で一つずつ
    expect(text).toContain("@while ink_i1 < len(game.extra)");
    const p = await play(r, "t", []);
    expect(p.diagnostics).toEqual([]);
    expect(p.pages).toEqual([
      "やかんは boiling。持ち物は key, map（2 個）。",
      "沸いている。",
      "冷めた。",
      "ランプがある。",
      "鍵は無い。",
      "ランプと地図。",
      "持ち物は map, lamp, rope, torch。",
      "空っぽ。",
      "ランプの値は 5。",
    ]);
  });

  it("リストの大小の比べ方は変換せずに報告する", () => {
    const r = importInk("LIST v = a, b\n{v > a: 大きい}\n-> END", { file: "t.ink" });
    expect([...r.unsupported.keys()]).toEqual(["ink-list"]);
    expect(limCheckErrors(r)).toEqual([]);
  });
});

describe("Ink のスレッド", () => {
  const src = lines(
    "-> hub",
    "=== hub ===",
    "広間にいる。",
    "<- talk",
    "<- leave",
    "+ [待つ] 時間が過ぎた。 -> hub",
    "=== talk ===",
    "* [話す]",
    "  話しかけた。",
    "  -> hub",
    "=== leave ===",
    "扉が見える。",
    "+ [出る] -> outside",
    "-> DONE",
    "=== outside ===",
    "外に出た。",
    "-> END",
  );

  it("<- ノット はそのノットの本文をここに出し、選択肢を今の選択肢と一緒に出す", async () => {
    const r = importInk(src, { file: "t.ink" });
    expect(limCheckErrors(r)).toEqual([]);
    expect(r.totals.manual).toBe(0);
    const p = await play(r, "t", [0, 1, 0]);
    expect(p.diagnostics).toEqual([]);
    expect(p.shown).toEqual([
      ["話す", "出る", "待つ"],
      ["出る", "待つ"],
      ["出る", "待つ"],
    ]);
    expect(p.pages).toEqual(["広間にいる。", "扉が見える。", "話しかけた。", "広間にいる。", "扉が見える。", "時間が過ぎた。", "広間にいる。", "扉が見える。", "外に出た。"]);
  });

  it("無いノットと、自分を取り込むスレッドは報告する", () => {
    const r = importInk("=== a ===\n<- a\n<- nowhere\n-> END", { file: "t.ink" });
    expect([...new Set(r.issues.filter((i) => i.code === "ink-thread").map((i) => i.message))]).toEqual([
      "スレッド <- a は変換できません（自分を取り込むスレッドです）",
      "スレッド <- nowhere は変換できません（nowhere というノットがありません）",
    ]);
  });
});

describe("Ink の本文の順番", () => {
  it("{A|B} {&A|B} {!A|B} {~A|B} は本文の出し分け（seq、cycle、once、shuffle）にし、Ink と同じ順に出す", async () => {
    const src = ["=== loop ===", "{一|二|三}、{&朝|夜}、{!初|}{~x|x}", "+ [もう一度] -> loop", "+ [終わる] -> END"].join("\n");
    const r = importInk(src, { file: "t.ink" });
    expect(limCheckErrors(r)).toEqual([]);
    const text = r.files[0]!.text;
    expect(text).toContain("{seq 一|二|三}、{cycle 朝|夜}、{once 初|}{shuffle x|x}");
    expect(text).not.toContain("ink_seq");
    expect((await play(r, "t", [0, 0, 0, 1])).pages).toEqual(["一、朝、初x", "二、夜、x", "三、朝、x", "三、夜、x"]);
  });

  it("条件の枝の中の順番は、前のとおり式にする", () => {
    const r = importInk("VAR b = true\n{b: {&甲|乙}|丙}\n-> END", { file: "t.ink" });
    expect(limCheckErrors(r)).toEqual([]);
    expect(r.files[0]!.text).toContain("ink_seq");
  });

  it("文字列の中の | も出し分けの区切りにする（Ink では \"…\" は本文の文字）", () => {
    const r = importInk('VAR x = 2\n{x > 1: "a|b"}\n{~a|"b|c"}\n-> END', { file: "t.ink" });
    expect(limCheckErrors(r)).toEqual([]);
    const text = r.files[0]!.text;
    expect(text).toContain('{= game.x > 1 ? "\\"a" : "b\\""}');
    expect(text).toContain('{shuffle a|"b|c"}');
  });
});
