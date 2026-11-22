import { describe, expect, it } from "vitest";
import { parse } from "@liminalia/lang";
import { sceneMarkers } from "../src/scene-markers.ts";

describe("場面マーカー", () => {
  it("自由な見出しと、文字列の日付・イベントを行番号とともに読む", () => {
    const text = '// @scene 8月27日 奏の来訪\n本文。\n  // @scene date=8/27 event="奏の 来訪"\n// @scene date=翌日\n// @scene event=捜索\n// @scene date=1\n';
    expect(sceneMarkers(text)).toEqual([
      { line: 1, title: "8月27日 奏の来訪" },
      { line: 3, title: "8/27 · 奏の 来訪", date: "8/27", event: "奏の 来訪" },
      { line: 4, title: "翌日", date: "翌日" },
      { line: 5, title: "捜索", event: "捜索" },
      { line: 6, title: "1", date: "1" },
    ]);
  });

  it("不完全な記法、スクリプトの中、行末のコメントは一覧に含めない", () => {
    const text = '// @scene\n// @scene date="閉じない\n// @scene date=一日 date=二日\n文章 // @scene 隠す\n@script\n// @scene コードの中\n@end\n// @scene 最後';
    expect(sceneMarkers(text)).toEqual([{ line: 8, title: "最後" }]);
  });

  it("コメントはゲームで実行される本文や命令にならない", () => {
    const script = parse('// @scene date=8/27 event=来訪\n本文。\n@wait 1s', "a");
    expect(script.body.map((s) => s.kind)).toEqual(["prose", "command"]);
    expect(script.diagnostics).toEqual([]);
  });
});
