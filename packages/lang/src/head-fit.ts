import { appearanceKey, flipAxisRatio, FRAME_POSITIONS, variantPreview, type CastEntry, type CastFrame } from "./cast.ts";
import { cloneFrame, framePositionNames, positionOf, referenceVariantKey, type FullFrame, type Size } from "./cast-edit.ts";
import { sha256Hex } from "./sha256.ts";

/**
 * 立ち絵の頭の測定点（画像の左上からの px）。衣装・表情を切り替えても頭の大きさと顎の位置が跳ねないよう、
 * 外接矩形ではなく頭を基準に枠を合わせるのに使う（制作画面の「頭の大きさを揃える」）。
 */
export interface HeadMark {
  /** 顎先。 */
  chinX: number;
  chinY: number;
  /** 頭頂の Y。 */
  top: number;
  /** 頭本体と主要な髪の外形の横幅（長髪の裾や添えた手は含めない）。 */
  width: number;
  /** 測ったときの画像の大きさ。画像が差し替わったかを見るのに使う。 */
  imageWidth: number;
  imageHeight: number;
  /**
   * 測ったときの画像のファイルの中身の印（imageContentHash）。同じパス、同じ大きさのまま差し替えた絵を見分ける。
   * 前の版で覚えた測定点には無いか、弱い印（長さと 32bit のハッシュ二通り）が入っている（どちらも確かめ直す。savedHeadMark）。
   */
  imageHash?: string;
}

/** 頭の高さと幅を合わせる重み（合計 1）。 */
const HEIGHT_WEIGHT = 0.565;
const WIDTH_WEIGHT = 0.435;
const OPAQUE = 32;
/** 首の細さから顎を決められないときの、頭の高さ ÷ 体（不透明な部分）の高さ。 */
const HEAD_RATIO = 0.165;
/** 基準の枠の縦横比が画像とこれ以上ずれていたら、歪んだ基準として使わない。 */
const ASPECT_TOLERANCE = 0.02;

export function headHeight(mark: HeadMark): number {
  return mark.chinY - mark.top;
}

/** 測定点が使える値か（高さ・幅が正で、画像の中に収まる）。 */
export function validHeadMark(mark: HeadMark, size: Size): boolean {
  const finite = [mark.chinX, mark.chinY, mark.top, mark.width].every(Number.isFinite);
  return finite && mark.width > 0 && headHeight(mark) > 0 && mark.top >= 0 && mark.chinY <= size.height && mark.chinX >= 0 && mark.chinX <= size.width && mark.imageWidth === size.width && mark.imageHeight === size.height;
}

/** 画像の中身の印の頭（SHA-256 の印。前の版の印はこの頭が無い）。 */
const IMAGE_HASH_PREFIX = "sha256-";

/**
 * 画像のファイルの中身の印（"sha256-" と SHA-256 の 16 進）。差し替えた絵を見分けるのに使う。
 * どの環境でも同じ値になるよう、絵を読んだ画素でなくファイルのバイトから作る（読み戻しの画素は、ブラウザと色の扱いで変わりうる）。
 * 前の版は長さと 32bit のハッシュ二通りで、偶然同じになる絵を見分けられなかった（その印は savedHeadMark が確かめ直しにする）。
 */
export function imageContentHash(bytes: Uint8Array): string {
  return `${IMAGE_HASH_PREFIX}${sha256Hex(bytes)}`;
}

/**
 * 覚えた測定点（saved）を今の絵（大きさ size、中身の印 hash）に使うか。
 * - 大きさと中身の印が今の絵と同じなら、確認済みのまま使う
 * - 中身の印の無い前の形の測定点、前の版の弱い印の測定点、今の絵の中身が分からない（hash が null）ときは、測定点を初めの値に使い、確かめ直す
 * - 中身が違う（同じパス、同じ大きさのまま差し替えた絵）か、大きさが合わなければ使わない（mark は null。推し量り直す）
 */
