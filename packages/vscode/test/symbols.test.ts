import { describe, expect, it } from "vitest";
import type { CompletionItem, Hover, Location, TextEdit, WorkspaceEdit } from "vscode-languageserver";
import { completions, foldingRanges, hover } from "../src/features.ts";
import { assetLeftMessage, prepareRename, references, renameEdit, workspaceSymbols } from "../src/rename.ts";
import { fixture, start } from "./helpers.ts";

/**
 * 参照の一覧、ワークスペースの記号、式の補完と説明、構文解析からの折りたたみ、名前の変更（シーン以外）。
 * 見本の start.lim の行（0 から）: 4 @bg、5 @chara ユイカ、6 ユイ「…」、8 @title-card、10 レン「待って{@chara ユイカ smile}」、
 * 12〜15 @choice、14 chapter2#south if=(game.trust >= 1)、17 # north_road、18 @if game.trust >= 2、19・21 ユイ「…」、23 @jump chapter2
 */

/** 編集を当てた中身。 */
function apply(text: string, edits: readonly TextEdit[]): string {
  const lines = text.split("\n");
  const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  let out = text;
  for (const e of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))) out = out.slice(0, offset(e.range.start)) + e.newText + out.slice(offset(e.range.end));
  return out;
}

/** 編集の中の、その URI のもの（changes でも documentChanges でも）。 */
function editsOf(edit: WorkspaceEdit, uri: string): TextEdit[] {
  if (edit.changes) return edit.changes[uri] ?? [];
  return (edit.documentChanges ?? []).flatMap((c) => ("textDocument" in c && c.textDocument.uri === uri ? (c.edits as TextEdit[]) : []));
}

const where = (list: Location[]) => list.map((l) => `${l.uri.replace(/^.*\/scenario\//, "")}:${l.range.start.line}:${l.range.start.character}-${l.range.end.character}`).sort();
const markdown = (h: Hover | null) => (h && typeof h.contents === "object" && "value" in h.contents ? h.contents.value : "");
const labelsOf = (list: CompletionItem[]) => list.map((i) => i.label);

describe("素材の名前の変更を始められる所", () => {
  it("@with のマクロの引数と @html の中身の <img src> の上からも始められる（2026-11-19。ほかの書き方と同じ）", async () => {
    const cases: [string, string, string][] = [
      ["@define scene(image: asset(bgimage))\n@content\n@end\n@with scene image=room_ni‸ght.jpg\nあ\n@end", "bgimage", "room_night.jpg"],
      ['@html notice\n<div><img src="mar‸k.png"></div>\n@end', "image", "mark.png"],
    ];
    for (const [text, , name] of cases) {
      const { project, pos } = await start(text);
      const r = prepareRename(project, "start", pos);
      expect(r, text).toMatchObject({ placeholder: name, range: { start: { line: pos.line } } });
      const line = text.replace("‸", "").split("\n")[pos.line]!;
      expect(line.slice(r!.range.start.character, r!.range.end.character), text).toBe(name);
    }
  });
});

describe("参照の一覧", () => {
  it("シーン、ファイル、マクロ、変数、キャラクター、話者、素材", async () => {
    const { project } = await fixture();
    const at = (line: number, character: number, decl = true) => where(references(project, "start", { line, character }, decl));
    expect(at(17, 4)).toEqual(["start.lim:13:13-23", "start.lim:17:2-12"]);
    expect(at(17, 4, false)).toEqual(["start.lim:13:13-23"]);
    expect(at(23, 8)).toEqual(["chapter2.lim:0:0-0", "start.lim:14:12-20", "start.lim:23:6-14"]);
    expect(at(8, 3)).toEqual(["common.lim:1:8-18", "start.lim:8:1-11"]);
    expect(at(18, 6)).toEqual(["start.lim:14:31-41", "start.lim:18:4-14"]);
    expect(at(5, 8)).toEqual(["start.lim:10:14-17", "start.lim:5:7-10"]);
    expect(at(6, 0)).toEqual(["start.lim:19:0-2", "start.lim:21:0-2", "start.lim:6:0-2"]);
    expect(at(4, 6)).toEqual(["start.lim:4:4-18"]);
    // 本文には何もない
    expect(at(7, 3)).toEqual([]);
  });
});

