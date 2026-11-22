import { describe, expect, it } from "vitest";
import { checkProject, configTargets, CORE_COMMANDS, createRegistry, parse, type Script } from "../src/index.ts";

const registry = createRegistry(CORE_COMMANDS);
const flow = (files: Record<string, string>, o: { references?: string[]; speakers?: string[] } = {}) =>
  checkProject(new Map<string, Script>(Object.entries(files).map(([name, text]) => [name, parse(text, name, { speakers: o.speakers ?? [] })])), { registry, ...o })
    .filter((d) => ["call-without-return", "unreachable-line", "unused-label", "unused-define", "unused-speaker"].includes(d.code))
    .map((d) => `${d.file}:${d.line} ${d.severity} ${d.code}`);

describe("流れの静的な誤り", () => {
  it("@call の先から @return まで届かなければ警告する（届く、途中で別の場所へ移るなら知らせない）", () => {
    const a = ["# start", "@call #ok", "@call #broken", "@call #leaves", "@call b", "@jump #end", "# ok", "地の文", "@return", "# leaves", "@jump #end", "# end", "終わり", "# broken", "戻らない"].join("\n");
    expect(flow({ a, b: "地の文\n@if (game.x)\n@return\n@end" })).toEqual(["a:3 warning call-without-return"]);
  });

  it("@jump や @stop の後のラベルの無い行は届かない（続く行は一つだけ知らせる）。@if の中も", () => {
    const a = ["# start", "@jump #next", "届かない", "これも", "# next", "@if (game.x)", "@jump #start", "枝の中の届かない行", "@end", "@stop", "最後"].join("\n");
    expect(flow({ a })).toEqual(["a:3 warning unreachable-line", "a:8 warning unreachable-line", "a:11 warning unreachable-line"]);
  });

  it("@with の引数の式の中の「#ラベル」も飛び先に数える", () => {
    const a = ["# start", "@define f(a: string)", "@content", "@end", '@with f a=("#inn")', "本文", "@end", "@jump #start", "# inn", "宿"].join("\n");
    expect(flow({ a })).toEqual([]);
  });

  it("時間切れの無い @choice はどの選択肢も飛ぶので、@end の後は届かない（timeout= があれば時間切れで続くので届く）", () => {
    const a = ["# start", "@choice", "- あ -> #a", "- い -> #b", "@end", "この本文には届かない", "# a", "あを選んだ", "# b", "いを選んだ"].join("\n");
    expect(flow({ a })).toEqual(["a:6 warning unreachable-line"]);
    const b = ["# start", "@choice timeout=5s", "- あ -> #a", "@end", "時間切れでここへ続く", "# a", "あ"].join("\n");
    expect(flow({ b })).toEqual([]);
  });

  it("届かない行が命令だけ（取り込んだ台本の末尾の @return など）なら情報", () => {
    expect(flow({ a: "# start\n@jump b\n@stop-bgm\n@return", b: "x" })).toEqual(["a:3 info unreachable-line"]);
  });

  it("どこからも飛ばれず前の行からも続かないラベルは情報（liminalia.json の entry や式の中の飛び先も数える）", () => {
    const a = ["# start", '@set game.next = "#via_var"', "@jump #used", "# orphan", "x", "# used", "@stop", "# via_var", "y", "@jump #used", "# entry", "z"].join("\n");
    expect(flow({ a })).toEqual(["a:4 info unused-label", "a:11 info unused-label"]);
    expect(flow({ a }, { references: configTargets({ entry: "a#entry" }) })).toEqual(["a:4 info unused-label"]);
  });

  it("使われないマクロと話者は情報", () => {
    const a = "@define used()\n@end\n@define unused()\n@end\n@used\nユイ「はい」";
    expect(flow({ a }, { speakers: ["ユイ", "レン"] })).toEqual(["a:3 info unused-define", "cast.json:1 info unused-speaker"]);
  });
});

