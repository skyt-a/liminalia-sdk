import * as S from "../commands/image.ts";
import type { StageState, Value } from "@liminalia/runtime";
import type { AssetKind, Renderer, RenderContext, Restorer } from "@liminalia/web";
import type { Look } from "../commands/anim.ts";
import { applyLook } from "./look.ts";
import "./image.css";

/**
 * 画像・レイヤー・合成・フィルタ・立ち絵の移動の描画。
 *
 * 重ね順（TyranoScript のレイヤー → このエンジンの層）:
 *   base（背景）        → layers.background
 *   0（立ち絵）         → layers.sprites（立ち絵）と、layers.images の中の fg0（@image で置いた画像）
 *   1・2               → layers.images の中の fg1・fg2（カメラの内側、立ち絵の上）
 *   [layermode]（z=99） → layers.fx（カメラの外側、メッセージ枠の下）
 *
 * 他の命令の要素を TyranoScript のレイヤーごと消させたいとき（TyranoScript で layer=0 に置いた章タイトルなどは
 * [freeimage layer=0] で片付けられる）は、その要素に data-layer="fg0" などを付けておけば @free-image で一緒に消える。
 */

type Args = Record<string, Value>;

const num = (v: Value | undefined, d = 0): number => (typeof v === "number" ? v : d);
const str = (v: Value | undefined, d = ""): string => (typeof v === "string" ? v : d);
const asset = (ctx: RenderContext, folder: string, path: string): string => ctx.asset(folder as AssetKind, path);

// ---- 層 ----

function layerRoot(ctx: RenderContext): HTMLDivElement {
  let root = ctx.layers.images.querySelector<HTMLDivElement>(":scope > .lim-img-root");
  if (!root) {
    root = document.createElement("div");
    root.className = "lim-img-root";
    for (const name of S.IMAGE_LAYERS) {
      const layer = document.createElement("div");
      layer.className = "lim-img-layer";
      layer.dataset.layer = name;
      root.append(layer);
    }
    // 他の担当が layers.images に置く演出より下にする。
    ctx.layers.images.prepend(root);
  }
  return root;
}

export function imageLayer(ctx: RenderContext, name: string): HTMLDivElement {
  return layerRoot(ctx).querySelector<HTMLDivElement>(`:scope > [data-layer="${name}"]`)!;
}

/**
 * レイヤーに置いたもののうち、状態の一覧の項目に当たる要素（並びは一覧と同じ）。消えていく途中のものと、
 * 状態に残らない一時的なもの（data-transient を付けたもの）は除く。
 */
export function layerItems(ctx: RenderContext, name: string): HTMLElement[] {
  return ([...imageLayer(ctx, name).children] as HTMLElement[]).filter((el) => el.dataset.transient === undefined);
}

/** TyranoScript のレイヤー一つ分に当たる要素（fg0 は立ち絵の層も含む）。 */
export function layerTargets(ctx: RenderContext, name: string): HTMLElement[] {
  if (name === "base") return [ctx.layers.background];
  if (name === "fg0") return [ctx.layers.sprites, imageLayer(ctx, "fg0")];
  return [imageLayer(ctx, name)];
}

// ---- 部品 ----

/**
 * 画像の要素。SVG もほかの画像と同じく <img> で読む（前は TyranoScript と同じ <object> だったが、それだと SVG の中のスクリプトが
 * ゲームのページのオリジンで動く。<img> ではスクリプトが動かない代わりに、SVG の中から参照する別のファイルの画像も読まれない）。
 */
export async function loadElement(ctx: RenderContext, url: string): Promise<HTMLElement> {
  return ctx.image(url);
}

export function fadeIn(ctx: RenderContext, el: HTMLElement, ms: number, to = 1): Promise<void> {
  el.style.opacity = "0";
  return ctx.fade(el, to, ctx.time(ms));
}

export async function fadeOutAndRemove(ctx: RenderContext, els: HTMLElement[], ms: number): Promise<void> {
  for (const el of els) el.dataset.transient = "";
  const t = ctx.time(ms);
  if (t > 0) await Promise.all(els.map((el) => ctx.fade(el, 0, t)));
  for (const el of els) el.remove();
}

// ---- [image] ----

/** 一枚の絵の一部を canvas に写す（@image の sx・sy・sw・sh）。 */
async function croppedImage(ctx: RenderContext, url: string, crop: NonNullable<S.PlacedImage["crop"]>): Promise<HTMLElement> {
  const img = await ctx.image(url);
  const canvas = Object.assign(document.createElement("canvas"), { width: crop.width, height: crop.height });
  canvas.getContext("2d")?.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return canvas;
}

