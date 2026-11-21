import type { Args, Value } from "@liminalia/runtime";
import { t, type CommandDefinition, type ParamDefinition } from "@liminalia/sdk";
import type { Look } from "./anim.ts";

/**
 * 画像・レイヤー・合成・フィルタまわり（TyranoScript 組み込みの [image] [freeimage] [layopt] [layermode]
 * [filter] [chara_move] と、TyranoBuilder のマクロ tb_image_* / tb_chara_shake、TyranoBuilder の
 * フィルタのプラグイン tb_filter_* / tb_free_filter）。
 *
 * TyranoScript のレイヤーは次の名前で書く。重ね順は下から base → fg0 → fg1 → fg2 → 合成（@blend）→ メッセージ枠。
 *   base … 背景の層（.lim では @bg の背景）
 *   fg0  … layer=0（立ち絵の層。TyranoScript ではここに文字の演出なども置かれる）
 *   fg1  … layer=1（TyranoBuilder の画像表示）
 *   fg2  … layer=2
 * 表示し続ける画像・合成・フィルタ・立ち絵の移動は stage.extra に持ち、ロード時に組み立て直す。
 */

/** ease で使えるイージングの名前（jQuery の easing 名。web/image.ts の EASINGS と同じ並び）。制作画面の候補に出す。 */
export const EASING_NAMES = ["swing", "linear", "easeInSine", "easeOutSine", "easeInOutSine", "easeInQuad", "easeOutQuad", "easeInOutQuad", "easeInCubic", "easeOutCubic", "easeInOutCubic", "easeInQuart", "easeOutQuart", "easeInOutQuart", "easeInExpo", "easeOutExpo", "easeInOutExpo", "easeInBack", "easeOutBack", "easeInOutBack"] as const;

export const IMAGE_LAYERS = ["fg0", "fg1", "fg2"] as const;
export type ImageLayer = (typeof IMAGE_LAYERS)[number];
export const FILTER_LAYERS = ["base", ...IMAGE_LAYERS] as const;
export type FilterLayer = (typeof FILTER_LAYERS)[number];

/** [image] で置いた画像。 */
export interface PlacedImage {
  kind: "image";
  file: string;
  folder: string;
  name: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  /** 画像の中の切り出す範囲（@image の sx・sy・sw・sh）。 */
  crop?: { x: number; y: number; width: number; height: number };
  zindex: number;
  flip: boolean;
  /** @anim / @kanim で動かしたあとの姿。 */
  look?: Look;
}

/**
 * レイヤーに置いたもの。kind が "image" 以外のものはプラグインが足す種類（描画は @liminalia/std/web の
 * registerLayerItem で登録する）。@free-image は種類に関係なくレイヤーごと消す。
 */
export type LayerItem = PlacedImage | ForeignLayerItem;

export interface ForeignLayerItem {
  kind: string;
  [key: string]: unknown;
}

export interface LayerOption {
  visible?: boolean;
  /** 0〜1。 */
  opacity?: number;
  left?: number;
  top?: number;
}

/** [layermode] の合成レイヤー。movie があれば動画を重ねる（@blend-movie）。 */
export interface Blend {
  name: string;
  graphic: string;
  folder: string;
  color: string;
  mode: string;
  /** 0〜1。 */
  opacity: number;
  movie?: BlendMovie;
}

/** @blend-movie の動画（繰り返すものだけが状態に残る）。 */
export interface BlendMovie {
  file: string;
  /** 0〜100。 */
  volume: number;
  speed: number;
  fit: boolean;
  left: number | null;
  top: number | null;
  width: number | null;
  height: number | null;
}

