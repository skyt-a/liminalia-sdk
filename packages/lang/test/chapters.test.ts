import { describe, expect, it } from "vitest";
import { chapterOf, checkChapters, checkExtra, checkProject, CORE_COMMANDS, createRegistry, englishDiagnostic, extraWithChapters, parse, type ChapterInfo, type CommandSpec, type Diagnostic } from "../src/index.ts";

const chapters: ChapterInfo[] = [
  { id: "prologue", number: "序章", title: "はじまり", files: ["prologue_*"] },
  { id: "ep1", number: "第一章", title: "星を待つ丘", subtitle: "THE HILL OF STARS", files: ["chapter1_*", "side1"], cover: "covers/ch1.png" },
  { id: "ep2", title: "二章", files: ["chapter2_*"] },
];

describe("章の情報（liminalia.json の chapters）", () => {
  it("シナリオファイル（と実行単位）から章を引く。前に書いた章が優先する", () => {
    expect(chapterOf(chapters, "chapter1_3")?.id).toBe("ep1");
    expect(chapterOf(chapters, "side1::title-card")?.cover).toBe("covers/ch1.png");
    expect(chapterOf(chapters, "prologue_0")?.number).toBe("序章");
    expect(chapterOf(chapters, "chapter10_1")).toBeNull();
    expect(chapterOf(undefined, "chapter1_1")).toBeNull();
  });

  it("形の誤りはエラー、当たらない files と二つの章に入るファイルは警告", () => {
    const files = ["prologue_0", "chapter1_1", "side1", "chapter2_1"];
    expect(checkChapters(chapters, files)).toEqual([]);
    expect(checkChapters({}, files).map((d) => d.code)).toEqual(["bad-chapters"]);
    const d = checkChapters([{ id: "a", title: "A", files: ["chapter1_*", "nothing*"] }, { id: "a", files: [1] }, { id: "b", title: "B", number: 2, files: ["chapter1_1"] }, { title: "x" }], files);
    expect(d.map((x) => [x.severity, x.message])).toEqual([
      ["warning", "chapters a の files の nothing* に当たるシナリオファイルがありません"],
      ["error", "chapters の id a が重複しています"],
      ["error", "chapters a に title（題）がありません"],
      ["error", "chapters a の files はシナリオファイルの名前の配列で書きます（* は任意の文字の並び）"],
      ["error", "chapters b の number は文字列で書きます"],
      ["warning", "シナリオファイル chapter1_1 が章 a と b の両方に入っています（前の a とみなします）"],
      ["error", "chapters に id のないものがあります"],
    ]);
  });

  it("おまけの CG の chapter は章の見出しを group にし、章選択の title を省けば章の題で補う", () => {
    const extra = { cg: [{ id: "a", chapter: "ep1", images: ["a.png"] }, { id: "b", chapter: "ep2", images: ["b.png"] }, { id: "c", chapter: "ep1", group: "別", images: ["c.png"] }], chapters: [{ id: "ep1", title: "", target: "chapter1_1" }] };
    const out = extraWithChapters(extra as never, chapters)!;
    expect(out.cg!.map((c) => c.group)).toEqual(["第一章", "二章", "別"]);
    expect(out.chapters![0]!.title).toBe("星を待つ丘");
    const scripts = new Map([["chapter1_1", parse("本文", "chapter1_1")]]);
    expect(checkExtra(extra, scripts, undefined, chapters).filter((x) => x.code === "bad-extra")).toEqual([]);
    expect(checkExtra({ cg: [{ id: "a", chapter: "ep9", images: ["a.png"] }], chapters: [{ id: "x", target: "chapter1_1" }] }, scripts, undefined, chapters).map((x) => x.message)).toEqual([
      "extra.cg a の chapter ep9 が liminalia.json の chapters にありません",
      "extra.chapters x に title がありません",
    ]);
  });
});

