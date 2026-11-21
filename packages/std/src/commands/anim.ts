import { EvalError, type Args, type StageState, type Value } from "@liminalia/runtime";
import { t, type CommandDefinition, type ParamDefinition } from "@liminalia/sdk";
import { EASING_NAMES, IMAGE_LAYERS, num, readExtra, spriteKey, text, writeExtra, type ImageLayer, type LayerItem } from "./image.ts";

/**
 * 要素を動かす演出（TyranoScript 組み込みの [anim] [stopanim] [wa] [keyframe] [frame] [endkeyframe]
 * [kanim] [stop_kanim] [xanim] [stop_xanim]）。
 *
 * 書き方の誤り（対象の指定・@keyframe のコマ）は EvalError にして、実行時の診断として位置付きで出す。
 *
 * 対象は名前（キャスト名、@image / @layer-text の name）か、前景レイヤー（fg0〜fg2 の中のものすべて。fg0 は立ち絵も含む）。
 * 動かした結果は「最後の姿」（Look）として対象ごとに状態に持つ。前景の画像・文字は stage.extra の画像の一覧の
 * 項目そのもの（item.look）に、立ち絵は "anim.sprites" に持つ。ロード時は動きの途中でも最後の姿で組み立て直す
 * （TyranoScript もセーブの直前に [anim] を終わりまで飛ばす）。止めるまで繰り返す動き（@kanim loop=true）は
 * 状態に残し、ロード時に頭から動かし直す（TyranoScript も同じ）。
 */

export type BoxKey = "left" | "top" | "width" | "height";
export const BOX_KEYS: readonly BoxKey[] = ["left", "top", "width", "height"];

/** 位置と大きさ。to は絶対値（null なら元の値）、by はそこからの増減。 */
export interface BoxValue {
  to: number | null;
  by: number;
}

/** 動かしたあとの姿。 */
export interface Look {
  box?: Partial<Record<BoxKey, BoxValue>>;
  /** CSS のプロパティ（opacity・color、@kanim のフレームに書いたもの）。 */
  style?: Record<string, string>;
  /** 変形の部品（@kanim のフレームの x / y / scale / rotate など。書いた順）。 */
  transform?: Record<string, string>;
  /** 止めるまで繰り返している @kanim。 */
  loop?: KanimLoop;
}

/** @keyframe の一コマ。at は 0〜100（%）。 */
export interface Frame {
  at: number;
  transform: Record<string, string>;
  style: Record<string, string>;
}

export interface KanimOptions {
  time: number;
  easing: string;
  count: number;
  loop: boolean;
  delay: number;
  direction: string;
  keep: boolean;
  reset: boolean;
}

export interface KanimLoop {
  frames: Frame[];
  options: KanimOptions;
}

/**
 * 立ち絵の姿。sprite は動かしたときの立ち絵の状態。@chara で替わると DomHost が位置・大きさを立ち位置に戻し、
 * 不透明度を 1 にして切り替えるので、それらは無効にする。変形とほかの CSS は表示している間は残す
 * （画面でも残る。TyranoScript の [chara_mod] は要素をそのまま使うので、不透明度も残る点が違う）。
 */
export interface SpriteLook {
  sprite: string;
  look: Look;
}

/** 今の立ち絵に当たる姿（立ち絵の状態が替わっていれば位置と大きさを外す）。 */
export function currentSpriteLook(entry: SpriteLook | undefined, sprite: string): Look {
  if (!entry) return {};
  if (entry.sprite === sprite) return entry.look;
  const { box: _, style, ...rest } = entry.look;
  const { opacity: __, ...others } = style ?? {};
  return Object.keys(others).length > 0 ? { ...rest, style: others } : rest;
}

export const ANIM_KEYS = {
  sprites: "anim.sprites",
  keyframes: "anim.keyframes",
} as const;

export function spriteLooks(extra: Record<string, Value>): Record<string, SpriteLook> {
  return (extra[ANIM_KEYS.sprites] as unknown as Record<string, SpriteLook> | undefined) ?? {};
}

export function keyframes(extra: Record<string, Value>): Record<string, Frame[]> {
  return (extra[ANIM_KEYS.keyframes] as unknown as Record<string, Frame[]> | undefined) ?? {};
}

function writeMap(extra: Record<string, Value>, key: string, map: Record<string, unknown>): void {
  if (Object.keys(map).length === 0) delete extra[key];
  else extra[key] = map as unknown as Value;
}

