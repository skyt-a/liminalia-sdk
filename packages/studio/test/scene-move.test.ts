import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRegistry, CORE_COMMANDS, parse, translationKey, type CommandSpec } from "@liminalia/lang";
import { loadProject } from "@liminalia/project";
import { targetVariables } from "@liminalia/editor/label-rename";
import { planSceneMove, type Falls } from "../src/model/scene-move.ts";
import { readReviews } from "../src/server/reviews.ts";
import { moveScenes } from "../src/server/scene-move.ts";
import { StudioWorkspace } from "../src/server/workspace.ts";

const registry = createRegistry(CORE_COMMANDS, []);
const specOf = (name: string): CommandSpec | undefined => registry.get(name);

function plan(texts: Record<string, string>, labels: string[], to: string, falls: Falls = () => null) {
  const map = new Map(Object.entries(texts));
  const scripts = [...map].map(([f, t]) => parse(t, f));
  return planSceneMove({ file: "a", labels, to, texts: map, parse: (t, f) => parse(t, f), specOf, variables: targetVariables(scripts), unique: () => true, falls });
}

describe("シーンを別のファイルへ移す字面", () => {
  const a = ["# one", "　一。", "@jump #two", "", "# two", "　二。", "@jump #three", "", "# three", "　三。", "@choice", "- 戻る -> #one", "- 二へ -> #two", "@end"].join("\n");

  it("移したシーンの中の、元のファイルに残るシーンは ファイル#ラベル にし、ほかのファイルの参照は移した先へ", () => {
    const out = plan({ a, b: ["# b1", "@jump a#three", "@jump b#b1"].join("\n"), c: ["@jump a#three", "@jump #three"].join("\n") }, ["three"], "b");
    expect(out.files.get("a")!.text.split("\n")).toEqual(["# one", "　一。", "@jump #two", "", "# two", "　二。", "@jump b#three", ""]);
    expect(out.files.get("b")!.text.split("\n")).toEqual(["# b1", "@jump b#three", "@jump b#b1", "", "# three", "　三。", "@choice", "- 戻る -> a#one", "- 二へ -> a#two", "@end"]);
    expect(out.files.get("c")!.text.split("\n")).toEqual(["@jump b#three", "@jump #three"]);
  });

  it("続いて並んだシーンをまとめて移すと、その中の参照は #ラベル のまま", () => {
    const out = plan({ a }, ["two", "three"], "b");
    expect(out.files.get("b")!.text.split("\n")).toEqual(["# two", "　二。", "@jump #three", "", "# three", "　三。", "@choice", "- 戻る -> a#one", "- 二へ -> #two", "@end"]);
    expect(out.files.get("a")!.text.split("\n")).toEqual(["# one", "　一。", "@jump b#two", ""]);
    // 出どころ（移した行は元の行番号）
    expect(out.files.get("b")!.origin[0]).toEqual({ file: "a", line: 5 });
  });

  it("流れを変えない行を足す（続いていたシーンへの @jump、移した先の終わりの @stop）", () => {
    const flows = ["# one", "　一。", "# two", "　二。", "# three", "　三。"].join("\n");
    const falls: Falls = (file, label) => (file === "b" ? "end" : label === "three" ? "end" : label === null ? null : "next");
    const out = plan({ a: flows, b: ["# b1", "　終わり。", ""].join("\n") }, ["two"], "b", falls);
    expect(out.files.get("a")!.text.split("\n")).toEqual(["# one", "　一。", "@jump b#two", "# three", "　三。"]);
    expect(out.files.get("b")!.text.split("\n")).toEqual(["# b1", "　終わり。", "@stop", "", "# two", "　二。", "@jump a#three"]);
    expect(out.joins).toEqual([
      { file: "b", line: 7, text: "@jump a#three" },
      { file: "a", line: 3, text: "@jump b#two" },
      { file: "b", line: 3, text: "@stop" },
    ]);
  });

  it("元のファイルの @use と、移したシーンが呼ぶマクロのファイルを移した先の頭に足す", () => {
    const src = ["@use common", "@define hello()", "　やあ。", "@end", "# one", "　一。", "# two", "@hello"].join("\n");
    const out = plan({ a: src, common: "" }, ["two"], "b");
    expect(out.files.get("b")!.text.split("\n")).toEqual(["@use common", "@use a", "", "# two", "@hello"]);
  });

  it("続いていないシーン・同じ名前のシーンがある先・頭は断る", () => {
    expect(() => plan({ a }, ["one", "three"], "b")).toThrow(/連続した/);
    expect(() => plan({ a, b: "# two\n" }, ["two"], "b")).toThrow(/すでに/);
    expect(() => plan({ a }, ["none"], "b")).toThrow(/ありません/);
    expect(() => plan({ a }, ["one"], "a")).toThrow(/同じ/);
  });

  it("変数へ入れる #ラベル は、移したなら ファイル#ラベル にする", () => {
    const src = ['@set game.go = "#two"', "@jump (game.go)", "# one", "# two", "　二。"].join("\n");
    const out = plan({ a: src }, ["two"], "b");
    expect(out.files.get("a")!.text.split("\n")[0]).toBe('@set game.go = "b#two"');
  });
});