async function buildImage(ctx: RenderContext, item: S.PlacedImage): Promise<HTMLElement> {
  const url = asset(ctx, item.folder, item.file);
  const el = item.crop ? await croppedImage(ctx, url, item.crop) : await loadElement(ctx, url);
  el.classList.add("lim-img");
  if (item.flip) el.classList.add("lim-img--flip");
  if (item.name) el.dataset.name = item.name;
  Object.assign(el.style, { left: `${item.x}px`, top: `${item.y}px`, zIndex: String(item.zindex) });
  if (item.width !== null) el.style.width = `${item.width}px`;
  if (item.height !== null) el.style.height = `${item.height}px`;
  return el;
}

async function showImage(ctx: RenderContext, a: Args, wait: boolean): Promise<void> {
  const item: S.PlacedImage = {
    kind: "image",
    file: str(a.file),
    folder: str(a.folder, "fgimage"),
    name: str(a.name),
    x: num(a.x),
    y: num(a.y),
    width: typeof a.width === "number" ? a.width : null,
    height: typeof a.height === "number" ? a.height : null,
    ...(typeof a.sw === "number" && typeof a.sh === "number" ? { crop: { x: num(a.sx), y: num(a.sy), width: a.sw, height: a.sh } } : {}),
    zindex: num(a.zindex, 1),
    flip: a.flip === true,
  };
  const el = await buildImage(ctx, item);
  const layer = imageLayer(ctx, str(a.layer, "fg1"));
  el.style.opacity = "0";
  if (a.depth === "back") layer.prepend(el);
  else layer.append(el);
  const done = fadeIn(ctx, el, num(a.time));
  if (wait) await done;
}

async function freeImage(ctx: RenderContext, a: Args, wait: boolean): Promise<void> {
  const name = str(a.layer);
  const only = str(a.name);
  let els: HTMLElement[];
  if (name === "base") {
    els = [...ctx.layers.background.children] as HTMLElement[];
  } else if (only) {
    // その名前の画像だけ（@image name=）
    els = ([...imageLayer(ctx, name).children] as HTMLElement[]).filter((el) => el.dataset.name === only);
  } else {
    els = [...imageLayer(ctx, name).children] as HTMLElement[];
    // プラグインが TyranoScript の同じレイヤーに置いたもの（data-layer で目印を付けたもの）。
    els.push(...ctx.stage.querySelectorAll<HTMLElement>(`[data-layer="${name}"]:not(.lim-img-layer)`));
  }
  const done = fadeOutAndRemove(ctx, els, num(a.time));
  if (wait) await done;
}

// ---- [layopt] ----

function applyLayerOption(ctx: RenderContext, name: string, o: S.LayerOption): void {
  for (const el of layerTargets(ctx, name)) {
    el.style.display = o.visible === false ? "none" : "";
    el.style.opacity = o.opacity === undefined ? "" : String(o.opacity);
    el.style.translate = o.left === undefined && o.top === undefined ? "" : `${o.left ?? 0}px ${o.top ?? 0}px`;
  }
}

// ---- プラグインが足す種類 ----

/** レイヤーに置く項目の種類ごとの組み立て（ロード時）。kind "image" は組み込み。 */
const itemBuilders = new Map<string, (ctx: RenderContext, item: S.ForeignLayerItem) => Promise<HTMLElement>>();

/**
 * @image 以外のものを前景レイヤー（fg0〜fg2）に置く命令が、ロード時の組み立て方を登録する。
 * 状態は stage.extra の画像の一覧（@liminalia/std/commands の readExtra / writeExtra）に kind 付きで積む。
 */
export function registerLayerItem(kind: string, build: (ctx: RenderContext, item: S.ForeignLayerItem) => Promise<HTMLElement>): void {
  itemBuilders.set(kind, build);
}

async function buildItem(ctx: RenderContext, item: S.LayerItem): Promise<HTMLElement | null> {
  if (item.kind === "image") return buildImage(ctx, item as S.PlacedImage);
  const build = itemBuilders.get(item.kind);
  if (!build) {
    console.warn(`レイヤーの項目の種類 ${item.kind} の描画処理が登録されていません`);
    return null;
  }
  const el = await build(ctx, item as S.ForeignLayerItem);
  // @anim / @kanim が名前で探すための目印。
  if (typeof item.name === "string" && item.name !== "") el.dataset.name = item.name;
  return el;
}

