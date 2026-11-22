import type { TagConversion } from "../convert.ts";
import type { TagMapping, TagMappingContext } from "../mapping.ts";
import type { Params } from "../types.ts";
import { addNote, enumValues, layerName } from "./image.ts";

/**
 * 画面全体の演出の変換表（TyranoScript 組み込みの [backlay] [trans] [wt] [bg2] [quake2] [vibrate] [vibrate_stop]、
 * [camera] / [reset_camera] の layer 指定、[wait_camera]）。変換先は標準の命令（@liminalia/std）。
 */

/** .ks の method を .lim の値にする（fadeIn は crossfade と同じ動き）。扱えない名前は crossfade にして記録する。 */
function methodValue(pm: Params, ctx: TagMappingContext, notes: string[]): Params {
  const method = pm.method;
  if (method === undefined || method === "") return pm;
  if (method === "fadeIn") return { ...pm, method: "crossfade" };
  if (enumValues(ctx.spec, "method").includes(method)) return pm;
  notes.push(`method=${method} は変換していません（crossfade で切り替えます）`);
  return { ...pm, method: "crossfade" };
}

const isWholeCamera = (pm: Params) => pm.layer === undefined || pm.layer === "" || pm.layer === "layer_camera";

/** TyranoScript の x はそのまま、y は符号を反転する（@camera と同じく「カメラの位置」で書く）。 */
function cameraConvert(pm: Params, tag: string, ctx: TagMappingContext): TagConversion {
  const layer = layerName(pm.layer);
  if (layer === null || !enumValues(ctx.spec, "layer").includes(layer)) {
    return { name: "", positional: [], named: [], drop: true, notes: [`layer=${pm.layer} は動かせないので変換していません（base と 0〜2 だけ）`] };
  }
  const rest: Params = { ...pm, layer };
  const negate = (v: string | undefined) => (v === undefined || v === "" ? v : String(-Number(v)));
  if (tag === "camera") {
    rest.y = negate(pm.y) ?? "";
    // from_* を一つでも書くと、書かなかった開始値は現在値ではなく 0（倍率は 1）になる（TyranoScript と同じ）。
    const hasFrom = ["from_x", "from_y", "from_zoom", "from_rotate"].some((k) => pm[k]);
    if (hasFrom) {
      rest.from_x = pm.from_x || "0";
      rest.from_y = negate(pm.from_y || "0")!;
      rest.from_zoom = pm.from_zoom || "1";
      rest.from_rotate = pm.from_rotate || "0";
    }
  }
  return ctx.mechanical(rest);
}

export const MAPPINGS: TagMapping[] = [
  // TyranoScript の裏ページ（[backlay] で表を写し、page=back で組み替え、[trans] で表に出す）は、
  // @freeze 〜 組み替え 〜 @transition にする。
  { command: "freeze", tags: ["backlay"], ignore: ["layer"] },
  {
    command: "transition",
    tags: ["trans"],
    ignore: ["layer", "children"],
    convert(pm, _tag, ctx) {
      // [trans] は待たない（待つのは [wt]）。method の既定は fadeIn（crossfade と同じ）。
      const notes: string[] = [];
      const conv = ctx.mechanical({ ...methodValue(pm, ctx, notes), wait: "false" });
      for (const n of notes) addNote(conv, n);
      if (pm.children === "false" && pm.layer && pm.layer !== "base") addNote(conv, `layer=${pm.layer} だけでなく画面全体を切り替えます`);
      return conv;
    },
  },
  { command: "wait-transition", tags: ["wt"] },
  {
    command: "bg-place",
    tags: ["bg2"],
    params: { image: "storage", time: "time" },
    ignore: ["name"],
    convert(pm, _tag, ctx) {
      // TyranoScript の [bg2] の time の既定は 3000 ミリ秒。
      const notes: string[] = [];
      const conv = ctx.mechanical({ ...methodValue(pm, ctx, notes), time: pm.time || "3000" });
      for (const n of notes) addNote(conv, n);
      if (pm.name) addNote(conv, `name=${pm.name} は変換していません（背景は名前で動かせません）`);
      return conv;
    },
  },
  {
    command: "quake-decay",
    tags: ["quake2"],
    params: { horizontal: "hmax", vertical: "vmax", "fill-edges": "copybase" },
    ignore: ["skippable"],
    convert(pm, _tag, ctx) {
      const conv = ctx.mechanical(pm);
      if (pm.skippable === "false") addNote(conv, "skippable=false は変換していません（スキップ中は揺らしません）");
      return conv;
    },
  },
  {
    command: "vibrate",
    tags: ["vibrate"],
    ignore: ["power"],
    convert(pm, _tag, ctx) {
      const rest = { ...pm };
      const notes: string[] = [];
      if (rest.time?.includes(",")) {
        notes.push(`time=${rest.time} は最初の値だけ変換しました（振動の並びは書けません）`);
        rest.time = rest.time.split(",")[0]!.trim();
      }
      if (pm.power) notes.push("power は変換していません（ゲームパッドの振動の強さ）");
      const conv = ctx.mechanical(rest);
      for (const n of notes) addNote(conv, n);
      return conv;
    },
  },
  { command: "vibrate-stop", tags: ["vibrate_stop"] },
  // [camera] / [reset_camera] は layer を省くか layer_camera なら画面全体（組み込みの @camera）。
  { command: "layer-camera", tags: ["camera"], params: { ease: "ease_type" }, defer: isWholeCamera, convert: (pm, tag, ctx) => cameraConvert(pm, tag, ctx) },
  { command: "reset-layer-camera", tags: ["reset_camera"], params: { ease: "ease_type" }, defer: isWholeCamera, convert: (pm, tag, ctx) => cameraConvert(pm, tag, ctx) },
  { command: "wait-camera", tags: ["wait_camera"] },
];

/** 取り込まないタグ（タグ名 → 理由）。 */
export const UNSUPPORTED_TAGS: Record<string, string> = {
  bgcamera: "端末のカメラの映像を背景にする機能は扱いません（カメラの許可が要り、画面が端末に依存するため）",
  stop_bgcamera: "端末のカメラの映像を背景にする機能（[bgcamera]）は扱いません",
  qr_config: "カメラで QR コードを読む機能（[bgcamera]）は扱いません",
  qr_define: "カメラで QR コードを読んで飛ぶ機能（[bgcamera]）は扱いません。分岐は @choice などで書いてください",
};
