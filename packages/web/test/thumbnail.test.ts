import { describe, expect, it } from "vitest";
import { applyColorMatrix } from "../src/system/thumbnail.ts";

describe("縮小画像の色の行列", () => {
  it("feColorMatrix（type=matrix）と同じに、乗算済みでない RGBA に掛ける", () => {
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 128, 255, 128]);
    // 白黒（輝度）
    const mono = [0.2126, 0.7152, 0.0722, 0, 0, 0.2126, 0.7152, 0.0722, 0, 0, 0.2126, 0.7152, 0.0722, 0, 0, 0, 0, 0, 1, 0];
    applyColorMatrix(px, mono);
    expect([...px.subarray(0, 4)]).toEqual([54, 54, 54, 255]);
    expect(px[4]).toBe(px[5]);
    expect(px[7]).toBe(128);
  });
});