export function savedHeadMark(saved: HeadMark | undefined, size: Size, hash: string | null): { mark: HeadMark | null; confirmed: boolean } {
  if (!saved || !validHeadMark(saved, size)) return { mark: null, confirmed: false };
  if (saved.imageHash === undefined || !saved.imageHash.startsWith(IMAGE_HASH_PREFIX) || hash === null) return { mark: saved, confirmed: false };
  return saved.imageHash === hash ? { mark: saved, confirmed: true } : { mark: null, confirmed: false };
}

/**
 * 画素（RGBA）から頭の測定点を推し量る。確認用の初めの値で、正解ではない。
 * 頭頂は不透明な部分の上端、頭の幅は頭から首へ細くなる手前までの中央の連なりの最大幅、顎は首（上から 30% までで一番細い所）に幅が近づく最初の行。首が見つからないとき（長い髪など）は体の高さの 16.5% で推す。
 * 長い髪・帽子・大きなポーズでは外れるので、画面で直して確かめる。透明な画像は null。
 */
export function estimateHead(pixels: ArrayLike<number>, width: number, height: number): HeadMark | null {
  const solid = (x: number, y: number) => pixels[(y * width + x) * 4 + 3]! >= OPAQUE;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height && (top < 0 || bottom < 0); y++) {
    for (let x = 0; x < width; x++) {
      if (top < 0 && solid(x, y)) top = y;
      if (bottom < 0 && solid(x, height - 1 - y)) bottom = height - 1 - y;
    }
  }
  if (top < 0 || bottom < top) return null;
  const body = bottom - top + 1;
  // 頭頂の中心 X: 上端から数行の不透明な画素の平均
  let sum = 0;
  let count = 0;
  for (let y = top; y < Math.min(bottom + 1, top + Math.max(3, Math.round(body * 0.02))); y++) {
    for (let x = 0; x < width; x++) if (solid(x, y)) (sum += x), count++;
  }
  const centerX = Math.round(sum / count);
  /** 行 y で、centerX を含む不透明の連なり。含まなければ最も近い連なり。 */
  const span = (y: number): [number, number] | null => {
    let seed = -1;
    for (let d = 0; d < width && seed < 0; d++) {
      if (centerX - d >= 0 && solid(centerX - d, y)) seed = centerX - d;
      else if (centerX + d < width && solid(centerX + d, y)) seed = centerX + d;
    }
    if (seed < 0) return null;
    let l = seed;
    let r = seed;
    while (l > 0 && solid(l - 1, y)) l--;
    while (r < width - 1 && solid(r + 1, y)) r++;
    return [l, r + 1];
  };
  const limit = Math.min(bottom, top + Math.round(body * 0.3));
  const widths: number[] = [];
  for (let y = top; y <= limit; y++) {
    const s = span(y);
    widths.push(s ? s[1] - s[0] : 0);
  }
  // 頭の幅: 上から幅が増えていき、最大の 70% を切る（首へ細くなる）手前までの最大。肩が広がる前で止める
  let maxWidth = 0;
  let widest = top;
  let narrowed = -1;
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i]!;
    if (w > maxWidth) (maxWidth = w), (widest = top + i);
    else if (maxWidth > 0 && w < maxWidth * 0.7) {
      narrowed = i;
      break;
    }
  }
  if (maxWidth === 0) return null;
  // 首: 細くなったあと、肩で幅が 1.6 倍を超えるまでの一番細い幅。顎は、そこまでに幅が首の 1.15 倍以下になる最初の行
  let chin = top + Math.round(body * HEAD_RATIO);
  if (narrowed >= 0) {
    let neck = widths[narrowed]!;
    for (let i = narrowed; i < widths.length && widths[i]! <= neck * 1.6; i++) neck = Math.min(neck, widths[i]!);
    chin = top + (widths.findIndex((w, i) => i >= widest - top && w <= neck * 1.15) || narrowed);
  } else {
    // 長い髪などで首が細く見えないときは、立ち絵の頭の割合（体の高さの 16.5%）で推し、頭の幅もその範囲で測り直す
    maxWidth = Math.max(...widths.slice(0, Math.max(1, chin - top)));
  }
  const face = skinFace(pixels, width, top, limit);
  let chinX: number;
  if (face) {
    // 顔の肌が一番広い行（目・頬）から顎までは頭の高さの 10〜30% 下。アルファの幅の推定が髪の裾で早く切れたときに、そこへ引き上げる
    const reference = body * HEAD_RATIO;
    chin = Math.round(Math.min(Math.max(chin, face.row + reference * 0.1), face.row + reference * 0.3));
    chinX = face.centerX;
  } else {
    const at = span(Math.max(top, chin - 1));
    chinX = at ? (at[0] + at[1]) / 2 : centerX;
  }
  return { chinX, chinY: chin, top, width: maxWidth, imageWidth: width, imageHeight: height };
}

