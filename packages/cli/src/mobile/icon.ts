import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

/**
 * スマホ版のアイコンの画像（外部のライブラリを使わず、PNG を開いて縮め、置き直す）。
 * - iOS（App Store）: 1024×1024、透明を持たない。正方形でなければ引き伸ばさずに収め、余白と透明な所は地の色で埋める
 * - Android の適応アイコン（API 26 から）: 前景（108dp の四角の中央に、アイコンを見える範囲に収めたもの）と地の色。古い端末向けのアイコンも作る
 */

/** 8 ビットの RGBA の画像。 */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG を開く（飛び越し走査は開かない。読めなければ null）。 */
export function decodePng(bytes: Uint8Array): Rgba | null {
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
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color as 0 | 2 | 3 | 4 | 6];
  if (!channels || interlace !== 0 || width === 0 || height === 0 || ![1, 2, 4, 8, 16].includes(depth) || (color === 3 && !palette)) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    // 読めない PNG は null（呼ぶ側がアイコンの誤りとして出す）
    return null;
  }
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < (stride + 1) * height) return null;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let line = new Uint8Array(stride);
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
    // 一つの標本（depth ビット）を 0〜255 にする
    const sample = (index: number): number => {
      if (depth === 8) return line[index]!;
      if (depth === 16) return line[index * 2]!;
      const bit = index * depth;
      const v = (line[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      return color === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
    };
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (color === 3) {
        const i = sample(x);
        out[o] = palette![i * 3] ?? 0;
        out[o + 1] = palette![i * 3 + 1] ?? 0;
        out[o + 2] = palette![i * 3 + 2] ?? 0;
        out[o + 3] = trns?.[i] ?? 255;
      } else if (color === 0 || color === 4) {
        const g = sample(x * channels);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = color === 4 ? sample(x * channels + 1) : 255;
      } else {
        out[o] = sample(x * channels);
        out[o + 1] = sample(x * channels + 1);
        out[o + 2] = sample(x * channels + 2);
        out[o + 3] = color === 6 ? sample(x * channels + 3) : 255;
      }
    }
    [prev, line] = [line, prev];
  }
  return { width, height, data: out };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG にする（alpha が false なら透明を持たない RGB の形。iOS の App Store のアイコン）。 */
export function encodePng(img: Rgba, alpha = true): Buffer {
  const channels = alpha ? 4 : 3;
  const stride = img.width * channels;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4;
      const d = y * (stride + 1) + 1 + x * channels;
      raw[d] = img.data[s]!;
      raw[d + 1] = img.data[s + 1]!;
      raw[d + 2] = img.data[s + 2]!;
      if (alpha) raw[d + 3] = img.data[s + 3]!;
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** 一つの向きの、出す側の各画素が読む元の画素と重み（縮めるときは面積、広げるときは隣り合う二つの間）。 */
function taps(from: number, to: number): { index: number; weight: number }[][] {
  const scale = from / to;
  const out: { index: number; weight: number }[][] = [];
  for (let i = 0; i < to; i++) {
    const list: { index: number; weight: number }[] = [];
    if (scale > 1) {
      const start = i * scale;
      const end = start + scale;
      for (let j = Math.floor(start); j < Math.min(from, Math.ceil(end)); j++) {
        const w = Math.min(end, j + 1) - Math.max(start, j);
        if (w > 0) list.push({ index: j, weight: w / scale });
      }
    } else {
      const center = (i + 0.5) * scale - 0.5;
      const j = Math.floor(center);
      const t = center - j;
      list.push({ index: Math.min(from - 1, Math.max(0, j)), weight: 1 - t }, { index: Math.min(from - 1, Math.max(0, j + 1)), weight: t });
    }
    out.push(list);
  }
  return out;
}

/** 大きさを変える（透明な所の色がにじまないよう、alpha を掛けた色で混ぜる）。 */
export function resize(img: Rgba, width: number, height: number): Rgba {
  if (img.width === width && img.height === height) return img;
  const xs = taps(img.width, width);
  const ys = taps(img.height, height);
  // 横に縮めた途中（alpha を掛けた値）
  const mid = new Float64Array(width * img.height * 4);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const { index, weight } of xs[x]!) {
        const s = (y * img.width + index) * 4;
        const al = img.data[s + 3]! * weight;
        r += img.data[s]! * al;
        g += img.data[s + 1]! * al;
        b += img.data[s + 2]! * al;
        a += al;
      }
      const o = (y * width + x) * 4;
      mid[o] = r;
      mid[o + 1] = g;
      mid[o + 2] = b;
      mid[o + 3] = a;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const { index, weight } of ys[y]!) {
        const s = (index * width + x) * 4;
        r += mid[s]! * weight;
        g += mid[s + 1]! * weight;
        b += mid[s + 2]! * weight;
        a += mid[s + 3]! * weight;
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        data[o] = Math.round(Math.min(255, r / a));
        data[o + 1] = Math.round(Math.min(255, g / a));
        data[o + 2] = Math.round(Math.min(255, b / a));
      }
      data[o + 3] = Math.round(Math.min(255, a));
    }
  }
  return { width, height, data };
}

