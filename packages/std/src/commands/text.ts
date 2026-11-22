import { argOrigin, type Args, type TextOrigin } from "@liminalia/runtime";
import { t, type CommandDefinition, type ParamDefinition } from "@liminalia/plugin-host";
import { IMAGE_LAYERS, num, readExtra, text, writeExtra, type ImageLayer, type LayerItem } from "./image.ts";

/**
 * レイヤーに置く文字（TyranoScript 組み込みの [ptext] [mtext] と、TyranoBuilder のマクロ tb_ptext_show）。
 * 置いた文字は前景レイヤーの項目（kind "text"）として stage.extra の画像の一覧に積むので、@free-image で消え、
 * @anim / @kanim の name で動かせ、ロード時に組み立て直される。消える演出の @motion-text は状態に残らない
 * （stay=true のときだけ、出し終わった文字が残る）。
 * 字面で書いた文字は訳の元（i18n）を持ち、言語を替えたときと別の言語でロードしたときに今の言語で出し直される。
 */

/** レイヤーに置いた文字。 */
export interface TextItem {
  kind: "text";
  name: string;
  text: string;
  x: number;
  y: number;
  size: number;
  color: string;
  face: string;
  bold: boolean;
  italic: boolean;
  align: string;
  width: number | null;
  vertical: boolean;
  edge: string;
  edgeWidth: number;
  shadow: string;
  /** @anim / @kanim で動かしたあとの姿。 */
  look?: unknown;
  /** 言語を替えたときに出し直す元（text。@liminalia/runtime の retranslate.ts）。 */
  i18n?: { text: TextOrigin };
}

export function textItem(args: Args): TextItem {
  const origin = argOrigin(args, "text");
  return {
    kind: "text",
    name: text(args.name),
    text: text(args.text),
    x: num(args.x) ?? 0,
    y: num(args.y) ?? 0,
    size: num(args.size) ?? 26,
    color: text(args.color, "#ffffff"),
    face: text(args.face),
    bold: args.bold === true,
    italic: args.italic === true,
    align: text(args.align, "left"),
    width: num(args.width),
    vertical: args.vertical === true,
    edge: text(args.edge),
    edgeWidth: num(args["edge-width"]) ?? 1,
    shadow: text(args.shadow),
    ...(origin ? { i18n: { text: origin } } : {}),
  };
}

/** 文字の見た目の引数（@layer-text と @motion-text で共通）。 */
const textParams: Record<string, ParamDefinition> = {
  text: t.required(t.text("文字")),
  x: t.number("左端（px）", "0"),
  y: t.number("上端（px）", "0"),
  layer: t.enum([...IMAGE_LAYERS], "置くレイヤー（fg0〜fg2）", "fg0"),
  name: t.string("名前（@anim で動かすときや、@layer-text overwrite=true で書き換えるときに使う）"),
  size: t.number("文字サイズ（px）", "26"),
  color: t.color("文字の色", "#ffffff"),
  face: t.string("フォント（CSS の font-family）"),
  bold: t.bool("太字", false),
  italic: t.bool("斜体", false),
  align: t.enum(["left", "center", "right"], "文字揃え（width を書いたとき）", "left"),
  width: t.number("幅（px）。省略時は文字の長さ"),
  vertical: t.bool("縦書き", false),
  edge: t.color("縁取りの色"),
  "edge-width": t.number("縁取りの太さ（px）", "1"),
  shadow: t.color("影の色"),
};

