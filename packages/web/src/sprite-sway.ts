import { estimateFace, estimateHead, type CastVariant } from "@liminalia/lang";
import { createFace, hasFace, type SpritePart, type SpritePartContext } from "./sprite-face.ts";

/**
 * 一枚の立ち絵を、操り人形のように動かす部品（差分の model.type が "sway"）。
 * 呼吸で肩と胸が上下し、頭が首を軸にゆっくり傾き、長い髪の毛先が揺れ、体全体が足元からわずかに揺れる。
 * 口パクとまばたきの重ね画像（lip・blink）も一緒に変形して描く。
 *
 * 絵の各点を「どれだけ動かすか」を範囲ごとの重みで足し合わせ、その分ずらした位置の色を拾う（動きが小さいので逆写像の近似で足りる）。
 * 頭の位置は顔の肌のかたまりから推し量る（face-fit.ts の estimateFace。肌が見つからなければ head-fit.ts の estimateHead）。
 * 推定は顎が口の高さにずれることがあるので、頭と体の境目を広くなだらかにして、ずれても顔が崩れないようにしてある。外れるときは model.head に画像の px で書く。
 *
 * model の項目:
 * - strength: 動きの大きさ（既定 1。0.5 で半分）
 * - hair: 髪の揺れの大きさ（既定 1）
 * - head: { chinX, chinY, top, width }（画像の左上からの px。省くと推し量る）
 */
export function createSway(ctx: SpritePartContext): SpritePart {
  const gl = sharedGl();
  const canvas = document.createElement("canvas");
  const out = canvas.getContext("2d");
  if (!gl || !out) {
    // WebGL が使えなければ、ふつうの立ち絵（口パクとまばたきだけ）に戻す
    console.warn(`立ち絵を揺らせません（WebGL が使えません）。静止画で表示します: ${ctx.who}`);
    return hasFace(ctx.variant) ? createFace(ctx) : { update() {}, dispose() {} };
  }
  const sg: Shared = gl;
  canvas.className = "sprite-sway";
  // 動いた分が枠の外にはみ出しても切れないよう、枠より一回り大きく描く
  Object.assign(canvas.style, { position: "absolute", left: `${-PAD_X * 100}%`, top: `${-PAD_Y * 100}%`, width: `${(1 + 2 * PAD_X) * 100}%`, height: `${(1 + 2 * PAD_Y) * 100}%`, pointerEvents: "none" });
  ctx.el.append(canvas);

  // 口パクとまばたきは、見えない入れ物の中で今までどおり切り替えさせ、どの重ね画像が出ているかだけを読む
  const holder = document.createElement("div");
  holder.style.display = "none";
  const face = createFace({ ...ctx, el: holder });
  const overlays = () => [...holder.querySelectorAll("img")].filter((img) => img.style.visibility === "visible").map((img) => img.src);

  /** この立ち絵が借りている絵（返すと、だれも使っていない絵は GPU から消える）。 */
  const held = new Set<string>();
  const hold = (url: string) => {
    if (!held.has(url)) {
      held.add(url);
      acquire(url);
    }
    return sg.textures.get(url)!;
  };

  let variant: CastVariant = ctx.variant;
  let baseUrl = "";
  let options = readOptions(variant);
  /** 頭の目安（画像の幅と高さを 1 とした位置）。 */
  let head = { chinX: 0.5, chinY: 0.22, top: 0.04, width: 0.3 };
  let aspect = 1.5;
  let measured = "";

  function measure(image: HTMLImageElement): void {
    measured = image.src;
    aspect = image.naturalHeight / image.naturalWidth;
    const given = options.head;
    if (given) {
      head = { chinX: given.chinX / image.naturalWidth, chinY: given.chinY / image.naturalHeight, top: given.top / image.naturalHeight, width: given.width / image.naturalWidth };
      return;
    }
    const mark = headOf(image);
    if (mark) head = mark;
  }

  function update(next: CastVariant): void {
    variant = next;
    options = readOptions(next);
    const url = ctx.asset("fgimage", next.image);
    if (baseUrl && baseUrl !== url && !overlays().includes(baseUrl)) {
      held.delete(baseUrl);
      release(baseUrl);
    }
    baseUrl = url;
    hold(baseUrl);
    measured = "";
    face.update(next);
  }
  update(ctx.variant);

  // 人ごとに揺れの位相をずらし、並んだ人物が同じ動きをしないようにする
  const phase = Math.random() * 100;
  const motion = { roll: 0, rollV: 0, rollGoal: 0, yaw: 0, yawV: 0, yawGoal: 0, next: 0, last: 0 };

  function draw(now: number): void {
    const base = sg.textures.get(baseUrl);
    if (!base?.ready) return;
    if (measured !== base.image.src) measure(base.image);
    // 枠の大きさに合わせて描く解像度を決める
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    // 上限を超えるときは縦横を同じ割合で縮める（片方だけ縮めると、引き伸ばして縦横比がずれる）
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const fit = Math.min(1, MAX_SIZE / (rect.width * dpr), MAX_SIZE / (rect.height * dpr));
    const w = Math.max(1, Math.round(rect.width * dpr * fit));
    const h = Math.max(1, Math.round(rect.height * dpr * fit));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const dt = motion.last ? Math.min(0.05, (now - motion.last) / 1000) : 0;
    motion.last = now;
    const t = now / 1000 + phase;

    // 頭は数秒ごとに向きと傾きを少し変え、ばねでゆっくり追いつく
    if (now > motion.next) {
      motion.rollGoal = (Math.random() - 0.5) * 0.09;
      motion.yawGoal = (Math.random() - 0.5) * 1.2;
      motion.next = now + 1800 + Math.random() * 3200;
    }
    const k = 6;
    const damp = 2 * Math.sqrt(k);
    motion.rollV += (k * (motion.rollGoal - motion.roll) - damp * motion.rollV) * dt;
    motion.yawV += (k * (motion.yawGoal - motion.yaw) - damp * motion.yawV) * dt;
    motion.roll += motion.rollV * dt;
    motion.yaw += motion.yawV * dt;

    const layers = [baseUrl, ...overlays()].map(hold).filter((x) => x.ready);
    render(sg, w, h, layers, {
      aspect,
      head,
      time: t,
      strength: options.strength,
      hair: options.hair,
      roll: motion.roll + Math.sin(t * 0.37) * 0.015,
      yaw: motion.yaw,
    });
    // 共有の描画先の左下に描いたので、その範囲をこの立ち絵のキャンバスへ写す
    out!.clearRect(0, 0, w, h);
    out!.drawImage(sg.canvas, 0, sg.canvas.height - h, w, h, 0, 0, w, h);
  }

  return {
    coversImage: true,
    update,
    tick(now, mouth) {
      face.tick?.(now, mouth);
      draw(now);
    },
    dispose() {
      face.dispose();
      for (const url of held) release(url);
      held.clear();
      canvas.remove();
    },
  };
}

