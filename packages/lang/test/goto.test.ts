import { describe, expect, it } from "vitest";
import { CORE_COMMANDS, createRegistry, resolveTargetText, targetSiteAt, targetSitesOf, type TargetFiles } from "../src/index.ts";

/** ジャンプ先へ移動（VS Code の定義へ移動と Studio の ⌘クリック・F12 が共有する goto.ts）。 */

const registry = createRegistry(CORE_COMMANDS);
const specOf = (name: string) => registry.get(name);
const lines = [
  "# start", // 0
  "@jump #menu", // 1
  "@call part1/chapter2#later", // 2
  '@dialog "続けますか" target=#menu cancel-target=epilogue', // 3
  "@sleep-game #menu", // 4
  '　本文{@dialog "はい" target=#menu}のなか', // 5
  "@choice", // 6
  "- 望遠鏡をのぞく -> #telescope if=(game.x)", // 7
  "- ほかの話 -> part1/chapter2", // 8
  "@end", // 9
  "@jump (game.next)", // 10
  "@bg hill.png", // 11
];

describe("ジャンプ先の字面を見つける", () => {
  it("@jump・@call は名前より後ろならどこでも最初のパラメータ", () => {
    expect(targetSiteAt(lines, 1, 1, specOf)).toBeNull();
    expect(targetSiteAt(lines, 1, 8, specOf)).toEqual({ text: "#menu", start: 6, end: 11 });
    expect(targetSiteAt(lines, 2, 7, specOf)?.text).toBe("part1/chapter2#later");
  });

  it("target 型のパラメータ（名前付き・位置）と本文の中のコマンド", () => {
    const at = (line: number, word: string) => targetSiteAt(lines, line, lines[line]!.indexOf(word) + 1, specOf)?.text;
    expect(at(3, "#menu")).toBe("#menu");
    expect(at(3, "epilogue")).toBe("epilogue");
    expect(at(3, "続けますか")).toBeUndefined();
    expect(at(4, "#menu")).toBe("#menu");
    expect(at(5, "#menu")).toBe("#menu");
    expect(at(11, "hill")).toBeUndefined();
  });

  it("選択肢の行は -> の後ろだけ", () => {
    expect(targetSiteAt(lines, 7, lines[7]!.indexOf("#telescope") + 2, specOf)?.text).toBe("#telescope");
    expect(targetSiteAt(lines, 7, 3, specOf)).toBeNull();
  });

  it("行にあるジャンプ先を前から順に（F12・メニューはカーソルの位置によらず使う）", () => {
    expect(targetSitesOf(lines, 3, specOf).map((t) => t.text)).toEqual(["#menu", "epilogue"]);
    expect(targetSitesOf(lines, 5, specOf).map((t) => t.text)).toEqual(["#menu"]);
    expect(targetSitesOf(lines, 8, specOf).map((t) => t.text)).toEqual(["part1/chapter2"]);
    expect(targetSitesOf(lines, 10, specOf).map((t) => t.text)).toEqual(["(game.next)"]);
    expect(targetSitesOf(lines, 0, specOf)).toEqual([]);
    expect(targetSitesOf(lines, 11, specOf)).toEqual([]);
  });
});

describe("ジャンプ先を場所に解決する", () => {
  const files: TargetFiles = {
    has: (f) => f === "start" || f === "part1/chapter2",
    labels: (f) => (f === "start" ? [{ name: "menu", line: 51 }] : [{ name: "later", line: 6 }]),
  };
  it("#ラベルは書いたファイル、ファイルはその頭、サブフォルダのファイルも", () => {
    expect(resolveTargetText("#menu", "start", files)).toEqual({ file: "start", line: 51, label: "menu" });
    expect(resolveTargetText("part1/chapter2#later", "start", files)).toEqual({ file: "part1/chapter2", line: 6, label: "later" });
    expect(resolveTargetText("part1/chapter2", "start", files)).toEqual({ file: "part1/chapter2", line: 1, label: null });
  });
  it("無いファイル・無いラベル・式は null", () => {
    expect(resolveTargetText("nope#menu", "start", files)).toBeNull();
    expect(resolveTargetText("#nope", "start", files)).toBeNull();
    expect(resolveTargetText("(game.next)", "start", files)).toBeNull();
  });
});