/** 肌色（アニメ塗りの明るい肌。白い服や髪の明るい所は R−B が小さい・G が低いので外れる）。 */
function isSkin(pixels: ArrayLike<number>, i: number): boolean {
  const r = pixels[i]!;
  const g = pixels[i + 1]!;
  const b = pixels[i + 2]!;
  return pixels[i + 3]! > 200 && r > 170 && g > 120 && b > 90 && r > g && g > b && r - b > 18 && r - b < 110 && r - g < 70;
}

/**
 * 頭の領域（上から top〜limit 行）で肌が一番多い行（目・頬の高さ）と、その行の最も広い肌の連なりの中心 X。
 * 肌が見つからない（肌色が合わない絵）か、顔として小さすぎるときは null。
 */
function skinFace(pixels: ArrayLike<number>, width: number, top: number, limit: number): { row: number; centerX: number } | null {
  const counts: number[] = [];
  for (let y = top; y <= limit; y++) {
    let c = 0;
    for (let x = 0; x < width; x++) if (isSkin(pixels, (y * width + x) * 4)) c++;
    counts.push(c);
  }
  let peak = -1;
  let best = 0;
  for (let i = 0; i < counts.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - 8); j <= Math.min(counts.length - 1, i + 8); j++) (sum += counts[j]!), n++;
    if (sum / n > best) (best = sum / n), (peak = i);
  }
  if (peak < 0 || best < width * 0.03) return null;
  const y = top + peak;
  let run: [number, number] | null = null;
  let start = -1;
  let last = -100;
  const close = () => {
    if (start >= 0 && (!run || last - start > run[1] - run[0])) run = [start, last];
  };
  for (let x = 0; x < width; x++) {
    if (!isSkin(pixels, (y * width + x) * 4)) continue;
    if (start < 0 || x - last > 6) (close(), (start = x));
    last = x;
  }
  close();
  const found = run as [number, number] | null;
  if (!found || found[1] - found[0] < width * 0.03) return null;
  return { row: y, centerX: (found[0] + found[1]) / 2 };
}

/**
 * 頭を基準に、新しい画像の枠を決める。基準（枠・画像・測定点）と同じ頭の大きさ・顎の位置になるよう、縦横比を保つ均等な拡大縮小と位置だけを変える。
 * 倍率は頭の高さと幅の比の加重幾何平均。基準の枠にある立ち位置では、基準の顎の画面位置に新しい画像の顎を置く。
 * next.frame（新しい画像の今の枠）にだけある立ち位置は、今の枠での自分の顎の画面位置を保つ（その差分だけの置き場所を動かさない）。
 * 基準の枠の縦横比が画像と合わない・測定点が使えないときは null。
 *
 * 左右反転（flip）して出すときも顎が合うよう、裏返す軸（flipAxis）も決める（flipAxisFor）。軸が絵の中央になるとき（基準と同じく中央で裏返せば合うとき）は書かない。
 */
