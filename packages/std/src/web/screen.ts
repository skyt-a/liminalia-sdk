import * as C from "../commands/screen.ts";
import * as S from "../commands/image.ts";
import type { StageState, Value } from "@liminalia/runtime";
import { cameraTransform, ruleFromImage, ruleFromPattern, ruleTransition, transitionKeyframes, vibrate as vibrateDevice, type Renderer, type RenderContext, type Restorer, type RulePattern } from "@liminalia/web";
import { easing, imageLayer } from "./image.ts";
import { track } from "./look.ts";

/**
 * 画面全体の演出の描画（@freeze / @transition / @wait-transition / @bg-place / @quake-decay / @vibrate /
 * @layer-camera / @reset-layer-camera / @wait-camera）。
 */

type Args = Record<string, Value>;

const num = (v: Value | undefined, d = 0): number => (typeof v === "number" ? v : d);
const str = (v: Value | undefined, d = ""): string => (typeof v === "string" ? v : d);

/** 写しから data-* を外す（@free-image や @anim が写しの中の要素を本物と取り違えないように）。 */
function stripData(root: HTMLElement): void {
  for (const el of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    for (const attr of [...el.attributes]) if (attr.name.startsWith("data-")) el.removeAttribute(attr.name);
  }
}

// ---- @freeze / @transition ----

let transition: Promise<void> | null = null;

function frozen(ctx: RenderContext): HTMLElement | null {
  return ctx.camera.parentElement?.querySelector<HTMLElement>(":scope > .lim-freeze") ?? null;
}

/**
 * 今の画面（カメラの内側）を写して上に重ね、本物は隠す。止めている間の命令は隠した本物を組み替える。
 * すでに止めていれば何もしない（TyranoScript で [trans] の前に [backlay] を重ねても、見えている画面は変わらない）。
 */
async function freeze(ctx: RenderContext): Promise<void> {
  if (frozen(ctx)) return;
  const snap = ctx.camera.cloneNode(true) as HTMLElement;
  stripData(snap);
  snap.className = "lim-freeze";
  snap.style.transform = getComputedStyle(ctx.camera).transform;
  ctx.camera.after(snap);
  // 写しの画像が描けるようになってから本物を隠す（一瞬黒くならないように）。
  await Promise.all([...snap.querySelectorAll("img")].map((img) => img.decode().catch(() => undefined)));
  ctx.camera.style.visibility = "hidden";
}

/** @bg の method の動きを、カメラの transform（@camera の位置）とぶつからない個別のプロパティにする。 */
function individual(frame: Keyframe): Keyframe {
  const { transform, ...rest } = frame;
  const out: Keyframe = { ...rest };
  const t = String(transform ?? "");
  const move = /translate3d\(([^,]+),\s*([^,]+),/.exec(t);
  const scale = /scale\(([^)]+)\)/.exec(t);
  if (move) out.translate = `${move[1]} ${move[2]}`;
  if (scale) out.scale = scale[1]!;
  return out;
}

/** 写しを本物の下に回し、本物を method の動きで出す。出し終えたら写しを消す（TyranoScript の [trans] と同じく、新しい画面が上から出てくる）。 */
async function runTransition(ctx: RenderContext, a: Args, wait: boolean): Promise<void> {
  await ctx.spriteReady(); // 組み替えた立ち絵が揃ってから切り替える
  const snap = frozen(ctx);
  ctx.camera.style.visibility = "";
  if (!snap) return;
  ctx.camera.before(snap);
  const time = ctx.time(num(a.time, 1500));
  if (time === 0) {
    snap.remove();
    return;
  }
  // ルール（rule・pattern）があれば、暗いところから本物を出す
  if (str(a.rule) || str(a.pattern)) {
    const levels = str(a.rule) ? ruleFromImage(ctx.camera, await ctx.image(ctx.asset("image", str(a.rule)))) : ruleFromPattern(ctx.camera, str(a.pattern) as RulePattern);
    const done = ruleTransition(ctx.camera, levels, time, "show", num(a.vague, 64)).then(() => snap.remove());
    transition = done;
    if (wait) await done;
    return;
  }
  const frames = transitionKeyframes(str(a.method, "crossfade"), "show").map(individual);
  const animation = ctx.camera.animate(frames, { duration: time, easing: "ease" });
  animation.id = "lim-transition";
  const done = animation.finished.then(
    () => snap.remove(),
    () => snap.remove(),
  );
  transition = done;
  if (wait) await done;
}

