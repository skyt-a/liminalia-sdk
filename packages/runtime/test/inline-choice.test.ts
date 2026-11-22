import { describe, expect, it } from "vitest";
import { parseInline } from "@liminalia/lang";
import { Runtime, type Host, type Translator } from "../src/index.ts";

/**
 * 本文の流れに出す選択肢（ui.choice.position: inline → 実行器の設定 inlineChoices）。
 * @nvl の間、選んだ選択肢を本文の一部として stage.nvlPages に残し、ロードや言語の切り替えで出し直せるようにする。
 */

const tick = () => new Promise((r) => setTimeout(r, 20));

const SCENARIO = `@nvl on
雪が降っている。
@choice
- ペンションへ向かう -> #a
- 引き返す -> #b
@end
# a
ペンションに着いた。
@stop
# b
引き返した。
@stop
`;

const run = async (options: { inlineChoices?: boolean; pick?: number; src?: string; translator?: Translator | null } = {}) => {
  const host: Host = {
    loadSource: async () => options.src ?? SCENARIO,
    present: async () => {},
    waitClick: async () => {},
    choose: async () => options.pick ?? 0,
  };
  const rt = new Runtime(host, { speakers: [], ...(options.inlineChoices ? { inlineChoices: true } : {}), ...(options.translator !== undefined ? { translator: options.translator } : {}) });
  await rt.start("a");
  return rt;
};

describe("本文の流れに出す選択肢を @nvl の本文に残す（inlineChoices）", () => {
  it("選んだ選択肢を、出した文と選んだ番号で nvlPages に残す", async () => {
    const rt = await run({ inlineChoices: true, pick: 1 });
    const last = rt.state.stage.nvlPages?.find((p) => p.choice);
    expect(last).toMatchObject({
      speaker: null,
      choice: {
        options: [{ text: "ペンションへ向かう" }, { text: "引き返す" }],
        picked: 1,
      },
    });
    // 訳し直せるように、一つずつの文の元（option の origin）を持つ
    expect(last?.choice?.options.map((o) => [o.origin?.kind, o.origin?.file, o.origin?.source])).toEqual([
      ["option", "a", "ペンションへ向かう"],
      ["option", "a", "引き返す"],
    ]);
    // 本文の流れの中の記録なので、選ぶ前の段落と選んだあとの段落のあいだに並ぶ
    const kinds = rt.state.stage.nvlPages?.map((p) => (p.choice ? "choice" : "page"));
    expect(kinds).toEqual(["page", "choice", "page"]);
  });

  it("inlineChoices でなければ残さない", async () => {
    const rt = await run({ pick: 1 });
    expect(rt.state.stage.nvlPages?.every((p) => !p.choice)).toBe(true);
  });

  it("@nvl でなければ残さない", async () => {
    const rt = await run({
      inlineChoices: true,
      src: "雪が降っている。\n@choice\n- 行く -> #a\n@end\n# a\n着いた。\n@stop\n",
    });
    expect(rt.state.stage.nvlPages).toBeUndefined();
  });

  it("ロードしても残っていて、訳があれば今の言語にする", async () => {
    const first = await run({ inlineChoices: true, pick: 0 });
    const save = first.save();
    first.dispose();
    const words: Record<string, string> = { "ペンションへ向かう": "Head to the pension", "引き返す": "Turn back" };
    const translator: Translator = {
      line: () => null,
      option: (_f, s) => (words[s] ? parseInline(words[s]).content : null),
      speaker: () => null,
    };
    const host: Host = {
      loadSource: async () => SCENARIO,
      present: async () => {},
      waitClick: async () => {},
      choose: () => new Promise(() => undefined),
    };
    const second = new Runtime(host, { speakers: [], inlineChoices: true, translator });
    void second.load(save);
    await tick();
    second.dispose();
    const choice = second.state.stage.nvlPages?.find((p) => p.choice)?.choice;
    expect(choice?.options.map((o) => o.text)).toEqual(["Head to the pension", "Turn back"]);
    expect(choice?.picked).toBe(0);
  });
});
