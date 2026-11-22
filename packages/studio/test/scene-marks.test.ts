import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MapNode } from "@liminalia/lang";
import { loadProject } from "@liminalia/project";
import { matchesFilter, NO_FILTER } from "../src/model/map-filter.ts";
import { allTags, cleanMark, cleanMarks, dotColor, markFilterChoices, markSummary, markWords, matchesMark, parseTags } from "../src/model/scene-marks.ts";
import { renameLabel } from "../src/server/labels.ts";
import { readStudioState, writeStudioState } from "../src/server/studio-state.ts";
import { StudioWorkspace } from "../src/server/workspace.ts";

describe("シーンのタグ、色、状態", () => {
  it("タグは読点、カンマ、空白で区切り、先頭の # を外し、重なりを除く", () => {
    expect(parseTags("#伏線、要調査, 伏線  ＃夜")).toEqual(["伏線", "要調査", "夜"]);
    expect(parseTags("")).toEqual([]);
  });

  it("形の合うものだけを残し、何も無ければ覚えない", () => {
    expect(cleanMark({ status: "review", color: "red", tags: ["a", 1, "a", ""] })).toEqual({ status: "review", color: "red", tags: ["a"] });
    expect(cleanMark({ status: "nope", color: "teal" })).toBeNull();
    expect(cleanMarks({ "a#x": { status: "done" }, "": { status: "done" }, b: { color: "nope" } })).toEqual({ "a#x": { status: "done" } });
  });

  it("点の色は、色を決めていれば色、無ければ状態の色", () => {
    expect(dotColor({ color: "blue", status: "done" })).toBe("blue");
    expect(dotColor({ status: "review" })).toBe("yellow");
    expect(dotColor({ tags: ["a"] })).toBeNull();
    expect(dotColor(undefined)).toBeNull();
  });

  it("絞り込み: 印のあるもの、状態、色、タグ。選びは使っているものだけ", () => {
    const marks = { "a#x": { status: "draft" as const, tags: ["夜", "伏線"] }, "a#y": { color: "red" as const, tags: ["夜"] } };
    expect(matchesMark(marks["a#x"], "")).toBe(true);
    expect(matchesMark(undefined, "marked")).toBe(false);
    expect(matchesMark(marks["a#x"], "status:draft")).toBe(true);
    expect(matchesMark(marks["a#y"], "status:draft")).toBe(false);
    expect(matchesMark(marks["a#y"], "color:red")).toBe(true);
    expect(matchesMark(marks["a#x"], "tag:伏線")).toBe(true);
    expect(allTags(marks)).toEqual(["夜", "伏線"]);
    const names = { all: "すべて", marked: "印", status: { draft: "下書き" }, color: { red: "赤" }, tag: (t: string) => `#${t}` };
    expect(markFilterChoices(marks, names).map((c) => c.value)).toEqual(["", "marked", "status:draft", "color:red", "tag:夜", "tag:伏線"]);
    expect(markWords(marks["a#x"], (s) => (s === "draft" ? "下書き" : s))).toBe("下書き #夜 #伏線");
    expect(markSummary(marks["a#y"], { status: {}, color: { red: "赤" } }, "、")).toBe("赤、#夜");
  });

  it("フローチャートの絞り込みにも使う", () => {
    const node: MapNode = { id: "a#x", file: "a", label: "x", line: 1, end: 3, pages: 1, text: "", anchor: 2 };
    expect(matchesFilter(node, { ...NO_FILTER, mark: "tag:夜" }, {}, null, { "a#x": { tags: ["夜"] } })).toBe(true);
    expect(matchesFilter(node, { ...NO_FILTER, mark: "tag:夜" }, {}, null, {})).toBe(false);
  });
});

describe("シーンの印を制作画面のデータに覚え、名前の変更に追従させる", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-marks-"));
    cpSync(resolve(import.meta.dirname, "../../../templates/default"), dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it(".liminalia/studio.json の sceneMarks に覚え、形の合わないものは捨てる", () => {
    const project = loadProject(dir);
    writeStudioState(project, { sceneMarks: { "start#a": { status: "review", tags: ["夜"] }, "start#b": { color: "nope" } } });
    expect(readStudioState(project).sceneMarks).toEqual({ "start#a": { status: "review", tags: ["夜"] } });
  });

  it("シーンの名前を変えると、印の鍵も変わる", async () => {
    writeFileSync(join(dir, "scenario/marks.lim"), ["# old", "アカリ「一」", "# other", "アカリ「二」"].join("\n"));
    const project = loadProject(dir);
    writeStudioState(project, { sceneMarks: { "marks#old": { status: "draft" }, "marks#other": { color: "blue" } } });
    const ws = await StudioWorkspace.open(project);
    renameLabel(ws, "marks", "old", "renamed");
    expect(readStudioState(project).sceneMarks).toEqual({ "marks#renamed": { status: "draft" }, "marks#other": { color: "blue" } });
  });
});
