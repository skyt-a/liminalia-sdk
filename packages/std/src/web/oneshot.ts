import type { StageState, Value } from "@liminalia/runtime";
import type { AssetKind, EffectScope, Renderer, RenderContext, Restorer } from "@liminalia/web";
import { flipbookFrames, flipbookLoops, readCutins, readFlipbookLoops, splitDataRef, type FlipbookData } from "../commands/oneshot.ts";
import "./oneshot.css";

/**
 * 一回きりの演出（@flipbook・@flash・@blink・@cutin）の描画。
 * 演出は ctx.scope() に要素とタイマーを預けるので、ロードとスキップの始まりにエンジンが片付ける。待ちは scope.sleep で書き、
 * クリックの早送り・スキップで縮み、「光の点滅」を「控えめ」にしていれば @flash を点滅させない。
 * @flipbook loop=0（止めるまで繰り返す）だけは状態に残るので、スキップでは片付けず（keepOnSkip）、コマは実時間で送り、ロードで流し直す。
 */

type Args = Record<string, Value>;

const num = (v: Value | undefined, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: Value | undefined, d = ""): string => (typeof v === "string" ? v : d);

/** 置く層。 */
function layerOf(ctx: RenderContext, name: string): HTMLElement {
  return name === "images" ? ctx.layers.images : name === "fx" ? ctx.layers.fx : name === "hud" ? ctx.layers.hud : ctx.layers.overlay;
}

/** 待つ命令は終わるまで待ち、待たない命令は裏で流す。 */
function run(wait: boolean, job: Promise<void>): Promise<void> | void {
  const safe = job.catch((e: unknown) => console.warn(e));
  return wait ? safe : undefined;
}

// ---- @flipbook ----

const flipbookData = new Map<string, Promise<unknown>>();

async function flipbookDataOf(ctx: RenderContext, ref: string): Promise<FlipbookData | null> {
  const { name, key } = splitDataRef(ref);
  let p = flipbookData.get(name);
  if (!p) {
    p = ctx.loadData(name).catch((e: unknown) => {
      flipbookData.delete(name);
      console.warn(`@flipbook のデータ ${name} を読めません`, e);
      return null;
    });
    flipbookData.set(name, p);
  }
  const all = (await p) as Record<string, unknown> | null;
  const picked = all && (key === null ? all : all[key]);
  return picked && typeof picked === "object" ? (picked as FlipbookData) : null;
}

/** 繰り返しているコマ送り（舞台ごと）。 */
const loopsOf = new WeakMap<HTMLElement, { name: string; scope: EffectScope; img: HTMLImageElement }[]>();
const runningLoops = (ctx: RenderContext) => {
  let list = loopsOf.get(ctx.stage);
  if (!list) loopsOf.set(ctx.stage, (list = []));
  return list;
};

