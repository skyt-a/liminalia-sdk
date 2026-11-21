import { describe, expect, it } from "vitest";
import { checkDraftStarts, checkProject, checkSeverityConfig, configValueProblems, CORE_COMMANDS, createRegistry, ignoreLineEdit, isDraftSource, parse, placeConfigLines, setDraftSource, suppressDiagnostics, type Diagnostic, type Script } from "../src/index.ts";

const registry = createRegistry(CORE_COMMANDS);
const project = (files: Record<string, string>) => new Map<string, Script>(Object.entries(files).map(([name, text]) => [name, parse(text, name)]));
const short = (list: readonly Diagnostic[]) => list.map((d) => `${d.file}:${d.line} ${d.severity} ${d.code}`);

describe("診断を黙らせる（// lim-ignore と check.severity）", () => {
  it("// lim-ignore は、間のコメントの行を越えて次の行に効き、書いた code の警告と情報だけを黙らせる", () => {
    const a = ["# start", "@jump #next", "// lim-ignore unreachable-line", "//! 演技のメモ", "届かない", "# next", "@stop"].join("\n");
    const scripts = project({ a });
    expect(scripts.get("a")!.ignores).toEqual([{ line: 3, target: 5, codes: ["unreachable-line"], text: "// lim-ignore unreachable-line" }]);
    const all = checkProject(scripts, { registry });
    expect(short(all)).toContain("a:5 warning unreachable-line");
    expect(short(suppressDiagnostics(all, { scripts, reportUnused: true })).filter((d) => d.startsWith("a:"))).toEqual([]);
  });

  it("code を書かなければその行の警告と情報のすべて。エラーは黙らせず、使われなかったことを情報で知らせる", () => {
    const a = ["# start", "// lim-ignore", "それは…", "// lim-ignore unknown-command", "@nope"].join("\n");
    const scripts = project({ a });
    const all = checkProject(scripts, { registry });
    expect(short(all)).toEqual(expect.arrayContaining(["a:3 info single-ellipsis", "a:5 error unknown-command"]));
    const shown = suppressDiagnostics(all, { scripts, reportUnused: true });
    expect(short(shown)).toEqual(["a:5 error unknown-command", "a:4 info unused-ignore"]);
    const unused = shown.find((d) => d.code === "unused-ignore")!;
    expect(unused.message).toContain("エラーを黙らせられません");
    expect(unused.fix).toEqual({ kind: "delete-line", text: "// lim-ignore unknown-command" });
  });

  it("// lim-ignore-file はファイル全体に効く。何も黙らせなければ unused-ignore（全体を見るときだけ）", () => {
    const a = ["// lim-ignore-file unreachable-line", "@jump b", "届かない", "// lim-ignore unused-label", "地の文"].join("\n");
    const scripts = project({ a, b: "x" });
    const shown = suppressDiagnostics(checkProject(scripts, { registry }), { scripts, reportUnused: true });
    expect(short(shown)).toEqual(["a:4 info unused-ignore"]);
    expect(short(suppressDiagnostics(checkProject(scripts, { registry }), { scripts }))).toEqual([]);
  });

  it("check.severity は code ごとに重さを替え、off は出さない。エラーは替えない", () => {
    const list: Diagnostic[] = [
      { severity: "info", code: "unused-label", message: "x", file: "a", line: 1 },
      { severity: "warning", code: "single-ellipsis", message: "x", file: "a", line: 2 },
      { severity: "error", code: "unknown-label", message: "x", file: "a", line: 3 },
    ];
    expect(short(suppressDiagnostics(list, { severity: { "unused-label": "error", "single-ellipsis": "off", "unknown-label": "off" } }))).toEqual(["a:1 error unused-label", "a:3 error unknown-label"]);
    expect(checkSeverityConfig({ "unused-label": "quiet" }).map((d) => d.code)).toEqual(["bad-config"]);
    expect(checkSeverityConfig(["off"]).map((d) => d.code)).toEqual(["bad-config"]);
    expect(checkSeverityConfig({ "unused-label": "off" })).toEqual([]);
  });

  it("別の検査でしか判定できない指定は未使用と誤報せず、その検査の結果には通常どおり適用する", () => {
    const scripts = project({ a: "// lim-ignore text-overflow\n長い本文\n// lim-ignore single-ellipsis\n普通の本文" });
    const options = { scripts, reportUnused: true, externalCodes: new Set(["text-overflow"]) };
    expect(short(suppressDiagnostics([], options))).toEqual(["a:3 info unused-ignore"]);
    const overflow: Diagnostic[] = [{ severity: "warning", code: "text-overflow", message: "x", file: "a", line: 2 }];
    expect(suppressDiagnostics(overflow, { scripts })).toEqual([]);
    expect(suppressDiagnostics(overflow, { severity: { "text-overflow": "off" } })).toEqual([]);
  });

  it("「この行では出さない」は前に lim-ignore を足し、すぐ上が lim-ignore ならそこに code を足す", () => {
    expect(ignoreLineEdit(["# a", "  @bg x"], 2, "same-as-default")).toEqual({ row: 2, before: "  @bg x", text: "  // lim-ignore same-as-default\n  @bg x" });
    expect(ignoreLineEdit(["// lim-ignore a", "x"], 2, "b")).toEqual({ row: 1, before: "// lim-ignore a", text: "// lim-ignore a b" });
    expect(ignoreLineEdit(["// lim-ignore a", "x"], 2, "a")).toBeNull();
    expect(ignoreLineEdit(["// lim-ignore", "x"], 2, "a")).toBeNull();
  });
});

