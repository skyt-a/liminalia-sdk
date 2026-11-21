import { describe, expect, it } from "vitest";
import { writePsdUint8Array, type Layer } from "ag-psd";
import { applyLayers, castProblems, type Cast } from "@liminalia/lang";
import { importPsd } from "../src/psd.ts";

/** 幅 w・高さ h の一色の絵（a は不透明度 0〜255）。 */
function fill(w: number, h: number, rgb: [number, number, number], a = 255) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, a], i * 4);
  return { width: w, height: h, data };
}

const layer = (name: string, o: Partial<Layer> & { color: [number, number, number]; w?: number; h?: number }): Layer => {
  const { color, w = 4, h = 4, ...rest } = o;
  return { name, left: 0, top: 0, imageData: fill(w, h, color), ...rest };
};

/** PNG の (x, y) の RGBA（読むのに Node の zlib を使う）。 */
async function pixel(png: Uint8Array, x: number, y: number): Promise<number[]> {
  const { inflateSync } = await import("node:zlib");
  const view = new DataView(png.buffer, png.byteOffset);
  const width = view.getUint32(16);
  let at = 8;
  const idat: Uint8Array[] = [];
  while (at < png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const o = y * (width * 4 + 1) + 1 + x * 4;
  return [...raw.subarray(o, o + 4)];
}

describe("PSD の取り込み", () => {
  it("一番上のグループを層に、中のレイヤーを絵にし、表示しているものを既定にする", async () => {
    const psd = writePsdUint8Array({
      width: 8,
      height: 8,
      children: [
        layer("体", { color: [255, 0, 0], w: 8, h: 8 }),
        {
          name: "目",
          children: [layer("開き", { color: [0, 0, 255], left: 2, top: 2 }), layer("閉じ", { color: [0, 255, 0], hidden: true })],
        },
        layer("頬", { color: [255, 255, 255], hidden: true, opacity: 0.5 }),
      ],
    });
    const r = await importPsd(psd, "ユイ");
    expect(r.width).toBe(8);
    expect(r.layers).toEqual([
      { name: "体", options: { 体: "ユイ/体.png" }, default: "体" },
      { name: "目", options: { 開き: "ユイ/目/開き.png", 閉じ: "ユイ/目/閉じ.png" }, default: "開き" },
      { name: "頬", options: { 頬: "ユイ/頬.png" } },
    ]);
    const eyes = r.images.find((i) => i.path === "ユイ/目/開き.png")!.png;
    // レイヤーの位置（2, 2）に置いた、ドキュメントの大きさの絵
    expect(await pixel(eyes, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(await pixel(eyes, 3, 3)).toEqual([0, 0, 255, 255]);
    // 不透明度は絵に焼き込む
    expect((await pixel(r.images.find((i) => i.path === "ユイ/頬.png")!.png, 1, 1))[3]).toBeGreaterThan(120);

    const cast: Cast = {};
    applyLayers(cast, "ユイ", "default", r.layers);
    expect(cast.ユイ!.appearances.default!.variants).toEqual({ normal: { image: "", parts: {} } });
    expect(castProblems(cast)).toEqual([]);
  });

  it("通常以外の描画モードとクリッピングは知らせ、同じ名前は付け分け、使えない文字は _ にする", async () => {
    const psd = writePsdUint8Array({
      width: 4,
      height: 4,
      children: [layer("a/b", { color: [1, 2, 3], blendMode: "multiply" }), layer("a/b", { color: [1, 2, 3], clipping: true })],
    });
    const r = await importPsd(psd, "x");
    expect(r.layers.map((l) => l.name)).toEqual(["a_b", "a_b_2"]);
    expect(r.warnings).toEqual([expect.stringContaining("multiply"), expect.stringContaining("クリッピング")]);
  });

  it("取り込み直すと、差分の parts は残る層と絵のものだけ残す", () => {
    const cast: Cast = { ユイ: { appearances: { default: { variants: { smile: { image: "", parts: { 目: "閉じ", 口: "笑い" } }, still: { image: "a.png" } } } } } };
    applyLayers(cast, "ユイ", "default", [{ name: "目", options: { 閉じ: "p.png" } }]);
    expect(cast.ユイ!.appearances.default!.variants).toEqual({ smile: { image: "", parts: { 目: "閉じ" } }, still: { image: "a.png" } });
  });
});
