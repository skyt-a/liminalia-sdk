import { estimateHead } from "@liminalia/lang";
import type { StageState, Value } from "@liminalia/runtime";
import type { Renderer, RenderContext, Restorer } from "@liminalia/web";
import { EMOTE_DEFAULT_AT, emoteFrom, emoteOf, type Emote } from "../commands/emote.ts";
import { spriteEl } from "./image.ts";
import "./emote.css";

/**
 * 立ち絵に付いて動く漫符（@emote・@emote-off）の描画。立ち絵の要素（.sprite）の中に置くので、立ち絵の移動、揺れ、@anim と一緒に動き、
 * 表情を替えても残る。置き場所は立ち絵の絵から推し量った頭（lang の estimateHead。小さく写して測り、絵ごとに覚える）からの位置。
 * 状態（立ち絵の extra）と画面を、命令のたび、立ち絵が替わるたび（sprites の出来事）、ロードのときに合わせる。
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** 頭の位置（絵の大きさに対する割合）。 */
interface Head {
  /** 頭の真ん中の横の位置。 */
  x: number;
  /** 頭頂と顎。 */
  top: number;
  chin: number;
  /** 頭の幅。 */
  width: number;
}

/** 測れなかったときの頭（立ち絵の多い形: 上端から 4% に頭頂、頭の高さは 16%）。 */
const FALLBACK: Head = { x: 0.5, top: 0.04, chin: 0.2, width: 0.3 };

const heads = new Map<string, Promise<Head>>();

/** 絵から頭の位置を推し量る（幅 200px ほどに縮めて測る。読めない絵は既定の位置）。 */
function headOf(img: HTMLImageElement): Promise<Head> {
  const src = img.currentSrc || img.src;
  let p = heads.get(src);
  if (!p) {
    p = (async () => {
      try {
        if (!img.complete) await img.decode();
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        if (!nw || !nh) return FALLBACK;
        const k = Math.min(1, 200 / nw);
        const w = Math.max(1, Math.round(nw * k));
        const h = Math.max(1, Math.round(nh * k));
        const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
        const g = canvas.getContext("2d", { willReadFrequently: true });
        if (!g) return FALLBACK;
        g.drawImage(img, 0, 0, w, h);
        const mark = estimateHead(g.getImageData(0, 0, w, h).data, w, h);
        if (!mark || mark.chinY - mark.top <= 0) return FALLBACK;
        return { x: mark.chinX / w, top: mark.top / h, chin: mark.chinY / h, width: mark.width / w };
      } catch {
        // 別の場所の絵（読めない）など
        return FALLBACK;
      }
    })();
    heads.set(src, p);
  }
  return p;
}

