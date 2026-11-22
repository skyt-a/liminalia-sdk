import { deflateSync, inflateSync } from "node:zlib";

/**
 * ブラウザ版をホーム画面に置くときの絵（Web アプリの定義 manifest.webmanifest のアイコンと apple-touch-icon）を、
 * 書き出しの設定の icon（PNG）から作る（vite.config.ts の webManifest）。画像の道具を使わずに PNG を開いて縮める。
 * - icon-192.png、icon-512.png: そのまま縮めたもの（purpose: any）
 * - icon-maskable-512.png: 丸や角丸に切り抜かれても欠けないよう、絵を 8 割の大きさで真ん中に置き、まわりを地の色で埋めたもの（purpose: maskable）
 * - apple-touch-icon.png: 180px。iPhone は透明を黒で埋めるので、地の色に重ねたもの
 * 地の色は、絵の左上が不透明ならその色、透明なら黒。
 */

/** 8 ビットの RGBA の画素。 */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG を開く。開けない形（飛び越し走査など）なら null。 */
export function decodePng(bytes: Uint8Array): Pixels | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]!;
      color = data[9]!;
      interlace = data[12]!;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  if (!channels || interlace !== 0 || width === 0 || height === 0 || ![1, 2, 4, 8, 16].includes(depth)) return null;
  if (color === 3 && !palette) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel / 8);
  if (raw.length < (stride + 1) * height) return null;
  // 行ごとの前処理（filter）を戻す
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const left = x >= bpp ? rows[out + x - bpp]! : 0;
      const up = y > 0 ? rows[out - stride + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? rows[out - stride + x - bpp]! : 0;
      let r: number;
      if (filter === 0) r = v;
      else if (filter === 1) r = v + left;
      else if (filter === 2) r = v + up;
      else if (filter === 3) r = v + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        r = v + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else return null;
      rows[out + x] = r & 0xff;
    }
  }
  // 一つの標本（0 から 255 に）
  const max = (1 << depth) - 1;
  const sample = (y: number, i: number): number => {
    if (depth === 8) return rows[y * stride + i]!;
    if (depth === 16) return rows[y * stride + i * 2]!;
    const bit = i * depth;
    const v = (rows[y * stride + (bit >> 3)]! >> (8 - depth - (bit & 7))) & max;
    return color === 3 ? v : Math.round((v * 255) / max);
  };
  const raw16 = (y: number, i: number): number => (depth === 16 ? rows.readUInt16BE(y * stride + i * 2) : depth === 8 ? rows[y * stride + i]! : (rows[y * stride + ((i * depth) >> 3)]! >> (8 - depth - ((i * depth) & 7))) & max);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (color === 3) {
        const index = sample(y, x);
        data[o] = palette![index * 3] ?? 0;
        data[o + 1] = palette![index * 3 + 1] ?? 0;
        data[o + 2] = palette![index * 3 + 2] ?? 0;
        data[o + 3] = trns && index < trns.length ? trns[index]! : 255;
      } else if (color === 0 || color === 4) {
        const g = sample(y, x * channels);
        data[o] = data[o + 1] = data[o + 2] = g;
        data[o + 3] = color === 4 ? sample(y, x * channels + 1) : trns && trns.length >= 2 && raw16(y, x) === trns.readUInt16BE(0) ? 0 : 255;
      } else {
        data[o] = sample(y, x * channels);
        data[o + 1] = sample(y, x * channels + 1);
        data[o + 2] = sample(y, x * channels + 2);
        const keyed = color === 2 && trns && trns.length >= 6 && raw16(y, x * 3) === trns.readUInt16BE(0) && raw16(y, x * 3 + 1) === trns.readUInt16BE(2) && raw16(y, x * 3 + 2) === trns.readUInt16BE(4);
        data[o + 3] = color === 6 ? sample(y, x * channels + 3) : keyed ? 0 : 255;
      }
    }
  }
  return { width, height, data };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** RGBA の PNG にする。 */
