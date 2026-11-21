import { describe, expect, it } from "vitest";
import { applyLinesFix, check, CORE_COMMANDS, createRegistry, englishDiagnostic, parse, type Diagnostic } from "../src/index.ts";

/** 実行して初めて分かっていた書き損じを、構文チェックで知らせる（台本の書きやすさ）。 */

const registry = createRegistry(CORE_COMMANDS);
const all = (src: string, o: { speakers?: string[]; sourceLanguage?: string } = {}): Diagnostic[] => {
  const speakers = o.speakers ?? ["アカリ"];
  const s = parse(src, "a", { speakers });
  return [...s.diagnostics, ...check(s, { registry, speakers, ...(o.sourceLanguage ? { sourceLanguage: o.sourceLanguage } : {}) })];
};
const show = (src: string, o: { speakers?: string[]; sourceLanguage?: string } = {}) => all(src, o).map((d) => `${d.line} ${d.severity} ${d.code}`);

describe("@function をブロックの形で書いた", () => {
  it("一つの診断にまとめ、続く @return と @end と、使う所の「関数がありません」を出さない", () => {
    const src = ["@function double(n)", "@return n * 2", "@end", "　{= double(2)}"].join("\n");
    expect(show(src)).toEqual(["1 error bad-function"]);
    const d = all(src)[0]!;
    expect(d.message).toBe("関数は一行の式で書きます（@function 名前(引数) = 式）。手順を書くなら @define にします");
    expect(englishDiagnostic(d).message).toBe("A function is a one-line expression (@function name(arguments) = expression). To write steps, use @define");
    // 中身が @return 一つなら、一行の形にする直し方を付ける
    expect(d.hint).toBe("@function double(n) = n * 2 と書きます");
    const rows = src.split("\n");
    expect(d.fix?.kind).toBe("replace-lines");
    expect(d.fix?.kind === "replace-lines" ? applyLinesFix(rows, 0, d.fix) : null).toEqual({ count: 3, text: "@function double(n) = n * 2" });
  });

  it("中身が手順なら、@define の戻り値を案にする。中の @if 〜 @end も一緒に読み飛ばす", () => {
    const src = ["@function grade(n)", "@if n > 1", "@return (1)", "@end", "@return (0)", "@end", "本文"].join("\n");
    expect(show(src)).toEqual(["1 error bad-function"]);
    const d = all(src)[0]!;
    expect(d.hint).toBe("値を計算するだけなら @function grade(n) = 式 の一行に、手順を書くなら @define grade(n: number, into: variable) の中で @return (式) を書きます");
    expect(d.fix).toBeUndefined();
  });

  it("@end が無ければ、今までどおり一行の形の誤りだけ（後ろの行はそのまま読む）", () => {
    expect(show("@function f(x)\n# next\n本文")).toEqual(["1 error bad-function"]);
    expect(parse("@function f(x)\n# next\n本文", "a").body.map((s) => s.kind)).toEqual(["label", "prose"]);
  });
});

describe("話者でない名前の {name …}", () => {
  it("「{ のあとを解釈できません」とインラインの一覧のヒントを出さず、話者に足すことを一つの警告で言う", () => {
    const d = all("カイ{name ？？？}「……」");
    expect(d.map((x) => `${x.line} ${x.severity} ${x.code}`)).toEqual(["1 warning unknown-speaker"]);
    expect(d[0]!.message).toBe("カイ は話者に登録されていないため、この行は台詞ではなく地の文になります（{name …} は話者の台詞にだけ書けます）");
    expect(d[0]!.hint).toBe("カイ を話者（cast.json の speakers）に追加すると、名前の欄を ？？？ にした台詞になります");
    expect(englishDiagnostic(d[0]!).hint).toBe("Add カイ to the speakers (speakers in cast.json) to make this dialogue with ？？？ in the name box");
    expect(d[0]!.fixes).toEqual([{ kind: "add-speaker", name: "カイ" }]);
    expect(englishDiagnostic(d[0]!).message).toBe("カイ isn't a registered speaker, so this line becomes narration instead of dialogue ({name …} works only on a speaker's line)");
    // 英語の引用符の形も同じ
    expect(show('Kai{name ???} "Hello."', { speakers: [], sourceLanguage: "en" })).toEqual(["1 warning unknown-speaker"]);
  });

  it("話者なら今までどおり台詞になる", () => {
    expect(show("アカリ{name ？？？}「……」")).toEqual([]);
  });
});

