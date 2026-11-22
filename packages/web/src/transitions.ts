import { RULE_PATTERNS } from "@liminalia/lang";

/**
 * 画像の出し入れの動き（@bg の method）。TyranoScript は animate.css / magic.css の同名のアニメーションで切り替える。
 * show は「In」（出てくる）、hide は対になる「Out」（消えていく）。crossfade は fadeIn と同じ。
 */
export const TRANSITION_METHODS = [
  "crossfade",
  "fadeIn",
  "fadeInLeft",
  "fadeInRight",
  "fadeInUp",
  "fadeInDown",
  "slideInLeft",
  "slideInRight",
  "slideInUp",
  "slideInDown",
  "puffIn",
  "vanishIn",
] as const;

const NONE = "translate3d(0, 0, 0)";

/** 出てくる側の、動き始めの見た目（終わりは素の見た目）。 */
function enterFrom(method: string): Keyframe {
  switch (method) {
    case "fadeInLeft":
      return { opacity: 0, transform: "translate3d(-100%, 0, 0)" };
    case "fadeInRight":
      return { opacity: 0, transform: "translate3d(100%, 0, 0)" };
    case "fadeInUp":
      return { opacity: 0, transform: "translate3d(0, 100%, 0)" };
    case "fadeInDown":
      return { opacity: 0, transform: "translate3d(0, -100%, 0)" };
    case "slideInLeft":
      return { opacity: 1, transform: "translate3d(-100%, 0, 0)" };
    case "slideInRight":
      return { opacity: 1, transform: "translate3d(100%, 0, 0)" };
    case "slideInUp":
      return { opacity: 1, transform: "translate3d(0, 100%, 0)" };
    case "slideInDown":
      return { opacity: 1, transform: "translate3d(0, -100%, 0)" };
    case "puffIn":
      return { opacity: 0, transform: "scale(2)", filter: "blur(2px)" };
    case "vanishIn":
      return { opacity: 0, transform: "scale(2)", filter: "blur(90px)" };
    default:
      return { opacity: 0, transform: NONE };
  }
}

/** 消えていく側の、動き終わりの見た目（animate.css の Out は In の逆向きではなく、進む向きに抜けていく）。 */
function exitTo(method: string): Keyframe {
  switch (method) {
    case "fadeInLeft":
      return { opacity: 0, transform: "translate3d(-100%, 0, 0)" };
    case "fadeInRight":
      return { opacity: 0, transform: "translate3d(100%, 0, 0)" };
    case "fadeInUp":
      return { opacity: 0, transform: "translate3d(0, -100%, 0)" };
    case "fadeInDown":
      return { opacity: 0, transform: "translate3d(0, 100%, 0)" };
    case "slideInLeft":
      return { opacity: 1, transform: "translate3d(-100%, 0, 0)" };
    case "slideInRight":
      return { opacity: 1, transform: "translate3d(100%, 0, 0)" };
    case "slideInUp":
      return { opacity: 1, transform: "translate3d(0, -100%, 0)" };
    case "slideInDown":
      return { opacity: 1, transform: "translate3d(0, 100%, 0)" };
    case "puffIn":
      return { opacity: 0, transform: "scale(2)", filter: "blur(2px)" };
    case "vanishIn":
      return { opacity: 0, transform: "scale(2)", filter: "blur(20px)" };
    default:
      return { opacity: 0, transform: NONE };
  }
}

/** 素の見た目（from / to のもう一方）。filter を使う動きだけ filter も戻す。 */
function rest(frame: Keyframe): Keyframe {
  const r: Keyframe = { opacity: 1, transform: frame.transform === "scale(2)" ? "scale(1)" : NONE };
  if (frame.filter !== undefined) r.filter = "blur(0)";
  return r;
}

export function transitionKeyframes(method: string, mode: "show" | "hide"): Keyframe[] {
  if (mode === "show") {
    const from = enterFrom(method);
    return [from, rest(from)];
  }
  const to = exitTo(method);
  return [rest(to), to];
}

// ---- ルール画像の切り替え（ユニバーサルトランジション） ----

/** 組み込みのルール（@liminalia/lang の RULE_PATTERNS）。 */
export type RulePattern = (typeof RULE_PATTERNS)[number];

/** ルールの濃さを割り出す細かさ（横のます目の数。マスクは引き伸ばすので、境目はなめらかになる）。 */
const RULE_COLUMNS = 320;

/** ルールの濃さ（0〜1、横 width × 縦 height。暗い 0 のところから先に切り替わる）。 */
export interface RuleLevels {
  width: number;
  height: number;
  levels: Float32Array;
}

