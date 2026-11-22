import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkProject, CORE_COMMANDS, createRegistry, parse, type Script } from "@liminalia/lang";
import { HeadlessHost, Runtime, type TraceEntry, type Value } from "@liminalia/runtime";
import { importInk, importYarn, recheck, type StoryImportResult } from "../src/index.ts";
import { importStoryProject } from "../src/node.ts";

const FIXTURES = resolve(import.meta.dirname, "fixtures");
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const registry = createRegistry(CORE_COMMANDS);
const read = (f: string) => readFileSync(join(FIXTURES, f), "utf8");

function inkFixture(): StoryImportResult {
  return importInk(read("lighthouse.ink"), { file: "lighthouse.ink", include: (p) => read(p) });
}

function yarnFixture(): StoryImportResult {
  return importYarn(["market.yarn", "ending.yarn"].map((file) => ({ file, text: read(file) })));
}

/** 変換した .lim を画面なしで流し、ページの文を返す。 */
async function play(r: StoryImportResult, entry: string, choices: number[]) {
  const files = Object.fromEntries(r.files.map((f) => [f.name, f.text]));
  const host = new HeadlessHost({ loadSource: async (f) => files[f] ?? "", choices, whenChoicesRunOut: "stop", maxPages: 200 });
  const runtime = new Runtime(host, { speakers: r.speakers, variables: r.variables as Record<string, Value> });
  host.onLimit = () => runtime.stop();
  await runtime.start(entry);
  const pages = (t: TraceEntry[]) => t.flatMap((e) => (e.type === "page" ? [`${e.speaker ?? ""}${e.text}`] : []));
  const shown = host.trace.flatMap((e) => (e.type === "choice" ? [e.options] : []));
  const diagnostics = host.trace.flatMap((e) => (e.type === "diagnostic" ? [e.diagnostic.message] : []));
  return { pages: pages(host.trace), shown, diagnostics, game: runtime.state.game };
}

/** プロジェクト全体の検査（lim check と同じ checkProject）でエラーが無いか。 */
function projectErrors(r: StoryImportResult): string[] {
  const scripts = new Map<string, Script>(r.files.map((f) => [f.name, parse(f.text, f.name, { speakers: r.speakers })]));
  const diags = [...[...scripts.values()].flatMap((s) => s.diagnostics), ...checkProject(scripts, { registry, speakers: r.speakers, variables: r.variables })];
  return diags.filter((d) => d.severity === "error").map((d) => `${d.file}:${d.line} ${d.message}`);
}

