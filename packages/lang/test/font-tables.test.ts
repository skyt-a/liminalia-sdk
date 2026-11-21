import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkVerticalFont, fontTables } from "../src/font-tables.ts";

/** 表の並びだけを持つ sfnt（.ttf・.otf）。 */
function sfnt(tags: string[], signature = 0x00010000): Uint8Array {
  const data = new Uint8Array(12 + tags.length * 16);
  const v = new DataView(data.buffer);
  v.setUint32(0, signature);
  v.setUint16(4, tags.length);
  tags.forEach((t, i) => data.set([...t].map((c) => c.charCodeAt(0)), 12 + i * 16));
  return data;
}

/** 表の並びだけを持つ WOFF2（既知の表は番号、ほかは名前。glyf・loca は変形あり）。 */
function woff2(entries: (number | string)[]): Uint8Array {
  const bytes: number[] = [];
  for (const e of entries) {
    if (typeof e === "number") bytes.push(e, 100);
    else bytes.push(0x3f, ...[...e].map((c) => c.charCodeAt(0)), 100);
    // glyf（10）・loca（11）は版 0 で変形あり → 長さがもう一つ
    if (e === 10 || e === 11) bytes.push(0x81, 0x00);
  }
  const data = new Uint8Array(48 + bytes.length);
  data.set([..."wOF2"].map((c) => c.charCodeAt(0)));
  new DataView(data.buffer).setUint16(12, entries.length);
  data.set(bytes, 48);
  return data;
}

describe("書体の表の名前", () => {
  it("TTF・OTF・WOFF2 の表を読み、縦書きの字送り幅（vmtx）の有無が分かる", () => {
    expect(fontTables(sfnt(["cmap", "head", "hmtx"]))?.has("vmtx")).toBe(false);
    expect(fontTables(sfnt(["cmap", "vhea", "vmtx"], 0x4f54544f))?.has("vmtx")).toBe(true);
    expect([...(fontTables(woff2([0, 10, 11, 24, "BASE"])) ?? [])]).toEqual(["#0", "glyf", "loca", "vmtx", "BASE"]);
    expect(fontTables(woff2([0, 1, 3]))?.has("vmtx")).toBe(false);
  });

  it("テストの書体（fixtures/test-font.ttf）は vmtx を持つ。読めない形は null", () => {
    const font = readFileSync(resolve(import.meta.dirname, "../../web/test/e2e/fixtures/test-font.ttf"));
    expect(fontTables(font)?.has("vmtx")).toBe(true);
    expect(fontTables(new TextEncoder().encode("ttcf...."))).toBeNull();
    expect(fontTables(sfnt(["cmap"]).slice(0, 6))).toBeNull();
  });
});

describe("縦書きの書体の警告", () => {
  const noVmtx = sfnt(["cmap", "hmtx"]);
  it("縦書きを使い、書体のファイルが vmtx を持たないときだけ", () => {
    const read = () => noVmtx;
    expect(checkVerticalFont({ text: { fontFile: "a.ttf" } }, ["@vertical on\n本文。"], read).map((d) => d.code)).toEqual(["font-no-vertical-metrics"]);
    expect(checkVerticalFont({ text: { fontFile: "a.ttf" }, message: { vertical: true } }, [], read)).toHaveLength(1);
    expect(checkVerticalFont({ text: { fontFile: "a.ttf" } }, ["@vertical off\n本文。"], read)).toEqual([]);
    expect(checkVerticalFont({ message: { vertical: true } }, [], read)).toEqual([]);
    expect(checkVerticalFont({ text: { fontFile: "a.ttf" }, message: { vertical: true } }, [], () => sfnt(["cmap", "vmtx"]))).toEqual([]);
    expect(checkVerticalFont({ text: { fontFile: "a.ttf" }, message: { vertical: true } }, [], () => null)).toEqual([]);
  });
});
