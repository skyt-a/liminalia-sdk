import { estimateFace, estimateHead, resolveVariant, type Cast, type CHOICE_POSITIONS } from "@liminalia/lang";
import type { StageState } from "@liminalia/runtime";

/**
 * 選択肢の置き方（ui.choice.position）。center は CSS のまま（縦の中央）で、ほかはボタンを並べたあとに選択肢の層を縦にずらす。
 * - top: 舞台の上の端から少し下
 * - bottom: メッセージ枠のすぐ上（枠が見えなければ舞台の下の端から少し上）
 * - avoid-faces: 中央のボタンの並びが立ち絵の顔に重なるときだけ、重ならないいちばん近い高さへ（収まらなければ重なりのいちばん少ない高さ）
 * ずらす量は層の座標（px）で書くので、窓の大きさが変わってもそのまま合う。顔の範囲は cast.json の立ち絵セットの face（顔ウィンドウの切り出し）、
 * 無ければ立ち絵の絵の肌と輪郭から推し量る（face-fit.ts、head-fit.ts。頭頂から顎のうち、髪を除いた額から下）。読めない絵は上の 35% の真ん中を顔とみなす。
 */

export type ChoicePosition = (typeof CHOICE_POSITIONS)[number];

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ChoicePlaceInput {
  position: ChoicePosition;
  stage: HTMLElement;
  /** 選択肢の層（ボタンを並べたあと）。 */
  choices: HTMLElement;
  message: HTMLElement;
  /** 出ている立ち絵（キャスト名と要素）。 */
  sprites: Iterable<{ who: string; el: HTMLElement }>;
  cast: Cast;
  state: StageState | null;
}

/** 舞台の端との間と、メッセージ枠や顔との間（舞台の px）。 */
const EDGE = 24;
const GAP = 12;
const FACE_MARGIN = 8;

/** 選択肢の層を置き方に合わせてずらす（center なら何もしない）。ずらしたら data-lm-choice-place に置き方を書く。 */
export function placeChoices(o: ChoicePlaceInput): void {
  const { choices } = o;
  resetChoicePlace(choices);
  if (o.position === "center") return;
  const items = [...choices.children].filter((e): e is HTMLElement => e instanceof HTMLElement);
  const buttons = items.filter((e) => e.tagName === "BUTTON");
  // 作品が位置を決めたボタン（x= か y=）があれば動かさない
  if (buttons.length === 0 || buttons.some((b) => b.style.position === "absolute")) return;
  const rects = items.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return;
  const block: Box = { left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)), right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)) };
  const height = block.bottom - block.top;
  const stage = o.stage.getBoundingClientRect();
  // 画面の px ÷ 舞台の px（舞台の拡大と縮小）と、層の拡大と縮小（基準の大きさと違う作品の zoom）
  const unit = stage.height / (o.stage.offsetHeight || stage.height);
  const zoom = Number.parseFloat(getComputedStyle(choices).getPropertyValue("zoom")) || 1;
  const top = stage.top + EDGE * unit;
  let bottom = stage.bottom - EDGE * unit;
  const message = messageBox(o.message, block, stage);
  if (message) bottom = Math.min(bottom, message.top - GAP * unit);
  if (bottom - top < height) return;
  let y = block.top;
  if (o.position === "top") y = top;
  else if (o.position === "bottom") y = bottom - height;
  else {
    const faces = faceBoxes(o).map((f) => grow(f, FACE_MARGIN * unit));
    const overlap = (at: number) => faces.reduce((sum, f) => sum + area(f, { left: block.left, right: block.right, top: at, bottom: at + height }), 0);
    if (overlap(block.top) === 0) return;
    // 重なりの少ない高さのうち、もとの位置にいちばん近いもの
    let best = block.top;
    let cost = overlap(block.top) * 1e6;
    const step = Math.max(1, 2 * unit);
    for (let at = top; at <= bottom - height + 0.01; at += step) {
      const c = overlap(at) * 1e6 + Math.abs(at - block.top);
      if (c < cost) [best, cost] = [at, c];
    }
    y = best;
  }
  const shift = (y - block.top) / (unit * zoom);
  if (Math.abs(shift) < 0.5) return;
  choices.style.translate = `0 ${Math.round(shift)}px`;
  choices.dataset.lmChoicePlace = o.position;
}

/** ずらしたのを戻す（選択肢を消したとき）。 */
export function resetChoicePlace(choices: HTMLElement): void {
  choices.style.translate = "";
  delete choices.dataset.lmChoicePlace;
}