/** [chara_move] で動かした立ち絵の位置と大きさ。sprite は動かしたときの立ち絵の状態（@chara で替わったら無効）。 */
export interface SpriteMove {
  sprite: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

/**
 * 効果をかける範囲（@filter と @effect の mask="radial x y 幅 高さ ぼかし"）。x・y は楕円の中心、width・height は楕円の大きさ、soft は縁のぼかし（どれも px）。
 * radial は楕円の内側に、radial-out は外側にかける。
 */
export interface EffectMask {
  shape: "radial" | "radial-out";
  x: number;
  y: number;
  width: number;
  height: number;
  soft: number;
}

/** 範囲を決めた @filter（css はかけるフィルタ）。範囲の中の、base は背景、fg0 は背景と立ち絵、fg1・fg2 は前景まですべてにかかる。 */
export type MaskedFilter = EffectMask & { css: string };

/** stage.extra に置く状態。 */
export interface ImageExtra {
  images?: Partial<Record<ImageLayer, LayerItem[]>>;
  layerOptions?: Partial<Record<ImageLayer, LayerOption>>;
  blends?: Blend[];
  filters?: Partial<Record<FilterLayer, string>>;
  /** 範囲を決めた @filter（レイヤーごと。layer=all は fg2 に置く）。 */
  filterMasks?: Partial<Record<FilterLayer, MaskedFilter>>;
  spriteMoves?: Record<string, SpriteMove>;
}

/** stage.extra のキー（プラグインの状態とぶつからないよう接頭辞を付ける）。 */
export const EXTRA_KEYS = {
  images: "image.layers",
  layerOptions: "image.layerOptions",
  blends: "image.blends",
  filters: "image.filters",
  filterMasks: "image.filterMasks",
  spriteMoves: "image.spriteMoves",
} as const satisfies Record<keyof ImageExtra, string>;

export function readExtra<K extends keyof ImageExtra>(extra: Record<string, Value>, key: K): NonNullable<ImageExtra[K]> | undefined {
  return extra[EXTRA_KEYS[key]] as unknown as NonNullable<ImageExtra[K]> | undefined;
}

/** 空になったらキーごと消す（セーブを小さく保つ）。 */
export function writeExtra<K extends keyof ImageExtra>(extra: Record<string, Value>, key: K, value: ImageExtra[K] | undefined): void {
  const empty = value === undefined || (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0);
  if (empty) delete extra[EXTRA_KEYS[key]];
  else extra[EXTRA_KEYS[key]] = value as unknown as Value;
}

export const num = (v: Value | undefined): number | null => (typeof v === "number" ? v : null);
export const text = (v: Value | undefined, d = ""): string => (typeof v === "string" ? v : d);

/** TyranoScript の不透明度（0〜255）を 0〜1 にする。 */
const opacity255 = (v: Value | undefined, d: number): number => (typeof v === "number" ? Math.max(0, Math.min(1, v / 255)) : d);

export const imageLayerParam = (doc: string): ParamDefinition => t.enum([...IMAGE_LAYERS], doc, "fg1");
export const folderParam = (def: string): ParamDefinition => t.enum(["fgimage", "image", "bgimage"], "素材のフォルダ", def);
/** 省略時は「変えない」引数（既定値を持たない真偽）。 */
const optionalBool = (doc: string): ParamDefinition => ({ type: { kind: "bool" }, doc });

const imageCommand: CommandDefinition = {
  name: "image",
  summary: "前景レイヤーに画像を置く（図版など）。@free-image で消すまで残る",
  positional: ["file"],
  params: {
    file: t.required(t.asset("fgimage", "画像（folder の中のパス）")),
    layer: imageLayerParam("置くレイヤー（fg0〜fg2）"),
    folder: folderParam("fgimage"),
    name: t.string("名前（@free-image name= でこの画像だけを消すときに使う）"),
    x: t.number("左端（px）", "0"),
    y: t.number("上端（px）", "0"),
    width: t.number("幅（px）。省略時は画像の大きさ"),
    height: t.number("高さ（px）。省略時は画像の大きさ"),
    sx: t.number("切り出す範囲の左端（px。一枚の絵に並べた素材の一部だけを出す）"),
    sy: t.number("切り出す範囲の上端（px）"),
    sw: t.number("切り出す範囲の幅（px。書くと sx・sy・sh とあわせて切り出す）"),
    sh: t.number("切り出す範囲の高さ（px）"),
    zindex: t.int("レイヤーの中での重なり順", "1"),
    time: t.duration("表示にかける時間", "0ms"),
    wait: t.bool("表示し終わるまで次に進まない", true),
    skip: t.skip(),
    flip: t.bool("左右反転", false),
    depth: t.enum(["front", "back"], "レイヤーの中で前に追加するか後ろに追加するか", "front"),
    alt: t.text("絵の説明（画面には出さず、スクリーンリーダーとテキスト読み上げに次の本文と一緒に渡す）"),
  },
  example: "@image maps/town.png folder=image zindex=9 time=500ms width=1280 height=720",
  waits: true,
  apply(args, extra) {
    const layer = text(args.layer, "fg1") as ImageLayer;
    const item: PlacedImage = {
      kind: "image",
      file: text(args.file),
      folder: text(args.folder, "fgimage"),
      name: text(args.name),
      x: num(args.x) ?? 0,
      y: num(args.y) ?? 0,
      width: num(args.width),
      height: num(args.height),
      zindex: num(args.zindex) ?? 1,
      flip: args.flip === true,
      ...(num(args.sw) !== null && num(args.sh) !== null ? { crop: { x: num(args.sx) ?? 0, y: num(args.sy) ?? 0, width: num(args.sw)!, height: num(args.sh)! } } : {}),
    };
    const images = { ...(readExtra(extra, "images") ?? {}) };
    const list = [...(images[layer] ?? [])];
    if (args.depth === "back") list.unshift(item);
    else list.push(item);
    images[layer] = list;
    writeExtra(extra, "images", images);
  },
};

const freeImageCommand: CommandDefinition = {
  name: "free-image",
  summary: "レイヤーに置いたものをすべて消す（name を書けばその名前の画像だけ）。base なら背景を消す",
  positional: ["layer"],
  params: {
    layer: t.required(t.enum(["base", ...IMAGE_LAYERS], "消すレイヤー（base / fg0〜fg2）")),
    name: t.string("この名前（@image の name）の画像だけを消す。省くとレイヤーのものをすべて"),
    time: t.duration("消すのにかける時間", "0ms"),
    wait: t.bool("消し終わるまで次に進まない", true),
    skip: t.skip(),
  },
  example: "@free-image fg1 name=map time=500ms",
  async run(args, ctx) {
    const layer = text(args.layer);
    const name = text(args.name);
    const extra = ctx.state.stage.extra;
    if (layer === "base") {
      ctx.state.stage.background = null;
      delete ctx.state.stage.backgroundColor;
    } else {
      const images = { ...(readExtra(extra, "images") ?? {}) };
      if (name) {
        const left = (images[layer as ImageLayer] ?? []).filter((item) => item.name !== name);
        if (left.length > 0) images[layer as ImageLayer] = left;
        else delete images[layer as ImageLayer];
      } else delete images[layer as ImageLayer];
      writeExtra(extra, "images", images);
    }
    await ctx.present(args, args.wait !== false);
  },
};

const layerCommand: CommandDefinition = {
  name: "layer",
  summary: "前景レイヤーの表示、不透明度、位置を変える。メッセージウィンドウの表示、非表示は @window で書く",
  positional: ["layer"],
  params: {
    layer: t.required(
      t.enum([...IMAGE_LAYERS, "message1"], "レイヤー（fg0〜fg2。message1 は吹き出し用の 2 つ目のメッセージウィンドウで、Liminalia にはないので何もしない）"),
    ),
    visible: optionalBool("表示するか（省略時は変えない）"),
    opacity: t.int("不透明度（0〜255。省略時は変えない）"),
    left: t.number("横へのずれ（px。省略時は変えない）"),
    top: t.number("縦へのずれ（px。省略時は変えない）"),
  },
  example: "@layer fg2 visible=false",
  apply(args, extra) {
    const layer = text(args.layer);
    if (layer === "message1") return;
    const options = { ...(readExtra(extra, "layerOptions") ?? {}) };
    const o: LayerOption = { ...(options[layer as ImageLayer] ?? {}) };
    if (typeof args.visible === "boolean") o.visible = args.visible;
    if (typeof args.opacity === "number") o.opacity = opacity255(args.opacity, 1);
    if (typeof args.left === "number") o.left = args.left;
    if (typeof args.top === "number") o.top = args.top;
    options[layer as ImageLayer] = o;
    writeExtra(extra, "layerOptions", options);
  },
};

export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "plus-lighter",
];

