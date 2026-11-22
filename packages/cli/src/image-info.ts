import { inflateSync } from "node:zlib";
import { imageSize, type Bounds, type ImageInfo } from "@liminalia/lang";

/**
 * 画像の大きさと、透明でない部分の外接矩形（@liminalia/lang の ImageInfo）。制作画面は Canvas で読む（asset-import.ts の imageInfo）が、
 * AI の MCP はブラウザを持たないので、PNG はここで画素を開いて透明な部分を見る。
 * 透明を持たない形（JPEG・透明のない PNG）と、ここで開かない形（飛び越し走査の PNG・8 ビットでない色番号の PNG・WebP・GIF）は、画像全体を外接矩形とする。
 * 読めなければ null。
 */
export function imageInfoOf(bytes: Uint8Array): ImageInfo | null {
  const size = imageSize(bytes);
  if (!size) return null;
  const whole = box(0, 0, size.width, size.height);
  if (!isPng(bytes)) return { ...size, bbox: whole };
  try {
    return { ...size, bbox: pngBounds(bytes) };
  } catch {
    // 読めない PNG は画像の全体を中身とみなす
    return { ...size, bbox: whole };
  }
}

/** 左上と幅・高さから外接矩形を作る（@liminalia/lang の opaqueBounds と同じ形）。 */
function box(left: number, top: number, width: number, height: number): Bounds {
  return { left, top, right: left + width, bottom: top + height, width, height, centerX: left + width / 2, centerY: top + height / 2 };
}

const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** 透明でない部分の外接矩形（全部透明なら null）。透明を持たない PNG は画像全体。 */
function pngBounds(bytes: Uint8Array): Bounds | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = data[8]!;
      color = data[9]!;
      interlace = data[12]!;
    } else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const whole = box(0, 0, width, height);
  // 透明を持つのは、アルファのある形（4・6）と、色番号の表に透明のある形（3）
  const channels = color === 6 ? 4 : color === 4 ? 2 : color === 3 ? 1 : 0;
  if (channels === 0 || interlace !== 0 || (color === 3 && (!trns || depth !== 8)) || (depth !== 8 && depth !== 16)) return whole;
  const bpp = (channels * depth) / 8;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base]!;
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i]!;
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v = x;
      if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      line[i] = v & 0xff;
    }
    for (let px = 0; px < width; px++) {
      const alpha = color === 3 ? (trns![line[px]!] ?? 255) : line[px * bpp + (channels - 1) * (depth / 8)]!;
      if (alpha === 0) continue;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (y < minY) minY = y;
      maxY = y;
    }
    prev.set(line);
  }
  return maxX < 0 ? null : box(minX, minY, maxX - minX + 1, maxY - minY + 1);
}
