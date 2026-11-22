import { BOX_KEYS, planKanim, transformCss, type Frame, type KanimOptions, type Look } from "../commands/anim.ts";
import type { RenderContext } from "@liminalia/web";
import { easing } from "./image.ts";

/**
 * @anim / @kanim で動かしたあとの姿を要素に当てる部品（ロード時の組み立て直しと、動かすときの両方で使う）。
 * 要素には今の姿を data-look（JSON）として持たせ、次の @kanim が「今の姿から」動き始めるときに読む。
 */

/** @wait-anim が待つ動き（@anim・@kanim の繰り返さないもの・@quake-decay）。 */
const running = new Set<Animation>();

/** 動きを @wait-anim の待ち対象にする。終わるか取り消されたら外れる。 */
export function track(animation: Animation): Promise<void> {
  running.add(animation);
  return animation.finished.then(
    () => void running.delete(animation),
    () => void running.delete(animation),
  );
}

/** 待ち対象の動きがすべて終わるまで待つ。skipping なら終わりまで飛ばす。 */
export async function waitRunning(ctx: RenderContext): Promise<void> {
  if (ctx.skipping) for (const a of [...running]) a.finish();
  await Promise.all([...running].map((a) => a.finished.then(() => undefined, () => undefined)));
}

/** ロード時。古い要素の動きは片付ける（要素ごと組み立て直すので取り消すだけでよい）。 */
export function clearRunning(): void {
  for (const a of [...running]) a.cancel();
  running.clear();
}

export function elementLook(el: HTMLElement): Look {
  try {
    return el.dataset.look ? (JSON.parse(el.dataset.look) as Look) : {};
  } catch {
    return {};
  }
}

export function setElementLook(el: HTMLElement, look: Look): void {
  const { loop: _, ...rest } = look;
  if (Object.keys(rest).length === 0) delete el.dataset.look;
  else el.dataset.look = JSON.stringify(rest);
}

/** 左右反転した前景の画像（.lim-img--flip）は、変形の最後に反転を足す。 */
export function composeTransform(el: HTMLElement, parts: Record<string, string> | undefined): string {
  const flip = el.classList.contains("lim-img--flip") ? "scaleX(-1)" : "";
  return [transformCss(parts), flip].filter(Boolean).join(" ");
}

/** CSS のプロパティ名（background-color）→ Web Animations のキーフレームの名前（backgroundColor）。 */
export function camel(prop: string): string {
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function styleProps(style: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(style ?? {})) out[camel(k)] = v;
  return out;
}

/** 姿をそのまま当てる（動きなし）。位置・大きさの増減は今の値から数える。 */
export function applyLook(ctx: RenderContext, el: HTMLElement, look: Look): void {
  const cs = getComputedStyle(el);
  for (const k of BOX_KEYS) {
    const v = look.box?.[k];
    if (!v) continue;
    el.style[k] = `${(v.to ?? (parseFloat(cs[k]) || 0)) + v.by}px`;
  }
  Object.assign(el.style, styleProps(look.style));
  if (look.transform) el.style.transform = composeTransform(el, look.transform);
  setElementLook(el, look);
  // 繰り返す動きの Promise はすぐに解決する（待つものが無い）
  if (look.loop) void startKanim(ctx, el, look.loop.frames, look.loop.options);
}

/**
 * @kanim の動きを始める。繰り返さないものは @wait-anim の待ち対象にして、終わりを返す。
 * keep なら最後の姿を先に要素へ書いておき、動きは fill=backwards で重ねる（終われば最後の姿が残る）。
 */
export function startKanim(ctx: RenderContext, el: HTMLElement, frames: Frame[], o: KanimOptions): Promise<void> {
  for (const old of el.getAnimations()) if (old.id === "lim-kanim") old.cancel();
  const look = elementLook(el);
  const plan = planKanim(look, frames, o);
  const ease = easing(o.easing);
  const keyframes: Keyframe[] = plan.frames.map((f) => ({
    offset: f.at / 100,
    transform: composeTransform(el, f.transform) || "none",
    ...styleProps(f.style),
    // CSS アニメーションと同じく、緩急はコマとコマの間ごとにかかる。
    easing: ease,
  }));
  if (!o.loop && o.keep) {
    el.style.transform = composeTransform(el, plan.final.transform);
    Object.assign(el.style, styleProps(plan.final.style));
    setElementLook(el, plan.final);
  }
  // 繰り返す動きは待ち（演出の時間）ではないので、スキップ中も同じ速さで動かす。
  const time = o.loop ? o.time : ctx.time(o.time);
  const animation = el.animate(keyframes, {
    duration: time,
    delay: o.loop ? o.delay : ctx.time(o.delay),
    iterations: o.loop ? Infinity : o.count,
    direction: o.direction as PlaybackDirection,
    fill: "backwards",
  });
  animation.id = "lim-kanim";
  if (o.loop) return Promise.resolve();
  return track(animation);
}