/** 描く大きさの上限（画素）。 */
const MAX_SIZE = 2048;

type Texture = { tex: WebGLTexture | null; image: HTMLImageElement; ready: boolean; users: number };
type Shared = {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  program: NonNullable<ReturnType<typeof build>>;
  textures: Map<string, Texture>;
};

/**
 * すべての揺れる立ち絵が使う、ひとつの WebGL。ブラウザが同時に持てる WebGL の数には限り（Chrome で 16）があり、
 * 立ち絵ごとに作ると人物や差分が増えたとき古いものから消えるため。各立ち絵はここで描いてから、自分の 2D キャンバスへ写す。
 */
let shared: Shared | null | undefined;
function sharedGl(): Shared | null {
  if (shared !== undefined) return shared;
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false });
  const program = gl ? build(gl) : null;
  if (!gl || !program) return (shared = null);
  const s: Shared = { canvas, gl, program, textures: new Map() };
  // 描画先を失ったら（GPU のリセットなど）、作り直してから絵を上げ直す
  canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
  canvas.addEventListener("webglcontextrestored", () => {
    const again = build(gl);
    if (!again) return;
    s.program = again;
    for (const t of s.textures.values()) {
      t.tex = null;
      if (t.ready) upload(s, t);
    }
  });
  return (shared = s);
}