export function fitFrameToHead(parent: { frame: FullFrame; size: Size; mark: HeadMark }, next: { size: Size; mark: HeadMark; frame?: CastFrame | undefined }): FullFrame | null {
  if (!validHeadMark(parent.mark, parent.size) || !validHeadMark(next.mark, next.size)) return null;
  const scale = parent.frame.width / parent.size.width;
  if (!(scale > 0)) return null;
  if (Math.abs(parent.frame.height / parent.size.height / scale - 1) > ASPECT_TOLERANCE) return null;
  const fit = Math.exp(HEIGHT_WEIGHT * Math.log(headHeight(parent.mark) / headHeight(next.mark)) + WIDTH_WEIGHT * Math.log(parent.mark.width / next.mark.width));
  const nextScale = scale * fit;
  const frame: FullFrame = { width: Math.round(next.size.width * nextScale), height: Math.round(next.size.height * nextScale), positions: {} };
  const shared = framePositionNames(parent.frame);
  for (const name of shared) {
    const at = positionOf(parent.frame, name);
    const chinX = at.left + parent.mark.chinX * scale;
    const chinY = at.top + parent.mark.chinY * scale;
    frame.positions[name] = { left: Math.round(chinX - next.mark.chinX * nextScale), top: Math.round(chinY - next.mark.chinY * nextScale) };
  }
  Object.assign(frame.positions, ownPositions(next, shared, frame));
  const axis = flipAxisFor(parent, next, frame);
  if (axis !== undefined) frame.flipAxis = axis;
  return frame;
}

/**
 * 反転して出すときの軸（next の絵の px。中央なら undefined）。描画は絵を枠いっぱいに伸ばして軸で裏返すので、
 * 反転したときの顎の画面の X は「位置 +（2 × 軸 − 顎の X）× 倍率」。反転しないときの顎を基準に合わせた位置（fitFrameToHead）で、
 * これも基準（基準の軸。無ければ中央）と合うのは、軸 = 顎の X +（基準の軸 − 基準の顎の X）× 基準の倍率 ÷ 自分の倍率 のとき。
 * 基準が顎で裏返すなら、自分も顎で裏返す。基準の枠は変えない（軸の無い基準は、今までどおり中央で裏返す）。
 */
function flipAxisFor(parent: { frame: FullFrame; size: Size; mark: HeadMark }, next: { size: Size; mark: HeadMark }, frame: Size): number | undefined {
  const parentScale = parent.frame.width / parent.size.width;
  const scale = frame.width / next.size.width;
  if (!(parentScale > 0) || !(scale > 0)) return undefined;
  const parentAxis = flipAxisRatio(parent.frame, parent.size.width) * parent.size.width;
  const axis = Math.round((next.mark.chinX + ((parentAxis - parent.mark.chinX) * parentScale) / scale) * 10) / 10;
  return Math.abs(axis - next.size.width / 2) < 0.05 ? undefined : axis;
}

/**
 * 差分の今の枠にだけある立ち位置（shared に無い名前）を、新しい枠（to）の大きさで置き直す。今の枠での自分の顎の画面位置を保つ。
 * 今の枠が無い（実寸で出す）差分には無い。
 */
function ownPositions(next: { size: Size; mark: HeadMark; frame?: CastFrame | undefined }, shared: readonly string[], to: Size): Record<string, { left: number; top: number }> {
  const out: Record<string, { left: number; top: number }> = {};
  if (!next.frame?.positions) return out;
  const from = cloneFrame(next.frame);
  for (const name of Object.keys(next.frame.positions)) {
    if (shared.includes(name)) continue;
    const at = from.positions[name]!;
    const chinX = at.left + (next.mark.chinX * from.width) / next.size.width;
    const chinY = at.top + (next.mark.chinY * from.height) / next.size.height;
    out[name] = { left: Math.round(chinX - (next.mark.chinX * to.width) / next.size.width), top: Math.round(chinY - (next.mark.chinY * to.height) / next.size.height) };
  }
  return out;
}

/**
 * 計算に使う差分の枠。left / center / right を書いていない枠は、描画と同じく center（無ければ (0, 0)）にあるものとして埋める
 * （cloneFrame は (0, 0) で埋めるので、そのまま合わせると左上へ寄った位置を書いてしまう）。
 */
