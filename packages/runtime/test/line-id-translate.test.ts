import { describe, expect, it } from "vitest";
import { parseInline } from "@liminalia/lang";
import { Runtime, type Host, type StageState, type Translator } from "../src/index.ts";

/** 固定の行 ID（#line:ID）のある行は、ID を添えて訳を引く（原文を書き換えても訳が外れない）。 */

const tick = () => new Promise((r) => setTimeout(r, 20));
const text = (parts: readonly ({ text: string } | { br: true })[] | undefined) => (parts ?? []).map((p) => ("text" in p ? p.text : "")).join("");

describe("固定の行 ID の訳", () => {
  it("本文の行と選択肢の行の ID を訳の口に渡し、セーブの段落の元にも残す（ロードしたときの作り直しも ID で引く）", async () => {
    const asked: string[] = [];
    const translator: Translator = {
      line: (_f, s, _c, id) => {
        asked.push(`line ${id ?? "-"} ${s}`);
        return id === "g1" ? parseInline("“Morning.”").content : null;
      },
      option: (_f, s, _c, id) => {
        asked.push(`option ${id ?? "-"} ${s}`);
        return id === "c1" ? parseInline("Go").content : null;
      },
      speaker: () => null,
    };
    const pages: string[] = [];
    const choices: string[][] = [];
    const restored: StageState[] = [];
    const source = "@nvl on\nユイ「おはよう！」 #line:g1\n地の文。\n@choice\n- 行く -> #a #line:c1\n@end\n# a\n";
    const host: Host = {
      loadSource: async () => source,
      present: async (e) => {
        if (e.type === "text") pages.push(e.text);
        if (e.type === "command" && e.name === "restore") restored.push(structuredClone(e.stage));
      },
      waitClick: async () => {},
      choose: (options) => {
        choices.push([...options]);
        return new Promise(() => undefined);
      },
    };
    const rt = new Runtime(host, { speakers: ["ユイ"] });
    rt.translator = translator;
    void rt.start("a");
    await tick();
    expect(asked).toEqual(["line g1 「おはよう！」", "line - 地の文。", "option c1 行く"]);
    expect(pages.join("")).toContain("“Morning.”");
    expect(choices).toEqual([["Go"]]);
    const save = rt.save();
    rt.dispose();
    expect(save.stage.nvlPages?.map((p) => p.origin?.id ?? null)).toEqual(["g1", null]);

    // 別の言語でロードすると、読み終えた段落を ID で引き直す
    const again = new Runtime(host, { speakers: ["ユイ"] });
    again.translator = translator;
    void again.load(save);
    await tick();
    again.dispose();
    expect(text(restored.at(-1)?.nvlPages?.[0]?.parts)).toBe("“Morning.”");
  });
});