const blendCommand: CommandDefinition = {
  name: "blend",
  summary: "画面全体に色か画像を合成モードで重ねる（メッセージウィンドウの下）。@blend-off で消すまで残る",
  params: {
    name: t.string("名前（@blend-off で個別に消すのに使う）"),
    graphic: t.asset("image", "重ねる画像（folder の中のパス。原寸で敷き詰める）"),
    folder: folderParam("image"),
    color: t.color("重ねる色"),
    mode: t.enum(BLEND_MODES, "合成モード（CSS の mix-blend-mode）", "multiply"),
    opacity: t.int("不透明度（0〜255）", "255"),
    time: t.duration("表示にかける時間", "500ms"),
    wait: t.bool("表示し終わるまで次に進まない", true),
    skip: t.skip(),
  },
  example: "@blend name=memory graphic=effects/vignette.png mode=normal time=500ms wait=false",
  waits: true,
  apply(args, extra) {
    const blend: Blend = {
      name: text(args.name),
      graphic: text(args.graphic),
      folder: text(args.folder, "image"),
      color: text(args.color),
      mode: text(args.mode, "multiply"),
      opacity: opacity255(args.opacity, 1),
    };
    writeExtra(extra, "blends", [...(readExtra(extra, "blends") ?? []), blend]);
  },
};

