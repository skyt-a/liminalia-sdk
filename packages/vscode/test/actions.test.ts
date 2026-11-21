import { collectTranslatable, parse, voiceLines } from "@liminalia/lang";
import { d } from "@liminalia/sdk";
import { describe, expect, it } from "vitest";
import type { Diagnostic as LspDiagnostic, TextEdit } from "vscode-languageserver";
import { formatEdits, labelAt, playTarget, quickFixes, renameLabelEdit } from "../src/actions.ts";
import { toLspDiagnostic } from "../src/features.ts";
import { fixture, start } from "./helpers.ts";

/** 編集を当てた中身。 */
function apply(text: string, edits: readonly TextEdit[]): string {
  const lines = text.split("\n");
  const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  let out = text;
  for (const e of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))) out = out.slice(0, offset(e.range.start)) + e.newText + out.slice(offset(e.range.end));
  return out;
}

describe("整形", () => {
  it("lim fmt と同じに命令の行を整え、構文エラーがあれば理由を返す", async () => {
    const text = "# start\n@bg   room_night.jpg    time=1s\n地の文\n";
    const { project } = await start(text);
    const r = formatEdits(project, "start", text);
    expect("edits" in r && apply(text, r.edits)).toBe("# start\n@bg room_night.jpg time=1s\n地の文\n");
    const same = formatEdits(project, "start", "# start\n地の文\n");
    expect("edits" in same && same.edits).toEqual([]);
    const { project: broken } = await start("@if\n");
    expect(formatEdits(broken, "start", "@if\n")).toHaveProperty("error");
  });
});

describe("Quick Fix", () => {
  it("診断の直し方を、その行がまだ同じときだけ当てる", async () => {
    const text = "# start\n@bg room_night.jpg timee=1s\n";
    const { project } = await start(text);
    const lsp: LspDiagnostic[] = project
      .diagnostics()
      .filter((d) => d.file === "start" && d.fix)
      .map((d) => toLspDiagnostic(d, project.lines("start")));
    expect(lsp.length).toBeGreaterThan(0);
    const actions = quickFixes(project, "start", "file:///start.lim", lsp, "ja");
    expect(actions.length).toBe(lsp.length);
    const edits = actions[0]!.edit!.changes!["file:///start.lim"]!;
    expect(apply(text, edits)).not.toBe(text);
    expect(actions[0]!.kind).toBe("quickfix");
    expect(quickFixes(project, "start", "file:///start.lim", lsp, "en")[0]!.title).toMatch(/^(Change|Delete)/);
    // 置き換える先が空の直し方（余分な値を外す）は、外すものを名前にする
    const extra = await start("# start\n@mask 600ms 1s\n");
    const extraLsp = extra.project
      .diagnostics()
      .filter((d) => d.file === "start" && d.code === "too-many-positional")
      .map((d) => toLspDiagnostic(d, extra.project.lines("start")));
    expect(quickFixes(extra.project, "start", "u", extraLsp, "ja").map((a) => a.title)).toEqual(["「1s」を削除"]);
    expect(quickFixes(extra.project, "start", "u", extraLsp, "en").map((a) => a.title)).toEqual(['Remove "1s"']);
    // 行が変わっていれば出さない
    const { project: changed } = await start("# start\n地の文\n");
    expect(quickFixes(changed, "start", "u", lsp, "ja")).toEqual([]);
  });
});