// ---- [layermode] ----

async function buildBlend(ctx: RenderContext, b: S.Blend, loop = true): Promise<HTMLElement> {
  if (b.movie) return buildBlendMovie(ctx, b, b.movie, loop);
  const el = document.createElement("div");
  el.className = "lim-blend";
  el.dataset.blend = b.name;
  if (b.color) el.style.backgroundColor = b.color;
  if (b.graphic) {
    const url = asset(ctx, b.folder, b.graphic);
    // TyranoScriptは画像を読み終えてから出し始める。
    await ctx.image(url);
    el.style.backgroundImage = `url("${url}")`;
  }
  el.style.mixBlendMode = b.mode;
  return el;
}

/**
 * @blend-movie の動画。TyranoScript の [layermode_movie] と同じく、fit=true は画面を覆う大きさ、
 * fit=false は高さを画面に合わせる。読み込みを待たずに返す（流れ始めたら見える）。
 */
function buildBlendMovie(ctx: RenderContext, b: S.Blend, m: S.BlendMovie, loop: boolean): HTMLVideoElement {
  const video = document.createElement("video");
  video.className = "lim-blend lim-blend-movie";
  video.dataset.blend = b.name;
  video.src = ctx.asset("video", m.file);
  video.loop = loop;
  // 音のない動画は自動再生を拒まれないよう muted にする。
  video.muted = m.volume === 0;
  // 音量は volume × コンフィグの BGM の音量（ui.sound.movie）× 全体の音量
  ctx.audio.bindMedia(video, m.volume);
  video.playsInline = true;
  video.style.mixBlendMode = b.mode;
  video.style.objectFit = m.fit ? "cover" : "contain";
  for (const k of ["left", "top", "width", "height"] as const) if (m[k] !== null) video.style[k] = `${m[k]}px`;
  if (m.width !== null || m.height !== null || m.left !== null || m.top !== null) video.style.inset = "auto";
  video.addEventListener("loadedmetadata", () => (video.playbackRate = m.speed), { once: true });
  // 自動再生が止められたら、音を消して鳴らし直す。それでも鳴らせなければ（読めない形式など）作る人に分かるように残す
  video.play().catch(() => {
    video.muted = true;
    void video.play().catch((e: unknown) => console.warn(`動画を再生できません: ${m.file}`, e));
  });
  return video;
}

async function showBlendMovie(ctx: RenderContext, a: Args, wait: boolean): Promise<void> {
  const loop = a.loop !== false;
  const b: S.Blend = {
    name: str(a.name),
    graphic: "",
    folder: "image",
    color: "",
    mode: str(a.mode, "multiply"),
    opacity: Math.max(0, Math.min(1, num(a.opacity, 255) / 255)),
    movie: {
      file: str(a.file),
      volume: num(a.volume, 0),
      speed: num(a.speed, 1),
      fit: a.fit !== false,
      left: typeof a.left === "number" ? a.left : null,
      top: typeof a.top === "number" ? a.top : null,
      width: typeof a.width === "number" ? a.width : null,
      height: typeof a.height === "number" ? a.height : null,
    },
  };
  const el = await buildBlend(ctx, b, loop);
  el.style.opacity = "0";
  ctx.layers.fx.append(el);
  const shown = ctx.fade(el, b.opacity, ctx.time(num(a.time, 500)));
  // 繰り返さない動画は流し終えたら消える（状態にも残していない）。
  const ended = loop
    ? shown
    : new Promise<void>((resolve) => {
        const end = () => {
          el.remove();
          resolve();
        };
        el.addEventListener("ended", end, { once: true });
        el.addEventListener("error", end, { once: true });
      });
  if (wait) await (loop ? shown : ended);
}

async function showBlend(ctx: RenderContext, a: Args, wait: boolean): Promise<void> {
  const b: S.Blend = {
    name: str(a.name),
    graphic: str(a.graphic),
    folder: str(a.folder, "image"),
    color: str(a.color),
    mode: str(a.mode, "multiply"),
    opacity: Math.max(0, Math.min(1, num(a.opacity, 255) / 255)),
  };
  const job = (async () => {
    const el = await buildBlend(ctx, b);
    el.style.opacity = "0";
    ctx.layers.fx.append(el);
    await ctx.fade(el, b.opacity, ctx.time(num(a.time, 500)));
  })();
  if (wait) await job;
}