const blendOffCommand: CommandDefinition = {
  name: "blend-off",
  summary: "@blend で重ねたものを消す。name を省くとすべて消す",
  params: {
    name: t.string("消す名前（省略時はすべて）"),
    time: t.duration("消すのにかける時間", "500ms"),
    wait: t.bool("消し終わるまで次に進まない", true),
    skip: t.skip(),
  },
  example: "@blend-off name=memory time=400ms wait=false",
  waits: true,
  apply(args, extra) {
    const name = text(args.name);
    writeExtra(
      extra,
      "blends",
      (readExtra(extra, "blends") ?? []).filter((b) => name !== "" && b.name !== name),
    );
  },
};

const FILTER_FUNCTIONS: [param: string, css: string, unit: string][] = [
  ["grayscale", "grayscale", "%"],
  ["sepia", "sepia", "%"],
  ["saturate", "saturate", "%"],
  ["hue", "hue-rotate", "deg"],
  ["invert", "invert", "%"],
  ["opacity", "opacity", "%"],
  ["brightness", "brightness", "%"],
  ["contrast", "contrast", "%"],
  ["blur", "blur", "px"],
];

export const MASK_SHAPES = ["radial", "radial-out"] as const;

/** mask= の説明（@filter と @effect）。 */
export const MASK_DOC =
  "かける範囲。\"radial x y 幅 高さ\" か \"radial x y 幅 高さ ぼかし\" で書く。x・y は楕円の中心、幅と高さは楕円の大きさ、ぼかしは縁をぼかす長さで、どれも px。radial-out にすると楕円の外側にかける。省くと全体";

/**
 * mask= の値（"radial 640 360 400 300 60"）を読む。読めなければ null。ぼかしを省くと幅と高さの小さいほうの 4 分の 1。
 */
export function parseMask(v: Value | undefined): EffectMask | null {
  if (typeof v !== "string") return null;
  const parts = v.trim().split(/[\s,、]+/).filter(Boolean);
  const shape = parts[0];
  if (shape !== "radial" && shape !== "radial-out") return null;
  const nums = parts.slice(1).map(Number);
  if (nums.length < 4 || nums.length > 5 || nums.some((n) => !Number.isFinite(n))) return null;
  const [x, y, width, height, soft] = nums as [number, number, number, number, number | undefined];
  if (width <= 0 || height <= 0) return null;
  return { shape, x, y, width, height, soft: Math.max(0, soft ?? Math.min(width, height) / 4) };
}

