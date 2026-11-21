import { isPortrait, portraitSpriteScale, positionCenters } from "./screen.ts";
import { DEFAULT_APPEARANCE, DEFAULT_FRAME_SIZE, FRAME_POSITIONS, type Cast, type CastAppearance, type CastEntry, type CastFrame, type CastLayer, type CastPosition, type CastVariant } from "./cast.ts";

/**
 * キャストの編集と、立ち絵の枠の計算（立ち絵の位置調整画面と制作画面のキャラクターの画面が使う）。画面に依らない純粋な部分。
 * 計算は立ち絵プラグイン Tyrano Tatie の調整画面（tatie.builder.js）と同じ。
 */

export interface Size {
  width: number;
  height: number;
}

/** 幅・高さと left / center / right を必ず持つ枠。flipAxis は反転するときの軸（CastFrame の flipAxis。頭の位置合わせが書く）。 */
export interface FullFrame extends Size {
  positions: Record<string, CastPosition>;
  flipAxis?: number;
}

const numberOr = (value: unknown, fallback: number) => {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : fallback;
};

/** 枠を写す。幅・高さの既定は 632×843、left / center / right が無ければ (0, 0)。値は整数に丸める（tatie の cloneFrame）。 */
export function cloneFrame(frame: CastFrame | undefined): FullFrame {
  const positions: Record<string, CastPosition> = {};
  for (const key of new Set([...FRAME_POSITIONS, ...Object.keys(frame?.positions ?? {})])) {
    const p = frame?.positions?.[key];
    positions[key] = { left: Math.round(numberOr(p?.left, 0)), top: Math.round(numberOr(p?.top, 0)) };
  }
  return { width: Math.round(numberOr(frame?.width, DEFAULT_FRAME_SIZE.width)), height: Math.round(numberOr(frame?.height, DEFAULT_FRAME_SIZE.height)), positions };
}

/** 差分の枠を、幅・高さと left / center / right を持つ形にして返す（差分を書き換える。tatie の ensureFrame）。 */
export function ensureFrame(variant: CastVariant): FullFrame {
  const frame = (variant.frame ??= {});
  frame.width ??= DEFAULT_FRAME_SIZE.width;
  frame.height ??= DEFAULT_FRAME_SIZE.height;
  frame.positions ??= {};
  for (const key of FRAME_POSITIONS) frame.positions[key] ??= { left: 0, top: 0 };
  return frame as FullFrame;
}

/** 枠の中の立ち位置。無い名前は center、center も無ければ (0, 0)。 */
export function positionOf(frame: CastFrame, at: string): CastPosition {
  return frame.positions?.[at] ?? frame.positions?.center ?? { left: 0, top: 0 };
}

/**
 * 枠のない差分（画像の実寸で、どの立ち位置でも画面下の中央に出るもの）に、今と同じ見え方の枠を作る。
 * 位置調整画面で枠のない差分を動かしたときに使う。
 */
export function frameFromNatural(natural: Size, screen: Size): FullFrame {
  const at = { left: Math.round((screen.width - natural.width) / 2), top: Math.round(screen.height - natural.height) };
  return { width: natural.width, height: natural.height, positions: Object.fromEntries(FRAME_POSITIONS.map((k) => [k, { ...at }])) };
}

// ---- 差分を足すときの初めの枠 ----

/** 画像の透明でない部分の外接矩形。 */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface ImageInfo extends Size {
  /** 全部透明なら null。 */
  bbox: Bounds | null;
}

/** RGBA の画素（Canvas の getImageData の data）から、アルファが 0 でない部分の外接矩形を求める。 */
export function opaqueBounds(pixels: ArrayLike<number>, width: number, height: number): Bounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return {
    left: minX,
    top: minY,
    right: maxX + 1,
    bottom: maxY + 1,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    centerX: (minX + maxX + 1) / 2,
    centerY: (minY + maxY + 1) / 2,
  };
}

