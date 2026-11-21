import { describe, expect, it } from "vitest";
import { parseScenarioTests } from "@liminalia/lang";
import { runScenarioTest } from "../src/index.ts";

/** 台本のテスト（.limtest）を画面なしで流す。 */

const files: Record<string, string> = {
  start: [
    "@set game.trust = 0",
    "# menu",
    "@choice",
    "- 北の道を行く -> #north",
    "- 南の道を行く -> #south",
    "@end",
    "# north",
    "@set game.trust += 2",
    "ユイ「星が見える」",
    "@jump end#good if=(game.trust >= 2)",
    "# south",
    "ユイ「暗いね」",
    "@jump end#bad",
  ].join("\n"),
  end: ["# good", "よかった。", "@title-screen ending=good", "# bad", "残念。", "@title-screen ending=bad"].join("\n"),
};

const run = async (src: string) => {
  const { tests, diagnostics } = parseScenarioTests(src, "t.limtest");
  expect(diagnostics).toEqual([]);
  return Promise.all(tests.map((t) => runScenarioTest(t, { entry: "start", loadSource: async (f) => files[f]!, runtime: { speakers: ["ユイ"] } })));
};

describe("台本のテスト", () => {
  it("選び方（文と番号）と期待（式、通った場所、本文、エンディング）", async () => {
    const [north, south] = await run(
      [
        "# 北",
        "choose 北の道",
        "expect game.trust == 2",
        "expect reach end#good",
        "expect not reach end#bad",
        "expect reach start:9",
        'expect text "星が見える"',
        "expect ending good",
        "expect no-warnings",
        "# 南",
        "set game.trust = 5",
        "choose 2",
        "expect game.trust == 0",
        "expect ending bad",
      ].join("\n"),
    );
    expect(north!.failures).toEqual([]);
    expect(north!.ok).toBe(true);
    expect(south!.failures).toEqual([]);
    expect(south!.choices).toEqual([{ options: ["北の道を行く", "南の道を行く"], selected: 1 }]);
  });

  it("choose を使い切ったら止め（rest stop）、from と set で途中から始められる", async () => {
    const [stopped, from] = await run(["# 選ばない", "expect not reach end", "# 途中から", "from start#north", "set game.trust = -5", "expect game.trust == -3", "expect reach end#bad"].join("\n"));
    expect(stopped!.failures).toEqual([]);
    expect(stopped!.result.reason).toBe("stopped");
    expect(from!.failures).toEqual([]);
  });

  it("読めない行は診断にする", () => {
    const { tests, diagnostics } = parseScenarioTests(["choose 1", "# a", "choose 0", "expect reach !!", "rest sometimes", "set trust = 1", "frobnicate"].join("\n"), "t.limtest");
    expect(tests).toHaveLength(1);
    expect(diagnostics.map((d) => [d.line, d.code])).toEqual([
      [1, "bad-test"],
      [3, "bad-test"],
      [4, "bad-test"],
      [5, "bad-test"],
      [6, "bad-test"],
      [7, "bad-test"],
    ]);
  });
});
