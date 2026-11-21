import { describe, expect, it } from "vitest";
import { backgroundToneName, checkTones, checkUi, findTone, IDENTITY_MATRIX, mixMatrix, parse, spriteToneName, toneMatrix, uiAssetReferences } from "../src/index.ts";

/** 行列を RGB に掛ける。 */
const apply = (m: number[], [r, g, b]: number[]) => [0, 1, 2].map((row) => m[row * 5]! * r! + m[row * 5 + 1]! * g! + m[row * 5 + 2]! * b! + m[row * 5 + 4]!);

describe("立ち絵の色調", () => {
  it("彩度・掛ける色・明るさ・コントラストを一つの行列にする", () => {
    expect(toneMatrix(null)).toEqual(IDENTITY_MATRIX);
    const gray = apply(toneMatrix({ saturation: 0 }), [1, 0, 0]);
    expect(gray[0]).toBeCloseTo(0.2126);
    expect(gray[1]).toBeCloseTo(0.2126);
    expect(apply(toneMatrix({ color: "#ff8000" }), [1, 1, 1]).map((v) => Math.round(v * 255))).toEqual([255, 128, 0]);
    expect(apply(toneMatrix({ color: "#000000", amount: 0.5 }), [1, 1, 1])).toEqual([0.5, 0.5, 0.5]);
    expect(apply(toneMatrix({ brightness: 0.5 }), [1, 1, 1])).toEqual([0.5, 0.5, 0.5]);
    expect(apply(toneMatrix({ contrast: 2 }), [0.75, 0.5, 0.25])).toEqual([1, 0.5, 0]);
    expect(mixMatrix([0, 2], [2, 4], 0.5)).toEqual([1, 3]);
  });

  it("背景の色調は @bg の tone= → ui.backgroundTones の順。立ち絵には @tone の人物ごと → すべて → 背景の色調の順に掛ける", () => {
    const map = { "room.webp": "night", "hall.webp": "evening" };
    expect(backgroundToneName("room.webp", undefined, map)).toBe("night");
    expect(backgroundToneName("street.webp", undefined, map)).toBeNull();
    expect(backgroundToneName("room.webp", { image: "room.webp", tone: "dark" }, map)).toBe("dark");
    // tone=none はその背景に掛けない（ui.backgroundTones より先）
    expect(backgroundToneName("room.webp", { image: "room.webp", tone: "none" }, map)).toBeNull();
    // ほかの背景で決めた tone= は効かない（背景を替えるほかの命令のあと）
    expect(backgroundToneName("hall.webp", { image: "room.webp", tone: "dark" }, map)).toBe("evening");
    expect(backgroundToneName(null, undefined, map)).toBeNull();
    expect(spriteToneName(undefined, "ユイ", "night")).toBe("night");
    expect(spriteToneName({ "": "sepia" }, "ユイ", "night")).toBe("sepia");
    expect(spriteToneName({ "": "sepia", ユイ: "plain" }, "ユイ", "night")).toBe("plain");
    expect(spriteToneName(undefined, "ユイ", null)).toBe("none");
    // plain は色を変えない
    expect(toneMatrix(findTone("plain"))).toEqual(IDENTITY_MATRIX);
  });

  it("ui.backgroundTones の形と色調の名前を確かめ、鍵の背景を素材の参照に挙げる", () => {
    expect(checkUi({ backgroundTones: { "room.webp": "night" } })).toEqual([]);
    expect(checkUi({ backgroundTones: { "room.webp": 1 } })[0]?.code).toBe("bad-ui");
    expect(checkTones(new Map(), { tones: { bar: { color: "#ffb080" } }, backgroundTones: { "a.webp": "bar", "b.webp": "none", "c.webp": "nite" } })).toEqual([expect.objectContaining({ code: "unknown-tone", file: "liminalia.json", message: "ui.backgroundTones の c.webp の色調 nite はありません" })]);
    expect(uiAssetReferences({ backgroundTones: { "bg/room.webp": "night" } })).toEqual([{ folder: "bgimage", path: "bg/room.webp", where: "ui.backgroundTones.bg/room.webp" }]);
  });

  it("シナリオの色調の名前を、組み込みと ui.tones から確かめる", () => {
    const script = parse("@tone night\n@tone none\n@tone dusk time=1s\n@tone nite\n", "a");
    expect(checkTones(new Map([["a", script]]), { tones: { dusk: { brightness: 0.8 } } })).toEqual([expect.objectContaining({ code: "unknown-tone", line: 4, message: "色調 nite はありません" })]);
  });

  it("@bg と @scene-change の tone= の名前も確かめる（位置引数は背景の絵なので見ない）", () => {
    const script = parse("@bg nite.webp tone=night\n@bg a.webp tone=nite\n@scene-change b.webp tone=dusk\n@scene-change c.webp tone=dawn\n", "a");
    expect(checkTones(new Map([["a", script]]), { tones: { dusk: { brightness: 0.8 } } }).map((d) => [d.line, d.message])).toEqual([
      [2, "色調 nite はありません"],
      [4, "色調 dawn はありません"],
    ]);
  });
});