/**
 * 新しい画像の初めの枠を、基準の立ち絵と透明でない部分の外接矩形を比べて決める（tatie の buildInitialFrameFromReference）。
 * 倍率は、基準の体（外接矩形を枠に合わせた大きさ）との高さ比 0.75＋幅比 0.25。各立ち位置で、外接矩形の中心 X と下端を基準に合わせる。
 * 比べられないとき（画像が読めない・全部透明）は基準の枠をそのまま返す。
 */
export function initialFrameFromReference(reference: { frame: CastFrame; info: ImageInfo | null }, next: ImageInfo | null): FullFrame {
  const fallback = cloneFrame(reference.frame);
  const base = reference.info;
  if (!base?.bbox || !next?.bbox) return fallback;
  const baseScaleX = fallback.width / base.width;
  const baseScaleY = fallback.height / base.height;
  const byHeight = (base.bbox.height * baseScaleY) / next.bbox.height;
  const byWidth = (base.bbox.width * baseScaleX) / next.bbox.width;
  let scale = byHeight;
  if (Number.isFinite(byHeight) && Number.isFinite(byWidth)) scale = byHeight * 0.75 + byWidth * 0.25;
  else if (Number.isFinite(byWidth)) scale = byWidth;
  if (!Number.isFinite(scale) || scale <= 0) return fallback;

  const frame: FullFrame = { width: Math.round(next.width * scale), height: Math.round(next.height * scale), positions: {} };
  for (const name of framePositionNames(fallback)) {
    const at = positionOf(fallback, name);
    const centerX = at.left + base.bbox.centerX * baseScaleX;
    const bottom = at.top + base.bbox.bottom * baseScaleY;
    frame.positions[name] = { left: Math.round(centerX - next.bbox.centerX * scale), top: Math.round(bottom - next.bbox.bottom * scale) };
  }
  return frame;
}

/**
 * 基準の立ち絵が無いとき（立ち絵セットに差分がまだ無い）の初めの枠。
 * 画面の高さに収まるように縮め（拡大はしない）、left / center / right を画面の幅の 1/4・1/2・3/4 に中心を置いて下端をそろえる。
 * 縦長の作品では幅にも収め、立ち絵の高さを画面の 7 割ほどまでにして、中心を真ん中へ寄せる（screen.ts）。
 */
export function initialFrameAlone(natural: Size, screen: Size): FullFrame {
  const scale = Math.min(1, isPortrait(screen) ? portraitSpriteScale(natural, screen) : screen.height / natural.height);
  const width = Math.max(1, Math.round(natural.width * scale));
  const height = Math.max(1, Math.round(natural.height * scale));
  const at = (x: number) => ({ left: Math.round(x - width / 2), top: screen.height - height });
  const c = positionCenters(screen);
  return { width, height, positions: { left: at(screen.width * c.left), center: at(screen.width * c.center), right: at(screen.width * c.right) } };
}

/** 差分を足すときの基準の差分の名前。normal → default → 最初の差分。無ければ null。 */
export function referenceVariantKey(appearance: CastAppearance | undefined): string | null {
  const variants = appearance?.variants ?? {};
  for (const key of ["normal", "default", Object.keys(variants)[0]]) if (key && variants[key]) return key;
  return null;
}

// ---- 名前 ----

/** キー（立ち絵セット・差分の名前）にできない文字を _ にする。日本語の文字は残す。 */
export function normalizeKey(raw: string): string {
  return raw
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

/** existing に無いキー。あれば preferred_2、preferred_3 … */
export function uniqueKey(existing: Readonly<Record<string, unknown>>, preferred: string): string {
  const base = preferred || "variant";
  let key = base;
  for (let i = 2; key in existing; i++) key = `${base}_${i}`;
  return key;
}

/** 保存名（拡張子なし）にできない文字を _ にする（tatie の sanitizeFileBase）。 */
export function sanitizeFileBase(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "") || "variant"
  );
}

export const SPRITE_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;