describe("Ink", () => {
  it("例のファイルを構文と検査のエラーなしに変換する", () => {
    const r = inkFixture();
    expect(recheck(r, registry, [])).toEqual({ syntaxErrors: [], checkErrors: [] });
    expect(projectErrors(r)).toEqual([]);
    expect(r.totals.manual).toBe(0);
    expect(r.speakers).toEqual(["灯台守"]);
    expect(r.variables).toMatchObject({ "game.oil": 1, "game.met": false });
    const text = r.files[0]!.text;
    // ノットとステッチはラベル、タグは対応表のコマンド、グルーは一行に
    expect(text).toContain("# lighthouse\n");
    expect(text).toContain("# lighthouse-lamp\n");
    expect(text).toContain("@bg shore_evening.png");
    expect(text).toContain("@voice keeper/001.ogg");
    expect(text).toContain("潮のにおいのする坂を、灯台に向かってのぼっていく。足もとで砂が鳴った。");
    expect(text).toContain("@call #greeting");
  });

  it("選択肢、一度だけの選択肢、トンネル、条件分岐と順番が Ink と同じに動く", async () => {
    const r = inkFixture();
    const p = await play(r, "lighthouse", [0, 0, 0, 1]);
    expect(p.diagnostics).toEqual([]);
    // 一度選んだ「油を足す」は、戻ってきたときには出ない。油が 2 になって「話を聞く」が出る
    expect(p.shown[0]).toEqual(["油を足す", "帰る"]);
    expect(p.shown[1]).toEqual(["話を聞く", "帰る"]);
    expect(p.pages).toContain("灯台守「はじめまして。」");
    expect(p.pages).toContain("灯台守「また来たね。」");
    expect(p.pages).toContain("油は一缶だけ。");
    expect(p.pages).toContain("油は足りている。");
    expect(p.pages).toContain("波が寄せる。");
    // [ ] の後ろは選んだ後に出し、前と中は選択肢の文
    expect(p.shown[2]).toEqual(["「聞かせてください」", "「また今度」"]);
    expect(p.pages).toContain("「聞かせてください」と頼んだ。");
    // トンネルから戻って続きへ、入れ子のギャザーから外のギャザーへ
    const i = p.pages.indexOf("灯台守「ああ、そうだ。」");
    expect(p.pages[i + 1]).toBe("灯台守「昔の話をしようか。」");
    expect(p.pages.slice(-4)).toEqual(["話は長かった。", "灯台守「それじゃあ、またね。」", "何度も来てくれたね。", "帰り道は暗い。"]);
    expect(p.game).toMatchObject({ oil: 2, met: true, seen_lighthouse: 2 });
  });

  it("「帰る」は END（タイトルへ戻る）", async () => {
    const p = await play(inkFixture(), "lighthouse", [1]);
    expect(p.pages.at(-1)).toBe("油は一缶だけ。");
  });

  it("変換しない構文は止めずに報告し、コメントにする", () => {
    const src = [
      "LIST colors = red, green",
      "{colors < green: 小さい}",
      "EXTERNAL beep()",
      "Hello.",
      "<- side",
      "~ beep()",
      "-> knot(3)",
      "=== knot(x) ===",
      "In the knot.",
      "-> END",
      "=== function double(n) ===",
      "~ return n * 2",
    ].join("\n");
    const r = importInk(src, { file: "odd.ink" });
    const codes = [...r.unsupported.keys()];
    // LIST の大小の比べ方、EXTERNAL、無いノットのスレッド、EXTERNAL の関数の呼び出し、ノットの引数
    expect(codes).toEqual(expect.arrayContaining(["ink-list", "ink-external", "ink-thread", "ink-logic", "ink-knot-params"]));
    expect(r.files[0]!.text).toContain("// <- side");
    // 関数はマクロにする
    expect(r.files[0]!.text).toContain("@define ink-double(n: number, ink-result: variable)\n  @return (n * 2)\n@end");
    expect(recheck(r, registry, [])).toEqual({ syntaxErrors: [], checkErrors: [] });
  });

  it("対応表を上書きでき、対応表に無いタグはコメントにして数える", () => {
    const r = importInk("# flash: white\n# mood: calm\nText.", { file: "t.ink", commands: { flash: "@quake time=200ms", MOOD: null } });
    const text = r.files[0]!.text;
    expect(text).toContain("@quake time=200ms");
    expect(text).not.toContain("calm");
    const r2 = importInk("# fog thick\nText.", { file: "t.ink" });
    expect(r2.files[0]!.text).toContain("// #fog thick");
    expect(r2.unmapped.get("fog")).toBe(1);
  });

  it("variables: set なら初期値を先頭の @set に書く", () => {
    const r = importInk("VAR gold = 5\nGold: {gold}", { file: "t.ink", variables: "set" });
    expect(r.variables).toEqual({});
    expect(r.files[0]!.text).toContain("@set game.gold = 5");
  });

  it("選択肢を中に持つ条件分岐、ギャザーのラベルへのダイバート、++ と \\#", async () => {
    const src = [
      "VAR n = 0",
      "VAR open = true",
      "{ open:",
      "  扉は開いている。",
      "  * [入る]",
      "    ~ n++",
      "    中に入った。",
      "  * [見送る]",
      "    -> outside.back",
      "- else:",
      "  扉は閉まっている。",
      "}",
      "部屋の中だ。\\#1",
      "-> END",
      "=== outside ===",
      "外にいる。",
      "- (back) 引き返した。{n > 0: 二度目だ。|}",
      "-> END",
    ].join("\n");
    const r = importInk(src, { file: "t.ink" });
    expect(projectErrors(r)).toEqual([]);
    expect((await play(r, "t", [0])).pages).toEqual(["扉は開いている。", "中に入った。", "部屋の中だ。#1"]);
    const b = await play(r, "t", [1]);
    expect(b.pages).toEqual(["扉は開いている。", "引き返した。"]);
    expect(r.files[0]!.text).toContain("# outside-back");
  });

  it("先頭に本文が無ければ、最初のノットから始める", async () => {
    const r = importInk("=== first ===\nはじまり。\n-> END\n=== second ===\nつぎ。\n-> END", { file: "t.ink" });
    expect((await play(r, "t", [])).pages).toEqual(["はじまり。"]);
    expect(r.issues.map((i) => i.code)).toContain("ink-empty-root");
  });

  it("話者のタグと、{条件: -> 先} のダイバート", async () => {
    const src = "VAR ok = true\nこんにちは #speaker: 案内係\n{ok: -> yes | -> no}\n=== yes ===\nはい。\n-> END\n=== no ===\nいいえ。\n-> END";
    const r = importInk(src, { file: "t.ink" });
    expect(projectErrors(r)).toEqual([]);
    const p = await play(r, "t", []);
    expect(p.pages).toEqual(["案内係「こんにちは」", "はい。"]);
  });
});

