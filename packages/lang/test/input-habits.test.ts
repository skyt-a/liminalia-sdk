import { describe, expect, it } from "vitest";
import { applyFix, check, checkProject, CORE_COMMANDS, createRegistry, englishDiagnostic, parse, type Diagnostic } from "../src/index.ts";

const registry = createRegistry(CORE_COMMANDS);
const speakers = ["アカリ", "Yui"];
const all = (src: string, o: { sourceLanguage?: string } = {}): Diagnostic[] => {
  const s = parse(src, "a", { speakers });
  return [...s.diagnostics, ...check(s, { registry, speakers, ...o })];
};
const show = (src: string, o: { sourceLanguage?: string } = {}) => all(src, o).map((d) => `${d.line} ${d.severity} ${d.code}`);
/** 直し方を当てた行（当てられなければ null）。 */
const fixed = (line: string, d: Diagnostic) => {
  const r = d.fix ? applyFix(line, d.fix, d.column) : null;
  return r && !r.remove ? r.text : null;
};

describe("日本語入力のまま打った記号", () => {
  it("行頭の全角の ＠ ＃ ／／ を、半角にする直し方つきで警告する", () => {
    const lines = ["＠bg hill.webp", "＃ start", "／／ メモ", "＃１位"];
    const d = all(lines.join("\n")).filter((x) => x.code === "fullwidth-symbol");
    expect(d.map((x) => [x.line, x.severity])).toEqual([
      [1, "warning"],
      [2, "warning"],
      [3, "warning"],
    ]);
    expect(d.map((x) => fixed(lines[x.line - 1]!, x))).toEqual(["@bg hill.webp", "# start", "// メモ"]);
  });

  it("time＝300ms の全角の＝は、名前と値として読み、直し方を付ける（見当違いの誤りを出さない）", () => {
    const d = all("@bg hill.webp time＝300ms");
    expect(d.map((x) => `${x.severity} ${x.code}`)).toEqual(["warning fullwidth-symbol"]);
    expect(fixed("@bg hill.webp time＝300ms", d[0]!)).toBe("@bg hill.webp time=300ms");
  });

  it("@choice の外の選択肢の行を警告する", () => {
    expect(show("- 北へ行く -> #north\n# north")).toEqual(["1 warning option-outside-choice"]);
  });

  it("行末の // は「行末のコメントは書けません」。命令の行は残りだけを読み（見当違いの誤りを重ねない）、本文は警告", () => {
    const lines = ["@bg hill.webp // 夕方", "アカリ「こんにちは」 // 小声で", "- 行く -> #a // メモ", "@open-url https://example.com", "アカリ「a // b」"];
    const d = all(`${lines[0]}\n${lines[1]}\n@choice\n${lines[2]}\n@end\n${lines[3]}\n${lines[4]}\n# a`);
    expect(d.map((x) => `${x.line} ${x.severity} ${x.code}`)).toEqual(["1 error trailing-comment", "2 warning trailing-comment", "4 error trailing-comment"]);
    expect(fixed(lines[0]!, d[0]!)).toBe("@bg hill.webp");
    expect(fixed(lines[1]!, d[1]!)).toBe("アカリ「こんにちは」");
    expect(d[0]!.message).toBe("行末のコメントは書けません");
  });

  it("アカリ：「…」と【アカリ】「…」は unknown-speaker に含め、台詞の形に直す", () => {
    const lines = ["アカリ：「こんにちは」", "【アカリ】「こんにちは」", "アカリ：こんにちは", "店員：「いらっしゃい」", "注意：足元に気をつけて", 'Note: "x"'];
    const d = all(lines.join("\n")).filter((x) => x.code === "unknown-speaker");
    expect(d.map((x) => [x.line, fixed(lines[x.line - 1]!, x)])).toEqual([
      [1, "アカリ「こんにちは」"],
      [2, "アカリ「こんにちは」"],
      [3, "アカリ「こんにちは」"],
      [4, "店員「いらっしゃい」"],
    ]);
    // 登録していない名前は、話者に足す直し方を先頭に
    expect(d[3]!.fixes?.[0]).toEqual({ kind: "add-speaker", name: "店員" });
  });
});

