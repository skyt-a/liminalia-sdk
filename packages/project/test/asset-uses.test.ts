import { describe, expect, it } from "vitest";
import { assetAlwaysUsed, assetTextUses } from "../src/asset-uses.ts";

const uses = (text: string, assets: { folder: string; path: string }[]) => Object.fromEntries([...assetTextUses([{ where: "x", text }], assets)].map(([k, v]) => [k, v.map((u) => u.how)]));

describe("素材の名前を文字として探す", () => {
  it("名前（拡張子つきか拡張子なし）は語の境目で、大文字と小文字、濁点などの合成の違いを問わない", () => {
    const nfd = "ガード.webp".normalize("NFD");
    expect(uses('@bg "ガード.webp"\nBG_A\nxbg_b', [{ folder: "bgimage", path: nfd }, { folder: "bgimage", path: "bg_a.png" }, { folder: "bgimage", path: "bg_b.png" }])).toEqual({ [`bgimage/${nfd}`]: ["name"], "bgimage/bg_a.png": ["name"] });
  });

  it("連番の型と、式でつなぐ名前の一部", () => {
    const assets = [{ folder: "image", path: "fx/slash_01.png" }, { folder: "sound", path: "radio_2.wav" }, { folder: "fgimage", path: "yui_smile.png" }, { folder: "sound", path: "other.wav" }];
    expect(uses('@flipbook fx/slash_{nn}.png frames=2\n@set game.s = "radio_" + n\nconst f = face + "_smile.png";\n@se (n + ".wav")', assets)).toEqual({ "image/fx/slash_01.png": ["pattern"], "sound/radio_2.wav": ["fragment"], "fgimage/yui_smile.png": ["fragment"] });
  });

  it("区切りの無い長い文字でも時間がかからない", () => {
    const long = `url(data:image/png;base64,${"A".repeat(2_000_000)}) "${"b".repeat(1_000_000)}" {n`;
    const started = performance.now();
    assetTextUses([{ where: "x", text: long }], [{ folder: "image", path: "a_01.png" }]);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("名前が出てこなくても使っているとみなす素材", () => {
  it("選んだテーマ（言語ごとの見た目で選んだものも）の素材だけ", () => {
    const ui = { system: { preset: "night" }, languages: { en: { system: { preset: "school" } } } };
    expect(assetAlwaysUsed("image", "themes/night/frame.png", ui)).toBe(true);
    expect(assetAlwaysUsed("image", "themes/school/frame.png", ui)).toBe(true);
    expect(assetAlwaysUsed("image", "themes/mansion/frame.png", ui)).toBe(false);
    expect(assetAlwaysUsed("bgimage", "themes/night/frame.png", ui)).toBe(false);
    expect(assetAlwaysUsed("image", "themes/night/frame.png", undefined)).toBe(false);
  });
});
