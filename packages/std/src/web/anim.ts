import * as A from "../commands/anim.ts";
import * as S from "../commands/image.ts";
import type { StageState, Value } from "@liminalia/runtime";
import type { Renderer, RenderContext, Restorer } from "@liminalia/web";
import { easing, EASINGS, layerItems, spriteEl } from "./image.ts";
import { applyLook, clearRunning, elementLook, setElementLook, startKanim, track, waitRunning } from "./look.ts";

/**
 * @anim / @stop-anim / @wait-anim / @kanim / @stop-kanim の描画と、ロード時の立ち絵の姿の組み立て直し
 * （前景の項目の姿は image.ts の組み立て直しが当てる）。
 */

type Args = Record<string, Value>;

const num = (v: Value | undefined, d = 0): number => (typeof v === "number" ? v : d);
const str = (v: Value | undefined, d = ""): string => (typeof v === "string" ? v : d);

/**
 * 対象の要素（状態側の updateLooks と同じ選び方）。key は "sprite:キャスト名" か "fg1:並び順"（@stop-anim が止めた位置を返すときの目印）。
 */
function targets(ctx: RenderContext, a: Args): { key: string; el: HTMLElement }[] {
  const name = str(a.name);
  const layer = str(a.layer);
  const out: { key: string; el: HTMLElement }[] = [];
  for (const el of ctx.layers.sprites.querySelectorAll<HTMLElement>(".sprite[data-who]")) {
    const who = el.dataset.who!;
    if (name !== "" ? who === name : layer === "fg0") out.push({ key: `sprite:${who}`, el });
  }
  for (const l of S.IMAGE_LAYERS) {
    layerItems(ctx, l).forEach((el, i) => {
      if (name !== "" ? el.dataset.name === name : layer === l) out.push({ key: `${l}:${i}`, el });
    });
  }
  return out;
}

// ---- @anim ----

async function anim(ctx: RenderContext, a: Args, wait: boolean): Promise<void> {
  await ctx.spriteReady(); // 名前が立ち絵なら、直前の @chara で置いたものを動かす
  const time = ctx.time(num(a.time, 2000));
  const ease = EASINGS[str(a.ease, "swing")] ?? easing(str(a.ease), EASINGS.swing);
  const jobs: Promise<void>[] = [];
  for (const { el } of targets(ctx, a)) {
    // 動いている途中なら終わりまで飛ばしてから動かす（TyranoScript の stop(true, true)）。
    for (const old of el.getAnimations()) if (old.id === "lim-anim") old.finish();
    const cs = getComputedStyle(el);
    const from: Record<string, string> = {};
    const to: Record<string, string> = {};
    for (const k of A.BOX_KEYS) {
      const abs = a[k];
      const by = a[`${k}-by`];
      if (typeof abs !== "number" && typeof by !== "number") continue;
      const current = parseFloat(cs[k]) || 0;
      from[k] = `${current}px`;
      to[k] = `${(typeof abs === "number" ? abs : current) + (typeof by === "number" ? by : 0)}px`;
    }
    if (typeof a.opacity === "number") {
      from.opacity = cs.opacity;
      to.opacity = String(Math.max(0, Math.min(1, a.opacity / 255)));
    }
    if (typeof a.color === "string" && a.color !== "") {
      from.color = cs.color;
      to.color = a.color;
    }
    Object.assign(el.style, to);
    // 次の @kanim が今の姿から動けるよう、不透明度と色を要素の姿に足す（位置と大きさは要素の style が持つ）。
    const { box: _, ...look } = A.applyAnim(elementLook(el), a);
    setElementLook(el, look);
    if (time === 0 || Object.keys(to).length === 0) continue;
    const animation = el.animate([from, to], { duration: time, easing: ease });
    animation.id = "lim-anim";
    jobs.push(track(animation));
  }
  if (wait) await Promise.all(jobs);
}

/** その場で止め、止めた位置を返す（状態側がそれを最後の姿にする）。 */
function stopAnim(ctx: RenderContext, a: Args): Value {
  const stopped: A.StoppedBoxes = {};
  for (const { key, el } of targets(ctx, a)) {
    const animations = el.getAnimations().filter((x) => x.id === "lim-anim");
    if (animations.length === 0) continue;
    const props = new Set(animations.flatMap((x) => (x.effect as KeyframeEffect).getKeyframes().flatMap((f) => Object.keys(f))));
    const cs = getComputedStyle(el);
    const values: A.StoppedBoxes[string] = {};
    for (const k of A.BOX_KEYS) if (props.has(k)) values[k] = parseFloat(cs[k]) || 0;
    if (props.has("opacity")) values.opacity = parseFloat(cs.opacity);
    for (const x of animations) x.cancel();
    for (const k of A.BOX_KEYS) if (values[k] !== undefined) el.style[k] = `${values[k]}px`;
    if (values.opacity !== undefined) el.style.opacity = String(values.opacity);
    stopped[key] = values;
  }
  return stopped as unknown as Value;
}

// ---- @kanim ----

async function kanim(ctx: RenderContext, a: Args, wait: boolean, stage: StageState): Promise<void> {
  const frames = A.keyframes(stage.extra)[str(a.keyframe)];
  if (!frames) return;
  const o = A.kanimOptions(a);
  const jobs = targets(ctx, a).map(({ el }) => startKanim(ctx, el, frames, o));
  if (wait) await Promise.all(jobs);
}

function stopKanim(ctx: RenderContext, a: Args): void {
  for (const { el } of targets(ctx, a)) {
    for (const x of el.getAnimations()) if (x.id === "lim-kanim") x.cancel();
    if (a.reset === false) continue;
    const { transform: _, ...look } = elementLook(el);
    el.style.transform = el.classList.contains("lim-img--flip") ? "scaleX(-1)" : "";
    setElementLook(el, look);
  }
}

// ---- 組み立て直し（ロード時） ----

/** 立ち絵の姿。DomHost と image.ts（@chara-move の位置）が先に組み立てている。 */
function restore(ctx: RenderContext, stage: StageState): void {
  clearRunning();
  for (const [who, s] of Object.entries(A.spriteLooks(stage.extra))) {
    const el = spriteEl(ctx, who);
    if (el && stage.sprites[who]) applyLook(ctx, el, A.currentSpriteLook(s, S.spriteKey(stage.sprites[who])));
  }
}

export const renderers: Record<string, Renderer> = {
  anim: (ctx, a, wait) => anim(ctx, a, wait),
  "stop-anim": (ctx, a) => stopAnim(ctx, a),
  "wait-anim": (ctx) => waitRunning(ctx),
  kanim: (ctx, a, wait, stage) => kanim(ctx, a, wait, stage),
  "stop-kanim": (ctx, a) => stopKanim(ctx, a),
};

export const restorers: Restorer[] = [restore];
