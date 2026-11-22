import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePng, encodePng, pwaIcons, resizePixels } from "../pwa-icons.ts";

const TEMPLATE_ICON = resolve(import.meta.dirname, "../../../templates/default/icon.png");

/** 行の前処理なし（filter 0）の PNG を作る（色の形と深さを選ぶ）。 */
function rawPng(width: number, height: number, color: number, depth: number, rows: number[][], extra: [string, Buffer][] = []): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = color;
  const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra.map(([t, d]) => chunk(t, d)), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("ホーム画面に置くときの絵（PNG を開いて縮める）", () => {
  it("色番号（4 ビットと透明）、灰色、16 ビットの RGB を RGBA にする", () => {
    // 色番号 4 ビット: 2 画素で 1 バイト。0 番は赤、1 番は透明な緑
    const palette = rawPng(2, 1, 3, 4, [[0x01]], [["PLTE", Buffer.from([255, 0, 0, 0, 255, 0])], ["tRNS", Buffer.from([255, 0])]]);
    expect([...decodePng(palette)!.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 0]);
    const gray = rawPng(1, 1, 0, 8, [[128]]);
    expect([...decodePng(gray)!.data]).toEqual([128, 128, 128, 255]);
    const rgb16 = rawPng(1, 1, 2, 16, [[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]]);
    expect([...decodePng(rgb16)!.data]).toEqual([0x12, 0x56, 0x9a, 255]);
    // 開けない形（飛び越し走査）は null
    const interlaced = rawPng(1, 1, 0, 8, [[1]]);
    interlaced[8 + 8 + 12] = 1;
    expect(decodePng(interlaced)).toBeNull();
  });

  it("前処理のある PNG（ひな形のアイコン）を開き、書いた PNG を読み戻せる", () => {
    const img = decodePng(readFileSync(TEMPLATE_ICON))!;
    expect([img.width, img.height]).toEqual([1024, 1024]);
    // 月の真ん中の色（make-icon の (232, 217, 176)）
    const at = (x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
    expect(at(676, 338)).toEqual([232, 217, 176, 255]);
    const small = resizePixels(img, 64, 64);
    const back = decodePng(encodePng(small))!;
    expect([...back.data]).toEqual([...small.data]);
  });

  it("192、512、maskable の 512、apple-touch-icon の 180 を作る。maskable は絵を 8 割にして地の色で囲む", () => {
    const icons = pwaIcons(readFileSync(TEMPLATE_ICON))!;
    expect(icons.map((i) => `${i.file} ${i.size} ${i.purpose ?? "any"}`)).toEqual(["icon-192.png 192 any", "icon-512.png 512 any", "icon-maskable-512.png 512 maskable", "apple-touch-icon.png 180 any"]);
    for (const i of icons) {
      const img = decodePng(i.data)!;
      expect([img.width, img.height], i.file).toEqual([i.size, i.size]);
    }
    const maskable = decodePng(icons[2]!.data)!;
    const corner = [...maskable.data.subarray(0, 4)];
    const source = decodePng(readFileSync(TEMPLATE_ICON))!;
    expect(corner).toEqual([...source.data.subarray(0, 3), 255]);
    // 正方形でない絵も、縦横の比を保って正方形に収める
    const wide = encodePng({ width: 4, height: 2, data: new Uint8Array(4 * 2 * 4).fill(255) });
    const fromWide = decodePng(pwaIcons(wide)![0]!.data)!;
    expect([fromWide.width, fromWide.height]).toEqual([192, 192]);
  });
});