/** "#rgb"・"#rrggbb" を [r, g, b] に（読めなければ null）。 */
export function parseColor(text: string | undefined): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text?.trim() ?? "");
  if (!m) return null;
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** [r, g, b] を "#rrggbb" に。 */
export function colorHex([r, g, b]: readonly [number, number, number]): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** 透明な所があるか（ほぼ不透明なら false）。 */
export function hasTransparency(img: Rgba): boolean {
  let clear = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! < 250) clear++;
  return clear > (img.width * img.height) / 200;
}

/** 縁の色（外周の画素の平均。縁が透明なら null）。正方形に収めたときの余白と、適応アイコンの地の色に使う。 */
export function edgeColor(img: Rgba): [number, number, number] | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let n = 0;
  const add = (x: number, y: number) => {
    const s = (y * img.width + x) * 4;
    const al = img.data[s + 3]!;
    r += img.data[s]! * al;
    g += img.data[s + 1]! * al;
    b += img.data[s + 2]! * al;
    a += al;
    n++;
  };
  for (let x = 0; x < img.width; x++) {
    add(x, 0);
    add(x, img.height - 1);
  }
  for (let y = 1; y < img.height - 1; y++) {
    add(0, y);
    add(img.width - 1, y);
  }
  if (n === 0 || a / n < 230) return null;
  return [Math.round(r / a), Math.round(g / a), Math.round(b / a)];
}

/**
 * size×size の四角の中央に、アイコンを引き伸ばさずに収める（長い辺を size × fraction に）。background があれば地をその色で塗り、
 * 透明な所も埋める（無ければ透明のまま）。
 */
export function fitSquare(img: Rgba, size: number, fraction: number, background: readonly [number, number, number] | null): Rgba {
  const box = Math.max(1, Math.round(size * fraction));
  const scale = box / Math.max(img.width, img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const small = resize(img, w, h);
  const data = new Uint8Array(size * size * 4);
  if (background) for (let i = 0; i < data.length; i += 4) data.set([background[0], background[1], background[2], 255], i);
  const left = Math.floor((size - w) / 2);
  const top = Math.floor((size - h) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const o = ((top + y) * size + left + x) * 4;
      const al = small.data[s + 3]! / 255;
      const under = data[o + 3]! / 255;
      const outA = al + under * (1 - al);
      for (let c = 0; c < 3; c++) data[o + c] = outA > 0 ? Math.round((small.data[s + c]! * al + data[o + c]! * under * (1 - al)) / outA) : 0;
      data[o + 3] = Math.round(outA * 255);
    }
  }
  return { width: size, height: size, data };
}

/** 白（透明なアイコンで、地の色を書いていないとき）。 */
const WHITE: [number, number, number] = [255, 255, 255];

/**
 * アイコンの PNG を開く。開けない形（飛び越し走査など）は、Mac なら sips で開ける PNG に書き直してから開く。読めなければ null。
 */
export function readIcon(path: string): Rgba | null {
  const img = decodePng(readFileSync(path));
  if (img || process.platform !== "darwin") return img;
  const dir = mkdtempSync(join(tmpdir(), "liminalia-icon-"));
  try {
    const out = join(dir, "icon.png");
    execFileSync("sips", ["-s", "format", "png", "-s", "formatOptions", "default", path, "--out", out], { stdio: "ignore" });
    return decodePng(readFileSync(out));
  } catch {
    // sips で読めない画像は null（呼ぶ側がアイコンの誤りとして出す）
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * iOS（App Store）のアイコン: 1024×1024 で透明を持たない PNG。正方形でなければ引き伸ばさずに収め、余白と透明な所は
 * background（build.iconBackground）→ アイコンの縁の色 → 白で埋める。
 */
export function iosIconPng(img: Rgba, background?: string): Buffer {
  const fill = parseColor(background) ?? edgeColor(img) ?? WHITE;
  return encodePng(fitSquare(img, 1024, 1, fill), false);
}

/**
 * Android の適応アイコン（API 26 から）。前景は 108dp（xxxhdpi で 432px）の四角の中央に、アイコンを見える範囲（72dp）に収めたもの。
 * 透明なアイコン（ロゴの形など）は、どの形に切り抜かれても欠けないよう安全な範囲（66dp）に収める。地の色は background → 縁の色 → 白。
 * legacy は API 25 までの端末のアイコン（192px。xxxhdpi）。
 */
export function androidIcons(img: Rgba, background?: string): { foreground: Buffer; background: string; legacy: Buffer } {
  const transparent = hasTransparency(img);
  const fill = parseColor(background) ?? edgeColor(img) ?? WHITE;
  return {
    foreground: encodePng(fitSquare(img, 432, transparent ? 66 / 108 : 72 / 108, null)),
    background: colorHex(fill),
    legacy: encodePng(fitSquare(img, 192, 1, null)),
  };
}
