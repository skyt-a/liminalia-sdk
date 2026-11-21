import { describe, expect, it } from "vitest";
import { parseScenarioTests, renameInScenarioTests } from "../src/index.ts";

/** 名前の変更で、台本のテスト（.limtest）の中を書き換える（renameInScenarioTests）。 */

const SOURCE = [
  "// start#night を通る",
  "# 夜の道",
  "from start#intro",
  "set game.looked = visits(\"start#night\") > 0",
  "  choose 望遠鏡をのぞく",
  "choose start のこと",
  "expect game.looked && !game.lookedx",
  "expect reach start#night",
  "expect not reach start:12",
  "expect reach epilogue",
  "expect text \"ソウ\"",
  "expect text ソウが来た",
  "expect read(\"start\") && visits(\"#night\") == 1",
  "expect ending start",
  "",
].join("\n");

describe("台本のテストの名前の変更", () => {
  it("ファイル: from と expect reach の場所、式の visits と read", () => {
    const r = renameInScenarioTests(SOURCE, { kind: "file", from: "start", to: "opening" });
    const lines = r.text.split("\n");
    expect(lines[2]).toBe("from opening#intro");
    expect(lines[3]).toBe('set game.looked = visits("opening#night") > 0');
    expect(lines[5]).toBe("choose start のこと");
    expect(lines[7]).toBe("expect reach opening#night");
    expect(lines[8]).toBe("expect not reach opening:12");
    expect(lines[9]).toBe("expect reach epilogue");
    expect(lines[12]).toBe('expect read("opening") && visits("#night") == 1');
    expect(lines[13]).toBe("expect ending start");
    expect(lines[0]).toBe("// start#night を通る");
    expect(r.changed).toEqual([3, 4, 8, 9, 13]);
    expect(r.left).toEqual([]);
    // 書き換えたあとも読める
    expect(parseScenarioTests(r.text, "t.limtest").diagnostics).toEqual([]);
  });

  it("ラベル: `ファイル#ラベル` だけ書き換え、ファイルを省いた `#ラベル` は知らせる", () => {
    const r = renameInScenarioTests(SOURCE, { kind: "label", file: "start", from: "night", to: "yoru" });
    const lines = r.text.split("\n");
    expect(lines[3]).toBe('set game.looked = visits("start#yoru") > 0');
    expect(lines[7]).toBe("expect reach start#yoru");
    expect(lines[2]).toBe("from start#intro");
    expect(lines[12]).toBe('expect read("start") && visits("#night") == 1');
    expect(r.left).toEqual([13]);
    // シーンを別のファイルへ移すとき
    const moved = renameInScenarioTests(SOURCE, { kind: "label", file: "start", from: "night", to: "night", toFile: "night" });
    expect(moved.text.split("\n")[7]).toBe("expect reach night#night");
  });

  it("変数: set の変数と式、expect の式（似た名前と文の中は変えない）", () => {
    const r = renameInScenarioTests(SOURCE, { kind: "variable", from: "game.looked", to: "game.peeked" });
    const lines = r.text.split("\n");
    expect(lines[3]).toBe('set game.peeked = visits("start#night") > 0');
    expect(lines[6]).toBe("expect game.peeked && !game.lookedx");
    expect(r.changed).toEqual([4, 7]);
  });

  it("話者名: 話者名そのものと比べる expect text だけ", () => {
    const r = renameInScenarioTests(SOURCE, { kind: "speaker", from: "ソウ", to: "蒼" });
    const lines = r.text.split("\n");
    expect(lines[10]).toBe('expect text "蒼"');
    expect(lines[11]).toBe("expect text ソウが来た");
    expect(r.changed).toEqual([11]);
  });

  it("CRLF の行と字下げはそのまま", () => {
    const r = renameInScenarioTests("# a\r\n  from start\r\n", { kind: "file", from: "start", to: "b" });
    expect(r.text).toBe("# a\r\n  from b\r\n");
  });
});