function shownFrame(frame: CastFrame): FullFrame {
  const out = cloneFrame(frame);
  for (const name of FRAME_POSITIONS) {
    if (frame.positions?.[name]) continue;
    const at = positionOf(frame, name);
    out.positions[name] = { left: Math.round(Number(at.left) || 0), top: Math.round(Number(at.top) || 0) };
  }
  // 反転するときの軸（数でない値は描画と同じく無いものとする）
  if (typeof frame.flipAxis === "number" && Number.isFinite(frame.flipAxis)) out.flipAxis = frame.flipAxis;
  return out;
}

/** 大きさと、反転するときの軸と、どの立ち位置も同じ枠か（名前の並びは問わない）。 */
function sameFrame(a: FullFrame, b: FullFrame): boolean {
  const names = new Set([...Object.keys(a.positions), ...Object.keys(b.positions)]);
  return a.width === b.width && a.height === b.height && a.flipAxis === b.flipAxis && [...names].every((n) => a.positions[n]?.left === b.positions[n]?.left && a.positions[n]?.top === b.positions[n]?.top);
}

/** 頭基準の合わせの対象にする差分の画像（一枚絵かパーツ合成の基になる絵）。画像が無ければ null。 */
export function headImage(entry: CastEntry, appearance: string, variant: string): string | null {
  const a = entry.appearances[appearance];
  const v = a?.variants[variant];
  if (!a || !v) return null;
  return variantPreview(a, v) || null;
}

/**
 * 合わせられなかった理由。no-mark はその差分の絵の頭の測定点が無い、no-reference は基準（reference）の測定点か枠が無い
 * （実寸で出す基準など）、mismatch は測定点が画像に合わないか、基準の枠の縦横比が画像と合わない。
 */
export type HeadSkipReason = "no-mark" | "no-reference" | "mismatch";

export interface HeadAlignResult {
  /** "立ち絵セット/差分" → 新しい枠。今の枠と同じものは入れない。 */
  frames: Record<string, FullFrame>;
  /** 合わせられなかった差分と理由。reference は no-reference の基準（"立ち絵セット/差分"）。 */
  skipped: { key: string; reason: HeadSkipReason; reference?: string }[];
}

/**
 * キャラクターの全差分を頭基準に合わせた枠を求める（cast は書き換えない。書くのは applyHeadFrames）。
 * 既定の立ち絵セットの基準の差分（headReference。normal、default、最初の差分の順）は動かさない。ほかの立ち絵セットの基準の差分はそれに、
 * 各差分は同じ立ち絵セットの基準の差分に合わせる。基準と同じ絵の差分（パーツ合成の差分はどれも同じ下の絵）は、基準の（合わせ直した）枠を写す。
 * marks は画像のパス → 測定点。測定点の無い差分は動かさず skipped に入れる。
 */