async function waitTransition(ctx: RenderContext): Promise<void> {
  if (ctx.skipping) for (const x of ctx.camera.getAnimations()) if (x.id === "lim-transition") x.finish();
  await transition;
}

// ---- @bg-place ----

function placeBackground(img: HTMLElement, p: C.BgPlace): void {
  Object.assign(img.style, {
    left: `${p.left}px`,
    top: `${p.top}px`,
    right: "auto",
    bottom: "auto",
    width: p.width === null ? "100%" : `${p.width}px`,
    height: p.height === null ? "100%" : `${p.height}px`,
    objectFit: "fill",
  });
}

/** 新しい背景を method の動きで出し、出し終えたら古い背景を消す（DomHost の @bg と同じ。位置と大きさだけ違う）。 */
async function bgPlace(ctx: RenderContext, a: Args, wait: boolean, stage: StageState): Promise<void> {
  const place = C.bgPlace(stage.extra);
  const img = await ctx.image(ctx.asset("bgimage", str(a.image)));
  if (place) placeBackground(img, place);
  const previous = [...ctx.layers.background.children] as HTMLElement[];
  ctx.layers.background.append(img);
  const fade = ctx.time(num(a.time));
  const method = str(a.method, "crossfade");
  const jobs: Promise<unknown>[] = [];
  if (fade > 0) {
    jobs.push(img.animate(transitionKeyframes(method, "show"), { duration: fade, easing: "ease" }).finished);
    if (a.cross === true) for (const p of previous) jobs.push(p.animate(transitionKeyframes(method, "hide"), { duration: fade, easing: "ease", fill: "forwards" }).finished);
  }
  const done = Promise.all(jobs).then(() => previous.forEach((p) => p.remove()));
  if (wait) await done;
}

// ---- @quake-decay / @vibrate ----

/**
 * 舞台の中身（カメラ・合成・覆い・メッセージ枠・選択肢・UI）をまとめて揺らす。揺れ幅は 1/60 秒ごとに向きを反転し、
 * easeOutQuad で 0 まで弱まる（TyranoScript の [quake2] と同じ）。要素の transform とぶつからないよう translate で動かす。
 */
async function quakeDecay(ctx: RenderContext, a: Args, wait: boolean): Promise<void> {
  const time = ctx.time(num(a.time, 1000));
  // 「画面の揺れ: 控えめ」なら揺らさない
  if (time === 0 || ctx.reduceShake) return;
  const targets = [...ctx.stage.children] as HTMLElement[];
  let base: HTMLElement | null = null;
  if (a["fill-edges"] !== false) {
    base = ctx.layers.background.cloneNode(true) as HTMLElement;
    stripData(base);
    base.className = "layer background lim-quake-base";
    ctx.stage.prepend(base);
  }
  const h = num(a.horizontal);
  const v = num(a.vertical, 200);
  const steps = Math.max(2, Math.round(time / (1000 / 60)));
  const frames: Keyframe[] = [];
  for (let i = 0; i < steps; i++) {
    const sign = i % 2 === 0 ? -1 : 1;
    const amp = (1 - i / steps) ** 2;
    frames.push({ offset: i / steps, translate: `${sign * h * amp}px ${sign * v * amp}px` });
  }
  frames.push({ offset: 1, translate: "0px 0px" });
  const jobs = targets.map((el) => {
    const animation = el.animate(frames, { duration: time });
    animation.id = "lim-quake-decay";
    return track(animation);
  });
  const done = Promise.all(jobs).then(() => base?.remove());
  if (wait) await done;
}

/** 端末（Android のアプリは端末の振動、iOS のアプリは触覚、ブラウザは Vibration API）と、つないでいるゲームパッドを振動させる。 */
function vibrate(ctx: RenderContext, a: Args): void {
  if (ctx.skipping) return;
  const time = num(a.time, 500);
  const count = Math.max(1, num(a.count, 1));
  // 振動と休みを交互に（TyranoScript と同じく、休みも同じ長さ）。
  vibrateDevice(Array.from({ length: 2 * count - 1 }, () => time));
}

