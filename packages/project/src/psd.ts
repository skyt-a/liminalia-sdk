/**
 * PSD / PSB からパーツ合成の立ち絵（キャストの layers）を作る。Node の外（制作画面）でも使うので、ほかのモジュールは読まない。
 *
 * 一番上の階層の並びが層（下から順）になる。
 * - グループは一つの層。中の一つ一つ（レイヤーか、中のグループを重ねた一枚）がその層で選べる絵になり、表示しているものが default。
 * - グループの外のレイヤーは、それだけを絵に持つ層。表示していれば default。
 * 絵はどれもドキュメントと同じ大きさの PNG（左上を揃えて重ねるため）。不透明度とレイヤーマスクは絵に焼き込む。
 * 通常以外の描画モードとクリッピングは再現しないので、知らせる。
 */
import { initializeCanvas, readPsd, type Layer, type PixelData } from "ag-psd";
import type { CastLayer } from "@liminalia/lang";

export interface PsdImage {
  /** fgimage からのパス。 */
  path: string;
  png: Uint8Array;
}

export interface PsdImport {
  width: number;
  height: number;
  layers: CastLayer[];
  images: PsdImage[];
  /** 再現しないものなど。 */
  warnings: string[];
}

type Pixels = Uint8ClampedArray;

/** ファイル名に使えない文字（どの OS でも）を _ にする。 */
function cleanName(name: string): string {
  const s = name
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .trim()
    .replace(/[ .]+$/, "");
  return s === "" ? "_" : s;
}

/** 名前を重ならないようにする（同じ名前には _2、_3 … を付ける）。 */
function unique(name: string, used: Set<string>): string {
  let out = name;
  for (let i = 2; used.has(out); i++) out = `${name}_${i}`;
  used.add(out);
  return out;
}

/** 8 ビットの RGBA にそろえる（16 ビット・32 ビットのドキュメント）。 */
function rgba8(p: PixelData): Pixels {
  const d = p.data;
  if (d instanceof Uint8ClampedArray) return d;
  const out = new Uint8ClampedArray(d.length);
  if (d instanceof Uint16Array) for (let i = 0; i < d.length; i++) out[i] = d[i]! / 257;
  else if (d instanceof Float32Array) for (let i = 0; i < d.length; i++) out[i] = d[i]! * 255;
  else out.set(d);
  return out;
}

/** src を dst（ドキュメントの大きさ）の (left, top) に、不透明度とマスクを掛けて重ねる（通常の描画モード）。 */
function drawOver(dst: Pixels, width: number, height: number, layer: Layer): void {
  const img = layer.imageData;
  if (!img || img.width === 0 || img.height === 0) return;
  const src = rgba8(img);
  const left = layer.left ?? 0;
  const top = layer.top ?? 0;
  const opacity = layer.opacity ?? 1;
  const mask = layer.mask && !layer.mask.disabled && layer.mask.imageData ? layer.mask : null;
  const maskPixels = mask?.imageData ? rgba8(mask.imageData) : null;
  for (let y = 0; y < img.height; y++) {
    const dy = top + y;
    if (dy < 0 || dy >= height) continue;
    for (let x = 0; x < img.width; x++) {
      const dx = left + x;
      if (dx < 0 || dx >= width) continue;
      const s = (y * img.width + x) * 4;
      let a = (src[s + 3]! / 255) * opacity;
      if (mask && maskPixels) {
        const mx = dx - (mask.left ?? 0);
        const my = dy - (mask.top ?? 0);
        const mw = mask.imageData!.width;
        const mh = mask.imageData!.height;
        a *= (mx >= 0 && my >= 0 && mx < mw && my < mh ? maskPixels[(my * mw + mx) * 4]! : (mask.defaultColor ?? 255)) / 255;
      }
      if (a <= 0) continue;
      const d = (dy * width + dx) * 4;
      const da = dst[d + 3]! / 255;
      const oa = a + da * (1 - a);
      for (let c = 0; c < 3; c++) dst[d + c] = (src[s + c]! * a + dst[d + c]! * da * (1 - a)) / oa;
      dst[d + 3] = oa * 255;
    }
  }
}

/** グループの中の表示しているレイヤーを、下から重ねる。 */
function drawTree(dst: Pixels, width: number, height: number, layers: readonly Layer[], warn: (l: Layer) => void): void {
  for (const l of layers) {
    if (l.hidden) continue;
    if (l.children) drawTree(dst, width, height, l.children, warn);
    else {
      warn(l);
      drawOver(dst, width, height, l);
    }
  }
}

/** PSD / PSB を読んで、層と絵（PNG）を作る。folder は絵を置く fgimage の中のフォルダ。 */
export async function importPsd(data: ArrayBuffer | Uint8Array, folder: string): Promise<PsdImport> {
  const buffer = data instanceof Uint8Array ? data : new Uint8Array(data);
  // 画素は配列で受け取る（Node には canvas が無い。ブラウザでも canvas の乗算済みアルファで色が崩れない）
  initializeCanvas(
    () => {
      throw new Error("canvas は使いません");
    },
    (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: "srgb" }) as ImageData,
  );
  const psd = readPsd(buffer, { skipCompositeImageData: true, skipThumbnail: true, skipLinkedFilesData: true, useImageData: true });
  const { width, height } = psd;
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (l: Layer) => {
    const name = l.name ?? "";
    if (l.blendMode && l.blendMode !== "normal" && l.blendMode !== "pass through" && !warned.has(`b${name}`)) {
      warned.add(`b${name}`);
      warnings.push(`レイヤー「${name}」の描画モード（${l.blendMode}）は再現せず、通常で重ねます`);
    }
    if (l.clipping && !warned.has(`c${name}`)) {
      warned.add(`c${name}`);
      warnings.push(`レイヤー「${name}」のクリッピングは再現せず、そのまま重ねます`);
    }
  };
  const base = folder.split("/").map(cleanName).join("/");
  const layers: CastLayer[] = [];
  const images: PsdImage[] = [];
  const layerNames = new Set<string>();
  const render = async (draw: (dst: Pixels) => void): Promise<Uint8Array> => {
    const px = new Uint8ClampedArray(width * height * 4);
    draw(px);
    return encodePng(px, width, height);
  };
  for (const top of psd.children ?? []) {
    const name = unique(cleanName(top.name ?? "layer"), layerNames);
    const options: Record<string, string> = {};
    let pick: string | undefined;
    if (top.children) {
      const used = new Set<string>();
      for (const child of top.children) {
        const option = unique(cleanName(child.name ?? "part"), used);
        const path = `${base}/${name}/${option}.png`;
        images.push({ path, png: await render((px) => (child.children ? drawTree(px, width, height, child.children, warn) : (warn(child), drawOver(px, width, height, child)))) });
        options[option] = path;
        if (!child.hidden) {
          if (pick !== undefined) warnings.push(`グループ「${name}」で二つ以上表示しています（上の「${option}」を既定にします）`);
          pick = option;
        }
      }
    } else {
      const path = `${base}/${name}.png`;
      warn(top);
      images.push({ path, png: await render((px) => drawOver(px, width, height, top)) });
      options[name] = path;
      if (!top.hidden) pick = name;
    }
    if (Object.keys(options).length === 0) continue;
    layers.push({ name, options, ...(pick !== undefined ? { default: pick } : {}) });
  }
  return { width, height, layers, images, warnings };
}

// ---- PNG ----

const CRC_TABLE = (() => {
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
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** RGBA（8 ビット）を PNG にする。 */
export async function encodePng(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", await deflate(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