export function planHeadAlign(entry: CastEntry, marks: Readonly<Record<string, HeadMark>>, sizes: Readonly<Record<string, Size>>): HeadAlignResult {
  const result: HeadAlignResult = { frames: {}, skipped: [] };
  const defaultSet = appearanceKey(entry);
  const globalKey = referenceVariantKey(entry.appearances[defaultSet]);
  const frameOf = (appearance: string, variant: string): FullFrame | null => {
    const planned = result.frames[`${appearance}/${variant}`];
    if (planned) return planned;
    const v = entry.appearances[appearance]?.variants[variant];
    return v?.frame ? shownFrame(v.frame) : null;
  };
  const measured = (appearance: string, variant: string): { image: string; size: Size; mark: HeadMark } | null => {
    const image = headImage(entry, appearance, variant);
    const size = image ? sizes[image] : undefined;
    const mark = image ? marks[image] : undefined;
    return image && size && mark ? { image, size, mark } : null;
  };
  const fit = (appearance: string, variant: string, parentAt: [string, string]): void => {
    const key = `${appearance}/${variant}`;
    const next = measured(appearance, variant);
    const parent = measured(...parentAt);
    const parentFrame = frameOf(...parentAt);
    if (!next) return void result.skipped.push({ key, reason: "no-mark" });
    if (!parent || !parentFrame) return void result.skipped.push({ key, reason: "no-reference", reference: parentAt.join("/") });
    const own = entry.appearances[appearance]?.variants[variant]?.frame;
    let frame: FullFrame | null;
    if (next.image === parent.image) {
      // 同じ絵なら、基準の枠をそのまま写す（差分にだけある立ち位置は、新しい大きさで自分の顎の位置を保つ）
      frame = structuredClone(parentFrame);
      Object.assign(frame.positions, ownPositions({ ...next, frame: own }, framePositionNames(parentFrame), frame));
    } else frame = fitFrameToHead({ frame: parentFrame, size: parent.size, mark: parent.mark }, { ...next, frame: own });
    if (!frame) return void result.skipped.push({ key, reason: "mismatch" });
    // 書いても今と変わらなければ入れない（件数に数えず、cast.json も書かない）
    if (own && sameFrame(shownFrame(own), mergedFrame(own, frame))) return;
    result.frames[key] = frame;
  };
  for (const [appearance, a] of Object.entries(entry.appearances)) {
    const ref = referenceVariantKey(a);
    if (!ref) continue;
    if (globalKey && appearance !== defaultSet) fit(appearance, ref, [defaultSet, globalKey]);
  }
  for (const [appearance, a] of Object.entries(entry.appearances)) {
    const ref = referenceVariantKey(a);
    if (!ref) continue;
    for (const variant of Object.keys(a.variants)) if (variant !== ref) fit(appearance, variant, [appearance, ref]);
  }
  return result;
}

/** 差分の今の枠に、合わせた枠を重ねたもの（applyHeadFrames が書く形。合わせた枠に無い立ち位置は今のまま残り、軸は合わせた枠のものになる）。 */
function mergedFrame(own: CastFrame | undefined, frame: FullFrame): FullFrame {
  return { width: frame.width, height: frame.height, positions: { ...shownFrame(own ?? {}).positions, ...frame.positions }, ...(frame.flipAxis !== undefined ? { flipAxis: frame.flipAxis } : {}) };
}

/**
 * planHeadAlign の枠を cast のキャラクターに書く（差分の枠を置き換える。合わせた枠に無い立ち位置は今のまま残す）。
 * 反転するときの軸は合わせた枠のものにする（合わせた枠に無ければ外し、中央で裏返す）。
 * 書く前の枠（"立ち絵セット/差分" → 枠。無かった差分は undefined）を返す（元に戻すのに使う）。
 */
export function applyHeadFrames(entry: CastEntry, frames: Readonly<Record<string, FullFrame>>): Record<string, CastFrame | undefined> {
  const before: Record<string, CastFrame | undefined> = {};
  for (const [key, frame] of Object.entries(frames)) {
    const at = key.indexOf("/");
    const v = entry.appearances[key.slice(0, at)]?.variants[key.slice(at + 1)];
    if (!v) continue;
    before[key] = v.frame ? structuredClone(v.frame) : undefined;
    const { flipAxis: _, ...rest } = v.frame ?? {};
    v.frame = { ...rest, width: frame.width, height: frame.height, positions: { ...v.frame?.positions, ...structuredClone(frame.positions) }, ...(frame.flipAxis !== undefined ? { flipAxis: frame.flipAxis } : {}) };
  }
  return before;
}

/** 頭基準の合わせの基準の差分（既定の立ち絵セットの、normal、default、最初の差分の順）。"立ち絵セット/差分"。無ければ null。 */
export function headReference(entry: CastEntry): string | null {
  const set = appearanceKey(entry);
  const key = referenceVariantKey(entry.appearances[set]);
  return key ? `${set}/${key}` : null;
}

/** cast の全キャラクターのうち、頭基準の合わせの対象になる画像（重複なし）。 */
export function headImages(entry: CastEntry): string[] {
  const out = new Set<string>();
  for (const [appearance, a] of Object.entries(entry.appearances)) for (const variant of Object.keys(a.variants)) {
    const image = headImage(entry, appearance, variant);
    if (image) out.add(image);
  }
  return [...out];
}