describe("ほかのファイルから飛んでくるシーンの初めの背景（scene-start-no-bg）", () => {
  const starts = (files: Record<string, string>) =>
    checkProject(new Map<string, Script>(Object.entries(files).map(([name, text]) => [name, parse(text, name, { speakers: [] })])), { registry })
      .filter((d) => d.code === "scene-start-no-bg");

  it("ほかのファイルの @jump と選択肢で飛んでくるシーンが、最初の本文までに背景を決めていなければ、見出しの行に知らせる", () => {
    const a = ["# start", "@bg room.jpg", "地の文", "@choice", "- 行く -> b#hall", "@end"].join("\n");
    const b = ["# top", "続き", "@jump c", "# hall", "@bgm calm.ogg", "広間"].join("\n");
    const c = ["そのまま"].join("\n");
    const d = starts({ a, b, c });
    expect(d.map((x) => `${x.file}:${x.line} ${x.severity}`)).toEqual(["b:4 info", "c:1 info"]);
  });

  it("飛び先の初めか、飛ぶ直前に背景を決めていれば知らせない。同じファイルの中、@call、call=true の選択肢、式の飛び先も知らせない", () => {
    const a = ["# start", "地の文", "@jump b#one", "# two", "地の文", "@scene-change room.jpg", "@jump b#two", "# three", "地の文", "@call b#three", "@choice", '- 開く -> b#four call=true', '- 先 -> (game.next)', "@end"].join("\n");
    const b = ["# one", "@bgm x.ogg", "@scene-change hall.jpg", "広間", "@jump #three", "# two", "続き", "# three", "呼ばれた", "@return", "# four", "開いた", "@return"].join("\n");
    expect(starts({ a, b })).toEqual([]);
  });

  it("作品のどこにも背景を決める命令が無ければ（文字だけの作品）知らせない。飛び先が下書きでも知らせない", () => {
    expect(starts({ a: "地の文\n@jump b", b: "続き" })).toEqual([]);
    expect(starts({ a: "@bg x.jpg\n地の文\n@jump b", b: "// lim: draft\n続き" })).toEqual([]);
  });

  it("ファイルの先頭がラベルなら、ファイルへ飛ぶのとラベルへ飛ぶのを一つにまとめる", () => {
    const d = starts({ a: "@bg x.jpg\n地の文\n@jump b\n地の文\n@jump b#top", b: "# top\n続き" });
    expect(d.map((x) => `${x.file}:${x.line}`)).toEqual(["b:1"]);
  });

  it("画像を書かない @scene-change（雛形）は背景を決めたと数えない。単色の背景は数える", () => {
    const a = ["@bg x.jpg", "地の文", "@scene-change", "@jump b#one", "地の文", "@jump b#two", "地の文", "@jump b#three"].join("\n");
    const b = ["# one", "@scene-change", "続き", "# two", "@scene-change bg-color=#000000", "続き", "# three", "@bg color=#ffffff", "続き"].join("\n");
    expect(starts({ a, b }).map((x) => `${x.file}:${x.line}`)).toEqual(["b:1"]);
  });

  it("@if の中から飛ぶときは、@if の前で決めた背景も見る", () => {
    const a = ["@bg x.jpg", "地の文", "@bg y.jpg", "@if (game.x)", "@jump b", "@end", "地の文", "@if (game.y)", "@jump c", "@end"].join("\n");
    expect(starts({ a, b: "続き", c: "続き" }).map((x) => `${x.file}:${x.line}`)).toEqual(["c:1"]);
  });

  it("飛んでくる所のうち一つでも背景を決めていなければ知らせる。@if で始まるシーンは見ない", () => {
    const a = ["# start", "地の文", "@bg x.jpg", "@jump b#one", "# other", "地の文", "@jump b#one", "# again", "地の文", "@jump b#cond"].join("\n");
    const b = ["# one", "続き", "# cond", "@if (game.x)", "@bg y.jpg", "@end", "本文"].join("\n");
    expect(starts({ a, b }).map((x) => `${x.file}:${x.line}`)).toEqual(["b:1"]);
  });
});