describe("Yarn Spinner", () => {
  it("複数のファイルをノードの名前でつなぎ、エラーなしに変換する", () => {
    const r = yarnFixture();
    expect(r.files.map((f) => f.name)).toEqual(["market", "ending"]);
    expect(recheck(r, registry, [])).toEqual({ syntaxErrors: [], checkErrors: [] });
    expect(projectErrors(r)).toEqual([]);
    const market = r.files[0]!.text;
    expect(market).toContain("@jump ending#Ending");
    expect(market).toContain("@wait 1s");
    expect(market).toContain("// <<sparkle gold>>");
    expect(market).toContain("店主「{b まいどあり}。」");
    expect(r.unmapped.get("sparkle")).toBe(1);
    expect(r.variables).toEqual({ "game.coins": 0, "game.name": "旅人", "game.seen_Price": 0 });
  });

  it("選択肢、条件、別のファイルへのジャンプが動く", async () => {
    const r = yarnFixture();
    const a = await play(r, "market", [0]);
    expect(a.diagnostics).toEqual([]);
    expect(a.shown[0]).toEqual(["りんごを買う", "値段を聞く", "立ち去る"]);
    expect(a.pages).toEqual(["店主「いらっしゃい、旅人さん。」", "店主「まいどあり。」", "店主「また来てね。」", "空はもう暗い。帰ろう。"]);
    // 値段を聞く → Price → Start に戻る（coins が 2 なので「値段を聞く」は出ない）→ りんご → 3 で袋がいっぱい
    const b = await play(r, "market", [1, 0]);
    expect(b.shown[1]).toEqual(["りんごを買う", "立ち去る"]);
    expect(b.pages.slice(-2)).toEqual(["空はもう暗い。帰ろう。", "袋は、りんごでいっぱいだった。"]);
  });

  it("入れ子の選択肢、選択肢の中の <<if>>、行末の <<if>> と #タグ", async () => {
    const src = [
      "title: Start",
      "---",
      "<<declare $ok = true>>",
      "-> 進む",
      "    <<if $ok>>",
      "        門番: 通れ。",
      "        -> 礼を言う",
      "            旅人: ありがとう。 #se:thanks.ogg",
      "        -> 黙る",
      "    <<endif>>",
      "    門を抜けた。",
      "-> 戻る",
      "    引き返した。",
      "隠れた行。 <<if not $ok>>",
      "おわり。",
      "===",
    ].join("\n");
    const r = importYarn([{ file: "gate.yarn", text: src }]);
    expect(projectErrors(r)).toEqual([]);
    expect(r.files[0]!.text).toContain("@se thanks.ogg");
    expect((await play(r, "gate", [0, 0])).pages).toEqual(["門番「通れ。」", "旅人「ありがとう。」", "門を抜けた。", "おわり。"]);
    expect((await play(r, "gate", [1])).pages).toEqual(["引き返した。", "おわり。"]);
  });

  it("変換しない構文を報告する", () => {
    const src = "title: Start\n---\n<<endonce>>\nA line.\n<<jump {$next}>>\n===";
    const r = importYarn([{ file: "odd.yarn", text: src }]);
    expect([...r.unsupported.keys()]).toEqual(expect.arrayContaining(["yarn-once", "yarn-jump"]));
    expect(recheck(r, registry, [])).toEqual({ syntaxErrors: [], checkErrors: [] });
  });
});

