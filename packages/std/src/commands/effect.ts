import type { Value } from "@liminalia/runtime";
import { t, type CommandDefinition } from "@liminalia/plugin-host";
import { FILTER_LAYERS, MASK_DOC, num, parseMask, text, type EffectMask } from "./image.ts";

/**
 * 画面の演出（シェーダーにあたるもの）。wave（揺らぎ・陽炎）・glitch（映像の乱れ）・chromatic（色ずれ）は、
 * 画面全体（screen）かレイヤーに SVG のフィルタでかける。noise（粒子）・vignette（周辺を暗く）・scanlines（走査線）は、
 * 画面の上（メッセージ枠の下）に重ねる。radial-blur（回転のぼかし）・zoom-blur（ズームのぼかし）・mosaic（モザイク）・
 * ripple（波紋）と shader（作品のシェーダー）は、画面全体かレイヤーに WebGL でかける。
 * かけているものは stage.extra の "std.effects"（名前 → 設定）に持ち、ロード時にかけ直す。
 */

export const EFFECT_TYPES = ["wave", "glitch", "chromatic", "noise", "vignette", "scanlines", "radial-blur", "zoom-blur", "mosaic", "ripple", "shader"] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];
/** フィルタでかける種類（ほかは重ねる）。 */
export const FILTER_EFFECTS: readonly EffectType[] = ["wave", "glitch", "chromatic"];
/** WebGL でかける種類。 */
export const GL_EFFECTS: readonly EffectType[] = ["radial-blur", "zoom-blur", "mosaic", "ripple", "shader"];
export const EFFECT_LAYERS = ["screen", ...FILTER_LAYERS] as const;

/**
 * 種類ごとの強さの既定（wave・glitch・chromatic・mosaic・ripple は px、noise・vignette・scanlines・zoom-blur は %、
 * radial-blur は回す角度（度）。shader はシェーダーの u_strength）。
 */
export const EFFECT_STRENGTH: Record<EffectType, number> = { wave: 12, glitch: 30, chromatic: 4, noise: 25, vignette: 60, scanlines: 30, "radial-blur": 8, "zoom-blur": 15, mosaic: 16, ripple: 6, shader: 1 };

export interface Effect {
  type: EffectType;
  /** かける場所（フィルタの種類だけ。screen は画面全体）。 */
  layer: (typeof EFFECT_LAYERS)[number];
  strength: number;
  /** 動きの速さの倍率（0 で止める）。 */
  speed: number;
  /** 色（vignette・scanlines）。 */
  color: string;
  /** 中心（radial-blur・zoom-blur・ripple・shader。左上からの %）。 */
  center?: [number, number];
  /** 作品のシェーダー（shader。others からのパス）と、渡す値（uniform float の名前 → 値）。 */
  file?: string;
  values?: Record<string, number>;
  /** かける範囲（重ねる種類と WebGL の種類。フィルタの種類 wave・glitch・chromatic は全体にかかる）。 */
  mask?: EffectMask;
}

/** 「名前=値」を空白か読点・カンマで区切った並びを、名前 → 数値にする（values）。数値でないものは null。 */
export function parseValues(text: string): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const part of text.split(/[\s,、]+/).filter(Boolean)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(-?[0-9.]+)$/.exec(part);
    if (!m || !Number.isFinite(Number(m[2]))) return null;
    out[m[1]!] = Number(m[2]);
  }
  return out;
}

const KEY = "std.effects";

export function readEffects(extra: Record<string, Value>): Record<string, Effect> {
  return (extra[KEY] as unknown as Record<string, Effect> | undefined) ?? {};
}

function writeEffects(extra: Record<string, Value>, value: Record<string, Effect>): void {
  if (Object.keys(value).length === 0) delete extra[KEY];
  else extra[KEY] = value as unknown as Value;
}

