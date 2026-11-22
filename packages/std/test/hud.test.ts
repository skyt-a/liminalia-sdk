import { describe, expect, it } from "vitest";
import { check, CORE_COMMANDS, createRegistry, parse } from "@liminalia/lang";
import { HeadlessHost, Runtime, type Translator } from "@liminalia/runtime";
import { combinePlugins } from "@liminalia/plugin-host";
import std, { hudState as H } from "../src/commands/index.ts";

/** 常駐の表示（@hud-button・@hud-text）の命令の側。 */

const { implementations, specs } = combinePlugins([std]);
const registry = createRegistry([...CORE_COMMANDS, ...specs]);

async function run(src: string) {
  const host = new HeadlessHost({ loadSource: async () => src });
  const runtime = new Runtime(host, { speakers: ["ユイ"], commands: implementations });
  await runtime.start("a");
  return runtime.state.stage;
}

const errors = (src: string) =>
  check(parse(src, "a.lim", { speakers: ["ユイ"] }), { registry, speakers: ["ユイ"] })
    .filter((d) => d.severity === "error")
    .map((d) => d.code);

describe("常駐の表示", () => {
  it("置いたものは状態に残り、if= は式の元の文字で残る。同じ名前は置き換え、off は名前ごと（省けばすべて）外す", async () => {
    const stage = await run(
      '@set game.day = 1\n@hud-button memo label=メモ x=10 y=20 call=#m show-if=(game.day >= 2)\n@hud-text day text="{= game.day} 日目"\n@hud-text day text="{= game.day}日" size=20 align=right width=100\n@hud-text place text=駅\n本文\n# m\n@return',
    );
    // 訳の元（i18n）は別のテストで見る
    expect(H.readHud(stage.extra).map(({ i18n: _, ...item }) => item)).toEqual([
      { kind: "button", name: "memo", call: "#m", x: 10, y: 20, label: "メモ", if: "game.day >= 2" },
      { kind: "text", name: "day", text: "{= game.day}日", x: 0, y: 0, width: 100, size: 20, align: "right" },
      { kind: "text", name: "place", text: "駅", x: 0, y: 0 },
    ]);
    const off = await run("@hud-button memo label=メモ call=#m\n@hud-text day text=a\n@hud-text place text=b\n@hud-text-off day\n@hud-button-off\n本文\n# m\n@return");
    expect(H.readHud(off.extra).map((i) => `${i.kind}:${i.name}`)).toEqual(["text:place"]);
  });

  it("字面で書いた text= と label= は訳の元を持ち、言語を替えると今の言語の文字になる（式で書いたものはそのまま）", async () => {
    const words: Record<string, string> = { "{= game.day} 日目": "Day {= game.day}", メモ: "Memo", 駅: "Station" };
    const english: Translator = { line: () => null, option: () => null, speaker: () => null, arg: (_f, s) => words[s] ?? null };
    const host = new HeadlessHost({
      loadSource: async () => '@set game.day = 1\n@hud-text day text="{= game.day} 日目"\n@hud-text place text=(game.place)\n@hud-button memo label=メモ call=#m\n本文\n# m\n@return',
    });
    const runtime = new Runtime(host, { commands: implementations, variables: { "game.place": "駅" } });
    await runtime.start("a");
    const shown = () => H.readHud(runtime.state.stage.extra).map((i) => (i.kind === "text" ? i.text : i.label));
    expect(shown()).toEqual(["{= game.day} 日目", "駅", "メモ"]);
    runtime.translator = english;
    expect(runtime.retranslate()).toBe(true);
    expect(shown()).toEqual(["Day {= game.day}", "駅", "Memo"]);
    runtime.translator = null;
    runtime.retranslate();
    expect(shown()).toEqual(["{= game.day} 日目", "駅", "メモ"]);
  });

  it("call= の飛び先と if= の式は検査が見る", () => {
    expect(errors("@hud-button memo label=メモ call=#nowhere")).toEqual(["unknown-label"]);
    expect(errors("@hud-button memo label=メモ call=#m show-if=game.day\n# m")).toEqual(["bad-value"]);
    expect(errors('@hud-text day text="{= game.day} 日目" x=40')).toEqual([]);
  });

  it("{= 式} の並びを探す（\"…\" の中の } は数えない）", () => {
    expect(H.hudSegments('{= game.day} 日目 {= "a}b"}')).toEqual([
      { start: 0, end: 12, source: "game.day" },
      { start: 16, end: 25, source: '"a}b"' },
    ]);
    expect(H.hudSegments("{= 閉じない")).toEqual([]);
  });
});