/** 範囲の CSS の mask-image（内側を見せる。outside なら外側）。 */
export function maskImage(m: EffectMask, outside = m.shape === "radial-out"): string {
  // 楕円の縁（幅と高さの半分）で終わり、soft の分だけ内側から薄くしていく
  const rx = m.width / 2;
  const ry = m.height / 2;
  const inner = Math.max(0, Math.min(100, (1 - m.soft / Math.max(1, Math.min(rx, ry))) * 100));
  const [a, b] = outside ? ["transparent", "#000"] : ["#000", "transparent"];
  return `radial-gradient(${rx}px ${ry}px at ${m.x}px ${m.y}px, ${a} ${inner.toFixed(1)}%, ${b} 100%)`;
}

/**
 * 範囲を決めた WebGL の効果で、元の絵に掛けるマスク。効果の絵（maskImage の範囲）が覆いきる所だけを隠し、ぼかしの縁では元の絵を残す
 * （縁で元の絵まで薄くすると、効果の絵と合わせても下の黒が透けて暗い輪になる）。radial は内側のぼかしの始まりまで、radial-out は楕円の外を隠す。
 */
export function coverMask(m: EffectMask): string {
  const rx = m.width / 2;
  const ry = m.height / 2;
  const at = `${rx}px ${ry}px at ${m.x}px ${m.y}px`;
  if (m.shape === "radial-out") return `radial-gradient(${at}, #000 100%, transparent 100%)`;
  const inner = Math.max(0, Math.min(100, (1 - m.soft / Math.max(1, Math.min(rx, ry))) * 100)).toFixed(1);
  return `radial-gradient(${at}, transparent ${inner}%, #000 ${inner}%)`;
}

/** TyranoScript [filter] の buildFilterPropertyValue と同じ順で CSS の filter を組む。 */
export function filterCss(args: Args): string {
  return FILTER_FUNCTIONS.flatMap(([p, css, unit]) => (typeof args[p] === "number" ? [`${css}(${args[p]}${unit})`] : [])).join(" ");
}

const filterCommand: CommandDefinition = {
  name: "filter",
  summary: "レイヤーに CSS のフィルタをかける（前のフィルタは置き換える）。@filter-off で解除するまで残る",
  params: {
    layer: t.enum(["all", ...FILTER_LAYERS], "かけるレイヤー（all は base と fg0〜fg2 のそれぞれ）", "all"),
    grayscale: t.number("白黒（%）"),
    sepia: t.number("セピア（%）"),
    saturate: t.number("彩度（%）"),
    hue: t.number("色相の回転（度）"),
    invert: t.number("色の反転（%）"),
    opacity: t.number("不透明度（%）"),
    brightness: t.number("明るさ（%）"),
    contrast: t.number("コントラスト（%）"),
    blur: t.number("ぼかし（px）"),
    mask: t.string(`${MASK_DOC}。範囲を決めると、その範囲の中で、base は背景に、fg0 は背景と立ち絵に、fg1・fg2・all は前景まですべてにかかる`),
    time: t.duration("前のフィルタから切り替えるのにかける時間", "0ms"),
    wait: t.bool("切り替え終わるまで次に進まない", false),
    skip: t.skip(),
  },
  example: "@filter grayscale=100 time=600ms",
  apply(args, extra) {
    const layer = text(args.layer, "all");
    const filters = { ...(readExtra(extra, "filters") ?? {}) };
    const masks = { ...(readExtra(extra, "filterMasks") ?? {}) };
    const css = filterCss(args);
    const mask = parseMask(args.mask);
    const layers = layer === "all" ? FILTER_LAYERS : [layer as FilterLayer];
    for (const l of layers) {
      delete masks[l];
      if (mask) delete filters[l];
      else filters[l] = css;
    }
    // 範囲を決めたフィルタは、そのレイヤーより下にもかかる。全体（all）は一番上の fg2 に一つだけ置く
    if (mask) masks[layer === "all" ? "fg2" : (layer as FilterLayer)] = { ...mask, css };
    writeExtra(extra, "filters", filters);
    writeExtra(extra, "filterMasks", masks);
  },
};

