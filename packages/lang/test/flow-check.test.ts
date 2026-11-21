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
