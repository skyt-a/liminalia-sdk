import type { CastFrame, CastVariant } from "@liminalia/lang";
import { cloneFrame, ensureFrame, framePositionNames as namesOf, positionOf, type FullFrame, type Size } from "@liminalia/lang";

/**
 * 立ち絵の位置調整画面（開発サーバーの /__liminalia/cast）の計算のうち、画面の操作に寄るもの（動かす・大きさを変える・同期・元に戻す）。
 * キャストの編集と枠の計算は @liminalia/lang の cast-edit.ts にあり、ここからも引けるようにしてある。
 */
export {
  addAppearance,
  addCharacter,
  addPosition,
  cloneFrame,
  ensureFrame,
  folderOf,
  frameFromNatural,
  imageExtension,
  imageFileName,
  initialFrameAlone,
  initialFrameFromReference,
  normalizeKey,
  opaqueBounds,
  positionOf,
  referenceVariantKey,
  removeAppearance,
  sanitizeFileBase,
  SPRITE_IMAGE_EXTENSIONS as IMAGE_EXTENSIONS,
  uniqueKey,
  type Bounds,
  type FullFrame,
  type ImageInfo,
  type Size,
} from "@liminalia/lang";

// ---- 動かす・大きさを変える ----

export interface Box extends Size {
  left: number;
  top: number;
}

/** ホイールで中心を保って拡大縮小する。縦横比を固定しないときは横だけ、Shift なら縦だけ（tatie の resizeFromWheel）。 */
export function wheelResize(box: Box, deltaY: number, keepRatio: boolean, shift: boolean): Box {
  const scale = deltaY < 0 ? 1.035 : 0.965;
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  let width = box.width;
  let height = box.height;
  if (keepRatio) {
    width *= scale;
    height *= scale;
  } else if (shift) {
    height *= scale;
  } else {
    width *= scale;
  }
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  return { width, height, left: Math.round(cx - width / 2), top: Math.round(cy - height / 2) };
}

/** 中心を保ったまま、幅と高さを変える（数値の欄で大きさを変えたとき。ホイールと同じく中心がずれない）。 */
export function resizeAround(box: Box, width: number, height: number): Box {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  return { width, height, left: Math.round(cx - width / 2), top: Math.round(cy - height / 2) };
}

/** 二本の指で広げた・狭めたときの枠。開始の枠を factor 倍し、中心は動かさない（縦横比は保つ）。 */
export function pinchResize(start: Box, factor: number): Box {
  return resizeAround(start, Math.max(1, Math.round(start.width * factor)), Math.max(1, Math.round(start.height * factor)));
}

/** 大きさを変える取っ手。n・s・e・w と四隅。 */
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/**
 * 取っ手を (dx, dy) だけ引いたときの枠。反対側の辺・角は動かさない。
 * ratio（幅 / 高さ）を渡すと縦横比を保つ: 左右の辺は幅に、上下の辺は高さに合わせ、角は大きく動いた方に合わせる
 * （辺のときは、もう一方の向きは上端・左端を保つ。jQuery UI の resizable と同じ）。
 */
export function resizeBox(start: Box, handle: Handle, dx: number, dy: number, ratio: number | null): Box {
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  let width = start.width + (east ? dx : west ? -dx : 0);
  let height = start.height + (south ? dy : north ? -dy : 0);
  if (ratio && ratio > 0) {
    if ((east || west) && !(north || south)) height = width / ratio;
    else if ((north || south) && !(east || west)) width = height * ratio;
    else if (Math.abs(width / start.width - 1) >= Math.abs(height / start.height - 1)) height = width / ratio;
    else width = height * ratio;
  }
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  return {
    width,
    height,
    left: west ? start.left + start.width - width : start.left,
    top: north ? start.top + start.height - height : start.top,
  };
}

// ---- 同期 ----


export interface SyncResult {
  scaleX: number;
  scaleY: number;
  top: number;
  /** 書き換えた差分。 */
  targets: string[];
  /** 比較表示中なので書き換えなかった差分。 */
  excluded: string[];
}