const layerTextCommand: CommandDefinition = {
  name: "layer-text",
  summary: "前景レイヤーに文字を置く（章題や場所の表示など）。@free-image で消すまで残る",
  positional: ["text"],
  params: {
    ...textParams,
    time: t.duration("表示にかける時間", "0ms"),
    wait: t.bool("表示し終わるまで次に進まない", true),
    skip: t.skip(),
    overwrite: t.bool("同じ name の文字があれば、新しく置かずに文字、位置、色、大きさを書き換える", false),
  },
  example: '@layer-text "第一章　雨の駅" x=80 y=300 size=48 name=chapter time=600ms',
  apply(args, extra) {
    const item = textItem(args);
    const images = { ...(readExtra(extra, "images") ?? {}) };
    if (args.overwrite === true && item.name !== "") {
      let found = false;
      for (const l of IMAGE_LAYERS) {
        const list = images[l];
        if (!list?.some((i) => i.kind === "text" && i.name === item.name)) continue;
        found = true;
        images[l] = list.map((i) => (i.kind === "text" && i.name === item.name ? overwriteText(i as unknown as TextItem, args) : i));
      }
      if (found) return writeExtra(extra, "images", images);
    }
    const layer = text(args.layer, "fg0") as ImageLayer;
    images[layer] = [...(images[layer] ?? []), item as unknown as LayerItem];
    writeExtra(extra, "images", images);
  },
};

/** overwrite=true の書き換え（TyranoScript と同じく、文字と、書いた位置・色・大きさだけ）。 */
export function overwriteText(item: TextItem, args: Args): LayerItem {
  const next: TextItem = { ...item, text: text(args.text) };
  const origin = argOrigin(args, "text");
  if (origin) next.i18n = { text: origin };
  else delete next.i18n;
  if (num(args.x)) next.x = num(args.x)!;
  if (num(args.y)) next.y = num(args.y)!;
  if (typeof args.color === "string" && args.color !== "#ffffff") next.color = args.color;
  if (num(args.size) !== null && num(args.size) !== 26) next.size = num(args.size)!;
  return next as unknown as LayerItem;
}

/** 一文字ずつの出し方・消し方（animate.css の名前。In / Out は @bg の method と同じ動き）。 */
export const TEXT_IN_EFFECTS = ["fadeIn", "fadeInLeft", "fadeInRight", "fadeInUp", "fadeInDown", "slideInLeft", "slideInRight", "slideInUp", "slideInDown", "puffIn", "vanishIn"];
export const TEXT_OUT_EFFECTS = TEXT_IN_EFFECTS.map((e) => e.replace("In", "Out"));

const motionTextCommand: CommandDefinition = {
  name: "motion-text",
  summary: "文字を一文字ずつアニメーションを付けて表示し、しばらく表示してから一文字ずつ消す",
  positional: ["text"],
  params: {
    ...textParams,
    time: t.duration("表示し終わってから消し始めるまでの時間", "2s"),
    stay: t.bool("消さずに残す（@free-image で消すまで残る）", false),
    in: t.enum(TEXT_IN_EFFECTS, "表示するときの効果", "fadeIn"),
    "in-delay": t.duration("一文字ごとにずらす時間（in-scale を掛ける）", "50ms"),
    "in-scale": t.number("in-delay に掛ける倍率", "1.5"),
    "in-sync": t.bool("すべての文字を同時に表示する", false),
    "in-shuffle": t.bool("表示する順をばらばらにする", false),
    "in-reverse": t.bool("後ろの文字から表示する", false),
    out: t.enum(TEXT_OUT_EFFECTS, "消すときの効果", "fadeOut"),
    "out-delay": t.duration("一文字ごとにずらす時間（1.5 倍する）", "50ms"),
    "out-sync": t.bool("すべての文字を同時に消す", false),
    "out-shuffle": t.bool("消す順をばらばらにする", false),
    "out-reverse": t.bool("後ろの文字から消す", false),
    wait: t.bool("消し終わるまで（stay=true なら表示し終わるまで）次に進まない", true),
    skip: t.skip(),
  },
  example: '@motion-text "そして、朝が来た" x=200 y=320 size=40 in=fadeInUp time=1500ms',
  apply(args, extra) {
    if (args.stay !== true) return;
    const layer = text(args.layer, "fg0") as ImageLayer;
    const images = { ...(readExtra(extra, "images") ?? {}) };
    images[layer] = [...(images[layer] ?? []), textItem(args) as unknown as LayerItem];
    writeExtra(extra, "images", images);
  },
  waits: true,
};

export const COMMANDS: CommandDefinition[] = [layerTextCommand, motionTextCommand];