describe("ワークスペースの記号", () => {
  it("すべてのシナリオのシーンと @define を、名前で絞って返す", async () => {
    const { project } = await fixture();
    const all = workspaceSymbols(project, "");
    expect(all.map((s) => `${s.containerName} ${s.name}`)).toEqual(expect.arrayContaining(["start # start", "start # north_road", "chapter2 # south", "common # interlude", "common @title-card"]));
    expect(workspaceSymbols(project, "SOU").map((s) => s.name)).toEqual(["# south"]);
    expect(workspaceSymbols(project, "title")[0]).toMatchObject({ name: "@title-card", location: { range: { start: { line: 1, character: 8 } } } });
  });
});

describe("式の補完と説明", () => {
  it("@if・{= …}・(…) の中に変数と式の関数", async () => {
    const v = await start("@set game.trust = 1\n@if game.‸");
    const vars = labelsOf(completions(v.project, "start", v.pos));
    expect(vars).toEqual(expect.arrayContaining(["game.trust", "system.cg_unlocked"]));
    const s = await start("@if vi‸");
    const fn = completions(s.project, "start", s.pos).find((i) => i.label === "visits");
    expect(fn?.detail).toBe('visits("#ラベル") / visits("ファイル#ラベル") / visits("ファイル")');
    expect(fn?.textEdit && "newText" in fn.textEdit ? fn.textEdit.newText : "").toBe('visits("$1")');
    const inValue = await start("@set game.trust = 1\nユイ「{= game.‸}」");
    expect(labelsOf(completions(inValue.project, "start", inValue.pos))).toContain("game.trust");
    const inParen = await start("@set game.trust = 1\n@bg room_night.jpg time=(game.‸");
    expect(labelsOf(completions(inParen.project, "start", inParen.pos))).toContain("game.trust");
    // 英語の表示では関数の書き方も英語
    expect(completions(s.project, "start", s.pos, "en").find((i) => i.label === "visits")?.detail).toBe('visits("#label") / visits("file#label") / visits("file")');
  });

  it('item("…") に持ち物の名前、visits("…") にジャンプ先', async () => {
    const item = await start('@if item("‸") > 0');
    expect(completions(item.project, "start", item.pos)).toEqual([expect.objectContaining({ label: "key", detail: "持ち物: 鍵" })]);
    const visits = await start("# a\n# b\n@if visits(\"#‸\") > 1");
    expect(labelsOf(completions(visits.project, "start", visits.pos))).toEqual(["#a", "#b"]);
    const other = await start('@if read("chapter2#‸")');
    expect(labelsOf(completions(other.project, "start", other.pos))).toEqual(["chapter2#south"]);
  });

  it("関数、変数、持ち物、ジャンプ先の説明", async () => {
    const at = async (text: string) => {
      const { project, pos } = await start(text);
      return markdown(hover(project, "start", pos));
    };
    expect(await at('@if visi‸ts("#a")')).toContain("**visits** — 式の関数");
    expect(await at("@if game.tr‸ust >= 2")).toContain("**game.trust** — 変数");
    expect(await at("@if game.tr‸ust >= 2")).toContain("初期値なし");
    expect(await at('@if item("ke‸y") > 0')).toContain("**持ち物: 鍵**\n\n古い真鍮の鍵");
    expect(await at('# a\n@if visits("#‸a") > 0')).toContain("start 1 行目");
    const { project, pos } = await start("@if game.tr‸ust >= 2");
    project.update({ ...project.input, config: { ...project.input.config, variables: { "game.trust": 0 } } });
    expect(markdown(hover(project, "start", pos))).toContain("初期値 `0`");
    expect(markdown(hover(project, "start", pos, "en"))).toContain("Initial value `0`");
  });

  it("@while、@with、@content を補完し、@end の説明は閉じるものを並べる", async () => {
    const s = await start("@‸");
    const list = completions(s.project, "start", s.pos);
    expect(labelsOf(list)).toEqual(expect.arrayContaining(["while", "with", "content", "end"]));
    expect(list.find((i) => i.label === "end")?.detail).toBe("@if、@while、@with、@choice、@define、@script と、中身を持つコマンド（@html、file= の無い @staff-roll）を閉じる");
  });
});

