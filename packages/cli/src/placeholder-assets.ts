import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

/**
 * テスト版の書き出し（lim build --feedback）で、まだ無い素材の代わりに入れる札（画像）と無音（音）。
 * 絵や音がそろう前の台本をテスト版にして読んでもらうためのもの。製品の書き出しでは使わない（無い素材は止める）。
 *
 * 画像は PNG、音は WAV で作り、素材の名前（.webp、.ogg など）のまま置く。ブラウザと Electron は画像と音の中身の形を先頭のバイトで見分けるので、
 * 拡張子と違っても読める。札には「MISSING」と素材の名前（英数字と記号だけ。ほかの字は ? にする）を描く。
 * 開発サーバーの札（@liminalia/studio の missing-placeholder.ts。SVG）と大きさを合わせる: 背景は画面の大きさ、立ち絵は画面の高さの 9 割の人の形、画像は 16:9。
 */

/** 札にする画像の種類と、無音にする音の種類。 */
export const PLACEHOLDER_IMAGE_FOLDERS: ReadonlySet<string> = new Set(["bgimage", "fgimage", "image"]);
export const PLACEHOLDER_AUDIO_FOLDERS: ReadonlySet<string> = new Set(["bgm", "sound", "voice"]);

type Rgba = readonly [number, number, number, number];

/** 5×7 の字（行ごとに 5 ビット。上の行から）。 */
const GLYPHS: Record<string, readonly number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 17, 25, 21, 19, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [31, 2, 4, 2, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12],
  "-": [0, 0, 0, 31, 0, 0, 0],
  _: [0, 0, 0, 0, 0, 0, 31],
  ".": [0, 0, 0, 0, 0, 12, 12],
  "/": [1, 1, 2, 4, 8, 16, 16],
  "?": [14, 17, 1, 2, 4, 0, 4],
  " ": [0, 0, 0, 0, 0, 0, 0],
};

/** 描ける字にする（英字は大文字に、描けない字は ?）。 */
const drawable = (text: string) => [...text.toUpperCase()].map((c) => (GLYPHS[c] ? c : "?")).join("");

class Canvas {
  readonly data: Buffer;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = Buffer.alloc(width * height * 4);
  }
  fill(x0: number, y0: number, w: number, h: number, c: Rgba): void {
    const x1 = Math.min(this.width, Math.max(0, Math.round(x0 + w)));
    const y1 = Math.min(this.height, Math.max(0, Math.round(y0 + h)));
    for (let y = Math.max(0, Math.round(y0)); y < y1; y++) {
      for (let x = Math.max(0, Math.round(x0)); x < x1; x++) {
        const i = (y * this.width + x) * 4;
        this.data[i] = c[0];
        this.data[i + 1] = c[1];
        this.data[i + 2] = c[2];
        this.data[i + 3] = c[3];
      }
    }
  }
  /** 点線の枠。 */
  dashedFrame(inset: number, dash: number, thick: number, c: Rgba): void {
    const w = this.width - inset * 2;
    const h = this.height - inset * 2;
    for (let d = 0; d < w; d += dash * 1.5) {
      this.fill(inset + d, inset, Math.min(dash, w - d), thick, c);
      this.fill(inset + d, this.height - inset - thick, Math.min(dash, w - d), thick, c);
    }
    for (let d = 0; d < h; d += dash * 1.5) {
      this.fill(inset, inset + d, thick, Math.min(dash, h - d), c);
      this.fill(this.width - inset - thick, inset + d, thick, Math.min(dash, h - d), c);
    }
  }
  /** 楕円を塗る。 */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: Rgba): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      const t = 1 - ((y - cy) / ry) ** 2;
      if (t < 0) continue;
      const half = rx * Math.sqrt(t);
      this.fill(cx - half, y, half * 2, 1, c);
    }
  }
  /** 字を真ん中に描く（収まらなければ字を小さくし、それでも長ければ後ろを切る）。 */
  text(line: string, cy: number, scale: number, c: Rgba): void {
    let s = Math.max(1, Math.floor(scale));
    let chars = drawable(line);
    while (s > 1 && chars.length * 6 * s > this.width * 0.9) s--;
    const fit = Math.max(1, Math.floor((this.width * 0.9) / (6 * s)));
    if (chars.length > fit) chars = `${chars.slice(0, Math.max(1, fit - 1))}?`;
    const total = chars.length * 6 * s - s;
    let x = Math.round((this.width - total) / 2);
    const y = Math.round(cy - (7 * s) / 2);
    for (const ch of chars) {
      const rows = GLYPHS[ch]!;
      rows.forEach((bits, r) => {
        for (let col = 0; col < 5; col++) if (bits & (16 >> col)) this.fill(x + col * s, y + r * s, s, s, c);
      });
      x += 6 * s;
    }
  }
  png(): Buffer {
    const rows = Buffer.alloc((this.width * 4 + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      rows[y * (this.width * 4 + 1)] = 0;
      this.data.copy(rows, y * (this.width * 4 + 1) + 1, y * this.width * 4, (y + 1) * this.width * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const v of body) crc = CRC_TABLE[(crc ^ v) & 0xff]! ^ (crc >>> 8);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, sum]);
}

