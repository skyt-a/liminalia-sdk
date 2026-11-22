import { describe, expect, it } from "vitest";
import { castProblems, type Cast, type CastVariant } from "@liminalia/lang";
import {
  addAppearance,
  addCharacter,
  addPosition,
  cloneFrame,
  frameFromNatural,
  History,
  imageFileName,
  initialFrameAlone,
  initialFrameFromReference,
  normalizeKey,
  opaqueBounds,
  pinchResize,
  referenceVariantKey,
  removeAppearance,
  resizeBox,
  sanitizeFileBase,
  syncToAllVariants,
  syncToOtherPositions,
  uniqueKey,
  wheelResize,
  type FullFrame,
} from "../src/caster/model.ts";

const frame = (width: number, height: number, left: number, top: number): FullFrame => ({
  width,
  height,
  positions: { left: { left, top }, center: { left: left + 360, top }, right: { left: left + 720, top } },
});
const variant = (f: FullFrame, image = "a.png"): CastVariant => ({ image, frame: structuredClone(f) });

describe("枠", () => {
  it("pinchResize は中心を保って倍率を掛け、小さくなりすぎない", () => {
    const start = { left: 100, top: 50, width: 400, height: 600 };
    expect(pinchResize(start, 1.5)).toEqual({ left: 0, top: -100, width: 600, height: 900 });
    expect(pinchResize(start, 0.5)).toEqual({ left: 200, top: 200, width: 200, height: 300 });
    expect(pinchResize(start, 0)).toMatchObject({ width: 1, height: 1 });
  });

  it("cloneFrame は既定の大きさと left / center / right を埋め、ほかの立ち位置も残して丸める", () => {
    expect(cloneFrame(undefined)).toEqual({ width: 632, height: 843, positions: { left: { left: 0, top: 0 }, center: { left: 0, top: 0 }, right: { left: 0, top: 0 } } });
    expect(cloneFrame({ width: 100.4, positions: { far: { left: 1.6, top: 2 } } }).positions).toEqual({
      left: { left: 0, top: 0 },
      center: { left: 0, top: 0 },
      right: { left: 0, top: 0 },
      far: { left: 2, top: 2 },
    });
  });

  it("枠のない差分は、画面下の中央に実寸で出る枠になる", () => {
    expect(frameFromNatural({ width: 400, height: 600 }, { width: 1280, height: 720 })).toEqual({
      width: 400,
      height: 600,
      positions: { left: { left: 440, top: 120 }, center: { left: 440, top: 120 }, right: { left: 440, top: 120 } },
    });
  });
});

describe("動かす・大きさを変える", () => {
  const box = { left: 100, top: 50, width: 400, height: 600 };

  it("ホイールは中心を保つ。固定なら縦横とも、外せば横だけ、Shift で縦だけ", () => {
    expect(wheelResize(box, -1, true, false)).toEqual({ width: 414, height: 621, left: 93, top: 40 });
    expect(wheelResize(box, 1, true, false)).toEqual({ width: 386, height: 579, left: 107, top: 61 });
    expect(wheelResize(box, -1, false, false)).toEqual({ width: 414, height: 600, left: 93, top: 50 });
    expect(wheelResize(box, -1, false, true)).toEqual({ width: 400, height: 621, left: 100, top: 40 });
  });

  it("取っ手は反対側を動かさない", () => {
    expect(resizeBox(box, "se", 40, 10, null)).toEqual({ left: 100, top: 50, width: 440, height: 610 });
    expect(resizeBox(box, "nw", 40, 10, null)).toEqual({ left: 140, top: 60, width: 360, height: 590 });
    expect(resizeBox(box, "w", -20, 99, null)).toEqual({ left: 80, top: 50, width: 420, height: 600 });
    expect(resizeBox(box, "n", 99, -30, null)).toEqual({ left: 100, top: 20, width: 400, height: 630 });
  });

  it("縦横比を保つ: 辺はその向き、角は大きく動いた方に合わせる", () => {
    const ratio = 400 / 600;
    expect(resizeBox(box, "e", 40, 0, ratio)).toEqual({ left: 100, top: 50, width: 440, height: 660 });
    expect(resizeBox(box, "s", 0, 60, ratio)).toEqual({ left: 100, top: 50, width: 440, height: 660 });
    expect(resizeBox(box, "nw", -10, -60, ratio)).toEqual({ left: 60, top: -10, width: 440, height: 660 });
    expect(resizeBox(box, "se", -1000, -1000, ratio)).toEqual({ left: 100, top: 50, width: 1, height: 1 });
  });
});

