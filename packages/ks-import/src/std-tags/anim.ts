import type { TagConversion } from "../convert.ts";
import type { TagMapping, TagMappingContext } from "../mapping.ts";
import type { Params } from "../types.ts";
import { addNote, layerName } from "./image.ts";

/**
 * 要素を動かす演出の変換表（TyranoScript 組み込みの [anim] [stopanim] [wa] [keyframe] [frame] [endkeyframe]
 * [kanim] [stop_kanim] [xanim] [stop_xanim]）。変換先は標準の命令（@liminalia/std）。
 */

const BOX_KEYS = ["left", "top", "width", "height"] as const;

/** [anim] などの name / layer を .lim の書き方にする。 */
function targetConvert(pm: Params, ctx: TagMappingContext): TagConversion {
  const rest = { ...pm };
  const notes: string[] = [];
  if (rest.name) {
    // name が優先される（TyranoScript と同じ）。
    delete rest.layer;
  } else if (rest.layer !== undefined && rest.layer !== "") {
    const layer = layerName(rest.layer);
    if (layer === null || layer === "base") {
      notes.push(`layer=${rest.layer} は変換していません（前景レイヤー 0〜2 だけを動かせます）`);
      delete rest.layer;
    } else {
      rest.layer = layer;
    }
  }
  const conv = ctx.mechanical(rest);
  for (const n of notes) addNote(conv, n);
  return conv;
}

/** [anim] の +=N / -=N を left-by などにする。 */
function animConvert(pm: Params, ctx: TagMappingContext): TagConversion {
  const rest = { ...pm };
  const notes: string[] = [];
  for (const k of [...BOX_KEYS, "opacity"]) {
    const m = /^([+-])=\s*(-?[\d.]+)/.exec(rest[k] ?? "");
    if (!m) continue;
    delete rest[k];
    if (k === "opacity") notes.push(`opacity=${pm[k]} は変換していません（不透明度は値で書いてください）`);
    else rest[`${k}_by`] = String((m[1] === "-" ? -1 : 1) * Number(m[2]));
  }
  for (const k of BOX_KEYS) {
    // "100px" のような単位付きの値（jQuery の animate はそのまま受け取る）。
    const m = /^(-?[\d.]+)px$/.exec(rest[k] ?? "");
    if (m) rest[k] = m[1]!;
  }
  const conv = targetConvert(rest, ctx);
  for (const n of notes) addNote(conv, n);
  return conv;
}

/** [frame] の引数（TyranoScript の a3d の名前）→ @keyframe の項目。 */
const KS_TRANSFORM: Record<string, string> = {
  x: "x",
  y: "y",
  scale: "scale",
  scaleX: "scale-x",
  scaleY: "scale-y",
  rotate: "rotate",
  rotateX: "rotate-x",
  rotateY: "rotate-y",
  rotateZ: "rotate-z",
  skew: "skew",
  skewX: "skew-x",
  skewY: "skew-y",
  perspective: "perspective",
};

/** 取り込み中の [keyframe] 〜 [endkeyframe]（[endkeyframe] で一行にまとめる）。ファイルごとに区切る（ファイルをまたぐことはない）。 */
let pendingKeyframe: { file: string; name: string; frames: string[]; notes: string[] } | null = null;