/** 札の画像（PNG）。path は素材のフォルダからのパス。 */
export function placeholderPng(folder: string, path: string, screen: { width: number; height: number }): Buffer {
  if (folder === "fgimage") {
    const h = Math.round(screen.height * 0.9);
    const w = Math.round(h * 0.5);
    const c = new Canvas(w, h);
    const body: Rgba = [201, 196, 212, 150];
    c.ellipse(w / 2, h * 0.13, w * 0.16, h * 0.095, body);
    for (let y = Math.round(h * 0.27); y < h; y++) {
      const t = (y - h * 0.27) / (h * 0.73);
      const half = w * (0.36 + 0.08 * t);
      c.fill(w / 2 - half, y, half * 2, 1, body);
    }
    const size = Math.max(1, Math.round(h / 36 / 7));
    c.text("MISSING", h * 0.5, size * 1.4, [29, 27, 34, 255]);
    c.text(path, h * 0.5 + size * 14, size, [29, 27, 34, 255]);
    return c.png();
  }
  const [w, h] = folder === "bgimage" ? [screen.width, screen.height] : [480, 270];
  const c = new Canvas(w, h);
  c.fill(0, 0, w, h, [58, 63, 74, 255]);
  const unit = Math.max(1, Math.round(h / 20 / 7));
  c.dashedFrame(Math.round(h / 40), Math.round(h / 20), Math.max(2, Math.round(h / 270)), [138, 147, 163, 255]);
  c.text("MISSING", h / 2 - unit * 6, unit * 1.4, [232, 234, 240, 255]);
  c.text(`${folder}/${path}`, h / 2 + unit * 8, unit, [232, 234, 240, 255]);
  return c.png();
}

/** 無音の WAV（16 ビット、モノラル、22050 Hz）。 */
export function silentWav(seconds = 0.5): Buffer {
  const rate = 22050;
  const samples = Math.max(1, Math.round(rate * seconds));
  const data = samples * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(data, 40);
  return b;
}

/** 無い素材の札と無音を dir の <フォルダ>/<パス> に書き、書き出しの素材の一覧の形で返す。札にできない種類は書かない。 */
export function writePlaceholders(missing: readonly { folder: string; path: string }[], dir: string, screen: { width: number; height: number }): { rel: string; file: string }[] {
  const out: { rel: string; file: string }[] = [];
  for (const m of missing) {
    const image = PLACEHOLDER_IMAGE_FOLDERS.has(m.folder);
    if (!image && !PLACEHOLDER_AUDIO_FOLDERS.has(m.folder)) continue;
    const rel = `${m.folder}/${m.path}`;
    const file = join(dir, ...rel.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, image ? placeholderPng(m.folder, m.path, screen) : silentWav());
    out.push({ rel, file });
  }
  return out;
}
