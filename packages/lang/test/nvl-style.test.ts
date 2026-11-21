import { describe, expect, it } from "vitest";
import { checkNvlStyles, checkUi, parse, uiAssetReferences } from "../src/index.ts";

/** NVL の見た目（ui.nvl、ui.nvlStyles）と、@nvl on style= の名前の検査。 */
describe("NVL の見た目", () => {
  it("ui.nvl と ui.nvlStyles の形を確かめ、絵を素材の実在の確認に入れる", () => {
    const ok = { nvl: { background: "#000", padding: [10, 20, 30, 40], valign: "top", fade: 300 }, nvlStyles: { letter: { image: "paper.png", align: "center", names: false } } };
    expect(checkUi(ok)).toEqual([]);
    expect(checkUi({ nvl: { valign: "middle" }, nvlStyles: { letter: { size: "big", nope: 1 } } }).map((d) => d.message)).toEqual([
      "ui.nvl.valign は top、center、bottom のどれかを指定します",
      "ui.nvlStyles.letter.size は数値で書きます",
      "ui.nvlStyles.letter.nope という項目はありません",
    ]);
    expect(uiAssetReferences(ok as unknown as Parameters<typeof uiAssetReferences>[0])).toEqual(expect.arrayContaining([expect.objectContaining({ folder: "image", path: "paper.png" })]));
  });

  it("@nvl on style= の名前が ui.nvlStyles に無ければエラー", () => {
    const script = parse("@nvl on style=letter\n本文。\n@nvl on style=memo\n@nvl on\n", "a");
    expect(checkNvlStyles(new Map([["a", script]]), { nvlStyles: { letter: {} } })).toEqual([expect.objectContaining({ code: "unknown-nvl-style", line: 3, message: "NVL の見た目 memo は liminalia.json の ui.nvlStyles にありません", hint: "letter" })]);
  });
});