function keyframeConvert(pm: Params, tag: string, ctx: TagMappingContext): TagConversion {
  const drop = (notes: string[] = []): TagConversion => ({ name: "", positional: [], named: [], drop: true, ...(notes.length > 0 ? { notes } : {}) });
  if (pendingKeyframe && pendingKeyframe.file !== ctx.file) pendingKeyframe = null; // 前のファイルで閉じずに残ったものは捨てる
  if (tag === "keyframe") {
    pendingKeyframe = { file: ctx.file, name: pm.name ?? "", frames: [], notes: [] };
    return drop();
  }
  if (tag === "frame") {
    if (!pendingKeyframe) return drop(["[keyframe] の外の [frame] は変換していません"]);
    const p = (pm.p ?? "").trim();
    const parts: string[] = [];
    for (const [key, raw] of Object.entries(pm)) {
      if (key === "p" || key === "cond" || key.startsWith("_")) continue;
      const value = raw.replace(/\s+/g, "");
      if (/^[&%]/.test(value)) {
        pendingKeyframe.notes.push(`[frame p=${p}] の ${key}=${raw} は変換していません（式やマクロの引数はフレームに書けません）`);
        continue;
      }
      const k = KS_TRANSFORM[key];
      if (k === "x" || k === "y") {
        const m = /^(-?[\d.]+)(px)?$/.exec(value);
        if (!m) {
          pendingKeyframe.notes.push(`[frame p=${p}] の ${key}=${raw} は変換していません（相対・画面基準の位置は書けません）`);
          continue;
        }
        parts.push(`${k}=${Number(m[1])}`);
      } else if (k !== undefined) {
        parts.push(`${k}=${value}`);
      } else if (/^[a-z][a-z-]*$/.test(key)) {
        parts.push(`${key}=${value}`);
      } else {
        pendingKeyframe.notes.push(`[frame p=${p}] の ${key} は変換していません`);
      }
    }
    pendingKeyframe.frames.push([p, ...parts].join(" "));
    return drop();
  }
  // [endkeyframe]
  const k = pendingKeyframe;
  pendingKeyframe = null;
  if (!k) return drop(["[keyframe] のない [endkeyframe] は変換していません"]);
  const conv: TagConversion = { name: "keyframe", positional: [k.name], named: [["frames", JSON.stringify(k.frames.join("; ")), null]] };
  if (k.notes.length > 0) conv.notes = k.notes;
  return conv;
}

function kanimConvert(pm: Params, tag: string, ctx: TagMappingContext): TagConversion {
  const rest: Params = {};
  const notes: string[] = [];
  const known = new Set(["name", "layer", "keyframe", "time", "easing", "count", "delay", "direction", "mode", "reset", "wait", "next", "svg", "svg_x", "svg_y", "svg_rotate", "cond"]);
  for (const [k, v] of Object.entries(pm)) {
    if (known.has(k)) rest[k] = v;
    else if (!k.startsWith("_")) notes.push(`${k}=${v} は変換していません（値を直接書く [xanim] は、@keyframe に書いて keyframe= で指定してください）`);
  }
  if (rest.count === "infinite") {
    rest.loop = "true";
    delete rest.count;
  }
  if (rest.mode !== undefined) {
    // CSS の animation-fill-mode。forwards / both は最後の姿を残し、none / backwards は元に戻る。
    rest.keep = rest.mode === "none" || rest.mode === "backwards" ? "false" : "true";
    delete rest.mode;
  }
  if (tag === "kanim") {
    // [kanim] の time の既定は jquery.a3d の 4 秒、[xanim] は 1 秒（.lim の既定）。
    rest.time ??= "4000";
    // [kanim] は wait を持たず、reset もしない（前の動きの姿から続ける）。
    delete rest.wait;
    delete rest.reset;
  } else {
    // [xanim] の reset の既定は true（前の動きの変形を消してから動かす）。
    rest.reset ??= "true";
    if (rest.svg) notes.push(`svg=${rest.svg} は変換していません（SVG の線に沿った動きは扱いません）`);
  }
  for (const k of ["svg", "svg_x", "svg_y", "svg_rotate", "next"]) delete rest[k];
  if (rest.easing) rest.easing = rest.easing.replace(/\s+/g, "");
  const conv = targetConvert(rest, ctx);
  for (const n of notes) addNote(conv, n);
  return conv;
}

export const MAPPINGS: TagMapping[] = [
  { command: "anim", tags: ["anim"], params: { ease: "effect" }, convert: (pm, _tag, ctx) => animConvert(pm, ctx) },
  { command: "stop-anim", tags: ["stopanim"] },
  { command: "wait-anim", tags: ["wa"] },
  { command: "keyframe", tags: ["keyframe", "frame", "endkeyframe"], convert: keyframeConvert },
  { command: "kanim", tags: ["kanim", "xanim"], ignore: ["next"], convert: (pm, tag, ctx) => kanimConvert(pm, tag, ctx) },
  {
    command: "stop-kanim",
    tags: ["stop_kanim", "stop_xanim"],
    ignore: ["complete"],
    convert(pm, tag, ctx) {
      const conv = targetConvert({ ...pm, ...(tag === "stop_xanim" ? { reset: "false" } : {}) }, ctx);
      if (tag === "stop_xanim" && pm.complete !== "true") addNote(conv, "complete=false でも最後の姿で止めます（ロードしたときと同じ画面にするため）");
      return conv;
    },
  },
];