/** 引数から効果の設定を作る（@effect の状態と、time= の一回きりの効果が使う）。 */
export function effectFrom(args: Record<string, Value>): Effect {
  const type = text(args.type, "wave") as EffectType;
  const e: Effect = {
    type,
    layer: FILTER_EFFECTS.includes(type) || GL_EFFECTS.includes(type) ? (text(args.layer, "screen") as Effect["layer"]) : "screen",
    strength: num(args.strength) ?? EFFECT_STRENGTH[type],
    speed: num(args.speed) ?? 1,
    color: text(args.color, "#000000"),
  };
  if (GL_EFFECTS.includes(type)) e.center = [num(args.x) ?? 50, num(args.y) ?? 50];
  if (type === "shader") {
    e.file = text(args.file);
    const values = parseValues(text(args.values));
    if (values && Object.keys(values).length > 0) e.values = values;
  }
  const mask = FILTER_EFFECTS.includes(type) ? null : parseMask(args.mask);
  if (mask) e.mask = mask;
  return e;
}

export const COMMANDS: CommandDefinition[] = [
  {
    name: "effect",
    summary:
      "画面効果をかける（wave 揺らぎ / glitch 映像の乱れ / chromatic 色ずれ / noise 粒子 / vignette 周辺を暗く / scanlines 走査線 / radial-blur 回転のぼかし / zoom-blur ズームのぼかし / mosaic モザイク / ripple 波紋 / shader 作品のシェーダー）。@effect-off で解除する",
    positional: ["type"],
    params: {
      type: t.required(
        t.enum(
          [...EFFECT_TYPES],
          "種類（wave 揺らぎ / glitch 映像の乱れ / chromatic 色ずれ / noise 粒子 / vignette 周辺を暗く / scanlines 走査線 / radial-blur 回転のぼかし / zoom-blur ズームのぼかし / mosaic モザイク / ripple 波紋 / shader 作品のシェーダー）",
        ),
      ),
      name: t.string("名前（@effect-off で個別に解除するのに使う。同じ名前は置き換える）。省略時は種類の名前"),
      layer: t.enum([...EFFECT_LAYERS], "かける場所（noise、vignette、scanlines は画面全体だけ。screen は画面全体）", "screen"),
      strength: t.number(
        "強さ（wave、glitch、chromatic、mosaic、ripple は px、noise、vignette、scanlines、zoom-blur は %、radial-blur は回す角度。shader はシェーダーの u_strength。省略時は種類ごとの既定）",
      ),
      speed: t.number("動きの速さの倍率（0 で止める）", "1"),
      color: t.color("色（vignette と scanlines。省略時は黒）"),
      x: t.number("中心の横の位置（radial-blur、zoom-blur、ripple、shader。左端からの %）", "50"),
      y: t.number("中心の縦の位置（左上からの %）", "50"),
      file: t.asset("others", "作品のシェーダー（shader。GLSL ES 1.0 のフラグメントシェーダー）"),
      values: t.string("シェーダーに渡す値（「glow=0.5 tint=0.2」。uniform float で受け取る）"),
      mask: t.string(`${MASK_DOC}。wave、glitch、chromatic は範囲を決められず全体にかかる`),
      fade: t.duration("かけ始めるときに、強さを 0 から上げていく時間", "0ms"),
      time: t.duration("この時間だけかけたら外れる（一回きりの演出。状態に残さない）。省くと @effect-off まで"),
      wait: t.bool("fade= か time= のとき、かけ終わるまで（time= なら外れるまで）次に進まない", false),
      skip: t.skip(),
    },
    example: "@effect zoom-blur strength=20 x=50 y=40",
    apply(args, extra) {
      // time= の一回きりの効果は状態に残さない（描画側がかけて外す）
      if (typeof args.time === "number") return;
      const all = { ...readEffects(extra) };
      all[text(args.name, text(args.type, "wave"))] = effectFrom(args);
      writeEffects(extra, all);
    },
  },
  {
    name: "effect-off",
    summary: "@effect でかけた画面効果を解除する",
    positional: ["name"],
    params: {
      name: t.string("解除する名前（省略するとすべて）"),
      fade: t.duration("外すときに、強さを 0 まで下げていく時間", "0ms"),
      wait: t.bool("外し終わるまで次に進まない", false),
      skip: t.skip(),
    },
    example: "@effect-off glitch fade=500ms",
    apply(args, extra) {
      if (args.name === undefined) writeEffects(extra, {});
      else {
        const all = { ...readEffects(extra) };
        delete all[text(args.name)];
        writeEffects(extra, all);
      }
    },
  },
];
