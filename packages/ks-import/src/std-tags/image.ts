import type { CommandSpec } from "@liminalia/lang";
import type { TagConversion } from "../convert.ts";
import { ksValue, type TagMapping, type TagMappingContext } from "../mapping.ts";
import type { Params } from "../types.ts";

/**
 * 画像・レイヤー・合成・フィルタまわりの変換表（TyranoScript 組み込みの [image] [freeimage] [layopt] [layermode]
 * [filter] [chara_move] と、TyranoBuilder のマクロ tb_image_* / tb_chara_shake、TyranoBuilder の
 * フィルタのプラグイン tb_filter_* / tb_free_filter）。変換先は標準の命令（@liminalia/std）。
 *
 * TyranoScript のレイヤー番号は .lim では次の名前で書く。
 *   base … 背景の層（.lim では @bg の背景）
 *   0〜2 … fg0〜fg2（0 は立ち絵の層、1 は TyranoBuilder の画像表示）
 */

/** TyranoScript のレイヤー番号 → .lim のレイヤー名。 */
export function layerName(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  if (raw === "base") return "base";
  if (/^\d+$/.test(raw)) return `fg${raw}`;
  return null;
}

/** 命令の仕様の、列挙の引数が取れる値。 */
export function enumValues(spec: CommandSpec, param: string): readonly string[] {
  const type = spec.params[param]?.type;
  return type?.kind === "enum" ? type.values : [];
}

/** layer の値を .lim のレイヤー名に置き換えてから、表で機械的に変換する。 */
export function withLayer(ctx: TagMappingContext, pm: Params, layer: string | null): TagConversion {
  const rest = { ...pm };
  if (layer === null) delete rest.layer;
  else rest.layer = layer;
  return ctx.mechanical(rest);
}

export function addNote(conv: TagConversion, note: string): TagConversion {
  conv.notes = [...(conv.notes ?? []), note];
  return conv;
}

/** [filter] / [free_filter] の layer（省略と all はすべて）。 */
function filterConvert(pm: Params, ctx: TagMappingContext): TagConversion {
  const raw = pm.layer;
  const layer = raw === undefined || raw === "" || raw === "all" ? null : layerName(raw);
  const conv = withLayer(ctx, pm, layer);
  if (layer === null && raw !== undefined && raw !== "" && raw !== "all") addNote(conv, `layer=${raw} は変換していません`);
  if (pm.name) addNote(conv, `name=${pm.name} は変換していません（レイヤー単位でかけます）`);
  return conv;
}

export const MAPPINGS: TagMapping[] = [
  {
    command: "image",
    tags: ["image", "tb_image_show"],
    params: { file: "storage", time: "time", flip: "reflect" },
    ignore: ["page", "visible", "_clickable_img", "animimg", "left", "top", "pos"],
    convert(pm, tag, ctx) {
      // layer を省略した [image] は背景の層（base）に置く。.lim では背景なので @bg にする。
      if (tag === "image" && (pm.layer === undefined || pm.layer === "" || pm.layer === "base")) {
        const conv: TagConversion = { name: "bg", positional: [ksValue({ kind: "string" }, pm.storage ?? "")], named: [] };
        if (pm.folder && pm.folder !== "bgimage") addNote(conv, `folder=${pm.folder} は変換していません（背景は bgimage から読みます）`);
        return conv;
      }
      const merged = { ...pm };
      // left / top と x / y は同じ意味（TyranoScriptは x / y が優先）。
      if (!merged.x) merged.x = merged.left ?? "";
      if (!merged.y) merged.y = merged.top ?? "";
      const layer = tag === "tb_image_show" ? null : layerName(pm.layer);
      // page=back は表に置く（[backlay] 〜 [trans] は @freeze 〜 @transition にするので、見え方は同じになる）。
      const conv = withLayer(ctx, merged, layer);
      if (pm.pos) addNote(conv, `pos=${pm.pos} は変換していません（x で書いてください）`);
      return conv;
    },
  },
  {
    command: "free-image",
    tags: ["freeimage", "freelayer", "tb_image_hide", "tb_clear_images", "tb_ptext_hide"],
    params: { time: "time" },
    ignore: ["page"],
    convert(pm, tag, ctx) {
      if (tag === "tb_image_hide") return withLayer(ctx, pm, "fg1");
      // TyranoBuilder の文字の表示（tb_ptext_show）は layer=2 に置く。
      if (tag === "tb_ptext_hide") return withLayer(ctx, pm, "fg2");
      if (tag === "tb_clear_images") {
        return addNote(withLayer(ctx, {}, "fg1"), "tb_clear_images の [cm] と [clearfix] は変換していません（文字も消すなら @clear を足す）");
      }
      const layer = layerName(pm.layer);
      const conv = withLayer(ctx, pm, layer);
      if (layer !== null && !enumValues(ctx.spec, "layer").includes(layer)) addNote(conv, `layer=${pm.layer} は対応していません`);
      return conv;
    },
  },
  {
    command: "layer",
    tags: ["layopt"],
    ignore: ["page", "autohide", "index"],
    convert(pm, _tag, ctx) {
      // メッセージ枠（message0 / message）は組み込みの @window にする（TyranoBuilder の tb_show/hide_message_window と同じ扱い）。
      if (pm.layer === "message0" || pm.layer === "message") {
        if (pm.visible !== "true" && pm.visible !== "false") return null;
        const conv: TagConversion = { name: "window", positional: [pm.visible === "true" ? "show" : "hide"], named: [] };
        for (const key of ["left", "top", "opacity"]) if (pm[key]) addNote(conv, `${key}=${pm[key]} は変換していません`);
        return conv;
      }
      if (pm.layer === "message1") return withLayer(ctx, pm, "message1");
      const layer = layerName(pm.layer);
      if (layer === null || layer === "base") return null;
      return withLayer(ctx, pm, layer);
    },
  },
  { command: "blend", tags: ["layermode"], params: { time: "time" } },
  { command: "blend-off", tags: ["free_layermode"], params: { time: "time" } },
  {
    command: "filter",
    tags: ["filter", "tb_filter_grayscale", "tb_filter_sepia", "tb_filter_invert", "tb_filter_opacity", "tb_filter_blur"],
    ignore: ["page", "name"],
    convert: (pm, _tag, ctx) => filterConvert(pm, ctx),
  },
  {
    command: "filter-off",
    tags: ["free_filter", "tb_free_filter"],
    ignore: ["page", "name"],
    convert: (pm, _tag, ctx) => filterConvert(pm, ctx),
  },
  { command: "chara-move", tags: ["chara_move"], params: { who: "name", ease: "effect" } },
  { command: "chara-shake", tags: ["tb_chara_shake"], params: { who: "name" } },
];
