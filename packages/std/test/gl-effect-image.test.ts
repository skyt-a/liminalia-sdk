import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { drawsAnimated } from "../src/web/gl-effect.ts";

/**
 * WebGL の画面効果は、写すものが前のコマと同じなら写し直さない。drawImage で写すたびに中身が変わる画像（動きのある SVG）は、
 * 写すものの印が同じでも毎コマ写すので、画像のファイルの中身で見分ける。GIF・APNG・動く WebP は drawImage が一コマ目を写すので、動かないとする。
 */

const text = (s: string) => new TextEncoder().encode(s);

describe("drawImage で動く画像を見分ける", () => {
  it("<animate>・<set>・CSS の動きのある SVG は動く", () => {
    expect(drawsAnimated(text('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"><animate attributeName="r" values="4;8" dur="1s"/></circle></svg>'))).toBe(true);
    expect(drawsAnimated(text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect><set attributeName="fill" to="red" begin="1s"/></rect></svg>'))).toBe(true);
    expect(drawsAnimated(text('<svg xmlns="http://www.w3.org/2000/svg"><style>circle{animation: spin 1s}</style><circle r="4"/></svg>'))).toBe(true);
    expect(drawsAnimated(text('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'))).toBe(false);
  });

  it("SVG でない画像は動かない（動く GIF も drawImage は一コマ目を写す）", () => {
    expect(drawsAnimated(readFileSync(join(import.meta.dirname, "../../web/test/e2e/fixtures/stripes.png")))).toBe(false);
    expect(drawsAnimated(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x21, 0xf9, 0x04, 0x21, 0xf9, 0x04]))).toBe(false);
    expect(drawsAnimated(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]))).toBe(false);
  });
});