/**
 * 今の差分の大きさの倍率（基準の枠からの）と Y 位置を、同じ立ち絵セットの全差分へ写す（tatie の applyCurrentAdjustmentToAllVariants）。
 * 各差分は基準の枠（開いた時点／最後に保存した時点。base に無ければ今の枠）に同じ倍率を掛け、どの立ち位置も
 * 中心の X を保って top をそろえる。今の差分の今の立ち位置だけは、今の left のまま。
 * 枠のない差分と exclude の差分は書き換えない。差分を書き換え、書き換えるものが無ければ null。
 */
export function syncToAllVariants(
  variants: Record<string, CastVariant>,
  o: { variant: string; position: string; base: (key: string) => CastFrame | undefined; exclude?: ReadonlySet<string> },
): SyncResult | null {
  const source = variants[o.variant];
  if (!source?.frame) return null;
  const sourceFrame = cloneFrame(source.frame);
  const sourceBase = cloneFrame(o.base(o.variant) ?? source.frame);
  const sourcePosition = positionOf(sourceFrame, o.position);
  const scaleX = sourceBase.width > 0 ? sourceFrame.width / sourceBase.width : 1;
  const scaleY = sourceBase.height > 0 ? sourceFrame.height / sourceBase.height : 1;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) return null;
  const top = Math.round(sourcePosition.top);
  const excluded = Object.keys(variants).filter((k) => o.exclude?.has(k) && k !== o.variant);
  const targets = Object.keys(variants).filter((k) => variants[k]!.frame && !excluded.includes(k));

  for (const key of targets) {
    const variant = variants[key]!;
    const base = cloneFrame(o.base(key) ?? variant.frame);
    const frame = ensureFrame(variant);
    frame.width = Math.max(1, Math.round(base.width * scaleX));
    frame.height = Math.max(1, Math.round(base.height * scaleY));
    for (const name of namesOf(base, frame)) {
      const at = positionOf(base, name);
      frame.positions[name] = {
        left: key === o.variant && name === o.position ? Math.round(sourcePosition.left) : Math.round(at.left + (base.width - frame.width) / 2),
        top,
      };
    }
  }
  return { scaleX, scaleY, top, targets, excluded };
}

/**
 * 今の立ち位置の Y を、同じ差分のほかの立ち位置へ写し、ほかの立ち位置は大きさが変わっても中心の X を保つ
 * （tatie の syncCurrentFrameToOtherPositions。center を保存するときに使う）。枠を書き換える。
 */
export function syncToOtherPositions(frame: FullFrame, base: CastFrame | undefined, position: string): void {
  const b = cloneFrame(base ?? frame);
  const source = { ...positionOf(frame, position) };
  for (const name of namesOf(b, frame)) {
    if (name === position) {
      frame.positions[name] = { left: Math.round(source.left), top: Math.round(source.top) };
      continue;
    }
    const at = positionOf(b, name);
    frame.positions[name] = { left: Math.round(at.left + (b.width - frame.width) / 2), top: Math.round(source.top) };
  }
}

// ---- 元に戻す ----

/**
 * 元に戻す・やり直すの履歴。状態は文字列（JSON）で持つ。limit 手まで。
 * push は変える前に呼ぶ。同じ group を続けて push すると一手にまとめる（ホイール・矢印キーの連打）。
 */
export class History<T = string> {
  private readonly undoStack: { state: T; group: string | null }[] = [];
  private readonly redoStack: T[] = [];

  constructor(private readonly limit = 100) {}

  push(state: T, group: string | null = null): void {
    const last = this.undoStack.at(-1);
    this.redoStack.length = 0;
    if (group !== null && last?.group === group) return;
    this.undoStack.push({ state, group });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
  }

  /** 一連の操作の区切り（次の push は同じ group でもまとめない）。 */
  seal(): void {
    const last = this.undoStack.at(-1);
    if (last) last.group = null;
  }

  undo(current: T): T | null {
    const last = this.undoStack.pop();
    if (!last) return null;
    this.redoStack.push(current);
    return last.state;
  }

  redo(current: T): T | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push({ state: current, group: null });
    return next;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get size(): number {
    return this.undoStack.length;
  }
}