const filterOffCommand: CommandDefinition = {
  name: "filter-off",
  summary: "@filter でかけたフィルタを解除する",
  params: {
    layer: t.enum(["all", ...FILTER_LAYERS], "解除するレイヤー（all はすべて）", "all"),
    time: t.duration("外すのにかける時間", "0ms"),
    wait: t.bool("外し終わるまで次に進まない", false),
    skip: t.skip(),
  },
  example: "@filter-off time=600ms",
  apply(args, extra) {
    const layer = text(args.layer, "all");
    if (layer === "all") {
      writeExtra(extra, "filters", undefined);
      writeExtra(extra, "filterMasks", undefined);
      return;
    }
    const filters = { ...(readExtra(extra, "filters") ?? {}) };
    const masks = { ...(readExtra(extra, "filterMasks") ?? {}) };
    delete filters[layer as FilterLayer];
    delete masks[layer as FilterLayer];
    writeExtra(extra, "filters", filters);
    writeExtra(extra, "filterMasks", masks);
  },
};

/** 立ち絵の状態を比べるための文字列（@chara で別の表示に替わったら移動は無効になる）。立ち絵に付いたプラグインの状態（extra）は見ない。 */
export function spriteKey(sprite: unknown): string {
  if (sprite && typeof sprite === "object" && "extra" in sprite) {
    const { extra: _extra, ...rest } = sprite as Record<string, unknown>;
    return JSON.stringify(rest);
  }
  return JSON.stringify(sprite ?? null);
}

const spriteMoveCommand: CommandDefinition = {
  name: "chara-move",
  summary: "表示中の立ち絵の位置と大きさを変える（次に @chara するまで）",
  positional: ["who"],
  params: {
    who: { type: { kind: "cast", shown: true }, required: true, doc: "キャラクター ID" },
    time: t.duration("動かすのにかける時間", "600ms"),
    anim: t.bool("滑らかに動かす（false なら一度消えて現れる）", false),
    left: t.number("左端（px）"),
    top: t.number("上端（px）"),
    width: t.number("幅（px）"),
    height: t.number("高さ（px）"),
    ease: t.string("イージング（jQuery の easing 名）", "swing", EASING_NAMES),
    wait: t.bool("動き終わるまで次に進まない", true),
    skip: t.skip(),
  },
  example: "@chara-move ユイカ time=260ms anim=true left=362 top=39 width=544 height=967 ease=easeOutQuad wait=false",
  async run(args, ctx) {
    const who = text(args.who);
    const sprite = ctx.state.stage.sprites[who];
    // TyranoScriptは表示していない立ち絵には何もしない。
    if (!sprite) return;
    const extra = ctx.state.stage.extra;
    const moves = { ...(readExtra(extra, "spriteMoves") ?? {}) };
    const key = spriteKey(sprite);
    const prev = moves[who]?.sprite === key ? moves[who] : undefined;
    const move: SpriteMove = { ...(prev ?? {}), sprite: key };
    for (const k of ["left", "top", "width", "height"] as const) {
      const v = num(args[k]);
      if (v !== null) move[k] = v;
    }
    moves[who] = move;
    writeExtra(extra, "spriteMoves", moves);
    // @anim で動かした位置・大きさのうち、書き直した項目はこちらが勝つ。
    const looks = extra["anim.sprites"] as unknown as Record<string, { look: Look }> | undefined;
    const box = looks?.[who]?.look.box;
    if (box) for (const k of ["left", "top", "width", "height"] as const) if (num(args[k]) !== null) delete box[k];
    await ctx.present(args, args.wait !== false);
  },
};

const spriteShakeCommand: CommandDefinition = {
  name: "chara-shake",
  summary: "立ち絵を揺らす（TyranoBuilder のキャラクター揺らし）。終わりを待たない",
  positional: ["who"],
  params: {
    who: { type: { kind: "cast", shown: true }, required: true, doc: "キャラクター ID" },
    direction: t.enum(["x", "y"], "揺らす向き", "y"),
    count: t.int("回数", "5"),
    swing: t.required(t.number("振れ幅（px）")),
    time: t.duration("一回にかける時間", "500ms"),
  },
  example: "@chara-shake ユイカ count=1 swing=20",
  waits: false,
};

export const COMMANDS: CommandDefinition[] = [
  imageCommand,
  freeImageCommand,
  layerCommand,
  blendCommand,
  blendOffCommand,
  filterCommand,
  filterOffCommand,
  spriteMoveCommand,
  spriteShakeCommand,
];