describe("ルビの誤り", () => {
  it("{r 漢字} は「読みの区切り | がありません」にし、{ の閉じ忘れや約物の誤検出を出さない", () => {
    expect(show("アカリ「{r 漢字}だ」")).toEqual(["1 error bad-ruby"]);
    expect(all("アカリ「{r 漢字}だ」")[0]!.message).toBe("ルビの読みの区切り | がありません");
  });

  it("全角の ｜ はルビとして読み、半角にする直し方を付ける", () => {
    const d = all("アカリ「{r 漢字｜かんじ}だ」");
    expect(d.map((x) => x.code)).toEqual(["bad-ruby"]);
    expect(fixed("アカリ「{r 漢字｜かんじ}だ」", d[0]!)).toBe("アカリ「{r 漢字|かんじ}だ」");
    expect(parse("アカリ「{r 漢字｜かんじ}」", "a", { speakers }).body[0]).toMatchObject({ content: [{ kind: "text" }, { kind: "ruby", base: "漢字", reading: "かんじ" }, { kind: "text" }] });
  });

  it("《》のルビと残った TyranoScript のタグを警告し、書き方を直す", () => {
    const lines = ["｜遠野《とおの》の空。", "夕暮《ゆうぐれ》だ。[p]", "改行[r]する[l]", "絵画《星月夜》の構図。"];
    const d = all(lines.join("\n"));
    expect(d.map((x) => `${x.line} ${x.code}`)).toEqual(["1 aozora-ruby", "2 aozora-ruby", "2 tyrano-tag", "3 tyrano-tag", "3 tyrano-tag"]);
    expect(d.map((x) => fixed(lines[x.line - 1]!, x))).toEqual(["{r 遠野|とおの}の空。", "{r 夕暮|ゆうぐれ}だ。[p]", "夕暮《ゆうぐれ》だ。", "改行{br}する[l]", "改行[r]する{click}"]);
  });
});

describe("直し方の質", () => {
  it("話者の無い台詞に「話者に追加」の直し方。ヒントは原文の言語で分ける（英語の作品に全角スペースを案内しない）", () => {
    const ja = all("店員「いらっしゃい」").find((x) => x.code === "unknown-speaker")!;
    expect(ja.fixes).toEqual([{ kind: "add-speaker", name: "店員" }]);
    expect(ja.hint).toContain("全角スペース");
    const en = all('Clerk "Welcome."', { sourceLanguage: "en" }).find((x) => x.code === "unknown-speaker")!;
    expect(en.hint).not.toContain("全角");
    expect(englishDiagnostic(en).hint).toBe("Add Clerk to the speakers (speakers in cast.json) or fix the name's spelling");
  });

  it("無いジャンプ先には「シーンを作る」を先頭に出し、名前の長さに対して違いの大きい置き換えは出さない", () => {
    const stay = all("# start\n@jump #stay").find((x) => x.code === "unknown-label")!;
    expect(stay.fixes).toEqual([{ kind: "add-label", file: "a", label: "stay" }]);
    expect(stay.fix).toBeUndefined();
    const road = all("# north_road\n@jump #nort_road").find((x) => x.code === "unknown-label")!;
    expect(road.fixes).toEqual([{ kind: "add-label", file: "a", label: "nort_road" }, { kind: "replace", find: "#nort_road", with: "#north_road" }]);
  });

  it("別のファイルへの飛び先の綴り違いにも近い名前の案を出す", () => {
    const d = checkProject(new Map([["a", parse("@jump chapter_2#strat\n@jump chapter2", "a")], ["chapter_2", parse("# start", "chapter_2")]])).filter((x) => x.code === "unknown-label" || x.code === "unknown-file");
    expect(d.map((x) => [x.code, x.fix])).toEqual([
      ["unknown-label", { kind: "replace", find: "chapter_2#strat", with: "chapter_2#start" }],
      ["unknown-file", { kind: "replace", find: "chapter2", with: "chapter_2" }],
    ]);
    expect(d[0]!.fixes?.[0]).toEqual({ kind: "add-label", file: "chapter_2", label: "strat" });
  });

  it("ジャンプ先の候補（to=）の無いラベルにも、シーンを作る案と近い名前を出す", () => {
    const d = checkProject(new Map([["a", parse("# north\n@jump (game.go) to=#nort\n", "a")]])).find((x) => x.code === "unknown-label")!;
    expect(d.fixes).toEqual([{ kind: "add-label", file: "a", label: "nort" }]);
    expect(d.hint).toContain("#north");
  });

  it("書き忘れ、余分な値、順番の違う名前なしのパラメータ、変数の型の誤りは、その行を直した形を案にする", () => {
    const hints = (text: string) => all(text).map((x) => x.hint ?? "");
    expect(hints("@bg time=1s")).toContain("image か color を足します: @bg room_night.jpg time=1s");
    expect(hints("@chara-hide time=1s")[0]).toBe("who を足します: @chara-hide ユイカ time=1s");
    expect(hints("@wait 1s 2s")[0]).toBe("2s を外すか、名前を付けて書きます（@wait 1s）");
  });

  it("決まった見本ではなく、その行を直した形を出す（who= を外す、小さな時間には 1s。@let i += 1 は書ける）", () => {
    const cases: [string, string][] = [
      ["@chara who=アカリ", "@chara アカリ"],
      ["@wait 1", "@wait 1s"],
      ["@bg hill.webp time=300", "@bg hill.webp time=300ms"],
    ];
    for (const [line, want] of cases) {
      const d = all(line).find((x) => x.fix);
      expect(d ? fixed(line, d) : null, line).toBe(want);
    }
    expect(all("@let i = 0\n@let i += 1").filter((x) => x.severity === "error")).toEqual([]);
  });
});