async function flipbook(ctx: RenderContext, a: Args): Promise<void> {
  const loops = flipbookLoops(a);
  // 速いコマ送りは、スキップ中は出さない（止めるまで繰り返すものは、スキップ中も流しておく）
  if (ctx.skipping && !loops) return;
  const name = str(a.name);
  // 同じ名前で流し直したら、前のものを止める
  if (loops && name !== "") void stopLoops(ctx, name, 0);
  const data = typeof a.data === "string" && a.data !== "" ? await flipbookDataOf(ctx, a.data) : null;
  const plan = flipbookFrames(a, data);
  if ("error" in plan) {
    console.warn(plan.error);
    return;
  }
  const scope = ctx.scope(loops ? { keepOnSkip: true } : {});
  const img = document.createElement("img");
  if (loops) {
    // 止める（@flipbook-off）ときのために名前で控える。片付けたら外す
    const list = runningLoops(ctx);
    const entry = { name, scope, img };
    list.push(entry);
    scope.defer(() => {
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    });
  }
  const urls = plan.frames.map((f) => ctx.asset(plan.folder as AssetKind, f.path));
  // 全コマを読み込んでから流す（読めないコマがあっても始める）
  await Promise.allSettled(urls.map((u) => ctx.image(u)));
  if (scope.disposed) return;
  scope.add(img);
  img.className = "lim-flipbook";
  img.alt = "";
  img.draggable = false;
  Object.assign(img.style, {
    left: `${num(a.x, 0)}px`,
    top: `${num(a.y, 0)}px`,
    width: `${num(a.width, ctx.screen.width)}px`,
    height: `${num(a.height, ctx.screen.height)}px`,
    opacity: String(Math.min(1, Math.max(0, num(a.opacity, 1)))),
    mixBlendMode: str(a.blend, "normal"),
    transform: a.reflect === true ? "scaleX(-1)" : "",
  });
  layerOf(ctx, str(a.layer, "fx")).append(img);
  const speed = Math.min(10, Math.max(0.05, num(a.speed, 1)));
  if (loops) {
    // 止めるまで繰り返す: 早送りとスキップで縮まない実時間で送る（scope.sleep はスキップ中に 0 になる）
    let i = 0;
    const step = () => {
      img.src = urls[i]!;
      const ms = Math.max(16, plan.frames[i]!.ms / speed);
      i = (i + 1) % urls.length;
      scope.setTimeout(step, ms);
    };
    step();
    return;
  }
  const count = Math.max(1, Math.min(999, Math.floor(num(a.loop, 1))));
  for (let loop = 0; loop < count && !scope.disposed; loop++) {
    for (let i = 0; i < urls.length && !scope.disposed; i++) {
      img.src = urls[i]!;
      await scope.sleep(Math.max(1, plan.frames[i]!.ms / speed));
    }
  }
  scope.dispose();
}

// ---- @flash ----

async function flash(ctx: RenderContext, a: Args): Promise<void> {
  if (ctx.skipping) return;
  const type = str(a.type, "white");
  const color = type === "black" ? "#000000" : type === "color" ? str(a.color, "#ffffff") : "#ffffff";
  const scope = ctx.scope();
  const el = scope.add(document.createElement("div"));
  el.className = `lim-flash lim-flash--${type}`;
  if (type !== "invert") el.style.background = color;
  layerOf(ctx, str(a.layer, "overlay")).append(el);
  const time = num(a.time, 60);
  const gap = num(a.gap, 60);
  const fade = num(a.fade, 120);
  const count = Math.max(1, Math.min(20, Math.floor(num(a.count, 1))));
  // ヒットストップ: 画面の動きを止めて寄せる。後始末は scope が受け持つ
  const hitstop = Math.max(0, num(a.hitstop, 0));
  const resume = hitstop > 0 ? freeze(ctx, scope, num(a.zoom, 1)) : null;
  if (ctx.reduceFlash) {
    // 「光の点滅: 控えめ」なら、点滅させずに薄い幕を一度かけて外す（反転は暗い幕に置き換える）
    el.className = "lim-flash lim-flash--soft";
    el.style.background = type === "invert" || type === "black" ? "#000000" : color;
    const total = Math.max(200, count * (time + gap) + fade);
    await el.animate([{ opacity: 0 }, { opacity: 0.35, offset: 0.3 }, { opacity: 0 }], { duration: ctx.time(total), easing: "ease-in-out" }).finished.catch(() => undefined);
    if (resume) {
      await scope.sleep(hitstop);
      await resume();
    }
    scope.dispose();
    return;
  }
  for (let i = 0; i < count && !scope.disposed; i++) {
    el.style.opacity = "1";
    await scope.sleep(time);
    if (i < count - 1) {
      el.style.opacity = "0";
      await scope.sleep(gap);
    }
  }
  // 最後のコマを出したまま止めて置き、動きを戻しながら消す
  if (resume && !scope.disposed) await scope.sleep(hitstop);
  const out = !scope.disposed ? el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ctx.time(fade), easing: "ease-out", fill: "forwards" }).finished.catch(() => undefined) : Promise.resolve();
  await Promise.all([out, resume?.()]);
  scope.dispose();
}