describe("同期", () => {
  it("サイズ/Y を全差分へ: 基準の枠からの倍率を掛け、X は各立ち位置の中心を保ち、top をそろえる", () => {
    const base = { normal: frame(400, 600, 100, 50), smile: frame(420, 600, 90, 60), plain: undefined };
    const variants: Record<string, CastVariant> = {
      normal: variant(frame(440, 660, 100, 50)),
      smile: variant(base.smile),
      plain: { image: "p.png" },
    };
    // 今の差分（normal）の center を動かした
    variants.normal!.frame!.positions!.center = { left: 470, top: 30 };
    const r = syncToAllVariants(variants, { variant: "normal", position: "center", base: (k) => base[k as keyof typeof base] });
    expect(r).toEqual({ scaleX: 1.1, scaleY: 1.1, top: 30, targets: ["normal", "smile"], excluded: [] });
    // 今の差分の今の立ち位置は今の left のまま、ほかは中心を保つ（100 + (400 - 440) / 2 = 80）
    expect(variants.normal!.frame).toEqual({
      width: 440,
      height: 660,
      positions: { left: { left: 80, top: 30 }, center: { left: 470, top: 30 }, right: { left: 800, top: 30 } },
    });
    // 420 × 1.1 = 462、90 + (420 - 462) / 2 = 69
    expect(variants.smile!.frame).toEqual({
      width: 462,
      height: 660,
      positions: { left: { left: 69, top: 30 }, center: { left: 429, top: 30 }, right: { left: 789, top: 30 } },
    });
    expect(variants.plain).toEqual({ image: "p.png" });
  });

  it("比較表示中の差分は除外する（今の差分は除外しない）", () => {
    const variants: Record<string, CastVariant> = { a: variant(frame(400, 600, 0, 0)), b: variant(frame(400, 600, 0, 0)), c: variant(frame(400, 600, 0, 0)) };
    variants.a!.frame!.width = 800;
    const r = syncToAllVariants(variants, { variant: "a", position: "left", base: () => frame(400, 600, 0, 0), exclude: new Set(["b", "a"]) })!;
    expect(r.targets).toEqual(["a", "c"]);
    expect(r.excluded).toEqual(["b"]);
    expect(variants.b!.frame!.width).toBe(400);
    expect(variants.c!.frame!.width).toBe(800);
    expect(syncToAllVariants({ p: { image: "p.png" } }, { variant: "p", position: "center", base: () => undefined })).toBeNull();
  });

  it("大きさや位置を合わせても、反転するときの軸（flipAxis。画像の px なので枠の大きさに依らない）は残す", () => {
    const variants: Record<string, CastVariant> = { a: variant({ ...frame(400, 600, 0, 0), flipAxis: 180 }), b: variant({ ...frame(400, 600, 0, 0), flipAxis: 210 }) };
    variants.a!.frame!.width = 440;
    syncToAllVariants(variants, { variant: "a", position: "left", base: () => frame(400, 600, 0, 0) });
    expect(variants.a!.frame!.flipAxis).toBe(180);
    expect(variants.b!.frame!.flipAxis).toBe(210);
  });

  it("center の保存: Y をほかの立ち位置へ写し、ほかは中心の X を保つ（足した立ち位置も）", () => {
    const f = frame(440, 660, 100, 50);
    f.positions.far = { left: 1000, top: 80 };
    f.positions.center = { left: 455, top: 20 };
    const base = frame(400, 600, 100, 50);
    base.positions.far = { left: 1000, top: 80 };
    syncToOtherPositions(f, base, "center");
    expect(f.positions).toEqual({ left: { left: 80, top: 20 }, center: { left: 455, top: 20 }, right: { left: 800, top: 20 }, far: { left: 980, top: 20 } });
  });
});