function upload(s: Shared, t: Texture): void {
  const gl = s.gl;
  t.tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, t.image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/** 絵を借りる。初めてなら読み込んで GPU に上げる。 */
function acquire(url: string): void {
  const s = shared!;
  let t = s.textures.get(url);
  if (!t) {
    const image = new Image();
    const entry: Texture = { tex: null, image, ready: false, users: 0 };
    image.onload = () => {
      if (!s.textures.has(url)) return;
      upload(s, entry);
      entry.ready = true;
    };
    image.src = url;
    s.textures.set(url, entry);
    t = entry;
  }
  t.users++;
}

/** 絵を返す。だれも使わなくなったら GPU から消す。 */
function release(url: string): void {
  const s = shared;
  const t = s?.textures.get(url);
  if (!s || !t) return;
  if (--t.users > 0) return;
  if (t.tex) s.gl.deleteTexture(t.tex);
  s.textures.delete(url);
}

/** 頭の位置を、縮めた絵の肌と輪郭から推し量る（同じ絵は一度だけ数える）。 */
const heads = new Map<string, { chinX: number; chinY: number; top: number; width: number } | null>();
function headOf(image: HTMLImageElement): { chinX: number; chinY: number; top: number; width: number } | null {
  if (heads.has(image.src)) return heads.get(image.src)!;
  let found: { chinX: number; chinY: number; top: number; width: number } | null = null;
  try {
    const scale = Math.min(1, 320 / image.naturalWidth);
    const w = Math.max(1, Math.round(image.naturalWidth * scale));
    const h = Math.max(1, Math.round(image.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(image, 0, 0, w, h);
    const data = g.getImageData(0, 0, w, h).data;
    // 顔の肌から探し、見つからない絵（仮面、肌色でない肌）だけ輪郭の幅から推す
    const mark = estimateFace(data, w, h) ?? estimateHead(data, w, h);
    if (mark) found = { chinX: mark.chinX / w, chinY: mark.chinY / h, top: mark.top / h, width: mark.width / w };
  } catch {
    // 別のオリジンの絵などで読めなければ、目安のまま
  }
  heads.set(image.src, found);
  return found;
}

type Pose = { aspect: number; head: { chinX: number; chinY: number; top: number; width: number }; time: number; strength: number; hair: number; roll: number; yaw: number };

/** 共有の描画先の左下 w×h に、変形した立ち絵を描く。 */
function render(s: Shared, w: number, h: number, layers: Texture[], pose: Pose): void {
  const gl = s.gl;
  if (gl.isContextLost() || layers.length === 0) return;
  // 描画先は、これまでで一番大きい立ち絵に合わせて広げるだけ（毎回作り直さない）
  if (s.canvas.width < w || s.canvas.height < h) {
    s.canvas.width = Math.max(s.canvas.width, w);
    s.canvas.height = Math.max(s.canvas.height, h);
  }
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const { program, uniforms: u } = s.program;
  gl.useProgram(program);
  for (let i = 0; i < 3; i++) {
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, (layers[i] ?? layers[0]!).tex);
    gl.uniform1i(u[`uTex${i}`]!, i);
  }
  gl.uniform1f(u.uLayers!, layers.length);
  gl.uniform2f(u.uPad!, PAD_X, PAD_Y);
  gl.uniform1f(u.uAspect!, pose.aspect);
  gl.uniform4f(u.uHead!, pose.head.chinX, pose.head.chinY, pose.head.top, pose.head.width);
  gl.uniform1f(u.uTime!, pose.time);
  gl.uniform1f(u.uStrength!, pose.strength);
  gl.uniform1f(u.uHair!, pose.hair);
  gl.uniform1f(u.uRoll!, pose.roll);
  gl.uniform1f(u.uYaw!, pose.yaw);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

/** 枠の外に描ける余白（枠の幅・高さに対する割合）。 */
const PAD_X = 0.06;
const PAD_Y = 0.03;

function readOptions(variant: CastVariant): { strength: number; hair: number; head?: { chinX: number; chinY: number; top: number; width: number } } {
  const m = variant.model ?? { type: "sway" };
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const h = m.head as Record<string, unknown> | undefined;
  const head = h && ["chinX", "chinY", "top", "width"].every((k) => typeof h[k] === "number") ? (h as { chinX: number; chinY: number; top: number; width: number }) : undefined;
  return head ? { strength: num(m.strength, 1), hair: num(m.hair, 1), head } : { strength: num(m.strength, 1), hair: num(m.hair, 1) };
}

const VERTEX = `attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT = `precision mediump float;
uniform sampler2D uTex0, uTex1, uTex2;
uniform float uLayers, uAspect, uTime, uStrength, uHair, uRoll, uYaw;
uniform vec2 uPad;
uniform vec4 uHead;
varying vec2 v_uv;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// 絵の点 r（0〜1、y は下向き）がどれだけ動くか。
vec2 pose(vec2 r) {
  vec2 k = vec2(1.0, uAspect);
  float chinX = uHead.x;
  float chinY = uHead.y;
  float top = uHead.z;
  float hw = uHead.w;
  float hh = max(0.02, chinY - top);
  float dx = abs(r.x - chinX);
  vec2 off = vec2(0.0);

  // 頭: 首（顎の少し下）を軸に傾く。頭から下がる長い髪も、裾へ行くほど弱くついてくる
  float neckY = chinY + hh * 0.18;
  // 境目は広くなだらかにする。顎の推定が口や鼻の高さに外れても、顔の上下で回り方がほとんど変わらない
  float head = smoothstep(neckY + hh * 0.5, neckY - hh * 0.4, r.y) * smoothstep(hw * 1.6, hw * 0.6, dx);
  float hang = smoothstep(hw * 0.3, hw * 0.55, dx) * smoothstep(1.0, chinY, r.y) * step(chinY - hh * 0.2, r.y);
  float follow = max(head, hang * 0.5);
  vec2 a = r * k;
  vec2 pivot = vec2(chinX, neckY) * k;
  vec2 d = a - pivot;
  float c = cos(uRoll);
  float s = sin(uRoll);
  off += (pivot + vec2(c * d.x - s * d.y, s * d.x + c * d.y) - a) * follow;
  // 向きは、頭全体を少しずらすだけ（顔の中だけを動かすと、推定が外れたときに目鼻がずれる）
  off.x += uYaw * 0.006 * head * k.x;

  // 呼吸: 肩と胸が上下する（頭も少し持ち上がる）
  float breath = sin(uTime * 1.15) * 0.5 + 0.5;
  float chest = smoothstep(chinY, chinY + hh * 0.5, r.y) * smoothstep(chinY + hh * 3.2, chinY + hh * 1.4, r.y);
  off.y -= breath * 0.006 * (chest + head * 0.7) * k.y;
  off.x += (r.x - chinX) * breath * 0.009 * chest;

  // 足元から、体全体がわずかに揺れる
  off.x += sin(uTime * 0.29) * 0.008 * (1.0 - r.y);

  // 長い髪の毛先が、裾へ向かって流れる揺れ
  float tips = smoothstep(hw * 0.45, hw * 0.75, dx) * smoothstep(chinY, 1.0, r.y);
  off.x += (sin(r.y * 9.0 - uTime * 1.3 + sign(r.x - chinX) * 1.3) * 0.5 + noise(vec2(r.y * 6.0 - uTime * 0.5, r.x * 3.0)) - 0.5) * 0.0105 * uHair * tips;

  return off / k * uStrength;
}

vec4 layer(sampler2D tex, vec2 q) {
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return vec4(0.0);
  // 画像は上の行から読み込んである（上下を返していない）ので、y は下向きのまま引ける
  return texture2D(tex, q);
}

void main() {
  // キャンバスは枠より一回り大きい。枠の中の位置（y は下向き）に直す
  vec2 r = vec2(v_uv.x, 1.0 - v_uv.y) * (1.0 + 2.0 * uPad) - uPad;
  vec2 q = r - pose(r);
  vec4 c = layer(uTex0, q);
  // 重ね画像（まばたき、口）は同じ大きさなので、同じ位置で上に重ねる
  if (uLayers > 1.5) {
    vec4 o = layer(uTex1, q);
    c = o + c * (1.0 - o.a);
  }
  if (uLayers > 2.5) {
    vec4 o = layer(uTex2, q);
    c = o + c * (1.0 - o.a);
  }
  gl_FragColor = c;
}`;

function build(gl: WebGLRenderingContext): { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> } | null {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn(gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, VERTEX);
  const fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
  if (!vs || !fs) return null;
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const names = ["uTex0", "uTex1", "uTex2", "uLayers", "uPad", "uAspect", "uHead", "uTime", "uStrength", "uHair", "uRoll", "uYaw"];
  return { program, uniforms: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)])) };
}

/** 組み込みの立ち絵の部品（差分の model.type）。プラグインが同じ名前を登録すれば、そちらが優先される。 */
export const BUILTIN_SPRITE_PARTS = { sway: createSway } as const;
