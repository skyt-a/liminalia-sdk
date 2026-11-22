import { backingScale } from "./pixels.ts";

/**
 * WebGL でかける画面効果（radial-blur・zoom-blur・mosaic・ripple と、作品の自前のシェーダー）。
 * かける要素（画面全体ならカメラ、ほかはレイヤー）の中の絵（<img>・<canvas>・<video>・塗りつぶし）を一枚に描き写し、
 * それをシェーダーに通した結果を、その要素のいちばん上に置いたキャンバスに出す。元の絵は見えなくする（描き写しには使う）。
 * 範囲を決めたとき（mask）は、元の絵に範囲の外だけ見せるマスクを掛け、キャンバスは要素のすぐ後ろに重ねて範囲の中だけ見せる。
 * 描き写すのは位置・大きさ・不透明度・CSS のフィルタまでで、回転などの変形は写らない。
 * 描き写してテクスチャに上げるのは重い（WebKit は一回ごとに画素を読み戻す）ので、写すもの（どの絵を、どこに、どの濃さで）が
 * 前のコマと同じなら写し直さない。中身の変わるもの（キャンバス、動きのある SVG の画像、SVG かどうかを調べている途中の画像）が
 * あるときと、動画の時刻が進んだときだけ毎コマ写す。GIF・APNG・動く WebP は、drawImage が一コマ目を写す（HTML の決まり）ので止まった絵と同じ。
 * シェーダーを描き直すのも、絵か強さか大きさが変わったときと、時間（u_time）を使うシェーダーの時間が進んだときだけ。
 */

/** シェーダーに渡すもの（自前のシェーダーもこの名前で受け取る）。 */
export const SHADER_HEADER = `precision mediump float;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_strength;
uniform vec2 u_center;
varying vec2 v_uv;
`;