describe("折りたたみ", () => {
  it("シーン、@choice、@if の枝ごと、@define、@while、@with、@html、続いた // の行", async () => {
    const { project } = await fixture();
    const of = (file: string) => foldingRanges(project, file).map((r) => `${r.startLine}-${r.endLine}${r.kind ? ` ${r.kind}` : ""}`);
    expect(of("start")).toEqual(["3-15 region", "12-14", "17-23 region", "18-19", "20-21"]);
    expect(of("common")).toEqual(["1-3", "6-7 region"]);
    const s = await start("// 一\n// 二\n# a\n@while temp.n < 2\n@set temp.n += 1\n@end\n@with frame\n本文\n@end\n@html\n<p>x</p>\n@end\n\n// 次のシーン\n# b\n本文");
    expect(foldingRanges(s.project, "start").map((r) => `${r.startLine}-${r.endLine}${r.kind ? ` ${r.kind}` : ""}`)).toEqual(["0-1 comment", "2-11 region", "3-4", "6-7", "9-10", "14-15 region"]);
  });
});

describe("名前の変更（シーン以外）", () => {
  const cast = { uri: "file:///p/cast.json", text: '{\n  "speakers": ["ユイ", "レン"],\n  "cast": {\n    "ユイカ": { "speaker": "ユイ", "appearances": {} }\n  }\n}\n' };

  it("名前の上でだけ準備でき、範囲と今の名前を返す", async () => {
    const { project } = await fixture();
    expect(prepareRename(project, "start", { line: 18, character: 6 })).toMatchObject({ placeholder: "game.trust", range: { start: { line: 18, character: 4 } } });
    expect(prepareRename(project, "start", { line: 14, character: 16 })).toMatchObject({ placeholder: "chapter2" });
    expect(prepareRename(project, "start", { line: 14, character: 24 })).toMatchObject({ placeholder: "south" });
    expect(prepareRename(project, "start", { line: 7, character: 3 })).toBeNull();
  });

  it("変数: 台本と liminalia.json の初期値と条件", async () => {
    const { project } = await fixture();
    const config = { uri: "file:///p/liminalia.json", text: '{\n  "variables": { "game.trust": 0 },\n  "ui": { "title": { "if": "game.trust > 1" } }\n}\n' };
    const r = renameEdit(project, "start", { line: 18, character: 6 }, "game.faith", "ja", { config });
    if (!("edit" in r)) throw new Error(r.error);
    const text = apply(project.input.files.get("start")!.text, editsOf(r.edit, project.input.files.get("start")!.uri));
    expect(text).toContain("if=(game.faith >= 1)");
    expect(text).toContain("@if game.faith >= 2");
    expect(JSON.parse(editsOf(r.edit, config.uri)[0]!.newText)).toEqual({ variables: { "game.faith": 0 }, ui: { title: { if: "game.faith > 1" } } });
    expect(renameEdit(project, "start", { line: 18, character: 6 }, "faith", "ja")).toEqual({ error: "変数名は game.名前、system.名前、temp.名前 のどれかの形で指定します: faith" });
  });

  it("キャラクター: 行の命令と本文の中の {@chara …}、cast.json", async () => {
    const { project } = await fixture();
    const r = renameEdit(project, "start", { line: 5, character: 8 }, "yuika", "ja", { cast });
    if (!("edit" in r)) throw new Error(r.error);
    const text = apply(project.input.files.get("start")!.text, editsOf(r.edit, project.input.files.get("start")!.uri));
    expect(text).toContain("@chara yuika normal at=left");
    expect(text).toContain("{@chara yuika smile}");
    expect(Object.keys(JSON.parse(editsOf(r.edit, cast.uri)[0]!.newText).cast)).toEqual(["yuika"]);
    expect(renameEdit(project, "start", { line: 5, character: 8 }, "a b", "en")).toEqual({ error: "Not a usable name: a b" });
  });

  it("話者: 台詞の行頭と cast.json の speakers と話者", async () => {
    const { project } = await fixture();
    const r = renameEdit(project, "start", { line: 6, character: 1 }, "結衣", "ja", { cast });
    if (!("edit" in r)) throw new Error(r.error);
    const text = apply(project.input.files.get("start")!.text, editsOf(r.edit, project.input.files.get("start")!.uri));
    expect(text.match(/^結衣「/gm)).toHaveLength(3);
    expect(JSON.parse(editsOf(r.edit, cast.uri)[0]!.newText)).toMatchObject({ speakers: ["結衣", "レン"], cast: { ユイカ: { speaker: "結衣" } } });
    expect(renameEdit(project, "start", { line: 6, character: 1 }, "レン", "ja")).toHaveProperty("error");
  });

  it("マクロ: @define と呼び出し。組み込みの命令と同じ名前は断る", async () => {
    const { project } = await fixture();
    const r = renameEdit(project, "start", { line: 8, character: 3 }, "heading", "ja");
    if (!("edit" in r)) throw new Error(r.error);
    expect(apply(project.input.files.get("common")!.text, editsOf(r.edit, project.input.files.get("common")!.uri))).toContain("@define heading(text: string");
    expect(apply(project.input.files.get("start")!.text, editsOf(r.edit, project.input.files.get("start")!.uri))).toContain("@heading text=第一章");
    expect(renameEdit(project, "start", { line: 8, character: 3 }, "bg", "ja")).toEqual({ error: "@bg は組み込みかプラグインのコマンドと同じ名前です" });
  });

  it("ファイル: ジャンプ先を書き換え、.lim の名前と変更履歴のフォルダも変える", async () => {
    const { project } = await fixture();
    const scenarioUri = (n: string) => `file:///p/scenario/${n}.lim`;
    const r = renameEdit(project, "start", { line: 23, character: 8 }, "part2", "ja", { scenarioUri, history: { uri: (n) => `file:///p/.liminalia/history/${n}`, has: (n) => n === "chapter2" } });
    if (!("edit" in r)) throw new Error(r.error);
    const text = apply(project.input.files.get("start")!.text, editsOf(r.edit, project.input.files.get("start")!.uri));
    expect(text).toContain("-> part2#south");
    expect(text).toContain("@jump part2");
    expect(r.edit.documentChanges!.filter((c) => "kind" in c)).toEqual([
      { kind: "rename", oldUri: "file:///p/scenario/chapter2.lim", newUri: "file:///p/scenario/part2.lim", options: { ignoreIfExists: true } },
      { kind: "rename", oldUri: "file:///p/.liminalia/history/chapter2", newUri: "file:///p/.liminalia/history/part2", options: { ignoreIfExists: true } },
    ]);
    expect(renameEdit(project, "start", { line: 23, character: 8 }, "common", "ja")).toEqual({ error: "common.lim はすでにあります" });
  });

  it("素材: 台本の参照を書き換え、ファイルの名前も変える。拡張子は変えられない", async () => {
    const { project } = await fixture();
    const files = { assetUri: (f: string, p: string) => `file:///p/assets/${f}/${p}`, assetExists: (f: string, p: string) => f === "bgimage" && p === "room_night.jpg" };
    const r = renameEdit(project, "start", { line: 4, character: 6 }, "night.jpg", "ja", files);
    if (!("edit" in r)) throw new Error(r.error);
    expect(apply(project.input.files.get("start")!.text, editsOf(r.edit, project.input.files.get("start")!.uri))).toContain("@bg night.jpg time=1s");
    expect(r.edit.documentChanges!.filter((c) => "kind" in c)).toEqual([{ kind: "rename", oldUri: "file:///p/assets/bgimage/room_night.jpg", newUri: "file:///p/assets/bgimage/night.jpg", options: { ignoreIfExists: true } }]);
    expect(renameEdit(project, "start", { line: 4, character: 6 }, "night.png", "ja", files)).toHaveProperty("error");
  });

  it("素材: 書き換えられなかった所（式に渡す文字など）を手で直す所に返し、知らせの文にする", async () => {
    const { project, pos } = await start('# a\n@bg room_nigh‸t.jpg\n@set game.pic = "room_night.jpg"\n');
    const r = renameEdit(project, "start", pos, "night.jpg", "ja");
    if (!("edit" in r)) throw new Error(r.error);
    expect(apply(project.input.files.get("start")!.text, editsOf(r.edit, project.input.files.get("start")!.uri))).toContain("@bg night.jpg");
    expect(r.left).toEqual([{ in: "script", file: "start", line: 3 }]);
    expect(assetLeftMessage(r.left!, "ja")).toBe("書き換えられなかった参照が 1 か所あります（式に渡す文字、データ、訳、テンプレート、プラグインの中など）。手で直してください: start.lim:3");
    const many = Array.from({ length: 12 }, (_, i) => ({ in: "script" as const, file: "start", line: i + 1 }));
    expect(assetLeftMessage(many, "en")).toMatch(/^12 references couldn't be rewritten .*: start\.lim:1, start\.lim:2, .*start\.lim:10, and 2 more$/);
  });
});