/** 切り替える要素の縦横比に合わせた、ルールのます目の大きさ。 */
function ruleSize(el: HTMLElement): { width: number; height: number } {
  const w = el.offsetWidth || 1280;
  const h = el.offsetHeight || 720;
  return { width: RULE_COLUMNS, height: Math.max(1, Math.round((RULE_COLUMNS * h) / w)) };
}

/** ルール画像の明るさを濃さにする（要素いっぱいに引き伸ばす）。 */
export function ruleFromImage(el: HTMLElement, image: CanvasImageSource): RuleLevels {
  const { width, height } = ruleSize(el);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(image, 0, 0, width, height);
  const data = g.getImageData(0, 0, width, height).data;
  const levels = new Float32Array(width * height);
  for (let i = 0; i < levels.length; i++) levels[i] = (data[i * 4]! * 0.299 + data[i * 4 + 1]! * 0.587 + data[i * 4 + 2]! * 0.114) / 255;
  return { width, height, levels };
}

/** 組み込みのルールの濃さ。 */
export function ruleFromPattern(el: HTMLElement, pattern: RulePattern): RuleLevels {
  const { width, height } = ruleSize(el);
  const levels = new Float32Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const far = Math.hypot(cx, cy) || 1;
  // noise: 16px ほどのます目ごとに決まった順（同じ型はいつも同じ見え方）
  const cell = Math.max(1, Math.round(width / 80));
  const hash = (x: number, y: number) => {
    let n = (x * 374761393 + y * 668265263) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = width > 1 ? x / (width - 1) : 0;
      const v = height > 1 ? y / (height - 1) : 0;
      let l: number;
      switch (pattern) {
        case "wipe-left":
          l = 1 - u;
          break;
        case "wipe-right":
          l = u;
          break;
        case "wipe-up":
          l = 1 - v;
          break;
        case "wipe-down":
          l = v;
          break;
        case "circle-in":
          l = 1 - Math.hypot(x - cx, y - cy) / far;
          break;
        case "circle-out":
          l = Math.hypot(x - cx, y - cy) / far;
          break;
        case "blinds":
          l = ((y / height) * 8) % 1;
          break;
        case "blinds-vertical":
          l = ((x / width) * 12) % 1;
          break;
        case "diamond":
          l = (Math.abs(x - cx) / (cx || 1) + Math.abs(y - cy) / (cy || 1)) / 2;
          break;
        case "noise":
          l = hash(Math.floor(x / cell), Math.floor(y / cell));
          break;
      }
      levels[y * width + x] = Math.min(1, Math.max(0, l));
    }
  }
  return { width, height, levels };
}

/**
 * ルールで要素を出す（show）・消す（hide）。濃さの暗いところから順に、ms かけて切り替える。vague（0〜255）は境目のぼかしの幅。
 * 要素にマスク（mask-image）をかけて動かし、終わったら外す（hide なら終わりは見えない状態のまま opacity 0 にする）。
 * fastForward を渡すと、クリックで演出を早送りしたときに終わりの姿まで飛ぶ（DomHost の早送りの口）。
 */
export function ruleTransition(el: HTMLElement, rule: RuleLevels, ms: number, mode: "show" | "hide", vague = 64, fastForward?: (finish: () => void) => () => void): Promise<void> {
  const style = el.style as CSSStyleDeclaration & { webkitMaskImage: string; webkitMaskSize: string };
  const clear = () => {
    style.maskImage = "";
    style.webkitMaskImage = "";
    style.maskSize = "";
    style.webkitMaskSize = "";
  };
  if (ms <= 0) {
    clear();
    if (mode === "hide") el.style.opacity = "0";
    return Promise.resolve();
  }
  const { width, height, levels } = rule;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  const image = g.createImageData(width, height);
  const soft = Math.max(1, vague) / 255;
  const draw = (p: number) => {
    const edge = p * (1 + soft);
    for (let i = 0; i < levels.length; i++) {
      const a = Math.min(1, Math.max(0, (edge - levels[i]!) / soft));
      image.data[i * 4 + 3] = Math.round((mode === "show" ? a : 1 - a) * 255);
    }
    g.putImageData(image, 0, 0);
    const url = `url(${canvas.toDataURL()})`;
    style.maskImage = url;
    style.webkitMaskImage = url;
  };
  style.maskSize = "100% 100%";
  style.webkitMaskSize = "100% 100%";
  draw(0);
  el.style.opacity = "1";
  return new Promise((resolve) => {
    const start = performance.now();
    // クリックで早送りしたら、次の描画で終わりの姿にする
    let skipped = false;
    const off = fastForward?.(() => (skipped = true));
    const step = (now: number) => {
      const p = skipped ? 1 : Math.min(1, (now - start) / ms);
      if (p >= 1 || !el.isConnected) {
        off?.();
        clear();
        if (mode === "hide") el.style.opacity = "0";
        resolve();
        return;
      }
      draw(p);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