async function hideBlend(ctx: RenderContext, a: Args, wait: boolean): Promise<void> {
  const name = str(a.name);
  const els = [...ctx.layers.fx.querySelectorAll<HTMLElement>(":scope > .lim-blend")].filter((el) => name === "" || el.dataset.blend === name);
  const done = fadeOutAndRemove(ctx, els, num(a.time, 500)).then(() => {
    for (const el of els) if (el instanceof HTMLVideoElement) el.pause();
  });
  if (wait) await done;
}

// ---- [filter] ----

/**
 * @filter の状態を画面に当てる。fade（ミリ秒）があれば前のフィルタから移す。範囲を決めたフィルタ（filterMasks）は、
 * そのレイヤーのすぐ上に置いた板の backdrop-filter で、そのレイヤーとそれより下のすべての、範囲の中にかける。
 */
function applyFilters(ctx: RenderContext, stage: StageState, fade = 0): Promise<void> {
  const filters = S.readExtra(stage.extra, "filters") ?? {};
  const masks = S.readExtra(stage.extra, "filterMasks") ?? {};
  const jobs: Promise<unknown>[] = [];
  for (const name of S.FILTER_LAYERS) {
    for (const el of layerTargets(ctx, name)) {
      const before = el.dataset.cssFilter ?? "";
      const after = filters[name] ?? "";
      el.dataset.cssFilter = after;
      composeFilter(el);
      // 前のフィルタから移す（フィルタの関数の並びが同じなら滑らかに、違えば切り替わる）
      if (fade > 0 && before !== after) jobs.push(el.animate([{ filter: before || "none" }, { filter: after || "none" }], { duration: fade, easing: "ease" }).finished.catch(() => undefined));
    }
    jobs.push(syncMaskedFilter(ctx, name, masks[name], fade));
  }
  return Promise.all(jobs).then(() => undefined);
}

/**
 * 範囲を決めたフィルタの板を置く場所。下にあるものを写すので、カメラの中の層のすぐ上に置く（前景の fg0〜fg2 の中に置くと、
 * WebKit では前景の外を写さない）。base は背景の上、fg0 は立ち絵の上、fg1・fg2 は前景の上。
 */
function maskSlot(ctx: RenderContext, name: S.FilterLayer): { parent: HTMLElement; after: HTMLElement } {
  return { parent: ctx.camera, after: name === "base" ? ctx.layers.background : name === "fg0" ? ctx.layers.sprites : ctx.layers.images };
}

/**
 * 下を写す板（backdrop-filter）を描けるか。エンジンが動くブラウザ（@layer のあるもの）で描けないのは Firefox の 97〜102 だけ。
 * Safari と iOS の WKWebView は描く（Playwright の WebKit の撮影と WKWebView.takeSnapshot には写らないが、画面には出る）。
 */
let backdropSupport: boolean | undefined;
function canBackdrop(): boolean {
  backdropSupport ??= typeof CSS !== "undefined" && (CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)"));
  return backdropSupport;
}

/**
 * 範囲を決めたフィルタの板を、状態に合わせて置く・替える・外す（fade ミリ秒で出し入れする）。
 * 板を描けないブラウザでは出さない（レイヤー全体にかけると、範囲の外まで変わって場面が読めなくなるため）。開発者ツールに一度知らせる。
 */
async function syncMaskedFilter(ctx: RenderContext, name: S.FilterLayer, want: S.MaskedFilter | undefined, fade: number): Promise<void> {
  if (want && !canBackdrop()) {
    if (!warnedBackdrop) console.warn("このブラウザは backdrop-filter を描けないため、範囲を決めた @filter（mask=）は出しません");
    warnedBackdrop = true;
    want = undefined;
  }
  const { parent, after } = maskSlot(ctx, name);
  const current = parent.querySelector<HTMLElement>(`:scope > .lim-filter-mask[data-filter-layer="${name}"]:not([data-leaving])`);
  const key = want ? JSON.stringify(want) : "";
  if (current?.dataset.mask === key) return;
  const jobs: Promise<unknown>[] = [];
  if (current) {
    current.dataset.leaving = "";
    jobs.push(fadeOutAndRemove(ctx, [current], fade));
  }
  if (want) {
    const el = document.createElement("div");
    el.className = "lim-filter-mask";
    // data-layer は @free-image が消す目印なので使わない
    el.dataset.filterLayer = name;
    el.dataset.transient = "";
    el.dataset.mask = key;
    const image = S.maskImage(want);
    Object.assign(el.style, { backdropFilter: want.css, webkitBackdropFilter: want.css, maskImage: image, webkitMaskImage: image });
    after.after(el);
    if (fade > 0) jobs.push(fadeIn(ctx, el, fade));
  }
  await Promise.all(jobs);
}

