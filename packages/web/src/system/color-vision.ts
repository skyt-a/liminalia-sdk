/**
 * 色覚の補正（コンフィグの「色覚の補正」）。見分けにくい色の差を、見分けやすい色の差へ移す（daltonize）。
 * 色覚の型ごとの見え方の行列（Machado ほか 2009、強さ 1.0）S で失われる差 (I − S) を、ほかの色の向きへ E で足す: M = I + E(I − S)。
 * 舞台全体に SVG の feColorMatrix でかける（文字・枠・システム画面も含めて同じに見えるように）。
 * かけている間は舞台に lm-color-vision を付け、舞台の中のキャンバスを別の層にする（default.css）。WebKit は SVG のフィルタをかけた要素の中で
 * キャンバスが描き変わるたびに、その要素の絵をすべて描き直してフィルタをかけ直すので、粒子や砂嵐のように毎コマ描くものがあるとコマが落ちる
 * （高解像度の画面で 100 コマ/秒が 23〜40 コマ/秒）。別の層にしても行列は同じにかかる。
 */

export const COLOR_VISIONS = ["protan", "deutan", "tritan"] as const;
export type ColorVision = (typeof COLOR_VISIONS)[number];

type M3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

const SIMULATE: Record<ColorVision, M3> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** 失われる差を移す向き（赤・緑の差は緑と青へ、青・黄の差は赤と緑へ）。 */
const SHIFT: Record<ColorVision, M3> = {
  protan: [
    [0, 0, 0],
    [0.7, 1, 0],
    [0.7, 0, 1],
  ],
  deutan: [
    [1, 0.7, 0],
    [0, 0, 0],
    [0, 0.7, 1],
  ],
  tritan: [
    [1, 0, 0.7],
    [0, 1, 0.7],
    [0, 0, 0],
  ],
};

/** 補正の行列（feColorMatrix の values の 20 個）。 */
export function colorVisionMatrix(kind: ColorVision): number[] {
  const s = SIMULATE[kind];
  const e = SHIFT[kind];
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    const row = [0, 1, 2].map((c) => (r === c ? 1 : 0) + [0, 1, 2].reduce((sum, k) => sum + e[r]![k]! * ((k === c ? 1 : 0) - s[k]![c]!), 0));
    out.push(...row, 0, 0);
  }
  out.push(0, 0, 0, 1, 0);
  return out;
}

let defs: SVGSVGElement | null = null;

/** 舞台に補正をかける（"" で外す）。 */
export function applyColorVision(stage: HTMLElement, kind: string): void {
  if (!(COLOR_VISIONS as readonly string[]).includes(kind)) {
    stage.style.removeProperty("--lm-color-vision");
    stage.classList.remove("lm-color-vision");
    return;
  }
  const ns = "http://www.w3.org/2000/svg";
  if (!defs?.isConnected) {
    defs = document.createElementNS(ns, "svg");
    defs.setAttribute("aria-hidden", "true");
    Object.assign(defs.style, { position: "absolute", width: "0", height: "0", overflow: "hidden" });
    document.body.append(defs);
  }
  const id = `lm-color-vision-${kind}`;
  if (!defs.querySelector(`#${id}`)) {
    const filter = document.createElementNS(ns, "filter");
    filter.id = id;
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const m = document.createElementNS(ns, "feColorMatrix");
    m.setAttribute("type", "matrix");
    m.setAttribute("values", colorVisionMatrix(kind as ColorVision).map((v) => v.toFixed(5)).join(" "));
    filter.append(m);
    defs.append(filter);
  }
  stage.style.setProperty("--lm-color-vision", `url(#${id})`);
  stage.classList.add("lm-color-vision");
}