// ---- @layer-camera ----

/** TyranoScript のレイヤー一つ分の要素（fg0 は立ち絵の層も含む）。 */
function layerEls(ctx: RenderContext, layer: string): HTMLElement[] {
  if (layer === "base") return [ctx.layers.background];
  if (layer === "fg0") return [ctx.layers.sprites, imageLayer(ctx, "fg0")];
  return [imageLayer(ctx, layer)];
}

// 変形の順は組み込みの @camera と同じ（@liminalia/web の cameraTransform）。

const cameraAnimations = new Set<Animation>();

async function layerCamera(ctx: RenderContext, a: Args, wait: boolean, stage: StageState): Promise<void> {
  const layer = str(a.layer);
  const c = C.layerCameras(stage.extra)[layer as S.FilterLayer];
  const end = c ? cameraTransform(c) : "";
  const hasFrom = ["from-zoom", "from-x", "from-y", "from-rotate"].some((k) => a[k] !== undefined);
  const time = ctx.time(Math.max(10, num(a.time, 1000)));
  const jobs = layerEls(ctx, layer).map((el) => {
    const start = hasFrom
      ? cameraTransform({ zoom: num(a["from-zoom"], 1), x: num(a["from-x"]), y: num(a["from-y"]), rotate: num(a["from-rotate"]) })
      : getComputedStyle(el).transform;
    el.style.transform = end;
    const animation = el.animate([{ transform: start }, { transform: end || "none" }], { duration: time, easing: easing(str(a.ease, "ease")) });
    cameraAnimations.add(animation);
    return animation.finished.then(
      () => void cameraAnimations.delete(animation),
      () => void cameraAnimations.delete(animation),
    );
  });
  if (wait) await Promise.all(jobs);
}

async function waitCamera(ctx: RenderContext): Promise<void> {
  const all = [...ctx.camera.getAnimations(), ...cameraAnimations];
  if (ctx.skipping) for (const x of all) x.finish();
  await Promise.all(all.map((x) => x.finished.then(() => undefined, () => undefined)));
}

// ---- 組み立て直し（ロード時） ----

function restore(ctx: RenderContext, stage: StageState): void {
  frozen(ctx)?.remove();
  for (const x of ctx.camera.getAnimations()) if (x.id === "lim-transition") x.cancel();
  ctx.camera.style.visibility = "";
  transition = null;
  for (const el of ctx.stage.querySelectorAll(":scope > .lim-quake-base")) el.remove();

  // DomHost が背景を画面いっぱいに組み立て直している。@bg-place の背景のままなら位置と大きさを戻す。
  const place = C.bgPlace(stage.extra);
  const img = ctx.layers.background.lastElementChild as HTMLElement | null;
  if (place && img && place.image === stage.background) placeBackground(img, place);

  for (const x of cameraAnimations) x.cancel();
  cameraAnimations.clear();
  const cameras = C.layerCameras(stage.extra);
  for (const layer of S.FILTER_LAYERS) {
    const c = cameras[layer];
    for (const el of layerEls(ctx, layer)) el.style.transform = c ? cameraTransform(c) : "";
  }
}

export const renderers: Record<string, Renderer> = {
  freeze: (ctx) => freeze(ctx),
  transition: (ctx, a, wait) => runTransition(ctx, a, wait),
  "wait-transition": (ctx) => waitTransition(ctx),
  "bg-place": (ctx, a, wait, stage) => bgPlace(ctx, a, wait, stage),
  "quake-decay": (ctx, a, wait) => quakeDecay(ctx, a, wait),
  vibrate: (ctx, a) => vibrate(ctx, a),
  "vibrate-stop": () => vibrateDevice([]),
  "layer-camera": (ctx, a, wait, stage) => layerCamera(ctx, a, wait, stage),
  "reset-layer-camera": (ctx, a, wait, stage) => layerCamera(ctx, a, wait, stage),
  "wait-camera": (ctx) => waitCamera(ctx),
};

export const restorers: Restorer[] = [restore];