describe("下書き（// lim: draft）", () => {
  it("先頭のコメントの // lim: draft だけを下書きの印にする", () => {
    expect(parse("// lim: draft\n地の文", "a").draft).toBe(true);
    expect(parse("// 第三章\n\n// lim: draft\n地の文", "a").draft).toBe(true);
    expect(parse("地の文\n// lim: draft", "a").draft).toBeUndefined();
    expect(isDraftSource("// メモ\n//lim:draft\nx")).toBe(true);
    expect(isDraftSource("x\n// lim: draft")).toBe(false);
  });

  it("下書きにする、戻す", () => {
    expect(setDraftSource("x", true)).toBe("// lim: draft\nx");
    expect(setDraftSource("// メモ\n// lim: draft\nx", false)).toBe("// メモ\nx");
    expect(setDraftSource("x", false)).toBe("x");
  });

  it("下書きのファイルへ移る行は警告し、下書きの中の届かない行と使われないラベルは知らせない", () => {
    const scripts = project({ a: "# start\n@jump draft#b\n# orphan\nx", draft: "// lim: draft\n# b\n@stop\n届かない\n# c\nx" });
    const codes = short(checkProject(scripts, { registry }));
    expect(codes).toContain("a:2 warning draft-target");
    expect(codes.filter((c) => c.startsWith("draft:"))).toEqual([]);
    // 下書きから下書きへは知らせない
    expect(short(checkProject(project({ d1: "// lim: draft\n@jump d2", d2: "// lim: draft\nx" }), { registry })).filter((c) => c.includes("draft-target"))).toEqual([]);
  });

  it("下書きのファイルを @use するとエラー（書き出しに入らず、書き出したゲームではマクロが無い）。下書きどうしは知らせない", () => {
    const common = "// lim: draft\n@define banner\n地の文\n@end";
    const codes = short(checkProject(project({ a: "@use common\n@banner\n@stop", common }), { registry }));
    expect(codes).toContain("a:1 error draft-use");
    expect(short(checkProject(project({ a: "// lim: draft\n@use common\n@banner", common }), { registry })).filter((c) => c.includes("draft-use"))).toEqual([]);
  });

  it("liminalia.json の entry、afterLoad、おまけの回想と章の target が下書きを指すとエラー（draft-entry）", () => {
    const scripts = project({ start: "// lim: draft\n# a\nx", side: "// lim: draft\n# r\nx", main: "# m\nx" });
    const config = { entry: "start", afterLoad: "side#r", extra: { replay: [{ id: "r1", target: "side#r" }, { id: "r2", target: "main#m" }], chapters: [{ id: "c1", target: "start#a" }] } };
    const found = checkDraftStarts(config, scripts);
    expect(found.map((d) => `${d.file} ${d.severity} ${d.code}`)).toEqual(Array(4).fill("liminalia.json error draft-entry"));
    expect(found.map((d) => d.message)).toEqual([
      "「はじめから」の位置（entry）のファイル start が下書きです（下書きは書き出しに入らないので、書き出したゲームは「はじめから」で止まります）",
      "ロードの直後に呼び出す位置（afterLoad）のファイル side が下書きです（下書きは書き出しに入らないので、書き出したゲームはロードのあとで止まります）",
      "extra.replay r1 の target のファイル side が下書きです（下書きは書き出しに入らないので、書き出したゲームではこの回想を再生できません）",
      "extra.chapters c1 の target のファイル start が下書きです（下書きは書き出しに入らないので、書き出したゲームではこの章から始められません）",
    ]);
    expect(checkDraftStarts({ entry: "main" }, scripts)).toEqual([]);
    // 誤りのある項目の行に出す（entry も設定の道として探す）
    const text = JSON.stringify({ id: "x", entry: "start" }, null, 2);
    expect(placeConfigLines(checkDraftStarts({ entry: "start" }, scripts), text, "liminalia.json")[0]!.line).toBe(3);
  });

  it("liminalia.json の variables と saves.location の誤り（loadProject はその項目を使わない。検査は字面から同じ文で知らせる）", () => {
    const text = JSON.stringify({ variables: { "game.ok": 1, flag: true }, saves: { location: "cloud" } }, null, 2);
    expect(configValueProblems(JSON.parse(text), text).map((d) => `${d.line} ${d.code} ${d.message}`)).toEqual([
      '4 bad-config liminalia.json の variables の flag は "game.名前" か "system.名前" で書きます',
      '7 bad-config liminalia.json の saves.location は "user" か "portable" です',
    ]);
    expect(configValueProblems({ variables: [] }, "{}").map((d) => d.message)).toEqual(['liminalia.json の variables は "game.名前" → 値 の形で書きます']);
  });
});