export function encodePng(img: Pixels): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    // 上の行との差（Up）で詰める
    raw[y * (stride + 1)] = 2;
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = (img.data[y * stride + x]! - (y > 0 ? img.data[(y - 1) * stride + x]! : 0)) & 0xff;
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** 一つの向きの、縮めた先の一画素ごとの元の画素と重み（覆う広さで平均する）。 */
function weights(from: number, to: number): { index: number; weight: number }[][] {
  const scale = from / to;
  return Array.from({ length: to }, (_, i) => {
    const start = i * scale;
    const end = (i + 1) * scale;
    const out: { index: number; weight: number }[] = [];
    for (let s = Math.floor(start); s < Math.min(from, Math.ceil(end)); s++) {
      const w = Math.min(end, s + 1) - Math.max(start, s);
      if (w > 0) out.push({ index: s, weight: w / scale });
    }
    return out;
  });
}

/** 大きさを変える（面積で平均する。透明の縁が黒ずまないよう、アルファを掛けた色で計算する）。 */
export function resizePixels(img: Pixels, width: number, height: number): Pixels {
  const premultiplied = new Float64Array(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) {
    const a = img.data[i * 4 + 3]! / 255;
    premultiplied[i * 4] = img.data[i * 4]! * a;
    premultiplied[i * 4 + 1] = img.data[i * 4 + 1]! * a;
    premultiplied[i * 4 + 2] = img.data[i * 4 + 2]! * a;
    premultiplied[i * 4 + 3] = img.data[i * 4 + 3]!;
  }
  const wx = weights(img.width, width);
  const wy = weights(img.height, height);
  // 横、縦の順に
  const across = new Float64Array(width * img.height * 4);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < width; x++) {
      for (const { index, weight } of wx[x]!) for (let c = 0; c < 4; c++) across[(y * width + x) * 4 + c]! += premultiplied[(y * img.width + index) * 4 + c]! * weight;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0, 0];
      for (const { index, weight } of wy[y]!) for (let c = 0; c < 4; c++) sum[c]! += across[(index * width + x) * 4 + c]! * weight;
      const a = sum[3]!;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = a > 0 ? Math.min(255, Math.round((sum[c]! / a) * 255)) : 0;
      data[o + 3] = Math.min(255, Math.round(a));
    }
  }
  return { width, height, data };
}

/** size の正方形を地の色で埋め、絵を縦横の比を保って長い辺が ratio の大きさになるよう真ん中に重ねる（透明は地の色になる）。 */
function onBackground(img: Pixels, size: number, ratio: number, bg: [number, number, number]): Pixels {
  const scale = (size * ratio) / Math.max(img.width, img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const scaled = resizePixels(img, w, h);
  const data = new Uint8Array(size * size * 4);
  const left = Math.floor((size - w) / 2);
  const top = Math.floor((size - h) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const sx = x - left;
      const sy = y - top;
      const inside = sx >= 0 && sy >= 0 && sx < w && sy < h;
      const a = inside ? scaled.data[(sy * w + sx) * 4 + 3]! / 255 : 0;
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(bg[c]! * (1 - a) + (inside ? scaled.data[(sy * w + sx) * 4 + c]! * a : 0));
      data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

export interface PwaIcon {
  file: string;
  size: number;
  purpose?: "maskable";
  data: Buffer;
}

/** 書き出しの icon（PNG）から、ホーム画面に置くときの絵を作る。開けない PNG なら null（元の絵をそのまま使う）。 */
export function pwaIcons(png: Uint8Array): PwaIcon[] | null {
  const img = decodePng(png);
  if (!img) return null;
  const square = img.width === img.height ? img : null;
  const bg: [number, number, number] = img.data[3] === 255 ? [img.data[0]!, img.data[1]!, img.data[2]!] : [0, 0, 0];
  // 正方形でない絵は、地の色の正方形の真ん中に収める
  const base = square ?? onBackground(img, Math.max(img.width, img.height), 1, bg);
  return [
    { file: "icon-192.png", size: 192, data: encodePng(resizePixels(base, 192, 192)) },
    { file: "icon-512.png", size: 512, data: encodePng(resizePixels(base, 512, 512)) },
    { file: "icon-maskable-512.png", size: 512, purpose: "maskable", data: encodePng(onBackground(base, 512, 0.8, bg)) },
    { file: "apple-touch-icon.png", size: 180, data: encodePng(onBackground(base, 180, 1, bg)) },
  ];
}