let warnedBackdrop = false;

/** 要素の filter を、@effect のフィルタ（data-fx-filter）と @filter の CSS（data-css-filter）を重ねたものにする。 */
export function composeFilter(el: HTMLElement): void {
  // 被写界深度（@dof）のぼかしは本体がレイヤーの --dof-layer に置く。インラインの filter で消さないよう足しておく
  const own = [el.dataset.fxFilter ?? "", el.dataset.cssFilter ?? ""].filter((x) => x !== "");
  if (own.length > 0 && el.matches(".layer.background, .layer.sprites, .layer.images")) own.push("var(--dof-layer,)");
  el.style.filter = own.join(" ");
}

// ---- [chara_move] / tb_chara_shake ----

/** jQuery の easing 名 → CSS。jQuery の既定は swing。 */
export const EASINGS: Record<string, string> = ({
  swing: "cubic-bezier(0.37, 0, 0.63, 1)",
  linear: "linear",
  easeInSine: "cubic-bezier(0.12, 0, 0.39, 0)",
  easeOutSine: "cubic-bezier(0.61, 1, 0.88, 1)",
  easeInOutSine: "cubic-bezier(0.37, 0, 0.63, 1)",
  easeInQuad: "cubic-bezier(0.11, 0, 0.5, 0)",
  easeOutQuad: "cubic-bezier(0.5, 1, 0.89, 1)",
  easeInOutQuad: "cubic-bezier(0.45, 0, 0.55, 1)",
  easeInCubic: "cubic-bezier(0.32, 0, 0.67, 0)",
  easeOutCubic: "cubic-bezier(0.33, 1, 0.68, 1)",
  easeInOutCubic: "cubic-bezier(0.65, 0, 0.35, 1)",
  easeInQuart: "cubic-bezier(0.5, 0, 0.75, 0)",
  easeOutQuart: "cubic-bezier(0.25, 1, 0.5, 1)",
  easeInOutQuart: "cubic-bezier(0.76, 0, 0.24, 1)",
  easeInExpo: "cubic-bezier(0.7, 0, 0.84, 0)",
  easeOutExpo: "cubic-bezier(0.16, 1, 0.3, 1)",
  easeInOutExpo: "cubic-bezier(0.87, 0, 0.13, 1)",
  easeInBack: "cubic-bezier(0.36, 0, 0.66, -0.56)",
  easeOutBack: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  easeInOutBack: "cubic-bezier(0.68, -0.6, 0.32, 1.6)",
} satisfies Record<(typeof S.EASING_NAMES)[number], string>);

/** 緩急の名前（CSS の timing-function か jQuery の easing 名）→ CSS。分からない名前は fallback。 */
export function easing(name: string, fallback = "ease"): string {
  if (EASINGS[name]) return EASINGS[name]!;
  if (/^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)$/.test(name) || /^(cubic-bezier|steps)\(.*\)$/.test(name)) return name;
  // anime.js の cubicBezier(…) の書き方。
  const m = /^cubicBezier\((.*)\)$/.exec(name);
  if (m) return `cubic-bezier(${m[1]})`;
  if (name !== "") console.warn(`イージング ${name} は不明なため、${fallback} を使います`);
  return fallback;
}

export function spriteEl(ctx: RenderContext, who: string): HTMLElement | null {
  return ctx.layers.sprites.querySelector<HTMLElement>(`.sprite[data-who="${CSS.escape(who)}"]`);
}

type Geometry = Partial<Record<"left" | "top" | "width" | "height", string>>;

function geometry(m: Record<string, unknown>): Geometry {
  const g: Geometry = {};
  for (const k of ["left", "top", "width", "height"] as const) if (typeof m[k] === "number") g[k] = `${m[k]}px`;
  return g;
}

async function moveSprite(ctx: RenderContext, a: Args, wait: boolean): Promise<void> {
  await ctx.spriteReady(str(a.who));
  const el = spriteEl(ctx, str(a.who));
  if (!el) return;
  const to = geometry(a);
  const time = ctx.time(num(a.time, 600));
  let done: Promise<void>;
  if (time === 0) {
    Object.assign(el.style, to);
    return;
  }
  if (a.anim === true) {
    const style = getComputedStyle(el);
    const from: Geometry = {};
    for (const k of Object.keys(to) as (keyof Geometry)[]) from[k] = style[k];
    Object.assign(el.style, to);
    done = el
      .animate([from, to] as Keyframe[], { duration: time, easing: EASINGS[str(a.ease, "swing")] ?? EASINGS.swing! })
      .finished.then(() => undefined);
  } else {
    // anim=false は半分の時間で消え、位置を変えて半分の時間で現れる。
    done = ctx.fade(el, 0, time / 2).then(() => {
      Object.assign(el.style, to);
      return ctx.fade(el, 1, time / 2);
    });
  }
  if (wait) await done;
}

