import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { bodyRanges, foldKana, lineMatcher, replaceSpans, SearchPatternError } from "../src/search.ts";
import { inScope, SEARCH_LINE_LIMIT, searchProject } from "../src/server/search.ts";
import { hashText, StudioWorkspace } from "../src/server/workspace.ts";

/** 全体の検索（開発サーバーの中で探す。本文だけ・正規表現・ひらがなとカタカナ・大文字と小文字）。 */

const at = (line: string, query: string, opts: Record<string, boolean> = {}, ranges?: [number, number][]) =>
  lineMatcher({ query, ...opts })!(line, ranges).map((s) => line.slice(s.at, s.at + s.length));

describe("一行の探し方", () => {
  it("一行に何か所あっても全部当たる。既定は大文字と小文字を区別しない", () => {
    expect(at("Star star STAR", "star")).toEqual(["Star", "star", "STAR"]);
    expect(at("Star star STAR", "star", { caseSensitive: true })).toEqual(["star"]);
    expect(lineMatcher({ query: "" })).toBeNull();
  });

  it("小文字にすると長さの変わる字を含む行でも位置がずれない", () => {
    expect(at("İstar star", "star")).toEqual(["star", "star"]);
  });

  it("ひらがなとカタカナを同じに扱う（字の数は変わらない）", () => {
    expect(foldKana("ホシヴァヶヽ")).toBe("ほしゔぁゖゝ");
    expect(at("ほしとホシ", "ほし")).toEqual(["ほし"]);
    expect(at("ほしとホシ", "ほし", { kana: true })).toEqual(["ほし", "ホシ"]);
    expect(at("ほしとホシ", "ホシ", { kana: true, regex: true })).toEqual(["ほし", "ホシ"]);
  });

  it("正規表現。グループは書いてあるとおりの字で返し、空の一致は数えない。読めなければ投げる", () => {
    const line = "ホシの話とつきの話";
    const spans = lineMatcher({ query: "(ほし|つき)の", regex: true, kana: true })!(line);
    expect(spans.map((s) => s.groups)).toEqual([["ホシ"], ["つき"]]);
    expect(replaceSpans(line, spans, "$1が", true)).toBe("ホシが話とつきが話");
    expect(replaceSpans("ab", lineMatcher({ query: "x*", regex: true })!("ab"), "-", true)).toBe("ab");
    expect(replaceSpans("a$b", lineMatcher({ query: "a", regex: true })!("a$b"), "$$&$&", true)).toBe("$&a$b");
    expect(() => lineMatcher({ query: "ほし[", regex: true })).toThrow(SearchPatternError);
  });

  it("範囲を渡すと、その中に収まるものだけ", () => {
    expect(at("ほしほし", "ほし", {}, [[2, 4]])).toEqual(["ほし"]);
    expect(at("ほしほし", "しほ", {}, [[0, 2], [2, 4]])).toEqual([]);
  });
});