describe("プロジェクトへの取り込み", () => {
  const work = mkdtempSync(join(tmpdir(), "liminalia-story-import-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("シナリオ、話者、変数の初期値、報告を書き、取り込んだもの以外の .lim は上書きしない", () => {
    const dir = join(work, "p");
    cpSync(TEMPLATE, dir, { recursive: true });
    const r = importStoryProject(dir, "yarn", [join(FIXTURES, "market.yarn"), join(FIXTURES, "ending.yarn")], { registry });
    expect(r.written).toEqual(["market.lim", "ending.lim"]);
    expect(JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")).speakers).toContain("店主");
    expect(JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")).variables).toMatchObject({ "game.coins": 0 });
    expect(readFileSync(r.reportPath, "utf8")).toContain("# 取り込みの報告（Yarn Spinner、2 ファイル）");
    // もう一度取り込むのは上書きしてよい
    expect(importStoryProject(dir, "yarn", [join(FIXTURES, "market.yarn"), join(FIXTURES, "ending.yarn")], { registry }).refused).toEqual([]);
    // 自分で書いた start.lim と同じ名前は上書きしない
    const start = readFileSync(join(dir, "scenario/start.lim"), "utf8");
    writeFileSync(join(work, "start.ink"), "Hello.");
    const r2 = importStoryProject(dir, "ink", [join(work, "start.ink")], { registry });
    expect(r2.refused).toEqual(["start.lim"]);
    expect(r2.ok).toBe(false);
    expect(readFileSync(join(dir, "scenario/start.lim"), "utf8")).toBe(start);
    // 英語の注記で始まる .lim（Studio の英語の表示で取り込んだもの）も、取り込みで書いたものとして上書きしてよい
    writeFileSync(join(dir, "scenario/market.lim"), "// Converted from market.yarn with lim import-yarn\n# Start\n");
    expect(importStoryProject(dir, "yarn", [join(FIXTURES, "market.yarn"), join(FIXTURES, "ending.yarn")], { registry }).refused).toEqual([]);
  });

  it("INCLUDE は始まりのファイルのフォルダの外を読まない", () => {
    const dir = join(work, "q");
    cpSync(TEMPLATE, dir, { recursive: true });
    writeFileSync(join(work, "secret.ink"), "=== secret ===\nSecret.\n-> END");
    const inner = join(work, "inner");
    cpSync(FIXTURES, inner, { recursive: true });
    writeFileSync(join(inner, "main.ink"), "INCLUDE ../secret.ink\nINCLUDE parts/keeper.ink\nHi.\n-> END");
    const r = importStoryProject(dir, "ink", [join(inner, "main.ink")], { registry });
    expect(r.result.files[0]!.text).not.toContain("Secret.");
    expect(r.result.files[0]!.text).toContain("# greeting");
    expect([...r.result.unsupported.keys()]).toContain("include-missing");
  });
});
