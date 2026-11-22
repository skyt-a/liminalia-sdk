import * as T from "../commands/text.ts";
import type { StageState, Value } from "@liminalia/runtime";
import { transitionKeyframes, type Renderer, type RenderContext, type Restorer } from "@liminalia/web";
import * as S from "../commands/image.ts";
import { fadeIn, imageLayer, layerItems, registerLayerItem } from "./image.ts";

/**
 * @layer-text / @motion-text の描画。置いた文字は前景レイヤーの項目（kind "text"）として組み立てる。
 */

type Args = Record<string, Value>;

const num = (v: Value | undefined, d = 0): number => (typeof v === "number" ? v : d);

/** 縁取りを text-shadow で描く（TyranoScript の edge と同じく、太さの円周上に影を並べる）。 */
export function edgeShadow(color: string, width: number): string {
  const points: [number, number][] = [];
  if (width <= 1) {
    points.push([1, -1], [1, 1], [-1, 1], [-1, -1]);
  } else {
    const n = Math.max(8, Math.ceil(2 * width * Math.PI));
    for (let i = 0; i < n; i++) points.push([width * Math.cos((2 * Math.PI * i) / n), width * Math.sin((2 * Math.PI * i) / n)]);
  }
  return points.map(([x, y]) => `${x.toFixed(2)}px ${y.toFixed(2)}px 0px ${color}`).join(",");
}

export function buildText(item: T.TextItem): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "lim-text";
  p.textContent = item.text;
  Object.assign(p.style, {
    left: `${item.x}px`,
    top: `${item.y}px`,
    fontSize: `${item.size}px`,
    color: item.color,
    fontWeight: item.bold ? "bold" : "",
    fontStyle: item.italic ? "italic" : "",
    textAlign: item.align,
  });
  if (item.face) p.style.fontFamily = item.face;
  if (item.width !== null) p.style.width = `${item.width}px`;
  if (item.vertical) p.style.writingMode = "vertical-rl";
  if (item.edge) p.style.textShadow = edgeShadow(item.edge, item.edgeWidth);
  else if (item.shadow) p.style.textShadow = `2px 2px 2px ${item.shadow}`;
  if (item.name) p.dataset.name = item.name;
  return p;
}

registerLayerItem("text", async (_ctx, item) => buildText(item as unknown as T.TextItem));

// ---- @layer-text ----

async function layerText(ctx: RenderContext, a: Args, wait: boolean): Promise<void> {
  const item = T.textItem(a);
  if (a.overwrite === true && item.name !== "") {
    const existing = ctx.layers.images.querySelectorAll<HTMLElement>(`.lim-text[data-name="${CSS.escape(item.name)}"]`);
    if (existing.length > 0) {
      for (const el of existing) {
        el.textContent = item.text;
        if (num(a.x)) el.style.left = `${num(a.x)}px`;
        if (num(a.y)) el.style.top = `${num(a.y)}px`;
        if (typeof a.color === "string" && a.color !== "#ffffff") el.style.color = a.color;
        if (num(a.size, 26) !== 26) el.style.fontSize = `${num(a.size)}px`;
      }
      return;
    }
  }
  const el = buildText(item);
  imageLayer(ctx, typeof a.layer === "string" ? a.layer : "fg0").append(el);
  const done = fadeIn(ctx, el, num(a.time));
  if (wait) await done;
}

// ---- @motion-text ----

/** 並べ替え（in-shuffle）。同じ文字なら同じ順になるよう、文字から決まる乱数で混ぜる（撮影や自動確認で毎回同じ画面にするため）。 */
function shuffle<T>(list: T[], seed: string): T[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** 一文字の動きの長さ（animate.css の既定）。 */
const CHAR_MS = 1000;

/**
 * 一文字ずつ動かす（textillate と同じく、i 文字目は delay × i × scale だけ遅れて始まる。sync なら同時）。
 * 出し方は @bg の method の出てくる動き、消し方は消えていく動き（fadeOutUp は fadeInUp の消えていく動き）。
 */
function animateChars(ctx: RenderContext, chars: HTMLElement[], effect: string, mode: "show" | "hide", o: { delay: number; scale: number; sync: boolean; shuffle: boolean; reverse: boolean }, seed: string): Promise<void> {
  let order = chars;
  if (o.shuffle) order = shuffle(order, seed);
  if (o.reverse) order = [...order].reverse();
  const frames = transitionKeyframes(mode === "show" ? effect : effect.replace("Out", "In"), mode);
  const jobs = order.map((ch, i) => {
    const delay = ctx.time(o.sync ? o.delay : o.delay * i * o.scale);
    return ch.animate(frames, { duration: ctx.time(CHAR_MS), delay, easing: "ease", fill: mode === "show" ? "backwards" : "forwards" }).finished;
  });
  return Promise.all(jobs).then(() => undefined);
}

async function motionText(ctx: RenderContext, a: Args, wait: boolean): Promise<void> {
  const item = T.textItem(a);
  const el = buildText(item);
  el.textContent = "";
  const chars = [...item.text].map((c) => {
    const span = document.createElement("span");
    span.className = "lim-text-char";
    span.textContent = c;
    el.append(span);
    return span;
  });
  const stay = a.stay === true;
  // 消える文字は状態の一覧に入っていない（@stop-anim などの並び順から外す）。
  if (!stay) el.dataset.transient = "";
  imageLayer(ctx, typeof a.layer === "string" ? a.layer : "fg0").append(el);
  const visible = chars.filter((c) => c.textContent!.trim() !== "");
  const job = (async () => {
    await animateChars(
      ctx,
      visible,
      typeof a.in === "string" ? a.in : "fadeIn",
      "show",
      { delay: num(a["in-delay"], 50), scale: num(a["in-scale"], 1.5), sync: a["in-sync"] === true, shuffle: a["in-shuffle"] === true, reverse: a["in-reverse"] === true },
      item.text,
    );
    if (stay) return;
    await ctx.delay(num(a.time, 2000));
    await animateChars(
      ctx,
      visible,
      typeof a.out === "string" ? a.out : "fadeOut",
      "hide",
      { delay: num(a["out-delay"], 50), scale: 1.5, sync: a["out-sync"] === true, shuffle: a["out-shuffle"] === true, reverse: a["out-reverse"] === true },
      item.text,
    );
    el.remove();
  })();
  if (wait) await job;
}

/** 言語を替えたとき、置いた文字を出し直す（状態の一覧と、レイヤーに置いた要素は同じ並び）。 */
export const relocalizers: Restorer[] = [
  (ctx: RenderContext, stage: StageState) => {
    const images = S.readExtra(stage.extra, "images") ?? {};
    for (const name of S.IMAGE_LAYERS) {
      const els = layerItems(ctx, name);
      (images[name] ?? []).forEach((item, i) => {
        const el = els[i];
        if (item.kind !== "text" || !el?.classList.contains("lim-text")) return;
        const text = (item as unknown as T.TextItem).text;
        if (el.textContent !== text) el.textContent = text;
      });
    }
  },
];

export const renderers: Record<string, Renderer> = {
  "layer-text": (ctx, a, wait) => layerText(ctx, a, wait),
  "motion-text": (ctx, a, wait) => motionText(ctx, a, wait),
};