/**
 * 画面の動きを止める（ヒットストップ）。カメラの外側の層（ctx.world）の中で動いているもの（立ち絵の揺れ、@anim、画面効果の CSS の動き）を一時停止し、
 * zoom 倍に一瞬で寄せる。返す関数で動きを戻し、寄せたのを戻す（済んだら解決する）。片付けられたときも戻す。
 */
function freeze(ctx: RenderContext, scope: EffectScope, zoom: number): () => Promise<void> {
  const paused = ctx.world.getAnimations({ subtree: true }).filter((anim) => anim.playState === "running");
  for (const anim of paused) anim.pause();
  const world = ctx.world;
  const before = world.style.scale;
  if (zoom !== 1) {
    world.style.scale = String(zoom);
    world.animate([{ scale: before || "1" }, { scale: String(zoom) }], { duration: ctx.time(40), easing: "cubic-bezier(0.05, 0.85, 0.2, 1)" });
  }
  let done = false;
  const release = async () => {
    if (done) return;
    done = true;
    for (const anim of paused) if (anim.playState === "paused") anim.play();
    if (zoom !== 1) {
      world.style.scale = before;
      await world.animate([{ scale: String(zoom) }, { scale: before || "1" }], { duration: ctx.time(200), easing: "cubic-bezier(0.16, 1, 0.3, 1)" }).finished.catch(() => undefined);
    }
  };
  scope.defer(() => void release());
  return release;
}

// ---- @blink ----

async function blink(ctx: RenderContext, a: Args): Promise<void> {
  if (ctx.skipping) return;
  const scope = ctx.scope();
  const root = scope.add(document.createElement("div"));
  root.className = "lim-blink";
  const color = str(a.color, "#000000");
  const soft = Math.max(0, num(a.soft, 0));
  root.style.setProperty("--lim-blink-color", color);
  root.style.setProperty("--lim-blink-soft", `${soft}px`);
  const top = document.createElement("div");
  const bottom = document.createElement("div");
  top.className = "lim-blink-lid lim-blink-top";
  bottom.className = "lim-blink-lid lim-blink-bottom";
  root.append(top, bottom);
  layerOf(ctx, str(a.layer, "overlay")).append(root);
  const close = Math.max(1, num(a.close, 140));
  const hold = Math.max(0, num(a.hold, 160));
  const open = Math.max(1, num(a.open, 300));
  const gap = Math.max(0, num(a.gap, 260));
  const count = Math.max(1, Math.min(10, Math.floor(num(a.count, 1))));
  for (let i = 0; i < count && !scope.disposed; i++) {
    const shut = { duration: ctx.time(close), easing: "cubic-bezier(0.55, 0, 0.75, 0.3)", fill: "forwards" as const };
    await Promise.all([top.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], shut).finished, bottom.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], shut).finished]).catch(() => undefined);
    await scope.sleep(hold);
    const lift = { duration: ctx.time(open), easing: "cubic-bezier(0.25, 0.7, 0.4, 1)", fill: "forwards" as const };
    await Promise.all([top.animate([{ transform: "scaleY(1)" }, { transform: "scaleY(0)" }], lift).finished, bottom.animate([{ transform: "scaleY(1)" }, { transform: "scaleY(0)" }], lift).finished]).catch(() => undefined);
    if (i < count - 1) await scope.sleep(gap);
  }
  scope.dispose();
}

// ---- @cutin ----

/** カットインの枠と、差し込む・引く動きの姿（shift は差し込む向きのずれ）。 */
interface CutinFrame {
  frame: HTMLDivElement;
  /** 引いた先（差し込む前）の姿と、置いた姿。 */
  away: Keyframe;
  home: Keyframe;
}