// 実際の @chapter-card と @chapter-end は @liminalia/std のコマンド。ここでは検査に要る形だけの仕様を置く
const CARD = (name: string): CommandSpec => ({
  name,
  summary: "",
  positional: [],
  params: { number: { type: { kind: "string" }, doc: "" }, title: { type: { kind: "string" }, doc: "" }, subtitle: { type: { kind: "string" }, doc: "" } },
  example: "",
});
const registry = createRegistry(CORE_COMMANDS, [CARD("chapter-card"), CARD("chapter-end")]);
const project = (files: Record<string, string>, o: { chapters?: unknown; references?: string[] } = {}) =>
  checkProject(new Map(Object.entries(files).map(([name, src]) => [name, parse(src, name)])), { registry, references: o.references ?? ["start"], ...(o.chapters !== undefined ? { chapters: o.chapters } : {}) });
const show = (d: Diagnostic[], code: string) => d.filter((x) => x.code === code).map((x) => `${x.file}:${x.line} ${x.severity}`);

describe("章の扉と章末に出すものが無い", () => {
  it("番号も題も書かず、どの章にも入らないシナリオの @chapter-card と @chapter-end を警告する", () => {
    const d = project({ start: "@chapter-card\n@chapter-end\n@chapter-card number=第一章\n本文" }, { chapters });
    expect(show(d, "chapter-card-empty")).toEqual(["start:1 warning", "start:2 warning"]);
    expect(d.find((x) => x.code === "chapter-card-empty")!.message).toBe("@chapter-card に番号も題も無く、start はどの章（liminalia.json の chapters）にも入っていないため、何も書かれていない扉が出ます");
    expect(englishDiagnostic(d.find((x) => x.code === "chapter-card-empty")!).message).toBe(
      "@chapter-card has no number or title, and start isn't in any chapter (chapters in liminalia.json), so a blank card appears",
    );
  });

  it("章に入るシナリオなら章から補うので知らせない。マクロの中は、マクロを書いたシナリオの章で見る", () => {
    expect(show(project({ start: "@jump chapter1_1", chapter1_1: "@chapter-card\n本文" }, { chapters }), "chapter-card-empty")).toEqual([]);
    expect(show(project({ start: "@use parts\n@open\n本文", parts: "@define open()\n@chapter-card\n@end" }, { chapters }), "chapter-card-empty")).toEqual(["parts:2 warning"]);
  });
});

describe("章に入っていないシナリオ", () => {
  it("章を使う作品で、はじめから届き、本文があるのにどの章にも入らないシナリオを情報で知らせる", () => {
    const files = { start: "@jump chapter1_1", chapter1_1: "本文\n@call radio\n@jump episode4", radio: "ラジオの声\n@return", episode4: "本文", parts: "@define x()\n@end", unused: "本文" };
    const d = project(files, { chapters });
    expect(show(d, "not-in-chapter")).toEqual(["radio:1 info", "episode4:1 info"]);
    const one = d.find((x) => x.code === "not-in-chapter" && x.file === "episode4")!;
    expect(one.message).toBe("シナリオ episode4 はどの章（liminalia.json の chapters）にも入っていません（このシナリオのあいだ、セーブスロットの章の見出しと式の chapter() が空になります）");
    expect(one.hint).toBe("liminalia.json の chapters のどれかの files に episode4 を足します。章に入れないなら、このファイルの先頭に // lim-ignore-file not-in-chapter を書きます");
    expect(englishDiagnostic(one).message).toBe(
      "The script file episode4 isn't in any chapter (chapters in liminalia.json), so the chapter heading in save slots and chapter() in expressions are empty while it plays",
    );
  });

  it("章を使わない作品では知らせない。下書きは見ず、マクロの中から移る先も届く先に数える", () => {
    expect(show(project({ start: "本文\n@jump side", side: "本文" }), "not-in-chapter")).toEqual([]);
    const files = { start: "@use parts\n本文\n@go\n@jump draft", parts: "@define go()\n@jump side\n@end", side: "本文", draft: "// lim: draft\n本文" };
    expect(show(project(files, { chapters }), "not-in-chapter")).toEqual(["start:1 info", "side:1 info"]);
    // ファイルの頭のコメントの後の、最初の文の行に出す
    expect(show(project({ start: "// 説明\n// 説明\n本文" }, { chapters }), "not-in-chapter")).toEqual(["start:3 info"]);
  });
});