describe("シーンの名前の変更", () => {
  it("ラベルの行とジャンプ先から、ほかのファイルの参照まで書き換える", async () => {
    const { project } = await fixture();
    const at = labelAt(project, "start", { line: 17, character: 4 });
    expect(at).toMatchObject({ file: "start", label: "north_road" });
    // 選択肢のジャンプ先からも
    expect(labelAt(project, "start", { line: 13, character: 18 })).toMatchObject({ label: "north_road" });
    const r = renameLabelEdit(project, "start", { line: 13, character: 18 }, "kita", "ja");
    expect("edit" in r).toBe(true);
    const changes = "edit" in r ? r.edit.changes! : {};
    const startUri = project.input.files.get("start")!.uri;
    const next = apply(project.input.files.get("start")!.text, changes[startUri]!);
    expect(next).toContain("# kita");
    expect(next).toContain("-> #kita");
    // ほかのファイルのラベル（chapter2#south）
    const south = renameLabelEdit(project, "start", { line: 14, character: 22 }, "minami", "ja");
    const ch2 = project.input.files.get("chapter2")!;
    expect("edit" in south && apply(ch2.text, south.edit.changes![ch2.uri]!)).toContain("# minami");
    expect("edit" in south && apply(project.input.files.get("start")!.text, south.edit.changes![startUri]!)).toContain("chapter2#minami");
    expect(renameLabelEdit(project, "start", { line: 17, character: 4 }, "a b", "ja")).toHaveProperty("error");
    expect(renameLabelEdit(project, "start", { line: 17, character: 4 }, "start", "ja")).toHaveProperty("error");
    expect(labelAt(project, "start", { line: 6, character: 2 })).toBeNull();
  });

  it("liminalia.json の entry も書き換える", async () => {
    const { project } = await fixture();
    const config = { uri: "file:///liminalia.json", text: '{\n  "entry": "start#start"\n}\n' };
    const r = renameLabelEdit(project, "start", { line: 3, character: 3 }, "begin", "ja", { config });
    expect("edit" in r && JSON.parse(r.edit.changes![config.uri]![0]!.newText)).toEqual({ entry: "start#begin" });
  });

  it("制作画面と同じく、訳の鍵・ボイスの番号の固定・レビューのコメント・カードの位置・作品のデータ・基準の画像も付け替える", async () => {
    const text = ["# start", "ユイ「待って{@sleep-game target=#north_road}」", "　地の文{@sleep-game target=#north_road}", "@jump #north_road", "# north_road", "　着いた。"].join("\n");
    const { project } = await start(text);
    const before = parse(text, "start", { speakers: ["ユイ", "レン", "？？？"] });
    const say = collectTranslatable(before).find((x) => x.line === 2)!;
    const prose = collectTranslatable(before).find((x) => x.line === 3)!;
    const voice = voiceLines(before).find((x) => x.line === 2)!;
    const translations = { uri: "file:///p/lang/en.json", text: JSON.stringify({ language: "en", lines: { [say.key]: { source: say.source, text: "Wait{@sleep-game target=#north_road}" }, [prose.key]: { source: prose.source, text: "Prose.", contexts: { start: "Prose in start." } } } }) };
    const voiceLock = { uri: "file:///p/voice-lock.json", text: JSON.stringify({ lines: { [voice.key]: { speaker: "ユイ", n: 3, source: voice.source } } }) };
    const review = { uri: "file:///p/reviews/r1.json", text: JSON.stringify({ id: "r1", file: "start", line: 4, text: "@jump #north_road", hash: "h", resolved: false, comments: [] }) };
    const other = { uri: "file:///p/reviews/r2.json", text: JSON.stringify({ id: "r2", file: "start", line: 6, text: "　着いた。", hash: "h", resolved: false, comments: [] }) };
    const studioState = { uri: "file:///p/.liminalia/studio.json", text: JSON.stringify({ mapPositions: { "start#north_road": { x: 1, y: 2 }, "start#start": { x: 3, y: 4 } } }) };
    const data = { decl: { file: "stamps.json", title: "スタンプ", root: d.map(d.record({ scene: d.scene("場面") })) }, file: { uri: "file:///p/data/stamps.json", text: '{\n\t"a": { "scene": "start#north_road" }\n}\n' } };
    const r = renameLabelEdit(project, "start", { line: 4, character: 3 }, "kita", "ja", {
      translations: [translations],
      voiceLock,
      reviews: [review, other],
      studioState,
      data: [data],
      baselines: { folder: "file:///p/.liminalia/regress/baseline", names: ["start_north_road.png", "start_north_road~2.png", "start_start.png"] },
    });
    if (!("edit" in r)) throw new Error(r.error);
    const docs = r.edit.documentChanges!;
    const edits = (uri: string) => docs.flatMap((c) => ("textDocument" in c && c.textDocument.uri === uri ? c.edits : [])) as TextEdit[];
    const startUri = project.input.files.get("start")!.uri;
    const next = apply(text, edits(startUri));
    expect(next).toContain("# kita");
    const after = parse(next, "start", { speakers: ["ユイ", "レン", "？？？"] });
    const say2 = collectTranslatable(after).find((x) => x.line === 2)!;
    const prose2 = collectTranslatable(after).find((x) => x.line === 3)!;
    const en = JSON.parse(edits(translations.uri)[0]!.newText) as { lines: Record<string, { text: string; contexts?: Record<string, string> }> };
    expect(Object.keys(en.lines).sort()).toEqual([say2.key, prose2.key].sort());
    expect(en.lines[say2.key]!.text).toBe("Wait{@sleep-game target=#kita}");
    expect(en.lines[prose2.key]!.contexts).toEqual({ start: "Prose in start." });
    const lock = JSON.parse(edits(voiceLock.uri)[0]!.newText) as { lines: Record<string, { n: number; source: string }> };
    expect(lock.lines).toEqual({ [voiceLines(after).find((x) => x.line === 2)!.key]: { speaker: "ユイ", n: 3, source: voiceLines(after).find((x) => x.line === 2)!.source } });
    expect(JSON.parse(edits(review.uri)[0]!.newText)).toMatchObject({ id: "r1", line: 4, text: "@jump #kita" });
    expect(edits(other.uri)).toEqual([]);
    expect(Object.keys((JSON.parse(edits(studioState.uri)[0]!.newText) as { mapPositions: object }).mapPositions).sort()).toEqual(["start#kita", "start#start"]);
    expect(edits(data.file.uri)[0]!.newText).toBe('{\n\t"a": {\n\t\t"scene": "start#kita"\n\t}\n}\n');
    expect(docs.filter((c) => "kind" in c)).toEqual([
      { kind: "rename", oldUri: "file:///p/.liminalia/regress/baseline/start_north_road.png", newUri: "file:///p/.liminalia/regress/baseline/start_kita.png", options: { ignoreIfExists: true } },
      { kind: "rename", oldUri: "file:///p/.liminalia/regress/baseline/start_north_road~2.png", newUri: "file:///p/.liminalia/regress/baseline/start_kita~2.png", options: { ignoreIfExists: true } },
    ]);
  });
});

describe("ここからテストプレイ", () => {
  it("カーソルのシーンと、そこまでのページの数", async () => {
    const { project } = await fixture();
    expect(playTarget(project, "start", 7)).toEqual({ start: "start#start", skip: 2 });
    expect(playTarget(project, "start", 3)).toEqual({ start: "start#start", skip: 0 });
    expect(playTarget(project, "start", 20)).toEqual({ start: "start#north_road", skip: 1 });
    expect(playTarget(project, "start", 0)).toEqual({ start: "start", skip: 0 });
  });
});