/** 枠付きの画像を作る（まだ置かない）。大きさは width・height、無ければ max-width・max-height に収まる大きさ、無ければ画像の大きさ。 */
async function buildCutin(ctx: RenderContext, a: Args): Promise<CutinFrame> {
  const img = await ctx.image(ctx.asset("image", str(a.image)));
  const frame = document.createElement("div");
  frame.className = "lim-cutin-frame";
  const nw = img.naturalWidth || 1;
  const nh = img.naturalHeight || 1;
  const border = Math.max(0, num(a.border, 8));
  const padding = Math.max(0, num(a.padding, 0));
  let w = typeof a.width === "number" ? a.width : typeof a.height === "number" ? (a.height * nw) / nh : nw;
  let h = typeof a.height === "number" ? a.height : typeof a.width === "number" ? (a.width * nh) / nw : nh;
  if (typeof a.width !== "number" && typeof a.height !== "number") {
    // 上限の箱（枠と余白を含む）に、縦横比のまま縮めて収める
    const edge = (border + padding) * 2;
    const maxW = typeof a["max-width"] === "number" ? Math.max(1, a["max-width"] - edge) : Infinity;
    const maxH = typeof a["max-height"] === "number" ? Math.max(1, a["max-height"] - edge) : Infinity;
    const scale = Math.min(1, maxW / nw, maxH / nh);
    w = nw * scale;
    h = nh * scale;
  }
  img.className = "lim-cutin-image";
  img.draggable = false;
  img.alt = "";
  Object.assign(img.style, { width: `${w}px`, height: `${h}px` });
  Object.assign(frame.style, {
    left: `${num(a.x, ctx.screen.width / 2)}px`,
    top: `${num(a.y, ctx.screen.height / 2)}px`,
    borderWidth: `${border}px`,
    borderColor: str(a.frame, "#ffffff"),
    background: str(a.frame, "#ffffff"),
    padding: `${padding}px`,
  });
  frame.append(img);
  const rotate = num(a.rotate, 0);
  const from = str(a.from, "right");
  const far = Math.max(ctx.screen.width, ctx.screen.height);
  const offset = from === "right" ? `${far}px 0` : from === "left" ? `${-far}px 0` : from === "top" ? `0 ${-far}px` : from === "bottom" ? `0 ${far}px` : "0 0";
  const place = (shift: string, opacity: number): Keyframe => ({ transform: `translate(-50%, -50%) translate(${shift.replace(" ", ", ")}) rotate(${rotate}deg)`, opacity });
  const home = place("0 0", 1);
  Object.assign(frame.style, { transform: home.transform });
  return { frame, away: place(offset, from === "none" ? 0 : 1), home };
}

async function cutin(ctx: RenderContext, a: Args): Promise<void> {
  if (a.stay === true) return stayCutin(ctx, a);
  if (ctx.skipping) return;
  const scope = ctx.scope();
  const { frame, away, home } = await buildCutin(ctx, a);
  if (scope.disposed) return;
  scope.add(frame);
  layerOf(ctx, str(a.layer, "overlay")).append(frame);
  const release = a["hide-window"] === true ? ctx.window.hide() : null;
  if (release) scope.defer(release);
  await frame.animate([away, home], { duration: ctx.time(num(a.in, 250)), easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "forwards" }).finished.catch(() => undefined);
  await scope.sleep(num(a.time, 1200));
  if (!scope.disposed) await frame.animate([home, { ...away, opacity: 0 }], { duration: ctx.time(num(a.out, 250)), easing: "cubic-bezier(0.6, 0, 0.8, 0.4)", fill: "forwards" }).finished.catch(() => undefined);
  scope.dispose();
}

/** 残しているカットイン（舞台ごと。名前 → 枠と引く姿）。状態から出し直すので、演出の後始末（scope）には預けない。 */
const stayingOf = new WeakMap<HTMLElement, Map<string, CutinFrame>>();
const staying = (ctx: RenderContext) => {
  let map = stayingOf.get(ctx.stage);
  if (!map) stayingOf.set(ctx.stage, (map = new Map()));
  return map;
};

