/**
 * セーブ一覧の縮小画像。舞台のうち絵の部分（カメラの内側と画面効果の層にある <img>・<canvas>・<video>、
 * 塗りつぶしの背景、暗転の幕）を、表示されている位置と不透明度のまま縮小して描く。メッセージ枠やシステム画面は描かない。
 * 立ち絵の左右の反転（transform）と、色調（@tone の SVG の色の行列）や話していない人物を暗くするなどの CSS の filter も写す。
 * 本文を吹き出しで出す作品（ui.chat.dialogue）は、背景を覆う画面の地と吹き出しの形も描く（文字は描かない）。
 * 素材は同じオリジンから読んでいるので、キャンバスは汚れず data URL にできる。外部ライブラリは使わない。
 */
export const THUMB_WIDTH = 256;
export const THUMB_HEIGHT = 144;

export function captureThumbnail(stage: HTMLElement): string {
  // 舞台の縦横比のまま。16:9 でない作品は長い辺を THUMB_WIDTH にする
  const w = stage.offsetWidth;
  const h = stage.offsetHeight;
  if (!w || !h || Math.abs(w / h - THUMB_WIDTH / THUMB_HEIGHT) < 0.01) return captureStage(stage, THUMB_WIDTH, THUMB_HEIGHT, "image/jpeg");
  const scale = THUMB_WIDTH / Math.max(w, h);
  return captureStage(stage, Math.round(w * scale), Math.round(h * scale), "image/jpeg");
}

/** 舞台の絵の部分を、決めた大きさで描いて data URL にする（スクリーンショットはこれを舞台の大きさで）。 */
export function captureStage(stage: HTMLElement, width: number, height: number, type = "image/png"): string {
  const box = stage.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return "";
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (!g) return "";
  g.fillStyle = "#000";
  g.fillRect(0, 0, width, height);
  const sx = width / box.width;
  const sy = height / box.height;
  // screen が既定の大きさの作品は --stage-w を書かない。そのときは今までどおり、絵を枠いっぱいに描く
  const fitsCover = stage.style.getPropertyValue("--stage-w") !== "";

  // 文書の順（＝重なりの下から順）に描く
  for (const el of stage.querySelectorAll<HTMLElement>(".camera *, .fx *, .mask, .lim-chat.is-dialogue, .lim-chat.is-dialogue .lim-chat-bubble")) {
    const isMedia = el instanceof HTMLImageElement || el instanceof HTMLCanvasElement || el instanceof HTMLVideoElement;
    const filled = el.classList.contains("fill") || el.classList.contains("mask") || el.classList.contains("lim-chat") || el.classList.contains("lim-chat-bubble");
    const fill = !isMedia && filled ? getComputedStyle(el).backgroundColor : "";
    if (!isMedia && !fill) continue;
    if (el instanceof HTMLImageElement && (!el.complete || el.naturalWidth === 0)) continue;
    const alpha = opacityOf(el, stage);
    if (alpha <= 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    g.globalAlpha = alpha;
    const x = (r.left - box.left) * sx;
    const y = (r.top - box.top) * sy;
    try {
      const crop = fitsCover && el instanceof HTMLImageElement ? coverCrop(el, r.width / r.height) : null;
      const look = isMedia ? lookOf(el, stage) : null;
      if (look && (look.flipX || look.flipY || look.css || look.matrices.length > 0)) {
        const shot = drawWithLook(el as CanvasImageSource, crop, Math.max(1, Math.round(r.width * sx)), Math.max(1, Math.round(r.height * sy)), look);
        if (shot) g.drawImage(shot, x, y, r.width * sx, r.height * sy);
      } else if (crop) {
        g.drawImage(el as HTMLImageElement, crop.x, crop.y, crop.width, crop.height, x, y, r.width * sx, r.height * sy);
      } else if (isMedia) {
        g.drawImage(el as CanvasImageSource, x, y, r.width * sx, r.height * sy);
      } else {
        g.fillStyle = fill;
        g.fillRect(x, y, r.width * sx, r.height * sy);
      }
    } catch {
      // 描けない要素（読み込み途中の動画など）は飛ばす
    }
  }
  g.globalAlpha = 1;
  try {
    return canvas.toDataURL(type, 0.8);
  } catch {
    return "";
  }
}

/** object-fit: cover の絵のうち見えている範囲（元の画像の px）。切り抜いていない絵は null。焦点は object-position の割合。 */
function coverCrop(img: HTMLImageElement, boxRatio: number): { x: number; y: number; width: number; height: number } | null {
  const s = getComputedStyle(img);
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (s.objectFit !== "cover" || Math.abs(nw / nh - boxRatio) < 0.001) return null;
  const width = Math.min(nw, nh * boxRatio);
  const height = Math.min(nh, nw / boxRatio);
  const [fx = 50, fy = 50] = s.objectPosition.split(" ").map((v) => (v.endsWith("%") ? parseFloat(v) : 50));
  return { x: ((nw - width) * fx) / 100, y: ((nh - height) * fy) / 100, width, height };
}

/** 絵の見え方（左右・上下の反転、CSS の filter、SVG の色の行列）。 */
interface Look {
  flipX: boolean;
  flipY: boolean;
  /** url() を除いた CSS の filter（ctx.filter に渡す）。無ければ ""。 */
  css: string;
  /** url(#…) の SVG の feColorMatrix（type="matrix" の 20 の数。外側のものほど後）。 */
  matrices: number[][];
}

/** 要素から舞台までの transform の反転と filter を集める（回転は見ない。位置と大きさは getBoundingClientRect が持っている）。 */
function lookOf(el: Element, stage: Element): Look {
  let a = 1;
  let d = 1;
  const css: string[] = [];
  const matrices: number[][] = [];
  for (let e: Element | null = el; e && e !== stage; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (s.transform && s.transform !== "none") {
      try {
        const m = new DOMMatrixReadOnly(s.transform);
        if (Math.abs(m.b) < 1e-6 && Math.abs(m.c) < 1e-6) {
          a *= Math.sign(m.a) || 1;
          d *= Math.sign(m.d) || 1;
        }
      } catch {
        // 読めない変形は見ない
      }
    }
    if (s.filter && s.filter !== "none") {
      const own: string[] = [];
      for (const part of s.filter.match(/url\([^)]*\)|[a-z-]+\([^()]*(?:\([^()]*\)[^()]*)*\)/g) ?? []) {
        if (part.startsWith("url(")) {
          const id = /#([^"')]+)/.exec(part)?.[1];
          const node = id ? stage.ownerDocument.getElementById(id)?.querySelector("feColorMatrix") : null;
          const values = node?.getAttribute("type") === "matrix" ? (node.getAttribute("values") ?? "").trim().split(/[\s,]+/).map(Number) : [];
          if (values.length === 20 && values.every(Number.isFinite)) matrices.push(values);
        } else own.push(part);
      }
      // 内側の filter が先に効く
      css.push(...own);
    }
  }
  return { flipX: a < 0, flipY: d < 0, css: css.join(" "), matrices };
}