async function shakeSprite(ctx: RenderContext, a: Args): Promise<void> {
  await ctx.spriteReady(str(a.who));
  const el = spriteEl(ctx, str(a.who));
  const time = ctx.time(num(a.time, 500));
  // 「画面の揺れ: 控えめ」では揺らさない
  if (!el || time === 0 || ctx.reduceShake) return;
  const swing = num(a.swing);
  const peak = a.direction === "x" ? `translate(${swing}px, 0)` : `translate(0, ${swing}px)`;
  // TyranoScriptは [kanim]（a3d）で 0% → 50% → 100%。a3d の既定の緩急は直線。
  el.animate([{ transform: "translate(0, 0)" }, { transform: peak }, { transform: "translate(0, 0)" }], {
    duration: time,
    iterations: Math.max(1, num(a.count, 5)),
    easing: "linear",
  });
}

// ---- 組み立て直し（ロード時） ----

async function restore(ctx: RenderContext, stage: StageState): Promise<void> {
  for (const layer of layerRoot(ctx).children) layer.replaceChildren();
  for (const el of ctx.layers.fx.querySelectorAll(":scope > .lim-blend")) {
    if (el instanceof HTMLVideoElement) el.pause();
    el.remove();
  }

  const images = S.readExtra(stage.extra, "images") ?? {};
  for (const name of S.IMAGE_LAYERS) {
    const layer = imageLayer(ctx, name);
    for (const item of images[name] ?? []) {
      const el = await buildItem(ctx, item);
      if (!el) continue;
      layer.append(el);
      // @anim / @kanim で動かしたあとの姿（位置の増減は組み立てた位置から数える）。
      if (item.look) applyLook(ctx, el, item.look as Look);
    }
  }
  const options = S.readExtra(stage.extra, "layerOptions") ?? {};
  for (const name of S.IMAGE_LAYERS) applyLayerOption(ctx, name, options[name] ?? {});
  for (const b of S.readExtra(stage.extra, "blends") ?? []) {
    const el = await buildBlend(ctx, b);
    el.style.opacity = String(b.opacity);
    ctx.layers.fx.append(el);
  }
  for (const el of ctx.stage.querySelectorAll(".lim-filter-mask")) el.remove();
  await applyFilters(ctx, stage);
  // 立ち絵は DomHost が先に組み立て直している。動かしたときと同じ表示のものだけ動かした位置にする。
  for (const [who, move] of Object.entries(S.readExtra(stage.extra, "spriteMoves") ?? {})) {
    const el = spriteEl(ctx, who);
    if (el && move.sprite === S.spriteKey(stage.sprites[who])) Object.assign(el.style, geometry(move as unknown as Record<string, unknown>));
  }
}

export const renderers: Record<string, Renderer> = {
  image: (ctx, a, wait) => showImage(ctx, a, wait),
  "free-image": (ctx, a, wait) => freeImage(ctx, a, wait),
  layer: (ctx, a, _wait, stage) => {
    const name = str(a.layer);
    if (name !== "message1") applyLayerOption(ctx, name, S.readExtra(stage.extra, "layerOptions")?.[name as S.ImageLayer] ?? {});
  },
  blend: (ctx, a, wait) => showBlend(ctx, a, wait),
  "blend-off": (ctx, a, wait) => hideBlend(ctx, a, wait),
  "blend-movie": (ctx, a, wait) => showBlendMovie(ctx, a, wait),
  filter: async (ctx, a, wait, stage) => {
    const done = applyFilters(ctx, stage, ctx.time(num(a.time)));
    if (wait) await done;
  },
  "filter-off": async (ctx, a, wait, stage) => {
    const done = applyFilters(ctx, stage, ctx.time(num(a.time)));
    if (wait) await done;
  },
  "chara-move": (ctx, a, wait) => moveSprite(ctx, a, wait),
  "chara-shake": (ctx, a) => shakeSprite(ctx, a),
};

export const restorers: Restorer[] = [restore];
