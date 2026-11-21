import { describe, expect, it } from "vitest";
import { buildFlow, buildStoryMap, CORE_COMMANDS, createRegistry, pageKeys, parse, type Script } from "../src/index.ts";

const speakers = ["ユイ", "レン"];
const keys = (text: string) => pageKeys(parse(text, "a", { speakers }));
const flowOf = (files: Record<string, string>, entry = "a") => {
  const scripts = new Map(Object.entries(files).map(([file, text]) => [file, { script: parse(text, file, { speakers }), text }]));
  const map = buildStoryMap({ scripts, registry: createRegistry(CORE_COMMANDS), entry, hooks: new Map(), data: () => undefined });
  return buildFlow(map, new Map([...scripts].map(([file, { script }]) => [file, script])));
};
/** 本文 → 鍵（同じ本文が二つあれば後のもの）。 */
const byText = (text: string) => {
  const lines = text.split("\n");
  return new Map([...keys(text)].map(([line, key]) => [lines[line - 1]!.trim(), key]));
};

describe("ページの鍵（既読）", () => {
  it("行を足しても、ほかのページの鍵は変わらない（足したページとそのすぐ後だけが変わる）", () => {
    const before = byText("ユイ「おはよう」\n窓の外は雨だった。\nレン「……」\nユイ「行こう」");
    const after = byText("@bg room.jpg\nユイ「おはよう」\n\n窓の外は雨だった。\nユイ「足した台詞」\nレン「……」\nユイ「行こう」");
    expect(after.get("ユイ「おはよう」")).toBe(before.get("ユイ「おはよう」"));
    expect(after.get("窓の外は雨だった。")).toBe(before.get("窓の外は雨だった。"));
    expect(after.get("ユイ「行こう」")).toBe(before.get("ユイ「行こう」"));
    expect(new Set(before.values()).has(after.get("ユイ「足した台詞」")!)).toBe(false);
    expect(after.get("レン「……」")).not.toBe(before.get("レン「……」"));
  });

  it("同じ文を足しても、前のページが違えば別の鍵（既読を引き継がない）", () => {
    const before = keys("レン「……」\nユイ「どう？」\nレン「……」");
    const after = keys("ユイ「来た」\nレン「……」\nレン「……」\nユイ「どう？」\nレン「……」");
    expect(new Set(before.values()).has(after.get(2)!)).toBe(false);
    expect(after.get(5)).toBe(before.get(3));
  });

  it("話者が違えば別の鍵。前のページまで同じ組は何度目かで分ける。@if の枝と @define の中も数える", () => {
    const k = keys("ユイ「うん」\nレン「うん」\n@if game.a\nユイ「うん」\n@end\n@define m()\nユイ「うん」\n@end\n# x\nユイ「うん」");
    expect(k.size).toBe(5);
    expect(new Set(k.values()).size).toBe(5);
    expect(k.get(1)).not.toBe(k.get(2));
    expect(k.get(10)).toBe(`${k.get(7)}-2`);
  });

  it("ラベルの名前を変えても変わらない", () => {
    expect([...keys("# a\nユイ「一」\n# b\nユイ「二」").values()]).toEqual([...keys("# start\nユイ「一」\n# next\nユイ「二」").values()]);
  });

  it("フローチャートはページと場面の頭に鍵を添える", () => {
    const text = "ユイ「一」\n@choice\n- 右 -> #r\n@end\n# r\nレン「二」";
    const scripts = new Map<string, Script>([["a", parse(text, "a", { speakers })]]);
    const flow = buildFlow(buildStoryMap({ scripts: new Map([["a", { script: scripts.get("a")!, text }]]), registry: createRegistry(CORE_COMMANDS), entry: "a", hooks: new Map(), data: () => undefined }), scripts);
    const k = pageKeys(scripts.get("a")!);
    expect(flow.pages).toEqual({ a: [1, 6] });
    expect(flow.keys).toEqual({ a: [k.get(1), k.get(6)] });
    expect(flow.scenes.find((s) => s.id === "a#r")?.anchor).toEqual({ file: "a", line: 6, key: k.get(6) });
  });

  it("呼び出す場面を別ファイルに移しても、既読率の分母とフローチャートは変わらない", () => {
    const main = (target: string) => `はじまり。\n@call ${target}\n@choice\n- 右 -> #r\n- 左 -> #l\n@end\n# r\n右の道。\n@return\n# l\n左の道。\n@return`;
    const called = "# shared\n共通の場面。\n@return";
    const together = flowOf({ a: `${main("#shared")}\n${called}` });
    const separate = flowOf({ a: main("common#shared"), common: called });
    expect(together.pages).toEqual({ a: [1, 8, 11, 14] });
    expect(separate.pages).toEqual({ a: [1, 8, 11], common: [2] });
    expect(Object.values(together.pages).flat()).toHaveLength(4);
    expect(Object.values(separate.pages).flat()).toHaveLength(4);
    expect(separate.scenes).toEqual(together.scenes);
    expect(separate.links).toEqual(together.links);
    expect(together.scenes.map((s) => s.nodes)).toEqual([["a"], ["a#r"], ["a#l"]]);
    expect(together.links.map(({ from, to }) => ({ from, to }))).toEqual([{ from: "a", to: "a#r" }, { from: "a", to: "a#l" }]);
    for (const flow of [together, separate]) {
      for (const [file, lines] of Object.entries(flow.pages)) expect(flow.keys?.[file]).toHaveLength(lines.length);
    }
  });

  it("呼び出しの先とその分岐をたどり、循環や重複があっても一度だけ数える。届かないラベルと @define は数えない", () => {
    const flow = flowOf({
      a: "届かない頭。\n# start\nはじまり。\n@call common#shared\n@call common#shared\n@return\n# unused\n届かない末尾。",
      common: "届かない頭。\n# shared\n共通。\n@if game.flag\n条件つき。\n@call nested\n@end\n@return\n# unused\n届かない末尾。",
      nested: "@define m()\n部品。\n@end\n入れ子。\n@call common#shared\n@jump #next\n# next\nつづき。\n@return",
      unused: "届かないファイル。",
    }, "a#start");
    expect(flow.pages).toEqual({ a: [3], common: [3, 5], nested: [4, 8] });
    expect(flow.scenes.map((s) => s.nodes)).toEqual([["a#start"]]);
    expect(flow.links).toEqual([]);
    for (const [file, lines] of Object.entries(flow.pages)) {
      expect(flow.keys?.[file]).toHaveLength(lines.length);
      expect(flow.keys?.[file]?.every(Boolean)).toBe(true);
    }
  });

  it("飛び先が無い呼び出しは数えず、入口が無いか本文が無ければページは空", () => {
    expect(flowOf({ a: "本文。\n@call missing\n@return\n# unused\n届かない。" }).pages).toEqual({ a: [1] });
    for (const flow of [flowOf({ a: "@call missing\n@return" }), flowOf({ a: "本文。" }, "missing"), flowOf({})]) {
      expect(flow.pages).toEqual({});
      expect(flow.keys).toEqual({});
    }
  });

  it.each([false, true])("届く場面で呼んだマクロの @call の先も数える（別ファイル: %s）", (separate) => {
    const target = separate ? "common#shared" : "#shared";
    const main = `@define visit()\n@call ${target}\n@end\nはじまり。\n@visit\n@return`;
    const called = "# shared\n共通の場面。\n@return";
    const flow = flowOf(separate ? { a: main, common: called } : { a: `${main}\n${called}` });
    expect(flow.pages).toEqual(separate ? { a: [4], common: [2] } : { a: [4, 8] });
    const withoutCall = flowOf(separate ? { a: main.replace(`@call ${target}`, ""), common: called } : { a: `${main.replace(`@call ${target}`, "")}\n${called}` });
    expect(flow.scenes).toEqual(withoutCall.scenes);
    expect(flow.links).toEqual(withoutCall.links);
    for (const [file, lines] of Object.entries(flow.pages)) {
      expect(flow.keys?.[file]).toHaveLength(lines.length);
      expect(flow.keys?.[file]?.every(Boolean)).toBe(true);
    }
  });

  it("@use したマクロと入れ子の呼び出しを、定義したファイルから解決する。循環でも一度だけ数える", () => {
    const flow = flowOf({
      a: "@use lib\nはじまり。\n@if game.flag\n@with visit\n@end\n@end\n@return",
      lib: "@use nested\n@define visit()\n@call #shared\n部品{@inner}\n@end\n# shared\n共通。\n@return",
      nested: "@define inner()\n@visit\n@call ending\n@end\n@define visit()\n@inner\n@end",
      ending: "終わり。\n@return",
    });
    expect(flow.pages).toEqual({ a: [2], lib: [7], ending: [1] });
    expect(flow.scenes.map((s) => s.nodes)).toEqual([["a"]]);
    expect(flow.links).toEqual([]);
  });

  it("定義や @use だけでは先を数えず、届かない呼び出し・未取り込み・間接取り込み・隠れた定義も数えない", () => {
    const files = {
      a: "@use lib\n@define visit()\n@call #local\n@end\nはじまり。\n@visit\n@unimported\n@indirect\n@return\n# local\n近く。\n@return\n# unused\n@unused",
      lib: "@use nested\n@define visit()\n@call hidden\n@end\n@define unused()\n@call hidden\n@end",
      nested: "@define indirect()\n@call hidden\n@end",
      other: "@define unimported()\n@call hidden\n@end",
      hidden: "隠れた本文。",
    };
    expect(flowOf(files).pages).toEqual({ a: [5, 11] });
    const text = "@define visit()\n@call missing\n@end\n@visit\n@return";
    expect(flowOf({ a: text }).pages).toEqual({});
  });

  it("マクロ内の候補つきの呼び出しでファイルの入口を解決しても、地図の節と矢印は変えない", () => {
    const files = {
      a: "@define visit()\n@call (game.next) to=common,missing\n@end\nはじまり。\n@visit\n@return",
      common: "# shared\n共通。\n@return",
    };
    const scripts = new Map(Object.entries(files).map(([file, text]) => [file, { script: parse(text, file, { speakers }), text }]));
    const map = buildStoryMap({ scripts, registry: createRegistry(CORE_COMMANDS), entry: "a", hooks: new Map(), data: () => undefined });
    const before = structuredClone(map);
    const flow = buildFlow(map, new Map([...scripts].map(([file, { script }]) => [file, script])));
    expect(flow.pages).toEqual({ a: [4], common: [2] });
    expect(map).toEqual(before);
    expect(map.edges).toEqual([]);
    expect(flow.scenes.map((s) => s.nodes)).toEqual([["a"]]);
    expect(flow.links).toEqual([]);
  });
});
