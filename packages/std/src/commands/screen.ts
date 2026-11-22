import type { Value } from "@liminalia/runtime";
import { RULE_PARAMS, t, type CommandDefinition, type ParamDefinition } from "@liminalia/plugin-host";
import { EASING_NAMES, FILTER_LAYERS, num, text, type FilterLayer } from "./image.ts";

/** @layer-camera の ease の候補（CSS の ease と jQuery の easing 名）。 */
const CAMERA_EASE = ["ease", ...EASING_NAMES.filter((n) => n !== "swing")];

/**
 * 画面全体の演出（TyranoScript 組み込みの [backlay] [trans] [wt] [bg2] [quake2] [vibrate] [vibrate_stop]、
 * [camera] / [reset_camera] の layer 指定、[wait_camera]）。
 */

/** 画像の出し入れの動き（@liminalia/web の TRANSITION_METHODS と同じ）。 */
export const METHODS = ["crossfade", "fadeIn", "fadeInLeft", "fadeInRight", "fadeInUp", "fadeInDown", "slideInLeft", "slideInRight", "slideInUp", "slideInDown", "puffIn", "vanishIn"];
const methodParam = (doc: string): ParamDefinition => t.enum(METHODS, doc, "crossfade");

// ---- [backlay] / [trans] / [wt] ----

/**
 * TyranoScript の裏ページ（[backlay] で表を写し、page=back で組み替え、[trans] で表に出す）は、このエンジンでは
 * 「今の画面を写真のように止めて（@freeze）、その下で組み替え、@transition で写真から新しい画面へ切り替える」で書く。
 * 止めている間の命令はすべて表の状態を変えるので、セーブには切り替えたあとの画面が残る（止めた写真は残らない）。
 */
const freezeCommand: CommandDefinition = {
  name: "freeze",
  summary: "今の画面（背景、立ち絵、前景）を静止させて表示したまま、その下で組み替えられるようにする。@transition で切り替える",
  params: {},
  example: "@freeze",
};

const transitionCommand: CommandDefinition = {
  name: "transition",
  summary: "@freeze で止めた画面から、組み替えたあとの画面へ切り替える",
  params: {
    method: methodParam("切り替え方（@bg の method と同じ動き）"),
    time: t.duration("切り替えにかける時間", "1500ms"),
    ...RULE_PARAMS,
    wait: t.bool("切り替え終わるまで次に進まない", true),
    skip: t.skip(),
  },
  example: "@transition method=fadeInLeft time=800ms",
  waits: true,
};

const waitTransitionCommand: CommandDefinition = {
  name: "wait-transition",
  summary: "@transition の切り替えが終わるまで待つ",
  params: {},
  example: "@wait-transition",
  waits: true,
};

// ---- [bg2] ----

/** @bg-place で置いた背景の位置と大きさ。image は置いた背景（@bg で替わったら無効）。 */
export interface BgPlace {
  image: string;
  left: number;
  top: number;
  width: number | null;
  height: number | null;
}

export const SCREEN_KEYS = {
  bgPlace: "screen.bgPlace",
  layerCameras: "screen.layerCameras",
  bgMovie: "screen.bgMovie",
} as const;

export function bgPlace(extra: Record<string, Value>): BgPlace | undefined {
  return extra[SCREEN_KEYS.bgPlace] as unknown as BgPlace | undefined;
}

const bgPlaceCommand: CommandDefinition = {
  name: "bg-place",
  summary: "背景を、位置と大きさを決めて切り替える（画面より大きい背景をあとで @anim で動かすときなど）",
  positional: ["image"],
  params: {
    image: t.required(t.asset("bgimage", "背景画像", { cg: true })),
    left: t.number("左端（px）", "0"),
    top: t.number("上端（px）", "0"),
    width: t.number("幅（px）。省略時は画面の幅"),
    height: t.number("高さ（px）。省略時は画面の高さ"),
    time: t.duration("切り替えにかける時間", "0ms"),
    method: methodParam("切り替え方"),
    cross: t.bool("新旧の背景を重ねて切り替える", false),
    wait: t.bool("切り替え終わるまで次に進まない", true),
    skip: t.skip(),
  },
  example: "@bg-place wide_street.jpg width=1920 height=720 time=1s",
  async run(args, ctx) {
    const stage = ctx.state.stage;
    stage.background = text(args.image);
    delete stage.backgroundColor;
    const place: BgPlace = { image: text(args.image), left: num(args.left) ?? 0, top: num(args.top) ?? 0, width: num(args.width), height: num(args.height) };
    stage.extra[SCREEN_KEYS.bgPlace] = place as unknown as Value;
    await ctx.present(args, args.wait !== false);
  },
};

// ---- [quake2] / [vibrate] ----

