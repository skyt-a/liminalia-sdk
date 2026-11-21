import { describe, expect, it } from "vitest";
import { checkItems, itemAssetReferences, parse } from "../src/index.ts";

describe("持ち物", () => {
  it("定義の形と、シナリオの @item-add・@item-remove・item(\"…\") の名前を確かめる", () => {
    const script = parse('@item-add key\n@item-remove lamp count=1\n@if (item("map") > 0)\nある。\n@end\n@choice\n- 使う -> #a if=(item("rope") > 0)\n@end\n# a\n', "a");
    const d = checkItems({ key: { name: "鍵", image: "items/key.png" }, lamp: { name: "ランプ" }, bad: { image: "x.png" } }, new Map([["a", script]]));
    expect(d.map((x) => [x.code, x.line, x.message])).toEqual([
      ["bad-items", 1, "items.bad に name（表示する名前）がありません"],
      ["unknown-item", 3, "持ち物 map は liminalia.json の items にありません"],
      ["unknown-item", 7, "持ち物 rope は liminalia.json の items にありません"],
    ]);
    expect(itemAssetReferences({ key: { name: "鍵", image: "items/key.png" } })).toEqual([{ folder: "image", path: "items/key.png", where: "items.key.image" }]);
  });
});