/** 残すカットイン（stay=true）。差し込んで、そのまま置く。同じ名前のものと入れ替わる。スキップ中とロードでは動かさずに置く。 */
async function stayCutin(ctx: RenderContext, a: Args, animate = true): Promise<void> {
  const name = str(a.name);
  const built = await buildCutin(ctx, a);
  built.frame.classList.add("lim-cutin-frame--stay");
  built.frame.dataset.cutin = name;
  const map = staying(ctx);
  const previous = map.get(name);
  map.set(name, built);
  // 残すものの既定は、暗転の下（hud の層。暗転と章の扉の間は隠れる）
  layerOf(ctx, str(a.layer, "hud")).append(built.frame);
  const ms = animate ? ctx.time(num(a.in, 250)) : 0;
  if (ms > 0) {
    const job = () => built.frame.animate([built.away, built.home], { duration: ms, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }).finished.catch(() => undefined);
    await (a["hide-window"] === true ? ctx.window.hideWhile(job) : job());
  }
  previous?.frame.remove();
}

/** 残しているカットインを引く（name が null ならすべて）。time を省くと出したときの out。 */
async function hideCutins(ctx: RenderContext, a: Args, stage: StageState): Promise<void> {
  const name = typeof a.name === "string" ? a.name : null;
  const map = staying(ctx);
  const kept = new Set(readCutins(stage.extra).map((c) => c.name));
  const leaving = [...map.entries()].filter(([n]) => (name === null || n === name) && !kept.has(n));
  for (const [n] of leaving) map.delete(n);
  const job = () =>
    Promise.all(
      leaving.map(async ([, c]) => {
        const ms = ctx.time(typeof a.time === "number" ? a.time : 250);
        if (ms > 0 && c.frame.isConnected) await c.frame.animate([c.home, { ...c.away, opacity: 0 }], { duration: ms, easing: "cubic-bezier(0.6, 0, 0.8, 0.4)", fill: "forwards" }).finished.catch(() => undefined);
        c.frame.remove();
      }),
    ).then(() => undefined);
  await (a["hide-window"] === true && leaving.length > 0 ? ctx.window.hideWhile(job) : job());
}

/** 繰り返しているコマ送りを止める（name が null ならすべて）。fade ミリ秒で消す。 */
function stopLoops(ctx: RenderContext, name: string | null, fade: number): Promise<void> {
  const list = runningLoops(ctx).filter((l) => name === null || l.name === name);
  const ms = ctx.time(fade);
  return Promise.all(
    list.map(async (l) => {
      if (ms > 0 && l.img.isConnected) await l.img.animate([{ opacity: getComputedStyle(l.img).opacity }, { opacity: 0 }], { duration: ms, easing: "ease-out", fill: "forwards" }).finished.catch(() => undefined);
      l.scope.dispose();
    }),
  ).then(() => undefined);
}

/** ロードしたとき、繰り返しているコマ送りを流し直し、残しているカットインを置き直す（片付けはエンジンが組み立て直す前に済ませている）。 */
export const restorers: Restorer[] = [
  async (ctx: RenderContext, stage: StageState) => {
    void stopLoops(ctx, null, 0);
    for (const l of readFlipbookLoops(stage.extra)) void flipbook(ctx, l.args).catch((e: unknown) => console.warn(e));
    const map = staying(ctx);
    for (const c of map.values()) c.frame.remove();
    map.clear();
    for (const c of readCutins(stage.extra)) await stayCutin(ctx, c.args, false).catch((e: unknown) => console.warn(e));
  },
];

export const renderers: Record<string, Renderer> = {
  // 止めるまで繰り返すもの（loop=0）は待たない
  flipbook: (ctx, a, wait) => run(wait && !flipbookLoops(a), flipbook(ctx, a)),
  "flipbook-off": (ctx, a) => stopLoops(ctx, typeof a.name === "string" ? a.name : null, num(a.time, 0)),
  flash: (ctx, a, wait) => run(wait, flash(ctx, a)),
  blink: (ctx, a, wait) => run(wait, blink(ctx, a)),
  cutin: (ctx, a, wait) => run(wait, cutin(ctx, a)),
  "cutin-hide": (ctx, a, wait, stage) => run(wait, hideCutins(ctx, a, stage)),
};
