import { describe, expect, it } from "vitest";
import { parseInline } from "@liminalia/lang";
import { Runtime, type Host, type SaveData, type StageState, type Translator } from "../src/index.ts";

/** 別の言語でロードしたときの、NVL の読み終えた段落とクリックを待たずに残した本文（{noclick}）。 */

const speakers = ["ユイ", "ソウ"];
const words: Record<string, string> = { "「はい」": "“Yes”", "地の文。": "Prose.", "「待って」{noclick}": "“Wait”{noclick}" };
const translator: Translator = {
  line: (_f, s) => (words[s] ? parseInline(words[s]).content : null),
  option: () => null,
  speaker: (n) => (n === "ユイ" ? "Yui" : n === "ソウ" ? "Sou" : null),
};
const text = (parts: readonly ({ text: string } | { br: true })[] | undefined) => (parts ?? []).map((p) => ("text" in p ? p.text : "")).join("");
const tick = () => new Promise((r) => setTimeout(r, 20));

/** 選択肢で止まるまで流してセーブし、別の実行器（訳あり）でロードして、組み立て直させた舞台を返す。 */
async function reload(source: string, edit?: (save: SaveData) => void): Promise<{ save: SaveData; stage: StageState }> {
  const restored: StageState[] = [];
  const host: Host = {
    loadSource: async () => source,
    present: async (e) => {
      if (e.type === "command" && e.name === "restore") restored.push(structuredClone(e.stage));
    },
    waitClick: async () => {},
    choose: () => new Promise(() => undefined),
  };
  const first = new Runtime(host, { speakers });
  void first.start("a");
  await tick();
  const save = first.save();
  first.dispose();
  edit?.(save);
  const second = new Runtime(host, { speakers });
  second.translator = translator;
  void second.load(save);
  await tick();
  second.dispose();
  return { save, stage: restored.at(-1)! };
}

describe("別の言語でロードしたときの NVL の段落と {noclick} の本文", () => {
  it("読み終えた段落を今の言語の本文と名前で作り直す（前の版のセーブの段落はそのまま）", async () => {
    const { save, stage } = await reload("@nvl on\nユイ「はい」\n地の文。\n@choice\n- 甲 -> #a\n@end\n# a\n", (s) => {
      s.stage.nvlPages!.push({ speaker: null, parts: [{ text: "古い段落。", ruby: null, style: { bold: false, italic: false, color: null, perChar: null, size: null, mark: null } }] });
    });
    expect(save.stage.nvlPages?.map((p) => p.origin?.source)).toEqual(["「はい」", "地の文。", undefined]);
    expect(stage.nvlPages?.map((p) => [p.label ?? null, text(p.parts)])).toEqual([
      ["Yui", "“Yes”"],
      [null, "Prose."],
      [null, "古い段落。"],
    ]);
  });

  it("クリックを待たずに残した本文も今の言語にする", async () => {
    const { save, stage } = await reload("ソウ「待って」{noclick}\n@choice\n- 甲 -> #a\n@end\n# a\n");
    expect(save.stage.noclickPage).toMatchObject({ speaker: "ソウ", origin: { file: "a", source: "「待って」{noclick}" } });
    expect([stage.noclickPage?.label, text(stage.noclickPage?.parts)]).toEqual(["Sou", "“Wait”"]);
  });
});
