import { parseExpr, type Expr } from "@liminalia/lang";
import { display, truthy, type Runtime, type StageState } from "@liminalia/runtime";
import type { Renderer, RenderContext, Restorer } from "@liminalia/web";
import { hudSegments, readHud, type HudButton, type HudItem, type HudText } from "../commands/hud.ts";
import "./hud.css";

/**
 * 常駐の表示（@hud-button・@hud-text）の描画。メッセージ枠の上、暗転の下（hud の層の一番下）に置き、状態（stage.extra の "std.hud"）から
 * 描き直す。if= と {= 式} は今のプレイの実行器で評価し、変数が変わるたびに（同じ命令の中の変更はまとめて一度）見直す。
 * ボタンは、ページでクリックを待っているときと選択肢を出しているときに押せる（system.callScene。戻ったらそのページか選択肢を出し直す）。
 * キーボードとゲームパッドでも押せる: 根に data-lm-play-nav を付け（遊んでいる最中に矢印キー・十字キーで選べる。web の input.ts）、
 * key= のボタンに data-lm-key を付ける（そのキーで押す。web の既定のシステム画面）。押したらフォーカスを外し、本文を送るキーを本文に返す。
 * 文字は遊ぶ人の文字サイズ（--lm-text-scale）に従う。
 * 枠を隠しているあいだ（lm-window-hidden）と、暗転しきっている間、章の扉と全画面の動画の間（hud の層ごと）は出さない。
 * 言語を替えたら、訳し直した文字で出し直す（relocalizers）。
 */

/** 舞台ごとの表示。 */
interface Hud {
  root: HTMLDivElement;
  items: HudItem[];
  els: Map<string, HTMLElement>;
  runtime: Runtime | null;
  unwatch: (() => void) | null;
  queued: boolean;
}

const huds = new WeakMap<HTMLElement, Hud>();

function hudOf(ctx: RenderContext): Hud {
  let hud = huds.get(ctx.stage);
  if (!hud) {
    const root = document.createElement("div");
    root.className = "lim-hud";
    // 遊んでいる最中に、矢印キーと十字キーで中のボタンを選べる（web の input.ts の PLAY_NAV）
    root.dataset.lmPlayNav = "";
    hud = { root, items: [], els: new Map(), runtime: null, unwatch: null, queued: false };
    huds.set(ctx.stage, hud);
  }
  // hud の層の一番下（残すカットインが上に重なる。暗転と章の扉の間は層ごと隠れる）
  if (!hud.root.isConnected) ctx.layers.hud.prepend(hud.root);
  return hud;
}

const exprs = new Map<string, Expr | null>();
function expr(src: string): Expr | null {
  let e = exprs.get(src);
  if (e === undefined) {
    try {
      e = parseExpr(src);
    } catch {
      console.warn(`常駐の表示の式を読めません: ${src}`);
      e = null;
    }
    exprs.set(src, e);
  }
  return e;
}

/** 式を評価する（遊んでいない、読めない、評価できないなら fallback）。 */
function evaluate(runtime: Runtime | null, src: string, fallback: unknown): unknown {
  const e = expr(src);
  if (!runtime || !e) return fallback;
  try {
    return runtime.eval(e);
  } catch {
    return fallback;
  }
}

/** 文字の {= 式} を今の値で埋める。 */
function fill(runtime: Runtime | null, text: string): string {
  let out = "";
  let at = 0;
  for (const seg of hudSegments(text)) {
    out += text.slice(at, seg.start) + display(evaluate(runtime, seg.source, "") as never);
    at = seg.end;
  }
  return out + text.slice(at);
}

const keyOf = (item: HudItem) => `${item.kind}:${item.name}`;

