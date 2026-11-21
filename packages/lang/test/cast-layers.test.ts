import { describe, expect, it } from "vitest";
import { castAssetReferences, castProblems, resolveVariant, spriteProblem, variantLayers, variantPreview, type CastEntry } from "../src/index.ts";

const yui: CastEntry = {
  appearances: {
    uniform: {
      layers: [
        { name: "body", options: { uniform: "yui/body_uniform.png" }, default: "uniform" },
        { name: "eyes", options: { open: "yui/eyes_open.png", closed: "yui/eyes_closed.png" }, default: "open" },
        { name: "mouth", options: { smile: "yui/mouth_smile.png", open: "yui/mouth_open.png" } },
        { name: "cheek", options: { blush: "yui/cheek_blush.png" } },
      ],
      variants: {
        normal: { image: "", parts: {} },
        smile: { image: "", parts: { mouth: "smile" } },
        sleep: { image: "", parts: { eyes: "closed", mouth: "" } },
      },
    },
  },
};

describe("パーツ合成の立ち絵", () => {
  it("差分の parts と層の default から、下から重ねる絵を決める", () => {
    const set = yui.appearances.uniform!;
    expect(variantLayers(set, set.variants.smile!)).toEqual(["yui/body_uniform.png", "yui/eyes_open.png", "yui/mouth_smile.png"]);
    expect(variantLayers(set, set.variants.sleep!)).toEqual(["yui/body_uniform.png", "yui/eyes_closed.png"]);
    expect(variantPreview(set, set.variants.normal!)).toBe("yui/body_uniform.png");
    expect(variantLayers(undefined, { image: "a.png" })).toBeNull();
  });

  it("@chara の差分に「smile+blush」と書くと層の絵を足し、無い絵なら差分なし", () => {
    const r = resolveVariant(yui, "", "smile+blush");
    expect(variantLayers(yui.appearances.uniform, r.variant!)).toEqual(["yui/body_uniform.png", "yui/eyes_open.png", "yui/mouth_smile.png", "yui/cheek_blush.png"]);
    // 差分を省いて足すだけ（標準の差分 normal に足す）
    expect(variantLayers(yui.appearances.uniform, resolveVariant(yui, "", "+closed").variant!)).toEqual(["yui/body_uniform.png", "yui/eyes_closed.png"]);
    expect(resolveVariant(yui, "", "smile+nope").variant).toBeNull();
    expect(spriteProblem({ yui }, "yui", "", "smile+nope", "")?.code).toBe("unknown-variant");
    expect(spriteProblem({ yui }, "yui", "", "smile+blush", "")).toBeNull();
  });

  it("定義の形を確かめ、層の絵を素材に入れる", () => {
    expect(castProblems({ yui })).toEqual([]);
    const bad = structuredClone(yui);
    bad.appearances.uniform!.variants.smile!.parts = { mouth: "grin", hat: "x" };
    bad.appearances.uniform!.layers![1]!.default = "half";
    expect(castProblems({ yui: bad }).map((p) => p.message)).toEqual([
      expect.stringContaining("default half"),
      expect.stringContaining("絵 grin"),
      expect.stringContaining("層 hat"),
    ]);
    expect(castAssetReferences({ yui }).map((r) => r.path)).toContain("yui/cheek_blush.png");
  });

  it("人物ごとの台詞の文字の見た目（text）と、名前の欄と枠の画像（nameImage、windowImage）の形を確かめ、画像を素材に入れる", () => {
    const styled: CastEntry = { appearances: {}, text: { color: "#e8b4c8", font: "serif", italic: true }, nameImage: "ui/yui_name.png", windowImage: "ui/yui_window.png" };
    expect(castProblems({ yui: styled })).toEqual([]);
    expect(castAssetReferences({ yui: styled })).toEqual([
      { who: "yui", path: "ui/yui_name.png", folder: "image" },
      { who: "yui", path: "ui/yui_window.png", folder: "image" },
    ]);
    const bad = { appearances: {}, text: { color: 3, italic: "yes", size: 20 }, nameImage: "" } as unknown as CastEntry;
    expect(castProblems({ yui: bad }).map((p) => p.message)).toEqual([
      "キャラクター yui の text の color は文字列で書きます",
      "キャラクター yui の text の italic は true か false で書きます",
      "キャラクター yui の text に size は書けません",
      "キャラクター yui の nameImage は image からのパスで書きます",
    ]);
    expect(castProblems({ yui: { appearances: {}, text: "red" } as unknown as CastEntry }).map((p) => p.message)).toEqual(["キャラクター yui の text は { color, font, italic } で書きます"]);
  });
});
