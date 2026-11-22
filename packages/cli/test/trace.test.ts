import { applyCommandDefaults, CORE_COMMANDS, createRegistry } from "@liminalia/lang";
import { describe, expect, it } from "vitest";
import { formatTrace, shownArgs, tracePages } from "../src/commands/trace.ts";

describe("lim trace の文字の出力", () => {
  const registry = createRegistry(CORE_COMMANDS);

  it("既定値と同じ引数は並べない（skip=true なども）", () => {
    const spec = registry.get("chara");
    expect(shownArgs(spec, { who: "ユイカ", variant: "smile", time: 0, cross: true, wait: false, "if-hidden": false, skip: true })).toEqual({ who: "ユイカ", variant: "smile" });
    // .lim の書き方（名前なしのパラメータ、時間の単位）
    expect(formatTrace({ type: "command", name: "chara", args: { who: "ユイカ", time: 300, skip: true } }, registry)).toBe("    @chara ユイカ time=300ms");
    expect(formatTrace({ type: "command", name: "chara", args: { who: "ユイカ", variant: "smile", time: 1500 } }, registry)).toBe("    @chara ユイカ smile time=1.5s");
    expect(formatTrace({ type: "command", name: "bg", args: { image: "night sky.png", time: 2000 } }, registry)).toBe('    @bg "night sky.png" time=2s');
  });

  it("作品の既定値（commandDefaults）で変わったものは並べる", () => {
    const spec = applyCommandDefaults(registry.get("chara")!, { chara: { fade: "400ms" } });
    expect(shownArgs(spec, { who: "ユイカ", fade: 400, skip: true })).toEqual({ who: "ユイカ", fade: 400 });
  });

  it("仕様に無い命令はすべて並べる", () => {
    expect(shownArgs(undefined, { a: 1 })).toEqual({ a: 1 });
  });

  it("ページに開始位置から 1 で数えた番号を付け、行の頭に [N] で出す（?skip=N・lim shot --skip N で止まる番号）", () => {
    const trace = tracePages([
      { type: "command", name: "bg", args: { image: "a.png" } },
      { type: "page", file: "a", line: 3, speaker: null, text: "一つめ。" },
      { type: "choice", options: ["はい", "いいえ"], selected: 0 },
      { type: "page", file: "a", line: 5, speaker: "ユイ", text: "「二つめ」" },
    ]);
    expect(trace.flatMap((t) => (t.type === "page" ? [t.page] : []))).toEqual([1, 2]);
    expect(trace.map((t) => formatTrace(t, registry))).toEqual(["    @bg a.png", "[1] a:3  一つめ。", "    ? [はい] / いいえ", "[2] a:5  ユイ「二つめ」"]);
  });

  it("台詞の括弧を外す作品（ui.text.quotes の strip）では、話者と本文の間を全角のコロンで分ける", () => {
    expect(formatTrace({ type: "page", file: "a", line: 2, speaker: "アカリ", text: "括弧の台詞。", page: 1 }, registry)).toBe("[1] a:2  アカリ：括弧の台詞。");
    expect(formatTrace({ type: "page", file: "a", line: 2, speaker: "アカリ", label: "？？？", text: "括弧の台詞。", page: 1 }, registry)).toBe("[1] a:2  アカリ［？？？］：括弧の台詞。");
    // 括弧で始まる台詞は今までどおり続けて書く
    expect(formatTrace({ type: "page", file: "a", line: 2, speaker: "アカリ", text: "『題』", page: 1 }, registry)).toBe("[1] a:2  アカリ『題』");
  });

  it("--lang en は話者と本文の間を空け、名前欄の名前を半角の括弧で添える", () => {
    expect(formatTrace({ type: "page", file: "a", line: 2, speaker: "Akari", text: '"Hi."', page: 1 }, registry, "en")).toBe('[1] a:2  Akari: "Hi."');
    expect(formatTrace({ type: "page", file: "a", line: 2, speaker: "Akari", label: "???", text: '"Hi."', page: 1 }, registry, "en")).toBe('[1] a:2  Akari (???): "Hi."');
    expect(formatTrace({ type: "page", file: "a", line: 3, speaker: null, text: "The end.", page: 2 }, registry, "en")).toBe("[2] a:3  The end.");
  });
});