/** 画像の拡張子（小文字）。対応しない形式なら null。 */
export function imageExtension(fileName: string): string | null {
  const ext = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? "";
  return (SPRITE_IMAGE_EXTENSIONS as readonly string[]).includes(ext) ? ext : null;
}

/** 保存するファイル名。拡張子は元のファイルのもの（無ければ png）。 */
export function imageFileName(base: string, original: string): string {
  return `${sanitizeFileBase(base)}.${imageExtension(original) ?? "png"}`;
}

/** fgimage からのパスのフォルダ部分（"akari/normal.webp" → "akari"）。 */
export function folderOf(image: string): string {
  const i = image.lastIndexOf("/");
  return i < 0 ? "" : image.slice(0, i);
}

// ---- キャストの編集 ----

/** キャストを足す。立ち絵セット default（差分なし）を一つ持つ。 */
export function addCharacter(cast: Cast, name: string): void {
  if (name === "") throw new Error("キャラクター ID が空です");
  if (cast[name]) throw new Error(`キャラクター ${name} はすでにあります`);
  cast[name] = { defaultAppearance: DEFAULT_APPEARANCE, appearances: { [DEFAULT_APPEARANCE]: { variants: {} } } };
}

/** 立ち絵セットを足す（差分なし）。足したキーを返す。 */
export function addAppearance(entry: CastEntry, rawKey: string, label = ""): string {
  const key = normalizeKey(rawKey);
  if (key === "") throw new Error("立ち絵セットの名前が空です");
  if (entry.appearances[key]) throw new Error(`立ち絵セット ${key} はすでにあります`);
  entry.appearances[key] = label ? { label, variants: {} } : { variants: {} };
  entry.defaultAppearance ??= key;
  return key;
}

/** 立ち絵セットを消す。最後の一つは消せない。defaultAppearance だったら残りの最初のものにする。 */
export function removeAppearance(entry: CastEntry, key: string): void {
  if (!entry.appearances[key]) throw new Error(`立ち絵セット ${key} がありません`);
  if (Object.keys(entry.appearances).length <= 1) throw new Error("最後の立ち絵セットは削除できません");
  delete entry.appearances[key];
  if (entry.defaultAppearance === key) entry.defaultAppearance = Object.keys(entry.appearances)[0]!;
}

/**
 * 立ち絵セットにパーツ合成の層を入れる（PSD の取り込み）。キャストや立ち絵セットが無ければ作る。
 * 層は置き換え、差分の parts は残る層と絵のものだけ残す。差分が一つも無ければ、層の既定だけで出す normal を作る。
 * 一枚絵の差分（parts の無いもの）は、そのまま残す。
 */
export function applyLayers(cast: Cast, who: string, appearance: string, layers: CastLayer[]): void {
  const entry = (cast[who] ??= { defaultAppearance: appearance, appearances: {} });
  const set = (entry.appearances[appearance] ??= { variants: {} });
  set.layers = layers;
  for (const variant of Object.values(set.variants)) {
    if (!variant.parts) continue;
    for (const [layer, pick] of Object.entries(variant.parts)) {
      const l = layers.find((x) => x.name === layer);
      if (!l || (pick !== "" && !Object.hasOwn(l.options, pick))) delete variant.parts[layer];
    }
  }
  if (Object.keys(set.variants).length === 0) set.variants.normal = { image: "", parts: {} };
}

/** 立ち位置を足す（center と同じ位置から）。 */
export function addPosition(frame: FullFrame, rawName: string): string {
  const name = normalizeKey(rawName);
  if (name === "" || name === "auto") throw new Error(`この名前は立ち位置に使えません: ${rawName}`);
  if (frame.positions[name]) throw new Error(`立ち位置 ${name} はすでにあります`);
  frame.positions[name] = { ...positionOf(frame, "center") };
  return name;
}

/** 立ち位置の名前（left / center / right と、枠にあるもの）。 */
export function framePositionNames(...frames: CastFrame[]): string[] {
  return [...new Set([...FRAME_POSITIONS, ...frames.flatMap((f) => Object.keys(f.positions ?? {}))])];
}