/** 種類ごとの絵（SVG）。色を省けば種類ごとの色。 */
function glyph(e: Emote, ctx: RenderContext): HTMLElement {
  const box = document.createElement("div");
  box.className = `lim-emote-glyph lim-emote--${e.type}`;
  if (e.type === "image" && e.image) {
    box.style.backgroundImage = `url("${ctx.asset("image", e.image)}")`;
    return box;
  }
  const text = { surprise: "！", question: "？", music: "♪" }[e.type as "surprise" | "question" | "music"];
  if (text) {
    box.textContent = text;
    if (e.color) box.style.color = e.color;
    return box;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("aria-hidden", "true");
  const path = (d: string, fill: string, stroke = "#1a1a1a", width = 5) => {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", fill);
    p.setAttribute("stroke", stroke);
    p.setAttribute("stroke-width", String(width));
    p.setAttribute("stroke-linejoin", "round");
    p.setAttribute("stroke-linecap", "round");
    svg.append(p);
  };
  switch (e.type) {
    case "sweat":
      path("M50 8 C 64 34, 80 52, 80 68 A 30 30 0 0 1 20 68 C 20 52, 36 34, 50 8 Z", e.color ?? "#9fd3f5");
      path("M38 62 Q 36 74, 46 80", "none", "#ffffff", 6);
      break;
    case "anger": {
      // 四つの角が向き合う怒りの筋
      const c = e.color ?? "#e0302b";
      for (const r of [0, 90, 180, 270]) {
        const g = document.createElementNS(SVG_NS, "g");
        g.setAttribute("transform", `rotate(${r} 50 50)`);
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", "M42 10 Q 44 36, 18 40");
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", c);
        p.setAttribute("stroke-width", "11");
        p.setAttribute("stroke-linecap", "round");
        g.append(p);
        svg.append(g);
      }
      break;
    }
    case "heart":
      path("M50 88 C 18 66, 6 46, 14 28 C 22 12, 44 12, 50 30 C 56 12, 78 12, 86 28 C 94 46, 82 66, 50 88 Z", e.color ?? "#f25c8a");
      break;
    case "sparkle":
      path("M50 4 L 58 42 L 96 50 L 58 58 L 50 96 L 42 58 L 4 50 L 42 42 Z", e.color ?? "#ffe066", "#1a1a1a", 3);
      path("M82 8 L 85 18 L 95 21 L 85 24 L 82 34 L 79 24 L 69 21 L 79 18 Z", e.color ?? "#ffe066", "#1a1a1a", 2);
      break;
  }
  box.append(svg);
  return box;
}

/** 立ち絵の要素の中に漫符を置き直す（無ければ外す）。flip は立ち絵の左右反転。 */
async function place(ctx: RenderContext, who: string, e: Emote | null, flip: boolean, oneShot = false): Promise<HTMLElement | null> {
  await ctx.spriteReady(who);
  const sprite = spriteEl(ctx, who);
  if (!sprite) return null;
  if (!oneShot) {
    const sig = e ? JSON.stringify(e) : "";
    const current = sprite.querySelector<HTMLElement>(":scope > .lim-emote:not([data-once])");
    if (current?.dataset.sig === sig && current.dataset.flip === String(flip)) return current;
    current?.remove();
    if (!e) return null;
  }
  if (!e) return null;
  const img = sprite.querySelector<HTMLImageElement>(":scope > img");
  const head = img ? await headOf(img) : FALLBACK;
  const el = document.createElement("div");
  el.className = "lim-emote";
  el.dataset.who = who;
  if (oneShot) el.dataset.once = "";
  else el.dataset.sig = JSON.stringify(e);
  el.dataset.flip = String(flip);
  // 置き場所（割合）。左右は画面の向きなので、反転した立ち絵の頭の位置は、絵を裏返す軸（cast.json の frame の flipAxis。描画が絵の変形の起点に書く。
  // 書かなければ中央）で鏡に映す
  const hx = flip ? 2 * flipAxisOf(img) - head.x : head.x;
  const hh = head.chin - head.top;
  const at = e.at === "auto" ? EMOTE_DEFAULT_AT[e.type] : e.at;
  const spot = {
    head: { x: hx, y: head.top - hh * 0.15 },
    "head-left": { x: hx - head.width * 0.8, y: head.top + hh * 0.3 },
    "head-right": { x: hx + head.width * 0.8, y: head.top + hh * 0.3 },
    face: { x: hx, y: head.top + hh * 0.55 },
  }[at];
  const height = sprite.offsetHeight || 1;
  const size = e.size ?? Math.max(28, Math.min(160, hh * height * 0.45));
  // 位置は立ち絵の枠に対する割合（@chara-move や @anim で枠が変わってもついていく）。ずれは px
  Object.assign(el.style, { left: `calc(${(spot.x * 100).toFixed(2)}% + ${e.x ?? 0}px)`, top: `calc(${(spot.y * 100).toFixed(2)}% + ${e.y ?? 0}px)`, width: `${size}px`, height: `${size}px` });
  el.append(glyph(e, ctx));
  sprite.append(el);
  return el;
}

/** 反転した立ち絵の絵が裏返る軸の、枠の幅に対する割合（描画が書いた変形の起点の横。書いていなければ 0.5）。 */
function flipAxisOf(img: HTMLImageElement | null): number {
  const x = (img?.style.transformOrigin ?? "").trim().split(/\s+/)[0] ?? "";
  const n = Number.parseFloat(x);
  return x.endsWith("%") && Number.isFinite(n) ? n / 100 : 0.5;
}

/** 状態に合わせて、出ているすべての立ち絵の漫符を置き直す。 */
async function sync(ctx: RenderContext, stage: StageState): Promise<void> {
  // 消えた立ち絵の漫符は立ち絵と一緒に消えるので、出ている立ち絵だけ見る
  await Promise.all(Object.entries(stage.sprites).map(([who, s]) => place(ctx, who, emoteOf(s), s.flip === true)));
}

/** time= の一回きりの漫符（状態に残さない）。 */
async function once(ctx: RenderContext, a: Record<string, Value>, stage: StageState): Promise<void> {
  if (ctx.skipping) return;
  const who = String(a.who ?? "");
  const scope = ctx.scope();
  const el = await place(ctx, who, emoteFrom(a), stage.sprites[who]?.flip === true, true);
  if (!el) return scope.dispose();
  scope.add(el);
  await scope.sleep(typeof a.time === "number" ? a.time : 0);
  if (!scope.disposed) await el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ctx.time(200), fill: "forwards" }).finished.catch(() => undefined);
  scope.dispose();
}

/** 立ち絵が替わったら置き直す（舞台ごとに一度だけ受ける）。 */
const watching = new WeakSet<HTMLElement>();
function watch(ctx: RenderContext): void {
  if (watching.has(ctx.stage)) return;
  watching.add(ctx.stage);
  ctx.on("sprites", (e) => void sync(ctx, e.stage));
}

export const renderers: Record<string, Renderer> = {
  emote: (ctx, a, wait, stage) => {
    watch(ctx);
    if (typeof a.time !== "number") return sync(ctx, stage);
    const job = once(ctx, a, stage).catch((e: unknown) => console.warn(e));
    return wait ? job : undefined;
  },
  "emote-off": (ctx, _a, _wait, stage) => {
    watch(ctx);
    return sync(ctx, stage);
  },
};

/** ロードのとき（立ち絵は DomHost が先に組み立て直している）。 */
export const restorers: Restorer[] = [
  (ctx: RenderContext, stage: StageState) => {
    watch(ctx);
    return sync(ctx, stage);
  },
];
