/**
 * ゲームの画面の見本を開き終えたときの確かめ（run.ts が ready を出す前と、lim shot --screen が撮る直前に呼ぶ）。
 * 画面そのものが見えているかを、DOM と重なりの順で確かめる。見つけたことを文で返す（何も無ければ空）。
 *
 * - 画面の要素が無い、見えない（大きさが無い、visibility: hidden、ほぼ透明）
 * - 画面の上を、舞台のほとんどを覆うもの（ロードの幕、全画面の演出の層など）が覆っている。
 *   押せない層（pointer-events: none）も数えるため、確かめる間だけすべてを押せるようにして重なりを読む。
 *   塗りの無い層（透明なシステム画面の層など）と、画面の中のものと、画面を含むものは覆うものに数えない
 * - 中身の入った状態（filled、long）なのに、画面に文字も絵も無い
 *
 * 画面の要素が分からないとき（プラグインが差し替えた、開いた画面の印の無い画面）は、要素と覆うものは確かめない。
 */

export interface InspectTarget {
  /** 画面の要素のセレクタ（無ければ確かめない）。 */
  selector: string | null;
  /** 中身の入った状態か（empty でない）。 */
  filled: boolean;
}

/** 舞台のこの割合より広く覆うものを「覆うもの」とする。 */
const COVER_AREA = 0.85;
/** これより薄いものは見えないものとする。 */
const FAINT = 0.05;
/** 覆うものとして数える濃さ（重ねた不透明度。消えかけの幕も数える）。 */
const COVER_OPACITY = 0.05;

/** 先祖まで重ねた不透明度。 */
function opacityOf(el: Element): number {
  let o = 1;
  for (let e: Element | null = el; e; e = e.parentElement) o *= Number.parseFloat(getComputedStyle(e).opacity || "1");
  return o;
}

/** 色の不透明度（rgba(…) の a。読めなければ 1）。 */
function alphaOf(color: string): number {
  if (color === "transparent") return 0;
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (!m) return 1;
  const parts = m[1]!.split(/[ ,/]+/).filter(Boolean);
  if (parts.length < 4) return 1;
  const a = parts[3]!;
  return a.endsWith("%") ? Number.parseFloat(a) / 100 : Number.parseFloat(a);
}

/** 面を塗っているか（背景の色か絵、絵や動画そのもの）。 */
function paints(el: Element): boolean {
  if (/^(IMG|CANVAS|VIDEO|SVG|IFRAME|PICTURE)$/i.test(el.tagName)) return true;
  const s = getComputedStyle(el);
  return alphaOf(s.backgroundColor) >= 0.5 || (s.backgroundImage !== "" && s.backgroundImage !== "none");
}

/** 要素の説明（タグとクラス）。 */
function describe(el: Element): string {
  const classes = [...el.classList].slice(0, 3).map((c) => `.${c}`).join("");
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${classes}`;
}

/** 見えている要素か（大きさがあり、隠れておらず、透明でない）。 */
function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false;
  if (getComputedStyle(el).visibility === "hidden") return false;
  return opacityOf(el) > FAINT;
}

/** 開いた画面の確かめ。見つけたことの文（日本語）を返す。 */
export function inspectScreen(stage: HTMLElement, t: InspectTarget): string[] {
  // 窓に大きさが無い（隠れた iframe など）ときは確かめられない
  if (innerWidth < 1 || innerHeight < 1 || !t.selector) return [];
  const found: string[] = [];
  const all = [...document.querySelectorAll(t.selector)];
  const target = all.find(visible) ?? null;
  if (all.length === 0) return [`画面の要素（${t.selector}）がありません`];
  if (!target) return [`画面の要素（${t.selector}）が見えません（大きさが無いか、隠れているか、透明です）`];

  // 画面の上を覆うもの
  const stageRect = stage.getBoundingClientRect();
  const stageArea = Math.max(1, stageRect.width * stageRect.height);
  const box = target.getBoundingClientRect();
  const left = Math.max(box.left, 0);
  const top = Math.max(box.top, 0);
  const right = Math.min(box.right, innerWidth);
  const bottom = Math.min(box.bottom, innerHeight);
  const points: [number, number][] = [
    [(left + right) / 2, (top + bottom) / 2],
    [left + (right - left) * 0.25, top + (bottom - top) * 0.25],
    [left + (right - left) * 0.75, top + (bottom - top) * 0.25],
    [left + (right - left) * 0.25, top + (bottom - top) * 0.75],
    [left + (right - left) * 0.75, top + (bottom - top) * 0.75],
  ];
  const pointable = document.createElement("style");
  pointable.textContent = "*, *::before, *::after { pointer-events: auto !important; }";
  document.head.append(pointable);
  const covers = new Map<Element, number>();
  try {
    for (const [x, y] of points) {
      for (const el of document.elementsFromPoint(x, y)) {
        // 画面の中のもの、画面を含むもの（画面より下）まで来たら、そこから下は覆うものではない
        if (target.contains(el) || el.contains(target)) break;
        const r = el.getBoundingClientRect();
        const w = Math.max(0, Math.min(r.right, stageRect.right) - Math.max(r.left, stageRect.left));
        const h = Math.max(0, Math.min(r.bottom, stageRect.bottom) - Math.max(r.top, stageRect.top));
        if ((w * h) / stageArea < COVER_AREA) continue;
        if (!paints(el) || opacityOf(el) < COVER_OPACITY) continue;
        covers.set(el, (covers.get(el) ?? 0) + 1);
      }
    }
  } finally {
    pointable.remove();
  }
  for (const [el, hits] of covers) if (hits >= 2) found.push(`画面の上を ${describe(el)} が覆っています（ロードの幕や全画面の演出の層が残っています）`);

  // 中身の入った状態なのに、文字も絵も無い
  if (t.filled && found.length === 0) {
    const text = (target.textContent ?? "").trim();
    const media = target.querySelector("img, svg, canvas, video, picture") || [target, ...target.querySelectorAll("*")].some((e) => {
      const bg = getComputedStyle(e).backgroundImage;
      return bg !== "" && bg !== "none";
    });
    if (text === "" && !media) found.push(`画面（${t.selector}）に作り物の中身が出ていません（文字も絵もありません）`);
  }
  return found;
}