describe("差分を足すときの初めの枠", () => {
  /** w×h の画像で、(x, y, bw, bh) だけ不透明なもの。 */
  const image = (w: number, h: number, x: number, y: number, bw: number, bh: number) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let j = y; j < y + bh; j++) for (let i = x; i < x + bw; i++) px[(j * w + i) * 4 + 3] = 255;
    return { width: w, height: h, bbox: opaqueBounds(px, w, h) };
  };

  it("透明でない部分の外接矩形", () => {
    expect(image(10, 8, 2, 3, 4, 5).bbox).toEqual({ left: 2, top: 3, right: 6, bottom: 8, width: 4, height: 5, centerX: 4, centerY: 5.5 });
    expect(opaqueBounds(new Uint8ClampedArray(16), 2, 2)).toBeNull();
  });

  it("高さ比 0.75＋幅比 0.25 の倍率で、外接矩形の中心 X と下端を基準に合わせる", () => {
    // 基準: 200×400 の画像の (50, 100) から 100×300 が体。枠は 400×800（2 倍）で center は (440, -80)
    const reference = { frame: frame(400, 800, 80, -80), info: image(200, 400, 50, 100, 100, 300) };
    // 新しい画像: 300×300 の (100, 0) から 100×200 が体 → 高さ比 600/200 = 3、幅比 200/100 = 2 → 2.75
    const out = initialFrameFromReference(reference, image(300, 300, 100, 0, 100, 200));
    expect(out.width).toBe(825);
    expect(out.height).toBe(825);
    // 基準の体の中心 X = 440 + 100 × 2 = 640、下端 = -80 + 400 × 2 = 720
    expect(out.positions.center).toEqual({ left: Math.round(640 - 150 * 2.75), top: Math.round(720 - 200 * 2.75) });
    expect(out.positions.left).toEqual({ left: Math.round(280 - 150 * 2.75), top: Math.round(720 - 200 * 2.75) });
  });

  it("比べられないときは基準の枠のまま。基準が無いときは画面に収めて並べる", () => {
    const reference = { frame: frame(400, 800, 80, -80), info: image(200, 400, 0, 0, 0, 0) };
    expect(initialFrameFromReference(reference, image(10, 10, 0, 0, 5, 5))).toEqual(frame(400, 800, 80, -80));
    // 基準の反転の軸は写さない（新しい絵には合わない）
    expect(initialFrameFromReference({ ...reference, frame: { ...reference.frame, flipAxis: 120 } }, image(10, 10, 0, 0, 5, 5))).not.toHaveProperty("flipAxis");
    expect(initialFrameAlone({ width: 500, height: 1440 }, { width: 1280, height: 720 })).toEqual({
      width: 250,
      height: 720,
      positions: { left: { left: 195, top: 0 }, center: { left: 515, top: 0 }, right: { left: 835, top: 0 } },
    });
  });

  it("基準の差分は normal → default → 最初", () => {
    expect(referenceVariantKey({ variants: { smile: { image: "s" }, default: { image: "d" }, normal: { image: "n" } } })).toBe("normal");
    expect(referenceVariantKey({ variants: { smile: { image: "s" }, default: { image: "d" } } })).toBe("default");
    expect(referenceVariantKey({ variants: { smile: { image: "s" } } })).toBe("smile");
    expect(referenceVariantKey({ variants: {} })).toBeNull();
  });
});

describe("名前とキャストの編集", () => {
  it("キー・保存名", () => {
    expect(normalizeKey(" 笑顔 2 ")).toBe("笑顔_2");
    expect(normalizeKey("smile!!")).toBe("smile");
    expect(uniqueKey({ smile: 1, smile_2: 1 }, "smile")).toBe("smile_3");
    expect(sanitizeFileBase("my face?.PNG")).toBe("my_face");
    expect(imageFileName("my face", "x.WEBP")).toBe("my_face.webp");
  });

  it("キャスト・立ち絵セット・立ち位置を足し、立ち絵セットを消す（最後の一つは消せない）", () => {
    const cast: Cast = {};
    addCharacter(cast, "ユイカ");
    expect(() => addCharacter(cast, "ユイカ")).toThrow();
    const entry = cast["ユイカ"]!;
    expect(addAppearance(entry, "coat", "コート")).toBe("coat");
    expect(Object.keys(entry.appearances)).toEqual(["default", "coat"]);
    expect(castProblems(cast)).toEqual([]);
    entry.defaultAppearance = "coat";
    removeAppearance(entry, "coat");
    expect(entry.defaultAppearance).toBe("default");
    expect(() => removeAppearance(entry, "default")).toThrow("最後の立ち絵セットは削除できません");
    const f = frame(400, 600, 0, 10);
    expect(addPosition(f, "far left")).toBe("far_left");
    expect(f.positions.far_left).toEqual({ left: 360, top: 10 });
    expect(() => addPosition(f, "auto")).toThrow();
  });
});

describe("元に戻す", () => {
  it("push した順に戻し、やり直せる。同じ group の連続は一手", () => {
    const h = new History<number>(3);
    h.push(0);
    h.push(1, "wheel");
    h.push(2, "wheel");
    h.seal();
    h.push(3, "wheel");
    expect(h.undo(4)).toBe(3);
    expect(h.undo(3)).toBe(1);
    expect(h.redo(1)).toBe(3);
    expect(h.undo(3)).toBe(1);
    expect(h.undo(1)).toBe(0);
    expect(h.undo(0)).toBeNull();
  });

  it("limit を超えると古いものから捨てる", () => {
    const h = new History<number>(2);
    for (const n of [0, 1, 2]) h.push(n);
    expect(h.size).toBe(2);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBeNull();
  });
});
