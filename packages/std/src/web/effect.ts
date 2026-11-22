import * as E from "../commands/effect.ts";
import { coverMask, maskImage } from "../commands/image.ts";
import type { StageState, Value } from "@liminalia/runtime";
import type { Renderer, RenderContext, Restorer } from "@liminalia/web";
import { composeFilter, layerTargets } from "./image.ts";
import { BUILTIN_SHADERS, SHADER_HEADER, createGlPass, shaderSource, type GlPass } from "./gl-effect.ts";

/**
 * 画面の演出（@effect / @effect-off）の描画。
 * - wave・glitch・chromatic: 隠した SVG にフィルタを置き、かける要素の filter に url(#…) で足す（@filter の CSS とは重ねる）
 * - noise・vignette・scanlines: 前景の上（ctx.layers.fx。メッセージ枠の下）に重ねる要素
 * - radial-blur・zoom-blur・mosaic・ripple・shader: かける要素の絵を WebGL のシェーダーに通して出す（gl-effect.ts）
 * 動くもの（揺らぎ・乱れ・粒子・シェーダー）は一つの requestAnimationFrame でまとめて動かし、演出が無くなったら止める。
 */

const SVG_NS = "http://www.w3.org/2000/svg";

interface Live {
  effect: E.Effect;
  ctx: RenderContext;
  /** フィルタ（フィルタの種類）。 */
  filter?: SVGFilterElement;
  /** フィルタをかけた要素。 */
  targets: HTMLElement[];
  /** 重ねた要素（重ねる種類）。 */
  overlay?: HTMLElement;
  /** WebGL でかける種類。 */
  passes?: GlPass[];
  /** 一コマ動かす（t は秒）。 */
  tick?: (t: number) => void;
  /** 強さの倍率（0〜1。@effect fade= と @effect-off fade= で動かす）。 */
  level: number;
  /** 強さの倍率を移している途中（from から to へ、start から ms ミリ秒で）。終わったら done を呼ぶ。 */
  fading?: { from: number; to: number; start: number; ms: number; done: () => void };
  /** 強さの倍率を見た目に当てる。 */
  setLevel?: (level: number) => void;
}

const live = new Map<string, Live>();
let defs: SVGSVGElement | null = null;
let frame = 0;
let started = 0;
let serial = 0;

function svgDefs(): SVGSVGElement {
  if (defs?.isConnected) return defs;
  defs = document.createElementNS(SVG_NS, "svg");
  defs.setAttribute("aria-hidden", "true");
  Object.assign(defs.style, { position: "absolute", width: "0", height: "0", overflow: "hidden" });
  document.body.append(defs);
  return defs;
}

function node(tag: string, attrs: Record<string, string | number>, parent?: Element): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent?.append(el);
  return el;
}

