import { BLEND_ADDITIVE, BLEND_MULTIPLICATIVE, DOUBLE_SIDED, drawableColor, INVERTED_MASK, IS_VISIBLE, type CoreModel } from "./core.ts";

/**
 * Cubism のモデルを WebGL（1）で描く。描くもの（drawable）を描く順（renderOrders）に、テクスチャと乗算色・スクリーン色、
 * 合成（通常、加算、乗算）、クリッピング（マスク）付きで描く。Cubism の Framework は使わない（Core の値だけを読む）。
 *
 * WebGL の描画先は、すべての Live2D の立ち絵で一つを共有する（ブラウザの WebGL の数の上限で消えないように）。
 * 立ち絵ごとに描いてから、その立ち絵の 2D のキャンバスへ写す（web.ts）。
 */

const VERTEX = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform vec4 u_map;
varying vec2 v_uv;
varying vec2 v_screen;
void main() {
  vec2 p = vec2(a_pos.x * u_map.x + u_map.y, a_pos.y * u_map.z + u_map.w);
  gl_Position = vec4(p, 0.0, 1.0);
  v_uv = vec2(a_uv.x, 1.0 - a_uv.y);
  v_screen = p * 0.5 + 0.5;
}`;

const FRAGMENT = `
precision mediump float;
varying vec2 v_uv;
varying vec2 v_screen;
uniform sampler2D u_tex;
uniform sampler2D u_mask;
uniform vec4 u_multiply;
uniform vec4 u_screen;
uniform float u_opacity;
uniform float u_maskMode;
void main() {
  vec4 c = texture2D(u_tex, v_uv);
  c.rgb *= u_multiply.rgb;
  c.rgb = c.rgb + u_screen.rgb * c.a - c.rgb * u_screen.rgb;
  c *= u_opacity;
  if (u_maskMode > 0.5) {
    float m = texture2D(u_mask, v_screen).a;
    if (u_maskMode > 1.5) m = 1.0 - m;
    c *= m;
  }
  gl_FragColor = c;
}`;

export interface Shared {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  buffers: { pos: WebGLBuffer; uv: WebGLBuffer; index: WebGLBuffer };
  loc: { pos: number; uv: number; map: WebGLUniformLocation; tex: WebGLUniformLocation; mask: WebGLUniformLocation; multiply: WebGLUniformLocation; screen: WebGLUniformLocation; opacity: WebGLUniformLocation; maskMode: WebGLUniformLocation };
  mask: { fb: WebGLFramebuffer; tex: WebGLTexture; width: number; height: number } | null;
  /** 描き直しのたびに上げ直すもの（失ったあと戻ったとき）。 */
  restored: Set<() => void>;
}

let shared: Shared | null | undefined;

function compile(gl: WebGLRenderingContext): Omit<Shared, "canvas" | "gl" | "mask" | "restored"> | null {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = shader(gl.VERTEX_SHADER, VERTEX);
  const fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  const u = (name: string) => gl.getUniformLocation(program, name)!;
  const pos = gl.createBuffer();
  const uv = gl.createBuffer();
  const index = gl.createBuffer();
  if (!pos || !uv || !index) return null;
  return {
    program,
    buffers: { pos, uv, index },
    loc: {
      pos: gl.getAttribLocation(program, "a_pos"),
      uv: gl.getAttribLocation(program, "a_uv"),
      map: u("u_map"),
      tex: u("u_tex"),
      mask: u("u_mask"),
      multiply: u("u_multiply"),
      screen: u("u_screen"),
      opacity: u("u_opacity"),
      maskMode: u("u_maskMode"),
    },
  };
}

/** 共有の描画先（WebGL が使えなければ null）。 */
export function sharedGl(): Shared | null {
  if (shared !== undefined) return shared;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: false });
  const parts = gl ? compile(gl) : null;
  if (!gl || !parts) return (shared = null);
  const s: Shared = { canvas, gl, ...parts, mask: null, restored: new Set() };
  canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
  canvas.addEventListener("webglcontextrestored", () => {
    const again = compile(gl);
    if (!again) return;
    Object.assign(s, again, { mask: null });
    for (const f of s.restored) f();
  });
  return (shared = s);
}

/** 絵を GPU に上げる（乗算済みのアルファ。2 のべき乗の大きさならミップマップも作る）。 */
export function uploadTexture(s: Shared, image: TexImageSource & { width: number; height: number }): WebGLTexture | null {
  const gl = s.gl;
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  const pot = (n: number) => n > 0 && (n & (n - 1)) === 0;
  if (pot(image.width) && pot(image.height)) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** マスクを描く先（描く先と同じ大きさ）。 */
function maskTarget(s: Shared, width: number, height: number): NonNullable<Shared["mask"]> | null {
  const gl = s.gl;
  if (s.mask && s.mask.width === width && s.mask.height === height) return s.mask;
  if (s.mask) {
    gl.deleteFramebuffer(s.mask.fb);
    gl.deleteTexture(s.mask.tex);
    s.mask = null;
  }
  const tex = gl.createTexture();
  const fb = gl.createFramebuffer();
  if (!tex || !fb) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return (s.mask = { fb, tex, width, height });
}

/** モデルの座標（単位）から、描く先の範囲（-1〜1）への写し方: x' = x * a + b、y' = y * c + d。 */
export type Mapping = [a: number, b: number, c: number, d: number];

/**
 * 描く先（幅 width、高さ height の画素）の中で、モデルのキャンバス（canvasinfo の px）を置く範囲 rect（画素）から写し方を作る。
 */
export function mapping(model: CoreModel, width: number, height: number, rect: { x: number; y: number; width: number; height: number }): Mapping {
  const info = model.canvasinfo;
  const ppu = info.PixelsPerUnit || 1;
  const sx = rect.width / info.CanvasWidth;
  const sy = rect.height / info.CanvasHeight;
  // モデルの単位 → キャンバスの px（上が 0）: px = origin.x + x * ppu、py = origin.y - y * ppu
  // → 描く先の画素: rect.x + px * sx → 描く先の範囲: / width * 2 - 1（y は上が 1）
  const a = ((ppu * sx) / width) * 2;
  const b = ((rect.x + info.CanvasOriginX * sx) / width) * 2 - 1;
  const c = ((ppu * sy) / height) * 2;
  const d = 1 - ((rect.y + info.CanvasOriginY * sy) / height) * 2;
  return [a, b, c, d];
}

/** 一つのモデルを、共有の描画先の左下 width×height に描く（呼ぶ前に描画先を大きくしておく）。 */
export function drawModel(s: Shared, model: CoreModel, textures: readonly (WebGLTexture | null)[], map: Mapping, width: number, height: number, opacity: number): void {
  const gl = s.gl;
  const d = model.drawables;
  gl.useProgram(s.program);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.SCISSOR_TEST);
  gl.enable(gl.BLEND);
  gl.frontFace(gl.CCW);
  gl.uniform4f(s.loc.map, map[0], map[1], map[2], map[3]);
  gl.uniform1i(s.loc.tex, 0);
  gl.uniform1i(s.loc.mask, 1);
  gl.enableVertexAttribArray(s.loc.pos);
  gl.enableVertexAttribArray(s.loc.uv);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const order = [...Array(d.count).keys()].sort((x, y) => d.renderOrders[x]! - d.renderOrders[y]!);
  let maskKey = "";
  const mesh = (i: number) => {
    const tex = textures[d.textureIndices[i]!];
    const indices = d.indices[i];
    if (!tex || !indices || indices.length === 0) return false;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.buffers.pos);
    gl.bufferData(gl.ARRAY_BUFFER, d.vertexPositions[i]!, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(s.loc.pos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.buffers.uv);
    gl.bufferData(gl.ARRAY_BUFFER, d.vertexUvs[i]!, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(s.loc.uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.buffers.index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
    return true;
  };
  for (const i of order) {
    const visible = (d.dynamicFlags[i]! & IS_VISIBLE) !== 0;
    const alpha = d.opacities[i]! * opacity;
    if (!visible || alpha <= 0) continue;
    const masks = d.maskCounts[i]! > 0 ? [...(d.masks[i] ?? [])].slice(0, d.maskCounts[i]) : [];
    let mode = 0;
    if (masks.length > 0) {
      const key = masks.join(",");
      const target = maskTarget(s, width, height);
      if (target) {
        if (key !== maskKey) {
          // マスクの形を、マスク用の描き先にアルファで描く（描き先の絵を読む口から外しておく。外さないと描けない）
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
          gl.viewport(0, 0, width, height);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.disable(gl.CULL_FACE);
          gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.uniform4f(s.loc.multiply, 1, 1, 1, 1);
          gl.uniform4f(s.loc.screen, 0, 0, 0, 1);
          gl.uniform1f(s.loc.opacity, 1);
          gl.uniform1f(s.loc.maskMode, 0);
          for (const m of masks) if (mesh(m)) gl.drawElements(gl.TRIANGLES, d.indices[m]!.length, gl.UNSIGNED_SHORT, 0);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          maskKey = key;
        }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, target.tex);
        mode = (d.constantFlags[i]! & INVERTED_MASK) !== 0 ? 2 : 1;
      }
    }
    if (!mesh(i)) continue;
    const flags = d.constantFlags[i]!;
    if ((flags & DOUBLE_SIDED) !== 0) gl.disable(gl.CULL_FACE);
    else {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
    }
    if ((flags & BLEND_ADDITIVE) !== 0) gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
    else if ((flags & BLEND_MULTIPLICATIVE) !== 0) gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    else gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const mul = drawableColor(d.multiplyColors, i, [1, 1, 1, 1]);
    const scr = drawableColor(d.screenColors, i, [0, 0, 0, 1]);
    gl.uniform4f(s.loc.multiply, mul[0], mul[1], mul[2], mul[3]);
    gl.uniform4f(s.loc.screen, scr[0], scr[1], scr[2], scr[3]);
    gl.uniform1f(s.loc.opacity, alpha);
    gl.uniform1f(s.loc.maskMode, mode);
    gl.drawElements(gl.TRIANGLES, d.indices[i]!.length, gl.UNSIGNED_SHORT, 0);
  }
  gl.disable(gl.CULL_FACE);
  d.resetDynamicFlags();
}