/** 空の姿は undefined にする（セーブを小さく保つ）。 */
function compact(look: Look): Look | undefined {
  const out: Look = {};
  if (look.box && Object.keys(look.box).length > 0) out.box = look.box;
  if (look.style && Object.keys(look.style).length > 0) out.style = look.style;
  if (look.transform && Object.keys(look.transform).length > 0) out.transform = look.transform;
  if (look.loop) out.loop = look.loop;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 対象（名前かレイヤー）の姿を一つずつ書き換える。対象の選び方は描画側（@liminalia/std/web の anim）と同じ。
 * 立ち絵は名前がキャスト名のとき、またはレイヤーが fg0 のとき。前景の項目は name が一致するもの、またはそのレイヤーのすべて。
 */
export function updateLooks(stage: StageState, args: Args, update: (look: Look) => Look): void {
  const name = text(args.name);
  const layer = text(args.layer);
  const extra = stage.extra;
  const sprites = { ...spriteLooks(extra) };
  // 消した立ち絵の姿は捨てる。
  for (const who of Object.keys(sprites)) if (!stage.sprites[who]) delete sprites[who];
  for (const who of Object.keys(stage.sprites)) {
    if (name !== "" ? who !== name : layer !== "fg0") continue;
    const key = spriteKey(stage.sprites[who]);
    const prev = currentSpriteLook(sprites[who], key);
    const look = compact(update(structuredClone(prev)));
    if (look) sprites[who] = { sprite: key, look };
    else delete sprites[who];
  }
  writeMap(extra, ANIM_KEYS.sprites, sprites);

  const images = { ...(readExtra(extra, "images") ?? {}) };
  for (const l of IMAGE_LAYERS) {
    const list = images[l];
    if (!list) continue;
    images[l] = list.map((item) => {
      if (name !== "" ? item.name !== name : layer !== l) return item;
      const look = compact(update(structuredClone((item.look as Look | undefined) ?? {})));
      const next: LayerItem = { ...item };
      if (look) next.look = look;
      else delete next.look;
      return next;
    });
  }
  writeExtra(extra, "images", images);
}

/** 対象の書き方の検査（名前とレイヤーのどちらか一方）。 */
function requireTarget(command: string, args: Args): void {
  const hasName = text(args.name) !== "";
  const hasLayer = text(args.layer) !== "";
  if (hasName === hasLayer) throw new EvalError(`@${command} は対象を名前（名前なしのパラメータ）か layer= のどちらか一方で書きます`);
}

// ---- @anim ----

/** @anim の引数を姿に重ねる。 */
export function applyAnim(look: Look, args: Args): Look {
  const box = { ...(look.box ?? {}) };
  for (const k of BOX_KEYS) {
    const to = num(args[k]);
    const by = num(args[`${k}-by`]);
    if (to !== null) box[k] = { to, by: 0 };
    if (by !== null) box[k] = { to: box[k]?.to ?? null, by: (box[k]?.by ?? 0) + by };
  }
  const style = { ...(look.style ?? {}) };
  const opacity = num(args.opacity);
  if (opacity !== null) style.opacity = String(Math.max(0, Math.min(1, opacity / 255)));
  if (typeof args.color === "string" && args.color !== "") style.color = args.color;
  return { ...look, box, style };
}

const targetParams = (what: string): Record<string, ParamDefinition> => ({
  name: t.string(`${what}対象の名前（キャラクター ID、@image や @layer-text の name）。layer とどちらか一方だけ書く`),
  layer: t.enum([...IMAGE_LAYERS], `${what}レイヤー（中のものすべて。fg0 は立ち絵も含む）。name とどちらか一方だけ書く`),
});

const animCommand: CommandDefinition = {
  name: "anim",
  summary: "名前かレイヤーで選んだものの位置、大きさ、不透明度、文字色をアニメーションさせる。終わりは @wait-anim で待てる",
  positional: ["name"],
  params: {
    ...targetParams("動かす"),
    left: t.number("左端（px）"),
    top: t.number("上端（px）"),
    width: t.number("幅（px）"),
    height: t.number("高さ（px）"),
    "left-by": t.number("左端を今の値から増減する（px）"),
    "top-by": t.number("上端を今の値から増減する（px）"),
    "width-by": t.number("幅を今の値から増減する（px）"),
    "height-by": t.number("高さを今の値から増減する（px）"),
    opacity: t.int("不透明度（0〜255）"),
    color: t.color("文字の色（@layer-text の文字）"),
    time: t.duration("動かすのにかける時間", "2s"),
    ease: t.string("イージング（jQuery の easing 名）", "swing", EASING_NAMES),
    wait: t.bool("動き終わるまで次に進まない", false),
    skip: t.skip(),
  },
  example: "@anim ユイカ left-by=200 opacity=128 time=800ms ease=easeOutQuad",
  async run(args, ctx) {
    requireTarget("anim", args);
    updateLooks(ctx.state.stage, args, (look) => applyAnim(look, args));
    await ctx.present(args, args.wait === true);
  },
};

/** @stop-anim の描画が返す、止めた位置（対象ごと。キーは "sprite:キャスト名" か "fg1:並び順"）。 */
export type StoppedBoxes = Record<string, Partial<Record<BoxKey | "opacity", number>>>;

const stopAnimCommand: CommandDefinition = {
  name: "stop-anim",
  summary: "@anim のアニメーションをその場で止める（止めた位置のまま残る）",
  positional: ["name"],
  params: {
    name: t.required(t.string("止める対象の名前")),
  },
  example: "@stop-anim ユイカ",
  waits: true,
  async run(args, ctx) {
    const stopped = (await ctx.present(args, true)) as unknown as StoppedBoxes | undefined;
    if (!stopped) return;
    const stage = ctx.state.stage;
    const name = text(args.name);
    // 止めた位置を最後の姿にする（描画側が返した値。画面なしの実行では何も返らないので動き終わりの姿のまま）。
    const sprites = { ...spriteLooks(stage.extra) };
    const pin = (look: Look, s: Partial<Record<BoxKey | "opacity", number>>): Look => {
      const box = { ...(look.box ?? {}) };
      for (const k of BOX_KEYS) if (typeof s[k] === "number") box[k] = { to: s[k]!, by: 0 };
      const style = { ...(look.style ?? {}) };
      if (typeof s.opacity === "number") style.opacity = String(s.opacity);
      return { ...look, box, style };
    };
    for (const [key, s] of Object.entries(stopped)) {
      const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      if (kind === "sprite") {
        const sprite = stage.sprites[id];
        if (!sprite) continue;
        const k = spriteKey(sprite);
        const prev = currentSpriteLook(sprites[id], k);
        sprites[id] = { sprite: k, look: compact(pin(prev, s)) ?? {} };
      } else {
        const images = { ...(readExtra(stage.extra, "images") ?? {}) };
        const list = [...(images[kind as ImageLayer] ?? [])];
        const item = list[Number(id)];
        if (!item || item.name !== name) continue;
        list[Number(id)] = { ...item, look: compact(pin((item.look as Look | undefined) ?? {}, s)) ?? {} };
        images[kind as ImageLayer] = list;
        writeExtra(stage.extra, "images", images);
      }
    }
    writeMap(stage.extra, ANIM_KEYS.sprites, sprites);
  },
};

const waitAnimCommand: CommandDefinition = {
  name: "wait-anim",
  summary: "@anim、@kanim（ループを除く）、@quake-decay のアニメーションがすべて終わるまで待つ",
  params: {},
  example: "@wait-anim",
  waits: true,
};

// ---- @keyframe ----

/** 変形に使うフレームの項目（.lim の名前 → CSS の変形関数）。x / y は translate にまとめる。 */
export const TRANSFORM_KEYS: Record<string, string> = {
  x: "translate-x",
  y: "translate-y",
  scale: "scale",
  "scale-x": "scaleX",
  "scale-y": "scaleY",
  rotate: "rotate",
  "rotate-x": "rotateX",
  "rotate-y": "rotateY",
  "rotate-z": "rotateZ",
  skew: "skew",
  "skew-x": "skewX",
  "skew-y": "skewY",
  perspective: "perspective",
};

const ANGLE_KEYS = new Set(["rotate", "rotateX", "rotateY", "rotateZ", "skew", "skewX", "skewY"]);

/**
 * @keyframe のフレームの書き方を読む。`"0% x=0; 50% x=40 rotate=15deg opacity=0.5; 100% x=0"`。
 * 一コマは「割合% 項目=値 …」で、コマは ; で区切る。x / y は px、rotate・skew は単位を省くと deg。
 * 変形の項目以外は CSS のプロパティとしてそのまま渡す（値に空白は書けない）。
 */
export function parseFrames(source: string): Frame[] {
  const frames: Frame[] = [];
  for (const part of source.split(";")) {
    const chunk = part.trim();
    if (chunk === "") continue;
    const m = /^(\d+(?:\.\d+)?)%(?:\s+(.*))?$/s.exec(chunk);
    if (!m) throw new EvalError(`@keyframe のキーフレーム「${chunk}」は「割合% 項目=値 …」の形で書きます（例: 50% x=40 opacity=0.5）`);
    const at = Number(m[1]);
    if (at > 100) throw new EvalError(`@keyframe のキーフレームの割合 ${m[1]}% は 0〜100 で書きます`);
    if (frames.some((f) => f.at === at)) throw new EvalError(`@keyframe のキーフレーム ${m[1]}% が重複しています`);
    const frame: Frame = { at, transform: {}, style: {} };
    for (const kv of (m[2] ?? "").split(/\s+/).filter(Boolean)) {
      const p = /^([a-z][a-z-]*)=(\S+)$/.exec(kv);
      if (!p) throw new EvalError(`@keyframe の「${kv}」は「項目=値」の形で書きます`);
      const [, key, value] = p as unknown as [string, string, string];
      const fn = TRANSFORM_KEYS[key];
      if (fn === undefined) {
        frame.style[key] = value;
      } else if (fn === "translate-x" || fn === "translate-y") {
        if (!/^-?\d+(\.\d+)?$/.test(value)) throw new EvalError(`@keyframe の ${key}=${value} は px の数値で書きます`);
        frame.transform[fn] = `${Number(value)}px`;
      } else {
        frame.transform[fn] = ANGLE_KEYS.has(fn) && /^-?\d+(\.\d+)?$/.test(value) ? `${value}deg` : value;
      }
    }
    frames.push(frame);
  }
  if (frames.length === 0) throw new EvalError("@keyframe にキーフレームがありません");
  return frames.sort((a, b) => a.at - b.at);
}

/** 変形の部品を CSS の transform にする。translate は最後に置く（TyranoScript の a3d と同じ順）。 */
export function transformCss(parts: Record<string, string> | undefined): string {
  if (!parts) return "";
  const out: string[] = [];
  for (const [fn, value] of Object.entries(parts)) if (fn !== "translate-x" && fn !== "translate-y") out.push(`${fn}(${value})`);
  if (parts["translate-x"] !== undefined || parts["translate-y"] !== undefined) out.push(`translate(${parts["translate-x"] ?? "0px"}, ${parts["translate-y"] ?? "0px"})`);
  return out.join(" ");
}

const keyframeCommand: CommandDefinition = {
  name: "keyframe",
  summary: "@kanim で使うアニメーションに名前を付けて定義する。キーフレームは「割合% 項目=値 …」を ; で区切って一行に並べる",
  positional: ["name"],
  params: {
    name: t.required(t.string("アニメーションの名前")),
    frames: t.required(
      t.string(
        "キーフレーム（例: \"0% x=0; 50% x=40 rotate=15deg opacity=0.5; 100% x=0\"）。変形は x、y（px）、scale、scale-x、scale-y、rotate、rotate-x、rotate-y、rotate-z、skew、skew-x、skew-y、perspective、ほかは CSS のプロパティ",
      ),
    ),
  },
  example: '@keyframe sway frames="0% rotate=0; 50% rotate=8 x=12; 100% rotate=0"',
  apply(args, extra) {
    const frames = parseFrames(text(args.frames));
    extra[ANIM_KEYS.keyframes] = { ...keyframes(extra), [text(args.name)]: frames } as unknown as Value;
  },
};

// ---- @kanim ----

/** 動き終わったときに見えているコマ（向きと回数から）。 */
function endFrameIndex(frames: Frame[], o: KanimOptions): number {
  const last = frames.length - 1;
  const odd = o.count % 2 === 1;
  switch (o.direction) {
    case "reverse":
      return 0;
    case "alternate":
      return odd ? last : 0;
    case "alternate-reverse":
      return odd ? 0 : last;
    default:
      return last;
  }
}

export interface KanimPlan {
  /** 各コマの姿（前のコマの項目を引き継ぐ。TyranoScript の a3d の maintain と同じ）。 */
  frames: { at: number; transform: Record<string, string>; style: Record<string, string> }[];
  /** 動き終わったあとの姿（keep=false や繰り返しなら変わらない）。 */
  final: Look;
}

/**
 * @kanim の動きを組む。0% のコマがなく reset でもなければ今の姿から動き始める（0% があれば一から）。
 * 状態の更新（@kanim の run）と描画（@liminalia/std/web の anim）が同じものを使う。
 */
export function planKanim(look: Look, frames: Frame[], o: KanimOptions): KanimPlan {
  const fresh = o.reset || frames[0]!.at === 0;
  let transform = fresh ? {} : { ...(look.transform ?? {}) };
  let style = fresh ? {} : { ...(look.style ?? {}) };
  const planned: KanimPlan["frames"] = [];
  if (frames[0]!.at !== 0) planned.push({ at: 0, transform: { ...transform }, style: { ...style } });
  for (const f of frames) {
    transform = { ...transform, ...f.transform };
    style = { ...style, ...f.style };
    planned.push({ at: f.at, transform: { ...transform }, style: { ...style } });
  }
  if (planned.at(-1)!.at !== 100) planned.push({ ...planned.at(-1)!, at: 100 });
  if (o.loop || !o.keep) return { frames: planned, final: look };
  const end = planned[endFrameIndex(planned, o)]!;
  return { frames: planned, final: { ...look, transform: end.transform, style: { ...(look.style ?? {}), ...end.style } } };
}

export function kanimOptions(args: Args): KanimOptions {
  return {
    time: num(args.time) ?? 1000,
    easing: text(args.easing, "ease"),
    count: Math.max(1, num(args.count) ?? 1),
    loop: args.loop === true,
    delay: num(args.delay) ?? 0,
    direction: text(args.direction, "normal"),
    keep: args.keep !== false,
    reset: args.reset === true,
  };
}

const kanimCommand: CommandDefinition = {
  name: "kanim",
  summary: "@keyframe で定義したアニメーションで、名前かレイヤーで選んだものを動かす（変形や CSS のプロパティ）",
  positional: ["name"],
  params: {
    ...targetParams("動かす"),
    keyframe: t.required(t.string("@keyframe の名前")),
    time: t.duration("1 回のアニメーションにかける時間", "1s"),
    easing: t.string("キーフレームの間のイージング（CSS の timing-function か jQuery の easing 名）", "ease"),
    count: t.int("繰り返す回数", "1"),
    loop: t.bool("止めるまで繰り返す（count は使わない。@stop-kanim で止める）", false),
    delay: t.duration("動き始めるまでの時間", "0ms"),
    direction: t.enum(["normal", "reverse", "alternate", "alternate-reverse"], "向き（CSS の animation-direction）", "normal"),
    keep: t.bool("動き終わったあと最後の状態のままにする（false なら元の状態に戻る）", true),
    reset: t.bool("前の @kanim の変形を消してから動かす（false なら前の状態から続ける）", false),
    wait: t.bool("動き終わるまで次に進まない（loop=true では待たない）", false),
    skip: t.skip(),
  },
  example: "@kanim ユイカ keyframe=sway time=600ms count=2",
  async run(args, ctx) {
    requireTarget("kanim", args);
    const stage = ctx.state.stage;
    const name = text(args.keyframe);
    const frames = keyframes(stage.extra)[name];
    if (!frames) throw new EvalError(`@keyframe ${name} がまだ定義されていません`);
    const o = kanimOptions(args);
    updateLooks(stage, args, (look) => {
      const { loop: _, ...rest } = look;
      const next = planKanim(rest, frames, o).final;
      return o.loop ? { ...next, loop: { frames, options: o } } : next;
    });
    await ctx.present(args, args.wait === true && !o.loop);
  },
};

const stopKanimCommand: CommandDefinition = {
  name: "stop-kanim",
  summary: "@kanim のアニメーションを止める。途中なら最後の状態にする",
  positional: ["name"],
  params: {
    ...targetParams("止める"),
    reset: t.bool("@kanim で変えた変形も消して元の状態に戻す", true),
  },
  example: "@stop-kanim ユイカ",
  async run(args, ctx) {
    requireTarget("stop-kanim", args);
    updateLooks(ctx.state.stage, args, (look) => {
      const { loop: _, ...rest } = look;
      if (args.reset !== false) delete rest.transform;
      return rest;
    });
    await ctx.present(args, false);
  },
};

export const COMMANDS: CommandDefinition[] = [animCommand, stopAnimCommand, waitAnimCommand, keyframeCommand, kanimCommand, stopKanimCommand];