/** ボタンの並びの下にかかるメッセージ枠（下半分にあり、横に重なるもの）。見えなければ null。 */
function messageBox(message: HTMLElement, block: Box, stage: DOMRect): DOMRect | null {
  if (["nvl", "balloon", "vertical"].some((c) => message.classList.contains(c))) return null;
  const r = message.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const style = getComputedStyle(message);
  if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity) === 0) return null;
  if (r.top < (stage.top + stage.bottom) / 2 || r.right <= block.left || r.left >= block.right) return null;
  return r;
}

/** 出ている立ち絵の顔の範囲（画面の座標）。 */
export function faceBoxes(o: Pick<ChoicePlaceInput, "sprites" | "cast" | "state">): Box[] {
  const out: Box[] = [];
  for (const { who, el } of o.sprites) {
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const img = [...el.querySelectorAll<HTMLImageElement>(":scope > img")].at(-1);
    const face = castFace(o, who, img) ?? (img ? estimated(img) : null) ?? FALLBACK;
    const flip = img?.style.transform.includes("scaleX(-1)") === true;
    // 反転した立ち絵は、裏返す軸（cast.json の frame の flipAxis。書かなければ中央）で顔を鏡に映す
    const axis = flip ? spriteFlipAxis(img) : 0.5;
    const left = flip ? 2 * axis - face.right : face.left;
    const right = flip ? 2 * axis - face.left : face.right;
    out.push({ left: box.left + left * box.width, right: box.left + right * box.width, top: box.top + face.top * box.height, bottom: box.top + face.bottom * box.height });
  }
  return out;
}

/** 反転した立ち絵の絵が裏返る軸の、枠の幅に対する割合（描画が書いた変形の起点の横。書いていなければ 0.5）。 */
function spriteFlipAxis(img: HTMLImageElement | undefined): number {
  const x = (img?.style.transformOrigin ?? "").trim().split(/\s+/)[0] ?? "";
  const n = Number.parseFloat(x);
  return x.endsWith("%") && Number.isFinite(n) ? n / 100 : 0.5;
}

/** 推し量った頭のうち、顔とみなす上の端（頭頂から顎までの割合。上は髪）。 */
const FOREHEAD = 0.35;

/** 推し量れないときの顔（絵の幅と高さに対する割合）。 */
const FALLBACK: Box = { left: 0.25, right: 0.75, top: 0, bottom: 0.35 };

/** cast.json の立ち絵セットの face（顔ウィンドウに切り出す範囲。絵の px）を割合にしたもの。 */
function castFace(o: Pick<ChoicePlaceInput, "cast" | "state">, who: string, img: HTMLImageElement | undefined): Box | null {
  const entry = o.cast[who];
  const sprite = o.state?.sprites[who];
  if (!entry || !sprite || !img || img.naturalWidth <= 0 || img.naturalHeight <= 0) return null;
  const { appearance } = resolveVariant(entry, sprite.appearance, sprite.variant);
  const face = entry.appearances[appearance]?.face;
  if (!face) return null;
  return { left: face.x / img.naturalWidth, right: (face.x + face.width) / img.naturalWidth, top: face.y / img.naturalHeight, bottom: (face.y + face.height) / img.naturalHeight };
}

/** 絵から推し量った顔（同じ絵は一度だけ数える）。 */
const estimates = new Map<string, Box | null>();
function estimated(img: HTMLImageElement): Box | null {
  if (!img.complete || img.naturalWidth <= 0) return null;
  if (estimates.has(img.src)) return estimates.get(img.src)!;
  let found: Box | null = null;
  try {
    const scale = Math.min(1, 320 / img.naturalWidth);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, w, h);
    const data = g.getImageData(0, 0, w, h).data;
    const mark = estimateFace(data, w, h) ?? estimateHead(data, w, h);
    if (mark) {
      // 頭頂から顎までのうち、上の髪を除いた額から顎（顎は少し短めに出るので、頭の高さの 5% だけ下へ）
      const head = mark.chinY - mark.top;
      found = { left: (mark.chinX - mark.width / 2) / w, right: (mark.chinX + mark.width / 2) / w, top: (mark.top + head * FOREHEAD) / h, bottom: (mark.chinY + head * 0.05) / h };
    }
  } catch {
    // 別のオリジンの絵などで読めなければ、目安のまま
  }
  estimates.set(img.src, found);
  return found;
}

function grow(b: Box, d: number): Box {
  return { left: b.left - d, top: b.top - d, right: b.right + d, bottom: b.bottom + d };
}

function area(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}