function buildButton(ctx: RenderContext, item: HudButton): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "lim-hud-button";
  b.dataset.hud = item.name;
  Object.assign(b.style, { left: `${item.x}px`, top: `${item.y}px` });
  if (item.width !== undefined) b.style.width = `${item.width}px`;
  if (item.height !== undefined) b.style.height = `${item.height}px`;
  if (item.image) {
    const img = document.createElement("img");
    img.src = ctx.asset("image", item.image);
    img.alt = "";
    img.draggable = false;
    b.append(img);
    if (item.hover) {
      const normal = img.src;
      const hover = ctx.asset("image", item.hover);
      b.addEventListener("pointerenter", () => (img.src = hover));
      b.addEventListener("pointerleave", () => (img.src = normal));
      b.addEventListener("focus", () => (img.src = hover));
      b.addEventListener("blur", () => (img.src = normal));
    }
    if (item.label) b.setAttribute("aria-label", item.label);
  } else b.textContent = item.label ?? item.name;
  // key= のキーで押す（web の既定のシステム画面が data-lm-key を見る）。読み上げにもキーを知らせる
  if (item.key) {
    b.dataset.lmKey = item.key;
    b.setAttribute("aria-keyshortcuts", item.key.length === 1 ? item.key.toUpperCase() : item.key);
  }
  // 押しても本文は送らない（舞台のクリックへ渡さない）
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    // 押したらフォーカスを外す（呼んだ場面の本文を、本文を送るキーで送れるように）
    b.blur();
    void ctx.system?.callScene(item.call);
  });
  return b;
}

function buildText(item: HudText): HTMLElement {
  const el = document.createElement("div");
  el.className = "lim-hud-text";
  el.dataset.hud = item.name;
  Object.assign(el.style, { left: `${item.x}px`, top: `${item.y}px` });
  if (item.width !== undefined) el.style.width = `${item.width}px`;
  // 遊ぶ人の文字サイズに従う（ui.screen.textScale が message なら --lm-text-scale は 1）
  if (item.size !== undefined) el.style.fontSize = `calc(${item.size}px * var(--lm-text-scale, 1))`;
  if (item.color) el.style.color = item.color;
  if (item.align) el.style.textAlign = item.align;
  return el;
}

/** 状態の一覧に合わせて要素を作り直し（変わったものだけ）、値を入れる。 */
function render(ctx: RenderContext, items: HudItem[]): void {
  const hud = hudOf(ctx);
  hud.items = items;
  const want = new Set(items.map(keyOf));
  for (const [key, el] of hud.els) {
    if (want.has(key)) continue;
    el.remove();
    hud.els.delete(key);
  }
  for (const item of items) {
    const key = keyOf(item);
    const sig = JSON.stringify(item);
    let el = hud.els.get(key);
    if (el && el.dataset.sig !== sig) {
      el.remove();
      el = undefined;
    }
    if (!el) {
      el = item.kind === "button" ? buildButton(ctx, item) : buildText(item);
      el.dataset.sig = sig;
      hud.els.set(key, el);
    }
    // 状態の並び（後に置いたものが上）
    hud.root.append(el);
  }
  watch(ctx, hud);
  refresh(hud);
}

/** if= と {= 式} を今の値で見直す。 */
function refresh(hud: Hud): void {
  for (const item of hud.items) {
    const el = hud.els.get(keyOf(item));
    if (!el) continue;
    el.hidden = item.if !== undefined && !truthy(evaluate(hud.runtime, item.if, false) as never);
    if (item.kind === "text") el.textContent = fill(hud.runtime, item.text);
  }
}

/** 今のプレイの実行器の変数の変化を受ける（実行器が替わったら受け直す）。 */
function watch(ctx: RenderContext, hud: Hud): void {
  const runtime = ctx.system?.controller.runtime ?? null;
  if (runtime === hud.runtime) return;
  hud.unwatch?.();
  hud.runtime = runtime;
  hud.unwatch =
    runtime?.onVariableChange((_path) => {
      if (hud.queued) return;
      hud.queued = true;
      queueMicrotask(() => {
        hud.queued = false;
        if (hud.runtime === runtime) refresh(hud);
      });
    }) ?? null;
}

const sync: Renderer = (ctx, _a, _wait, stage) => render(ctx, readHud(stage.extra));

export const renderers: Record<string, Renderer> = {
  "hud-button": sync,
  "hud-button-off": sync,
  "hud-text": sync,
  "hud-text-off": sync,
};

/** ロード（巻き戻し、タイトルへ戻るときも）で、状態から出し直す。 */
export const restorers: Restorer[] = [(ctx: RenderContext, stage: StageState) => render(ctx, readHud(stage.extra))];

/** 言語を替えたとき、訳し直した文字（@hud-text の text、@hud-button の label）で出し直す（変わったものだけ作り直す）。 */
export const relocalizers: Restorer[] = [(ctx: RenderContext, stage: StageState) => render(ctx, readHud(stage.extra))];