describe("本文の範囲", () => {
  const text = (line: string, from = 0) => bodyRanges(line, from).map(([a, b]) => line.slice(a, b));

  it("本文の中の書き方を除き、ルビの親文字と読み、飾りの中の字は本文", () => {
    expect(text("それで？{click}{@chara ユイカ angry}……聞いてるの？")).toEqual(["それで？", "……聞いてるの？"]);
    expect(text("{r 星空|ほしぞら}を{b 見上げた}")).toEqual(["星空", "ほしぞら", "を", "見上げた"]);
    expect(text("{c #ff0000 赤い}{size 32 大きな}{fx wave 波}{= game.name}さん")).toEqual(["赤い", "大きな", "波", "さん"]);
    expect(text("\\{かっこ\\}{img icons/heart.png}{br}改行")).toEqual(["{かっこ", "}", "改行"]);
    expect(text('{@voice "a}b.ogg"}声')).toEqual(["声"]);
  });

  it("台詞は話者の名前の後ろから", () => {
    expect(text("アカリ「ほし」", 3)).toEqual(["「ほし」"]);
  });

  it("{noclick} と出し分けの名前と区切りと {fx} の調整は本文に数えない", () => {
    expect(text("待たずに{noclick}")).toEqual(["待たずに"]);
    expect(text("{seq あ|い|う}と{once 一度}だけ")).toEqual(["あ", "い", "う", "と", "一度", "だけ"]);
    expect(text("{fx wave strength=2 speed=0.5 ゆれる}文字")).toEqual(["ゆれる", "文字"]);
    // 調整の値と } の間に空白が無いものは値ごと中身の本文（parseInline と同じ読み方）
    expect(text("{fx wave speed=2}次")).toEqual(["speed=2", "次"]);
    expect(text("{fx wave speed=2 }")).toEqual([]);
    // 飾りの値のすぐ後ろの } もブロックを閉じる（{speed 600ms} 自体は読めない書き方だが、後ろの字は本文）
    expect(text("{speed 600ms}次")).toEqual(["次"]);
    expect(text("{seq {r 漢字|かんじ}|{cycle あ|{b い}}}")).toEqual(["漢字", "かんじ", "あ", "い"]);
    // 出し分けの外の | はそのままの字として本文
    expect(text("縦|棒")).toEqual(["縦|棒"]);
  });
});

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
let ws: StudioWorkspace;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-search-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  mkdirSync(join(dir, "scenario/part1"), { recursive: true });
  writeFileSync(join(dir, "scenario/part1/chapter2.lim"), ["# chapter2", "// ホシのメモ", "アカリ「ほしの話」", "@bg hill_night.webp", "@if game.looked", "　ホシが{@chara アカリ}光る。", "@end", "@choice", "ほしを見る -> #chapter2", "@end"].join("\n"));
  ws = await StudioWorkspace.open(loadProject(dir));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("開発サーバーの全体の検索", () => {
  const where = (r: ReturnType<typeof searchProject>) => r.files.flatMap((f) => f.lines.map((l) => `${f.file}:${l.line}`));

  it("packs なら、パック（packs/<フォルダ>/scenario）の台本も packs/<フォルダ>/scenario/<台本> の名前で探す（パックの話者も足して読む。2026-11-19 の rest-p）", () => {
    mkdirSync(join(dir, "packs/extra/scenario"), { recursive: true });
    writeFileSync(join(dir, "packs/extra/pack.json"), JSON.stringify({ id: "extra", title: "おまけ" }));
    writeFileSync(join(dir, "packs/extra/cast.json"), JSON.stringify({ speakers: ["ミナ"], cast: {} }));
    writeFileSync(join(dir, "packs/extra/scenario/bonus.lim"), ["# bonus", "// ほしのメモ", "ミナ「ほしの歌」"].join("\n"));
    const r = searchProject(ws, { query: "ほし", packs: true, body: true });
    expect(r.files.filter((f) => f.pack).map((f) => [f.file, f.pack, f.lines.map((l) => l.line)])).toEqual([["packs/extra/scenario/bonus", "packs/extra", [3]]]);
    // 頼まなければ探さない（TODO の一覧などは本体だけ）
    expect(searchProject(ws, { query: "ほし" }).files.some((f) => f.pack)).toBe(false);
    // パックの話者で、台詞の行だけを探せる
    expect(where(searchProject(ws, { query: "ほし", packs: true, speaker: "ミナ" }))).toEqual(["packs/extra/scenario/bonus:3"]);
  });

  it("サブフォルダも含め全部のファイルを探し、ファイルの hash を添える", () => {
    const r = searchProject(ws, { query: "ほし", kana: true });
    expect(where(r).filter((w) => w.startsWith("part1/"))).toEqual(["part1/chapter2:2", "part1/chapter2:3", "part1/chapter2:6", "part1/chapter2:9"]);
    const f = r.files.find((x) => x.file === "part1/chapter2")!;
    expect(f.hash).toBe(hashText(readFileSync(join(dir, "scenario/part1/chapter2.lim"), "utf8")));
    expect(r.count).toBe(r.files.reduce((n, x) => n + x.lines.reduce((m, l) => m + l.spans.length, 0), 0));
    expect(r.truncated).toBe(false);
  });

  it("本文だけ: 台詞と地の文（@if の中も）だけを見て、コメント・コマンド・選択肢・話者の名前・本文の中のコマンドは見ない", () => {
    const r = searchProject(ws, { query: "ほし", kana: true, body: true });
    expect(where(r).filter((w) => w.startsWith("part1/"))).toEqual(["part1/chapter2:3", "part1/chapter2:6"]);
    expect(where(searchProject(ws, { query: "アカリ", body: true })).filter((w) => w.startsWith("part1/"))).toEqual([]);
    expect(where(searchProject(ws, { query: "hill", body: true })).filter((w) => w.startsWith("part1/"))).toEqual([]);
  });

  it("開いているファイルのまだ保存していない内容を探す", () => {
    const r = searchProject(ws, { query: "まだ保存していない", open: { file: "epilogue", text: "まだ保存していない行\n" } });
    expect(where(r)).toEqual(["epilogue:1"]);
    expect(r.files[0]!.hash).toBe(hashText("まだ保存していない行\n"));
  });

  it("範囲（ファイル、フォルダ）と話者で絞る（@if の中の台詞も。開いているファイルは保存前の内容で）", () => {
    expect(inScope("part1/chapter2", "part1/")).toBe(true);
    expect(inScope("part10/x", "part1/")).toBe(false);
    expect(inScope("start", "start")).toBe(true);
    expect(inScope("start", undefined)).toBe(true);
    expect(new Set(where(searchProject(ws, { query: "ほし", kana: true, scope: "part1/" })).map((w) => w.split(":")[0]))).toEqual(new Set(["part1/chapter2"]));
    expect(where(searchProject(ws, { query: "ほし", kana: true, scope: "start" })).every((w) => w.startsWith("start:"))).toBe(true);
    // 話者: 台詞の行だけ（地の文・コメント・選択肢は除く）
    expect(where(searchProject(ws, { query: "ほし", kana: true, scope: "part1/chapter2", speaker: "アカリ" }))).toEqual(["part1/chapter2:3"]);
    const open = searchProject(ws, { query: "星", scope: "epilogue", speaker: "アカリ", open: { file: "epilogue", text: "　星。\n@if game.x\nアカリ「星だ」\n@end" } });
    expect(where(open)).toEqual(["epilogue:3"]);
  });

  it("読めない正規表現は 400。当たった行が多すぎれば途中でやめる", () => {
    expect(() => searchProject(ws, { query: "(", regex: true })).toThrow(/正規表現/);
    writeFileSync(join(dir, "scenario/many.lim"), Array.from({ length: SEARCH_LINE_LIMIT + 10 }, () => "あ").join("\n"));
    const r = searchProject(ws, { query: "あ" });
    expect(r.truncated).toBe(true);
    expect(r.files.reduce((n, f) => n + f.lines.length, 0)).toBe(SEARCH_LINE_LIMIT);
  });
});
