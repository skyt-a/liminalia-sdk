/**
 * Live2D Cubism Core（live2dcubismcore.min.js。作者が Cubism SDK for Web から自分で入手して置くもの）の、このプラグインが使う形。
 * Core は同梱しない（docs/live2d-spine.md）。Core はページに読み込むと window.Live2DCubismCore を置く。
 * ここに書いたのは Core の JavaScript の口のうち、モデルを読んで動かし、描くのに要るものだけ。
 */

export interface CoreParameters {
  count: number;
  ids: string[];
  minimumValues: Float32Array;
  maximumValues: Float32Array;
  defaultValues: Float32Array;
  values: Float32Array;
}

export interface CoreParts {
  count: number;
  ids: string[];
  opacities: Float32Array;
}

export interface CoreDrawables {
  count: number;
  ids: string[];
  constantFlags: Uint8Array;
  dynamicFlags: Uint8Array;
  textureIndices: Int32Array;
  renderOrders: Int32Array;
  opacities: Float32Array;
  maskCounts: Int32Array;
  masks: Int32Array[];
  vertexPositions: Float32Array[];
  vertexUvs: Float32Array[];
  indices: Uint16Array[];
  /** 乗算色（版によって、描くものごとの並びか、4 つずつ並べた一つの並び）。古い Core には無い。 */
  multiplyColors?: Float32Array | Float32Array[];
  /** スクリーン色（multiplyColors と同じ形）。 */
  screenColors?: Float32Array | Float32Array[];
  resetDynamicFlags(): void;
}

export interface CoreCanvasInfo {
  CanvasWidth: number;
  CanvasHeight: number;
  CanvasOriginX: number;
  CanvasOriginY: number;
  PixelsPerUnit: number;
}

export interface CoreModel {
  parameters: CoreParameters;
  parts: CoreParts;
  drawables: CoreDrawables;
  canvasinfo: CoreCanvasInfo;
  update(): void;
  release(): void;
}

export type CoreMoc = object & { _release?(): void };

export interface CubismCore {
  Moc: { fromArrayBuffer(buffer: ArrayBuffer): CoreMoc | null };
  Model: { fromMoc(moc: CoreMoc): CoreModel | null };
}

/** 描くもの（drawable）の決まった印（constantFlags）。 */
export const BLEND_ADDITIVE = 1 << 0;
export const BLEND_MULTIPLICATIVE = 1 << 1;
export const DOUBLE_SIDED = 1 << 2;
export const INVERTED_MASK = 1 << 3;
/** 描くものの、フレームごとに変わる印（dynamicFlags）。 */
export const IS_VISIBLE = 1 << 0;

/** ページに読み込んだ Core（無ければ null）。 */
export function globalCore(): CubismCore | null {
  const core = (globalThis as { Live2DCubismCore?: CubismCore }).Live2DCubismCore;
  return core && typeof core.Moc?.fromArrayBuffer === "function" && typeof core.Model?.fromMoc === "function" ? core : null;
}

/** 描くもの i の乗算色かスクリーン色（RGBA）。無ければ fallback。 */
export function drawableColor(list: Float32Array | Float32Array[] | undefined, i: number, fallback: readonly [number, number, number, number]): [number, number, number, number] {
  if (!list) return [...fallback];
  if (Array.isArray(list)) {
    const c = list[i];
    return c && c.length >= 3 ? [c[0]!, c[1]!, c[2]!, c[3] ?? 1] : [...fallback];
  }
  const flat = list as Float32Array;
  if (flat.length < (i + 1) * 4) return [...fallback];
  return [flat[i * 4]!, flat[i * 4 + 1]!, flat[i * 4 + 2]!, flat[i * 4 + 3]!];
}