const VERTEX = `attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/** 組み込みの効果の本体（SHADER_HEADER の後ろに付ける）。u_strength は種類ごとの単位（下の説明）。 */
export const BUILTIN_SHADERS: Record<string, string> = {
  // 回転のぼかし: 中心のまわりに u_strength 度ぶん回した位置を重ねる
  "radial-blur": `void main() {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 d = v_uv - u_center;
  d.x *= aspect;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    float a = radians(u_strength) * (float(i) / 23.0 - 0.5);
    vec2 r = vec2(d.x * cos(a) - d.y * sin(a), d.x * sin(a) + d.y * cos(a));
    r.x /= aspect;
    acc += texture2D(u_texture, u_center + r);
  }
  gl_FragColor = acc / 24.0;
}`,
  // ズームのぼかし: 中心へ向かって u_strength % まで縮めた位置を重ねる
  "zoom-blur": `void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    float s = 1.0 - u_strength * 0.01 * float(i) / 23.0;
    acc += texture2D(u_texture, u_center + (v_uv - u_center) * s);
  }
  gl_FragColor = acc / 24.0;
}`,
  // モザイク: u_strength px の升目ごとに真ん中の色
  mosaic: `void main() {
  vec2 cell = vec2(max(u_strength, 1.0)) / u_resolution;
  gl_FragColor = texture2D(u_texture, (floor(v_uv / cell) + 0.5) * cell);
}`,
  // 波紋: 中心から広がる輪で、u_strength px だけ外へずらす
  ripple: `void main() {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 d = v_uv - u_center;
  d.x *= aspect;
  float r = length(d);
  float w = sin(r * 48.0 - u_time * 6.0) * (u_strength / u_resolution.y) * smoothstep(1.2, 0.0, r);
  vec2 off = r > 0.0 ? d / r * w : vec2(0.0);
  off.x /= aspect;
  gl_FragColor = texture2D(u_texture, v_uv + off);
}`,
};

/** 自前のシェーダーの元を整える（precision や決まった uniform が無ければ足す）。 */
export function shaderSource(body: string): string {
  const missing = SHADER_HEADER.split("\n").filter((line) => {
    const name = /(\w+);$/.exec(line)?.[1];
    if (line.startsWith("precision")) return !/precision\s+\w+\s+float/.test(body);
    return name !== undefined && !new RegExp(`\\b${name}\\b\\s*;`).test(body.replace(/\/\/.*$/gm, ""));
  });
  return `${missing.join("\n")}\n${body}`;
}

export interface GlPass {
  /** 一コマ描く（t は秒）。 */
  render(t: number): void;
  /** 強さ（u_strength）を替える（@effect fade= の出し入れ）。 */
  setStrength(strength: number): void;
  dispose(): void;
}

/**
 * root の中の絵をシェーダーに通して出す。values は自前のシェーダーの uniform float（名前 → 値）。
 * WebGL が使えないかシェーダーを組めなければ null（元の絵のまま）。
 */
export function createGlPass(
  root: HTMLElement,
  fragment: string,
  o: { strength: number; center: [number, number]; values?: Record<string, number>; speed: number; mask?: { inside: string; outside: string } },
): GlPass | null {
  const canvas = document.createElement("canvas");
  canvas.className = "lim-gl-effect";
  Object.assign(canvas.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", pointerEvents: "none", visibility: "visible" });
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn(`シェーダーを組めません: ${gl.getShaderInfoLog(s) ?? ""}`);
      return null;
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl.FRAGMENT_SHADER, fragment);
  if (!vs || !fs) return null;
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn(`シェーダーを組めません: ${gl.getProgramInfoLog(program) ?? ""}`);
    return null;
  }
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  for (const [k, v] of [
    [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
    [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  ] as const)
    gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  const u = (name: string) => gl.getUniformLocation(program, name);
  const uTime = u("u_time");
  const uResolution = u("u_resolution");
  gl.uniform1i(u("u_texture"), 0);
  const uStrength = u("u_strength");
  gl.uniform1f(uStrength, o.strength);
  // 中心は左上からの %（GL は左下から）
  gl.uniform2f(u("u_center"), o.center[0] / 100, 1 - o.center[1] / 100);
  for (const [name, value] of Object.entries(o.values ?? {})) gl.uniform1f(u(name), value);

  const source = document.createElement("canvas");
  const g = source.getContext("2d");
  if (!g) return null;
  const mask = o.mask;
  if (mask) {
    // 範囲だけにかける: 範囲の中はシェーダーの絵、外は元の絵（縁は元の絵の上にシェーダーの絵を薄く重ねる）。
    // root に「シェーダーの絵が覆いきる所を隠す」マスクを掛けるので、キャンバスは root の中に置かない（中に置くと、範囲の中でキャンバスも消えて黒く抜ける）。
    // root のすぐ後ろに置き、毎コマ root の箱・変形・不透明度・フィルタ・重なり順に合わせる（follow）
    Object.assign(canvas.style, { maskImage: mask.inside, webkitMaskImage: mask.inside, visibility: "" });
    Object.assign(root.style, { maskImage: mask.outside, webkitMaskImage: mask.outside });
    root.after(canvas);
  } else {
    root.append(canvas);
    // 元の絵を見えなくする（同じ要素に二つかけたら、両方を外すまで）
    root.dataset.glPasses = String(Number(root.dataset.glPasses ?? 0) + 1);
    root.style.visibility = "hidden";
  }

  let scale = 1;
  let recheck = 0;
  let lastWidth = 0;
  // 時間を使わないシェーダー（モザイクなど）は、時間が進んでも描き直さない（宣言の行のほかに u_time が無いもの）
  const usesTime = /\bu_time\b/.test(fragment.replace(/uniform\s+float\s+u_time\s*;/g, ""));
  /** 前に写したもの（plan の key。null は写していない）と、前に描いたときの時間と大きさ。 */
  let captured: string | null = null;
  let drawnTime = Number.NaN;
  let drawnSize = "";
  /** 強さを替えたので描き直す。 */
  let restyled = true;
  return {
    render(t) {
      const width = root.offsetWidth;
      const height = root.offsetHeight;
      if (width === 0 || height === 0) return;
      // 描く細かさは表示される大きさに合わせる（高解像度の画面でぼやけない）。u_resolution はゲーム画面の px のまま（効果の強さの単位）
      if (--recheck <= 0 || width !== lastWidth) {
        recheck = 30;
        lastWidth = width;
        scale = backingScale(root, width);
      }
      if (mask) follow(root, canvas, width, height);
      const bw = Math.round(width * scale);
      const bh = Math.round(height * scale);
      if (source.width !== bw || source.height !== bh) {
        // 大きさを替えるとキャンバスが空になるので、写し直して描き直す
        source.width = canvas.width = bw;
        source.height = canvas.height = bh;
        captured = null;
      }
      const p = plan(root, canvas, bw, bh);
      const recapture = p.live || p.key !== captured;
      if (recapture) {
        paint(g, p.paints, bw, bh);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        captured = p.key;
      }
      const time = usesTime ? t * o.speed : 0;
      const size = `${bw}x${bh}:${width}x${height}`;
      if (!recapture && !restyled && time === drawnTime && size === drawnSize) return;
      restyled = false;
      drawnTime = time;
      drawnSize = size;
      gl.viewport(0, 0, bw, bh);
      gl.uniform2f(uResolution, width, height);
      gl.uniform1f(uTime, time);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    setStrength(strength) {
      gl.uniform1f(uStrength, strength);
      restyled = true;
    },
    dispose() {
      canvas.remove();
      if (mask) {
        root.style.removeProperty("mask-image");
        root.style.removeProperty("-webkit-mask-image");
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        return;
      }
      const left = Number(root.dataset.glPasses ?? 1) - 1;
      if (left > 0) root.dataset.glPasses = String(left);
      else {
        delete root.dataset.glPasses;
        root.style.visibility = "";
      }
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

/**
 * root の外（すぐ後ろ）に置いたキャンバスを、root と同じ所に同じ見え方で重ねる（範囲を決めた効果）。
 * 箱（root の親の中の位置と大きさ）、変形（カメラの動き・レイヤーの動き）、不透明度、フィルタ（@filter・被写界深度）、重なり順を写す。
 */
function follow(root: HTMLElement, canvas: HTMLCanvasElement, width: number, height: number): void {
  const s = getComputedStyle(root);
  Object.assign(canvas.style, {
    left: `${root.offsetLeft}px`,
    top: `${root.offsetTop}px`,
    width: `${width}px`,
    height: `${height}px`,
    transform: s.transform === "none" ? "" : s.transform,
    transformOrigin: s.transformOrigin,
    opacity: s.opacity,
    filter: s.filter === "none" ? "" : s.filter,
    zIndex: s.zIndex === "auto" ? "" : s.zIndex,
  });
}

/** 描き写す一つ（root の大きさの一枚の上の位置と大きさ、濃さ、CSS のフィルタ、左右反転、塗りつぶしの色）。 */
interface Paint {
  el: HTMLElement;
  media: boolean;
  alpha: number;
  filter: string;
  x: number;
  y: number;
  w: number;
  h: number;
  flip: boolean;
  fill: string;
}

/**
 * root の中の絵のうち、描き写すもの（自分のキャンバスとほかの効果のキャンバスは除く）。key は写すものが同じなら同じになる文字
 * （絵の出どころ・動画の時刻・位置・大きさ・濃さ・フィルタ・反転・色）。live はキャンバスがあるとき（中身が変わっても key に出ない）。
 */
function plan(root: HTMLElement, self: HTMLCanvasElement, width: number, height: number): { paints: Paint[]; key: string; live: boolean } {
  const paints: Paint[] = [];
  const keys: string[] = [];
  let live = false;
  const box = root.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return { paints, key: "", live };
  const sx = width / box.width;
  const sy = height / box.height;
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    if (el === self || el.classList.contains("lim-gl-effect")) continue;
    const isMedia = el instanceof HTMLImageElement || el instanceof HTMLCanvasElement || el instanceof HTMLVideoElement;
    if (!isMedia && !el.classList.contains("fill")) continue;
    const style = getComputedStyle(el);
    const fill = isMedia ? "" : style.backgroundColor;
    if (el instanceof HTMLImageElement && (!el.complete || el.naturalWidth === 0)) continue;
    const alpha = opacityOf(el, root);
    if (alpha <= 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const p: Paint = { el, media: isMedia, alpha, filter: filterOf(el, root), x: (r.left - box.left) * sx, y: (r.top - box.top) * sy, w: r.width * sx, h: r.height * sy, flip: isMedia && /matrix\(-1/.test(style.transform), fill };
    paints.push(p);
    // 絵の出どころ（画像は読んだ URL、動画は URL と時刻と読めた段階）。キャンバスと動く SVG の中身は見えないので毎コマ写す
    let what = "fill";
    if (el instanceof HTMLImageElement) {
      what = `img ${el.currentSrc || el.src}`;
      if (animatedImage(el.currentSrc || el.src) !== false) live = true;
    } else if (el instanceof HTMLVideoElement) what = `video ${el.currentSrc || el.src} ${el.currentTime} ${el.readyState}`;
    else if (el instanceof HTMLCanvasElement) {
      what = "canvas";
      live = true;
    }
    keys.push(`${what}|${p.x},${p.y},${p.w},${p.h}|${alpha}|${p.filter}|${p.flip ? 1 : 0}|${fill}`);
  }
  return { paints, key: keys.join("\n"), live };
}

/** 画像の URL → drawImage で写すたびに中身が変わるか（調べている途中は Promise）。 */
const animated = new Map<string, boolean | Promise<void>>();

/** 名前で SVG でないと分かる画像（中身を読まずに、動かないとする）。 */
const RASTER = /^(?:blob:|data:image\/(?!svg)|[^?#]*\.(?:png|apng|jpe?g|gif|webp|avif|bmp)(?:[?#]|$))/i;

/**
 * drawImage で写すたびに中身が変わる画像か（動きのある SVG）。SVG かもしれない画像は中身を一度だけ読んで調べ、それまでは undefined
 * （動くものとして毎コマ写す）。
 */
function animatedImage(url: string): boolean | undefined {
  const hit = animated.get(url);
  if (typeof hit === "boolean") return hit;
  if (hit) return undefined;
  if (RASTER.test(url)) {
    animated.set(url, false);
    return false;
  }
  animated.set(
    url,
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => void animated.set(url, drawsAnimated(new Uint8Array(b))))
      // 読めなければ動くものとして扱う（毎コマ写す。前と同じ見え方のまま、軽くならないだけ）
      .catch(() => void animated.set(url, true)),
  );
  return undefined;
}

/**
 * 画像のファイルの中身が、drawImage で写すたびに変わるものか（<animate>・<set> か CSS の動きのある SVG）。
 * GIF・APNG・動く WebP は drawImage が一コマ目（動かないときの絵）を写すので、変わらない。
 */
export function drawsAnimated(b: Uint8Array): boolean {
  const text = new TextDecoder().decode(b.subarray(0, 512 * 1024));
  return /<svg[\s>]/i.test(text) && /<animate|<set[\s/>]|@keyframes|animation\s*:/i.test(text);
}

/** plan のものを、大きさ width × height の一枚に描き写す。 */
function paint(g: CanvasRenderingContext2D, paints: readonly Paint[], width: number, height: number): void {
  g.clearRect(0, 0, width, height);
  for (const p of paints) {
    g.globalAlpha = p.alpha;
    g.filter = p.filter;
    try {
      if (p.media) {
        // 立ち絵の左右反転（scaleX(-1)）だけは写す
        if (p.flip) {
          g.save();
          g.translate(p.x + p.w, p.y);
          g.scale(-1, 1);
          g.drawImage(p.el as CanvasImageSource, 0, 0, p.w, p.h);
          g.restore();
        } else g.drawImage(p.el as CanvasImageSource, p.x, p.y, p.w, p.h);
      } else {
        g.fillStyle = p.fill;
        g.fillRect(p.x, p.y, p.w, p.h);
      }
    } catch {
      // 描けない要素（読み込み途中の動画など）は飛ばす
    }
  }
  g.globalAlpha = 1;
  g.filter = "none";
}

/** 要素から root までの不透明度の積（root は含めない）。表示していなければ 0。 */
function opacityOf(el: Element, root: Element): number {
  let a = 1;
  for (let e: Element | null = el; e && e !== root; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (s.display === "none") return 0;
    a *= Number(s.opacity);
  }
  return a;
}

/** 要素から root までの CSS のフィルタ（SVG のフィルタ url(…) は写さない）。 */
function filterOf(el: Element, root: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el; e && e !== root; e = e.parentElement) {
    const f = getComputedStyle(e).filter;
    if (f && f !== "none") parts.push(f.replace(/url\([^)]*\)/g, "").trim());
  }
  return parts.filter(Boolean).join(" ") || "none";
}