describe("シーンを別のファイルへ移す（POST /scenes/move）", () => {
  const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
  let dir: string;
  let ws: StudioWorkspace;
  const scenario = (f: string) => readFileSync(join(dir, "scenario", `${f}.lim`), "utf8");
  const config = () => JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-move-"));
    cpSync(TEMPLATE, dir, { recursive: true });
    const raw = config();
    raw.entry = "scene1#head";
    raw.languages = ["ja", "en"];
    raw.extra = { replay: [{ id: "r", target: "scene1#tail" }] };
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify(raw, null, 2));
    writeFileSync(join(dir, "scenario/scene1.lim"), ["# head", "　始まり。", "", "# mid", "　真ん中。", "", "# tail", "　終わり。", "@jump #head"].join("\n"));
    writeFileSync(join(dir, "scenario/scene2.lim"), ["# s2", "　二つ目。", "@jump scene1#tail"].join("\n"));
    mkdirSync(join(dir, "lang"), { recursive: true });
    const key = translationKey("scene1", "line", "　終わり。");
    writeFileSync(join(dir, "lang/en.json"), JSON.stringify({ language: "en", lines: { [key]: { source: "　終わり。", text: "The end." } } }));
    mkdirSync(join(dir, ".liminalia"), { recursive: true });
    writeFileSync(join(dir, ".liminalia/studio.json"), JSON.stringify({ mapPositions: { "scene1#tail": { x: 1, y: 2 } }, bookmarks: { scene1: [{ line: 2, text: "始まり。" }, { line: 8, text: "終わり。" }], scene2: [{ line: 2, text: "二つ目。" }] } }));
    mkdirSync(join(dir, "reviews"), { recursive: true });
    writeFileSync(join(dir, "reviews/r1.json"), JSON.stringify({ id: "r1", file: "scene1", line: 8, text: "終わり。", hash: "h", resolved: false, comments: [] }));
    ws = await StudioWorkspace.open(loadProject(dir));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("新しいファイルへ分け、ジャンプ先・設定・訳の鍵・コメント・フローチャートの位置を移す", () => {
    const r = moveScenes(ws, "scene1", ["tail"], "part2/rest");
    expect(r.created).toBe(true);
    expect(scenario("part2/rest").split("\n")).toEqual(["# tail", "　終わり。", "@jump scene1#head"]);
    // mid は tail へ続いていたので、移した先へ移る行を足す
    expect(scenario("scene1").split("\n")).toEqual(["# head", "　始まり。", "", "# mid", "　真ん中。", "@jump part2/rest#tail", ""]);
    expect(scenario("scene2").split("\n")[2]).toBe("@jump part2/rest#tail");
    expect((config().extra as { replay: { target: string }[] }).replay[0]!.target).toBe("part2/rest#tail");
    const en = JSON.parse(readFileSync(join(dir, "lang/en.json"), "utf8")) as { lines: Record<string, { text: string }> };
    expect(en.lines[translationKey("part2/rest", "line", "　終わり。")]?.text).toBe("The end.");
    expect(en.lines[translationKey("scene1", "line", "　終わり。")]).toBeUndefined();
    expect(readReviews(ws.project)[0]).toMatchObject({ file: "part2/rest", line: 2 });
    // 前の版の置き場（studio.json）に書いた位置は、開いたときに共有するデータ（shared.json）へ移る
    const state = JSON.parse(readFileSync(join(dir, ".liminalia/shared.json"), "utf8")) as { mapPositions: Record<string, unknown> };
    expect(Object.keys(state.mapPositions)).toEqual(["part2/rest#tail"]);
    // 移した行のブックマークは移した先の行へ（ほかの印はそのまま）
    const marks = (JSON.parse(readFileSync(join(dir, ".liminalia/studio.json"), "utf8")) as { bookmarks: Record<string, { line: number; text: string }[]> }).bookmarks;
    expect(Object.fromEntries(Object.entries(marks).map(([f, list]) => [f, list.map((b) => [b.line, b.text])]))).toEqual({ scene1: [[2, "始まり。"]], scene2: [[2, "二つ目。"]], "part2/rest": [[2, "終わり。"]] });
    expect(r.joins).toEqual([{ file: "scene1", line: 6, text: "@jump part2/rest#tail" }]);
  });

  it("あるファイルの終わりへ移す（entry も移した先へ）", () => {
    const r = moveScenes(ws, "scene1", ["head", "mid"], "scene2");
    expect(r.created).toBe(false);
    expect(scenario("scene2").split("\n")).toEqual(["# s2", "　二つ目。", "@jump scene1#tail", "", "# head", "　始まり。", "", "# mid", "　真ん中。", "@jump scene1#tail", ""]);
    expect(scenario("scene1").split("\n")).toEqual(["# tail", "　終わり。", "@jump scene2#head"]);
    expect(config().entry).toBe("scene2#head");
    expect(r.entry).toBe(true);
    expect(existsSync(join(dir, "scenario/scene2.lim"))).toBe(true);
  });
});
