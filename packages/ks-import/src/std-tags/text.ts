import type { TagConversion } from "../convert.ts";
import type { TagMapping, TagMappingContext } from "../mapping.ts";
import type { Params } from "../types.ts";
import { addNote, enumValues, layerName } from "./image.ts";

/**
 * レイヤーに置く文字の変換表（TyranoScript 組み込みの [ptext] [mtext] と、TyranoBuilder のマクロ tb_ptext_show）。
 * 変換先は標準の命令（@liminalia/std）。tb_ptext_hide は @free-image fg2（image.ts）。
 */

/** [ptext] / [mtext] の値を .lim の書き方に揃える（レイヤー・太字・縁取り・px 付きの大きさ）。 */
function textConvert(pm: Params, ctx: TagMappingContext, notes: string[]): TagConversion | null {
  const rest = { ...pm };
  const layer = layerName(rest.layer ?? "0");
  if (layer === null || layer === "base") {
    notes.push(`layer=${rest.layer} には置けないので変換していません（前景レイヤー 0〜2 だけ）`);
    return null;
  }
  rest.layer = layer;
  if (rest.bold === "bold") rest.bold = "true";
  if (rest.size) rest.size = rest.size.replace(/px$/, "");
  const edge = (rest.edge ?? "").trim();
  if (edge !== "") {
    // "4px 0xff0000" の形（太さ付き）。複数の縁取りは最初の一つだけ。
    const first = edge.split(/,(?![^(]*\))/)[0]!.trim();
    const m = /^([\d.]+)px\s+(.+)$/.exec(first);
    rest.edge = m ? m[2]! : first;
    if (m) rest.edge_width = m[1]!;
    if (first !== edge) notes.push(`edge=${edge} は最初の縁取りだけ変換しました`);
  }
  if (pm.page === "back") notes.push("page=back は表に置きます");
  return ctx.mechanical(rest);
}

function withNotes(conv: TagConversion | null, notes: string[]): TagConversion {
  const out = conv ?? { name: "", positional: [], named: [], drop: true };
  for (const n of notes) addNote(out, n);
  return out;
}

/** TyranoBuilder の文字の表示（tb_ptext_show）。anim=true なら [mtext]、そうでなければ [ptext] を layer=2 に置くマクロ。 */
function tbTextConvert(pm: Params, ctx: TagMappingContext): TagConversion {
  const { anim, ...rest } = pm;
  const ks: Params = { ...rest, layer: "2" };
  if (anim === "true") return ctx.convertAs("motion-text", ks, "mtext");
  // [ptext] は [mtext] 用の引数を使わない。
  for (const k of ["fadeout", "wait", "in_effect", "out_effect"]) delete ks[k];
  return ctx.convertAs("layer-text", ks, "ptext");
}

export const MAPPINGS: TagMapping[] = [
  {
    command: "layer-text",
    tags: ["ptext", "tb_ptext_show"],
    params: { time: "time" },
    ignore: ["page", "zindex", "gradient", "edge_method"],
    convert(pm, tag, ctx) {
      if (tag === "tb_ptext_show") return tbTextConvert(pm, ctx);
      const notes: string[] = [];
      if (pm.gradient) notes.push(`gradient=${pm.gradient} は変換していません`);
      return withNotes(textConvert(pm, ctx, notes), notes);
    },
  },
  {
    command: "motion-text",
    tags: ["mtext"],
    params: { in: "in_effect", "in-scale": "in_delay_scale", out: "out_effect" },
    ignore: ["page", "zindex", "out_scale_delay", "out_delay_scale"],
    convert(pm, _tag, ctx) {
      const rest = { ...pm };
      const notes: string[] = [];
      if (rest.fadeout !== undefined) {
        rest.stay = rest.fadeout === "false" ? "true" : "false";
        delete rest.fadeout;
      }
      if (rest.in_effect && !enumValues(ctx.spec, "in").includes(rest.in_effect)) {
        notes.push(`in_effect=${rest.in_effect} は変換していません（fadeIn で出します）`);
        delete rest.in_effect;
      }
      if (rest.out_effect && !enumValues(ctx.spec, "out").includes(rest.out_effect)) {
        notes.push(`out_effect=${rest.out_effect} は変換していません（fadeOut で消します）`);
        delete rest.out_effect;
      }
      return withNotes(textConvert(rest, ctx, notes), notes);
    },
  },
];