describe("英語の Name: \"…\"", () => {
  it("同じ名前の行が二つ以上あれば、話者でなくても知らせ、話者に足す直し方と台詞の形に直す直し方を付ける", () => {
    const lines = ['Nora: "Hello."', "　Some narration.", 'Nora: "Again."', 'Note: "x"'];
    const d = all(lines.join("\n"), { speakers: [], sourceLanguage: "en" }).filter((x) => x.code === "unknown-speaker");
    expect(d.map((x) => x.line)).toEqual([1, 3]);
    expect(d[0]!.fixes).toEqual([{ kind: "add-speaker", name: "Nora" }, { kind: "replace", find: "Nora: ", with: "Nora " }]);
    expect(englishDiagnostic(d[0]!).message).toBe("Nora isn't a registered speaker, so this line becomes narration, not dialogue (the way the name is written isn't a dialogue form either)");
  });

  it("一行だけなら黙る（英語の地の文の Note: \"x\"）。小文字で始まる名前も見ない", () => {
    expect(show('Note: "x"', { speakers: [] })).toEqual([]);
    expect(show('note: "x"\nnote: "y"', { speakers: [] })).toEqual([]);
  });

  it("半角の : に日本語の括弧なら一行でも知らせる", () => {
    expect(show("カイ:「こんにちは」")).toEqual(["1 warning unknown-speaker"]);
  });
});

describe("@let の += と @for の値", () => {
  it("前に値を入れていないローカル変数に += で足すと警告し、先に @let x = 0 と書く案を出す", () => {
    const d = all(["@define counter()", "@let x += 1", "@end"].join("\n"));
    expect(d.map((x) => `${x.line} ${x.severity} ${x.code}`)).toEqual(["2 warning uninitialized-variable"]);
    expect(d[0]!.message).toBe("ローカル変数 x に値を入れる前に、前の値から計算しています（実行すると、値の無いまま計算する誤りになります）");
    expect(d[0]!.hint).toBe("前の行に @let x = 0 を書きます");
    expect(englishDiagnostic(d[0]!).message).toBe("The local variable x is calculated from its previous value before it has one (running it is an error with no value to calculate from)");
    expect(englishDiagnostic(d[0]!).hint).toBe("Write @let x = 0 on the line before");
    expect(show("@let y = y * 2")).toEqual(["1 warning uninitialized-variable"]);
  });

  it("前に値を入れた変数、パラメータから入れた変数、@for の名前、値の有無を確かめる形は知らせない", () => {
    expect(show("@let i = 0\n@while i < 3\n@let i += 1\n@end")).toEqual([]);
    expect(show("@define count(n: int)\n@let m = n\n@let m += 1\n@end")).toEqual([]);
    expect(show("@for i in [1, 2]\n@let i += 1\n@end")).toEqual([]);
    expect(show("@let z = z == null ? 0 : z + 1")).toEqual([]);
    expect(show("@if game.x\n@let i = 0\n@end\n@let i += 1")).toEqual([]);
  });

  it("@for で配列でも辞書でもない字面の値を回すと誤り", () => {
    const d = all("@for i in 5\n　{= i}\n@end");
    expect(d.map((x) => `${x.line} ${x.severity} ${x.code}`)).toEqual(["1 error bad-for"]);
    expect(d[0]!.message).toBe("@for で回せるのは配列か辞書です（5 は配列でも辞書でもありません）");
    expect(englishDiagnostic(d[0]!).message).toBe("@for can only go through an array or a dictionary (5 is neither)");
    expect(show('@for c in "abc"\n@end')).toEqual(["1 error bad-for"]);
    expect(show("@for i in game.list\n@end")).toEqual([]);
    expect(show('@for k in {"a": 1}\n@end')).toEqual([]);
  });
});