const quakeDecayCommand: CommandDefinition = {
  name: "quake-decay",
  summary: "メッセージウィンドウも含めた画面全体を、だんだん弱まるように揺らす",
  params: {
    time: t.duration("揺れの長さ", "1s"),
    horizontal: t.number("横の揺れ幅（px。揺れ始め）", "0"),
    vertical: t.number("縦の揺れ幅（px。揺れ始め）", "200"),
    "fill-edges": t.bool("揺れて空いた画面の端を背景の複製で埋める", true),
    wait: t.bool("揺れ終わるまで次に進まない", true),
    skip: t.skip(),
  },
  example: "@quake-decay time=800ms vertical=40",
  waits: true,
};

const vibrateCommand: CommandDefinition = {
  name: "vibrate",
  summary: "端末を振動させる。対象はスマホのアプリと、Vibration API に対応したブラウザ（iOS のアプリは触覚）で、つないでいるゲームパッドも振動させる。対応しなければ何もしない。終わりを待たない",
  params: {
    time: t.duration("一回の振動の長さ", "500ms"),
    count: t.int("回数（振動と同じ長さの休みを挟む）", "1"),
  },
  example: "@vibrate time=200ms count=3",
};

const vibrateStopCommand: CommandDefinition = {
  name: "vibrate-stop",
  summary: "端末の振動を止める",
  params: {},
  example: "@vibrate-stop",
};

// ---- [camera] / [reset_camera] の layer ----

/** レイヤーごとのカメラ（@camera と同じ意味の値）。 */
export interface LayerCamera {
  zoom: number;
  x: number;
  y: number;
  rotate: number;
}

export function layerCameras(extra: Record<string, Value>): Partial<Record<FilterLayer, LayerCamera>> {
  return (extra[SCREEN_KEYS.layerCameras] as unknown as Partial<Record<FilterLayer, LayerCamera>> | undefined) ?? {};
}

const cameraLayerParam = t.required(t.enum([...FILTER_LAYERS], "動かすレイヤー（base / fg0〜fg2）"));

const layerCameraCommand: CommandDefinition = {
  name: "layer-camera",
  summary: "一つのレイヤーだけをズーム、移動、回転させる（画面全体は @camera）",
  positional: ["layer"],
  params: {
    layer: cameraLayerParam,
    zoom: t.number("倍率（1 で等倍）"),
    x: t.number("カメラの横位置（px）。正で右へ動き、レイヤーの中身は左へ流れる"),
    y: t.number("カメラの縦位置（px）。正で下へ動き、レイヤーの中身は上へ流れる"),
    rotate: t.number("回転の角度（度）"),
    "from-zoom": t.number("開始時の倍率。省略時は現在の値"),
    "from-x": t.number("開始時の横位置"),
    "from-y": t.number("開始時の縦位置"),
    "from-rotate": t.number("開始時の回転の角度"),
    time: t.duration("動きにかける時間", "1s"),
    ease: t.string("イージング（ease / easeOutSine など）", "ease", CAMERA_EASE),
    wait: t.bool("動き終わるまで次に進まない", true),
    skip: t.skip(),
  },
  example: "@layer-camera base zoom=1.2 x=80 time=2s wait=false",
  waits: true,
  apply(args, extra) {
    const layer = text(args.layer) as FilterLayer;
    const cameras = { ...layerCameras(extra) };
    const c = { ...(cameras[layer] ?? { zoom: 1, x: 0, y: 0, rotate: 0 }) };
    for (const k of ["zoom", "x", "y", "rotate"] as const) {
      const v = num(args[k]);
      if (v !== null) c[k] = v;
    }
    cameras[layer] = c;
    extra[SCREEN_KEYS.layerCameras] = cameras as unknown as Value;
  },
};

const resetLayerCameraCommand: CommandDefinition = {
  name: "reset-layer-camera",
  summary: "@layer-camera で動かしたレイヤーを元に戻す",
  positional: ["layer"],
  params: {
    layer: cameraLayerParam,
    time: t.duration("戻すのにかける時間", "1s"),
    ease: t.string("イージング", "ease", CAMERA_EASE),
    wait: t.bool("戻り終わるまで次に進まない", true),
    skip: t.skip(),
  },
  example: "@reset-layer-camera base time=400ms",
  waits: true,
  apply(args, extra) {
    const cameras = { ...layerCameras(extra) };
    delete cameras[text(args.layer) as FilterLayer];
    if (Object.keys(cameras).length === 0) delete extra[SCREEN_KEYS.layerCameras];
    else extra[SCREEN_KEYS.layerCameras] = cameras as unknown as Value;
  },
};

const waitCameraCommand: CommandDefinition = {
  name: "wait-camera",
  summary: "@camera と @layer-camera の動きが終わるまで待つ",
  params: {},
  example: "@wait-camera",
  waits: true,
};

export const COMMANDS: CommandDefinition[] = [
  freezeCommand,
  transitionCommand,
  waitTransitionCommand,
  bgPlaceCommand,
  quakeDecayCommand,
  vibrateCommand,
  vibrateStopCommand,
  layerCameraCommand,
  resetLayerCameraCommand,
  waitCameraCommand,
];