/** 色ずれ（赤を左、青を右へずらす）を in から組む。結果の名前を返す。 */
function chromatic(f: SVGFilterElement, input: string, prefix: string): { red: SVGElement; blue: SVGElement; result: string } {
  node("feColorMatrix", { in: input, type: "matrix", values: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0", result: `${prefix}r` }, f);
  const red = node("feOffset", { in: `${prefix}r`, dx: 0, dy: 0, result: `${prefix}ro` }, f);
  node("feColorMatrix", { in: input, type: "matrix", values: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0", result: `${prefix}g` }, f);
  node("feColorMatrix", { in: input, type: "matrix", values: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0", result: `${prefix}b` }, f);
  const blue = node("feOffset", { in: `${prefix}b`, dx: 0, dy: 0, result: `${prefix}bo` }, f);
  node("feBlend", { in: `${prefix}ro`, in2: `${prefix}g`, mode: "screen", result: `${prefix}rg` }, f);
  node("feBlend", { in: `${prefix}rg`, in2: `${prefix}bo`, mode: "screen", result: `${prefix}out` }, f);
  return { red, blue, result: `${prefix}out` };
}

/** フィルタの種類の SVG と、一コマの動き。level は強さの倍率（出し入れの途中）。 */
function buildFilter(e: E.Effect, level: () => number): { filter: SVGFilterElement; tick: (t: number) => void; setLevel: (k: number) => void } {
  const f = node("filter", { id: `lim-fx-${++serial}`, x: "-5%", y: "-5%", width: "110%", height: "110%", "color-interpolation-filters": "sRGB" }, svgDefs()) as SVGFilterElement;
  const full = e.strength;
  switch (e.type) {
    case "wave": {
      const noise = node("feTurbulence", { type: "turbulence", baseFrequency: "0.008 0.03", numOctaves: 2, seed: 3, result: "n" }, f);
      const shift = node("feDisplacementMap", { in: "SourceGraphic", in2: "n", scale: full * level(), xChannelSelector: "R", yChannelSelector: "G" }, f);
      return {
        filter: f,
        setLevel: (k) => shift.setAttribute("scale", String(full * k)),
        tick: (t) => {
          const k = t * e.speed;
          noise.setAttribute("baseFrequency", `${(0.008 + 0.002 * Math.sin(k * 1.3)).toFixed(5)} ${(0.03 + 0.006 * Math.sin(k * 0.9)).toFixed(5)}`);
        },
      };
    }
    case "glitch": {
      // 横に細い帯のノイズで横へずらし、色ずれを重ねる。ときどきだけ大きく乱れる
      const noise = node("feTurbulence", { type: "fractalNoise", baseFrequency: "0.00001 0.06", numOctaves: 1, seed: 1, result: "n" }, f);
      const shift = node("feDisplacementMap", { in: "SourceGraphic", in2: "n", scale: 0, xChannelSelector: "R", yChannelSelector: "A", result: "d" }, f);
      const split = chromatic(f, "d", "c");
      let next = 0;
      return {
        filter: f,
        setLevel: () => undefined,
        tick: (t) => {
          const s = full * level();
          if (e.speed <= 0 || t < next) return;
          next = t + (0.06 + Math.random() * 0.12) / e.speed;
          const burst = Math.random() < 0.35;
          noise.setAttribute("seed", String(Math.floor(Math.random() * 1000)));
          noise.setAttribute("baseFrequency", `0.00001 ${(0.02 + Math.random() * 0.1).toFixed(4)}`);
          shift.setAttribute("scale", String(burst ? s * (0.5 + Math.random()) : s * 0.08));
          const dx = burst ? s * 0.25 : s * 0.05;
          split.red.setAttribute("dx", String(-dx));
          split.blue.setAttribute("dx", String(dx));
        },
      };
    }
    default: {
      const split = chromatic(f, "SourceGraphic", "c");
      let last = 0;
      const place = (t: number) => {
        const dx = full * level() * (e.speed > 0 ? 0.8 + 0.2 * Math.sin(t * e.speed * 2) : 1);
        split.red.setAttribute("dx", String(-dx));
        split.blue.setAttribute("dx", String(dx));
      };
      return {
        filter: f,
        setLevel: () => place(last),
        tick: (t) => {
          last = t;
          const dx = full * level() * (e.speed > 0 ? 0.8 + 0.2 * Math.sin(t * e.speed * 2) : 1);
          split.red.setAttribute("dx", String(-dx));
          split.blue.setAttribute("dx", String(dx));
        },
      };
    }
  }
}

/** 重ねる種類の要素と、一コマの動き。 */
function buildOverlay(e: E.Effect): { overlay: HTMLElement; tick?: (t: number) => void } {
  const el = document.createElement("div");
  el.className = `lim-effect lim-effect-${e.type}`;
  Object.assign(el.style, { position: "absolute", inset: "0", pointerEvents: "none" });
  if (e.mask) {
    const image = maskImage(e.mask);
    Object.assign(el.style, { maskImage: image, webkitMaskImage: image });
  }
  const a = Math.max(0, Math.min(100, e.strength)) / 100;
  const rgb = hexRgb(e.color);
  switch (e.type) {
    case "vignette":
      el.style.background = `radial-gradient(ellipse at center, rgba(${rgb}, 0) 45%, rgba(${rgb}, ${a}) 100%)`;
      return { overlay: el };
    case "scanlines":
      el.style.background = `repeating-linear-gradient(to bottom, rgba(${rgb}, 0) 0 2px, rgba(${rgb}, ${a}) 2px 3px)`;
      return { overlay: el, tick: (t) => (el.style.opacity = e.speed > 0 ? String((0.85 + 0.15 * Math.sin(t * e.speed * 40)) * Number(el.dataset.level ?? 1)) : (el.dataset.level ?? "1")) };
    default: {
      // 粒子: 小さめのキャンバスに毎コマ違う砂嵐を描いて引き伸ばし、重ね合わせる
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 270;
      Object.assign(canvas.style, { width: "100%", height: "100%", opacity: String(a), mixBlendMode: "overlay" });
      el.append(canvas);
      const g = canvas.getContext("2d")!;
      const image = g.createImageData(canvas.width, canvas.height);
      let next = 0;
      return {
        overlay: el,
        tick: (t) => {
          if (t < next) return;
          next = t + 1 / (24 * Math.max(0.1, e.speed || 0.1));
          const d = image.data;
          for (let i = 0; i < d.length; i += 4) {
            const v = (Math.random() * 255) | 0;
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = 255;
          }
          g.putImageData(image, 0, 0);
        },
      };
    }
  }
}

function hexRgb(color: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  const n = m ? parseInt(m[1]!, 16) : 0;
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function targetsOf(ctx: RenderContext, layer: string): HTMLElement[] {
  return layer === "screen" ? [ctx.camera] : layerTargets(ctx, layer);
}

/** かけている要素の filter を、その要素にかけているフィルタの演出すべてで組み直す。 */
function refreshFilters(elements: Iterable<HTMLElement>): void {
  for (const el of new Set(elements)) {
    const urls = [...live.values()].filter((l) => l.filter && l.targets.includes(el)).map((l) => `url(#${l.filter!.id})`);
    el.dataset.fxFilter = urls.join(" ");
    composeFilter(el);
  }
}

function remove(name: string): void {
  const l = live.get(name);
  if (!l) return;
  live.delete(name);
  l.fading?.done();
  l.filter?.remove();
  l.overlay?.remove();
  for (const p of l.passes ?? []) p.dispose();
  refreshFilters(l.targets);
}

/** 作品のシェーダーの元（読んだものは覚えておく）。 */
const shaderFiles = new Map<string, Promise<string | null>>();

function loadShader(ctx: RenderContext, file: string): Promise<string | null> {
  const url = ctx.asset("others", file);
  let p = shaderFiles.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);
    shaderFiles.set(url, p);
  }
  return p;
}

async function startGl(ctx: RenderContext, name: string, e: E.Effect, entry: Live): Promise<void> {
  let body = BUILTIN_SHADERS[e.type];
  if (e.type === "shader") {
    const text = e.file ? await loadShader(ctx, e.file) : null;
    if (text === null) console.warn(`シェーダーを読めません: ${e.file ?? "（file がありません）"}`);
    body = text ?? undefined;
  }
  // 読んでいるあいだに外されたか、置き換えられた
  if (live.get(name) !== entry || body === undefined) return;
  const fragment = e.type === "shader" ? shaderSource(body) : `${SHADER_HEADER}${body}`;
  // 効果の絵は範囲に（縁はぼかす）、元の絵は効果の絵が覆いきる所だけ隠す（縁は元の絵の上に効果の絵が重なって移る）
  const mask = e.mask ? { inside: maskImage(e.mask), outside: coverMask(e.mask) } : undefined;
  entry.passes = targetsOf(ctx, e.layer).flatMap((root) => createGlPass(root, fragment, { strength: e.strength * entry.level, center: e.center ?? [50, 50], speed: e.speed, ...(e.values ? { values: e.values } : {}), ...(mask ? { mask } : {}) }) ?? []);
  entry.setLevel = (k) => {
    for (const p of entry.passes ?? []) p.setStrength(e.strength * k);
  };
  entry.tick = (t) => {
    for (const p of entry.passes ?? []) p.render(t);
  };
  entry.tick(0);
  loop();
}

/** fade ミリ秒かけて始める（0 ならすぐ）。かけ終わったら解決する。 */
function start(ctx: RenderContext, name: string, e: E.Effect, fade = 0): Promise<void> {
  remove(name);
  const entry: Live = { effect: e, ctx, targets: [], level: fade > 0 ? 0 : 1 };
  if (E.GL_EFFECTS.includes(e.type)) {
    live.set(name, entry);
    void startGl(ctx, name, e, entry);
  } else if (E.FILTER_EFFECTS.includes(e.type)) {
    const { filter, tick, setLevel } = buildFilter(e, () => entry.level);
    entry.filter = filter;
    entry.tick = tick;
    entry.setLevel = setLevel;
    entry.targets = targetsOf(ctx, e.layer);
    live.set(name, entry);
    refreshFilters(entry.targets);
  } else {
    const { overlay, tick } = buildOverlay(e);
    entry.overlay = overlay;
    if (tick) entry.tick = tick;
    entry.setLevel = (k) => {
      overlay.dataset.level = String(k);
      overlay.style.opacity = String(k);
    };
    entry.setLevel(entry.level);
    ctx.layers.fx.append(overlay);
    live.set(name, entry);
  }
  entry.tick?.(0);
  const done = fade > 0 ? fadeLevel(entry, 1, fade) : Promise.resolve();
  loop();
  return done;
}

/** 強さの倍率を to へ ms ミリ秒で移す（終わったら解決する。外されたときも）。 */
function fadeLevel(entry: Live, to: number, ms: number): Promise<void> {
  entry.fading?.done();
  return new Promise<void>((resolve) => {
    entry.fading = {
      from: entry.level,
      to,
      start: performance.now(),
      ms,
      done: () => {
        delete entry.fading;
        resolve();
      },
    };
    loop();
  });
}

/** 出し入れの途中の強さを進める。 */
function stepLevel(entry: Live, now: number): void {
  const f = entry.fading;
  if (!f) return;
  const k = Math.min(1, (now - f.start) / Math.max(1, f.ms));
  entry.level = f.from + (f.to - f.from) * k;
  entry.setLevel?.(entry.level);
  if (k >= 1) f.done();
}

function loop(): void {
  if (frame || live.size === 0) return;
  started ||= performance.now();
  const step = (now: number) => {
    frame = 0;
    if (live.size === 0) return;
    const t = (now - started) / 1000;
    for (const l of [...live.values()]) stepLevel(l, now);
    // 速さ 0 の WebGL の種類は、絵を写し直すので時間だけ止めて描き続ける
    for (const l of live.values()) l.tick?.(l.passes && l.effect.speed === 0 ? 0 : t);
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

/** 一回きりの効果（@effect time=）の名前の頭。状態の効果と重ならない。 */
const ONCE = "\u0000once:";
let onceSerial = 0;

/** 外していく途中の効果の名前の頭（同じ名前の効果をすぐかけ直せるように、名前を替えて残す）。 */
const LEAVING = "\u0000leaving:";
let leavingSerial = 0;

/** 状態に合わせてかける・外す。fade ミリ秒で出し入れし、すべて済んだら解決する。 */
function sync(ctx: RenderContext, stage: StageState, fade = 0): Promise<void> {
  const want = E.readEffects(stage.extra);
  const jobs: Promise<void>[] = [];
  for (const name of [...live.keys()]) {
    if (name.startsWith(ONCE) || name.startsWith(LEAVING)) continue;
    if (want[name] && JSON.stringify(want[name]) === JSON.stringify(live.get(name)!.effect)) continue;
    if (fade <= 0) {
      remove(name);
      continue;
    }
    // 強さを 0 まで下げてから外す
    const entry = live.get(name)!;
    const leaving = `${LEAVING}${++leavingSerial}`;
    live.delete(name);
    live.set(leaving, entry);
    jobs.push(fadeLevel(entry, 0, fade).then(() => remove(leaving)));
  }
  for (const [name, e] of Object.entries(want)) if (!live.has(name)) jobs.push(start(ctx, name, e, fade));
  return Promise.all(jobs).then(() => undefined);
}

/** time= の効果を、その時間だけかけて外す（状態には残さない。スキップ中は出さない。ロード・スキップの始まりで外れる）。 */
async function once(ctx: RenderContext, a: Record<string, Value>): Promise<void> {
  if (ctx.skipping) return;
  const name = `${ONCE}${++onceSerial}`;
  const scope = ctx.scope();
  scope.defer(() => remove(name));
  // 一回きりの効果はフェードせずに出す（出し終わりを待たずに時間を数える）
  void start(ctx, name, E.effectFrom(a));
  await scope.sleep(typeof a.time === "number" ? a.time : 0);
  scope.dispose();
}

const fadeOf = (ctx: RenderContext, a: Record<string, Value>): number => ctx.time(typeof a.fade === "number" ? a.fade : 0);

export const renderers: Record<string, Renderer> = {
  effect: (ctx, a, wait, stage) => {
    if (typeof a.time !== "number") {
      const done = sync(ctx, stage, fadeOf(ctx, a));
      return wait ? done : undefined;
    }
    const done = once(ctx, a).catch((e: unknown) => console.warn(e));
    return wait ? done : undefined;
  },
  "effect-off": (ctx, a, wait, stage) => {
    const done = sync(ctx, stage, fadeOf(ctx, a));
    return wait ? done : undefined;
  },
};

export const restorers: Restorer[] = [
  async (ctx: RenderContext, stage: StageState) => {
    for (const name of [...live.keys()]) remove(name);
    await sync(ctx, stage);
  },
];