/** 絵を見え方のとおりに、width × height のキャンバスへ描く。 */
function drawWithLook(source: CanvasImageSource, crop: { x: number; y: number; width: number; height: number } | null, width: number, height: number, look: Look): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d", { willReadFrequently: look.matrices.length > 0 });
  if (!g) return null;
  g.setTransform(look.flipX ? -1 : 1, 0, 0, look.flipY ? -1 : 1, look.flipX ? width : 0, look.flipY ? height : 0);
  if (look.css && "filter" in g) g.filter = look.css;
  if (crop) g.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  else g.drawImage(source, 0, 0, width, height);
  if (look.matrices.length > 0) {
    const image = g.getImageData(0, 0, width, height);
    for (const m of look.matrices) applyColorMatrix(image.data, m);
    g.putImageData(image, 0, 0);
  }
  return canvas;
}

/** feColorMatrix（type="matrix"）を、乗算済みでない RGBA に掛ける（color-interpolation-filters は sRGB）。 */
export function applyColorMatrix(px: Uint8ClampedArray, m: readonly number[]): void {
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]! / 255;
    const gr = px[i + 1]! / 255;
    const b = px[i + 2]! / 255;
    const a = px[i + 3]! / 255;
    px[i] = (m[0]! * r + m[1]! * gr + m[2]! * b + m[3]! * a + m[4]!) * 255;
    px[i + 1] = (m[5]! * r + m[6]! * gr + m[7]! * b + m[8]! * a + m[9]!) * 255;
    px[i + 2] = (m[10]! * r + m[11]! * gr + m[12]! * b + m[13]! * a + m[14]!) * 255;
    px[i + 3] = (m[15]! * r + m[16]! * gr + m[17]! * b + m[18]! * a + m[19]!) * 255;
  }
}

/** 要素から舞台までの不透明度の積。どこかが表示されていなければ 0。 */
function opacityOf(el: Element, stage: Element): number {
  let a = 1;
  for (let e: Element | null = el; e && e !== stage; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (s.display === "none" || s.visibility === "hidden") return 0;
    a *= Number(s.opacity);
  }
  return a;
}
