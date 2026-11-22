import { appearanceKey, AUTO_POSITION, baseVariant, uiSpace, type Cast } from "@liminalia/lang";
import type { StageState } from "@liminalia/runtime";
import type { LayoutItem, LayoutRect, LayoutReport } from "@liminalia/studio/protocol";
import type { RenderContext } from "./dom-host.ts";

/**
 * 制作画面の「ゲームの設定」の配置の編集（見本のプレイヤー ?ui-preview=page・choice に layout=1）が使う、今の配置の測り方。
 * 動かせるもの（メッセージウィンドウ、名前欄、顔ウィンドウ、選択肢、クイックメニュー、立ち絵、常駐の表示）の、ページの中の矩形と今の値を返す。
 * 値は ui の項目と同じ単位（文字と枠の座標の px。立ち絵は舞台の座標の px）。CSS の zoom（基準の大きさと違う作品）と
 * 舞台の縮小に依らないように、ページの中の矩形の差から換算する。
 */

/** 見えているか（大きさがあり、透明でない）。 */
function shown(el: Element | null | undefined): el is HTMLElement {
  if (!(el instanceof HTMLElement) || el.getClientRects().length === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
}

const rectOf = (r: DOMRect): LayoutRect => ({ x: r.left, y: r.top, width: r.width, height: r.height });
const round = (n: number) => Math.round(n);

/** 矩形をいくつか囲む矩形。 */
function union(rects: readonly DOMRect[]): DOMRect {
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

export function layoutReport(ctx: RenderContext, state: StageState | null | undefined, cast: Cast): LayoutReport {
  const stage = ctx.stage.getBoundingClientRect();
  const space = uiSpace(ctx.screen);
  // ページの px → 文字と枠の px、舞台の px
  const kUi = stage.width > 0 ? space.width / stage.width : 1;
  const kStage = stage.width > 0 ? ctx.screen.width / stage.width : 1;
  const items: LayoutItem[] = [];
  const px = (v: string) => parseFloat(v) || 0;

  const message = ctx.message.root;
  const messageShown = shown(message) && !message.classList.contains("nvl") && !message.classList.contains("balloon");
  const box = message.getBoundingClientRect();
  if (messageShown) {
    items.push({
      id: "message",
      kind: "message",
      rect: rectOf(box),
      values: { x: round((box.left - stage.left) * kUi), y: round((box.top - stage.top) * kUi), width: round(box.width * kUi), height: round(box.height * kUi) },
    });
    // 名前欄と顔ウィンドウは、メッセージウィンドウの内側（線の内側）の左上からの位置
    const border = getComputedStyle(message);
    const inner = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { r, x: round((r.left - box.left) * kUi - px(border.borderLeftWidth) - px(cs.marginLeft)), y: round((r.top - box.top) * kUi - px(border.borderTopWidth) - px(cs.marginTop)) };
    };
    const name = ctx.message.name;
    if (shown(name)) {
      const n = inner(name);
      items.push({ id: "name", kind: "name", rect: rectOf(n.r), values: { x: n.x, y: n.y } });
    }
    const face = message.querySelector<HTMLElement>(":scope > .face");
    if (shown(face)) {
      const f = inner(face);
      items.push({ id: "face", kind: "face", rect: rectOf(f.r), values: { x: f.x, y: f.y, width: round(f.r.width * kUi), height: round(f.r.height * kUi) } });
    }
  }

  const buttons = [...ctx.stage.querySelectorAll<HTMLElement>(":scope > .choices > button")].filter(shown);
  const choices = ctx.stage.querySelector<HTMLElement>(":scope > .choices");
  if (buttons.length > 0 && choices) {
    const all = union(buttons.map((b) => b.getBoundingClientRect()));
    const top = choices.getBoundingClientRect().top;
    // ui.choice.y は .choices の上の余白（最初のボタンの外側の余白の上）
    const margin = px(getComputedStyle(buttons[0]!).marginTop);
    items.push({ id: "choices", kind: "choices", rect: rectOf(all), values: { y: round((all.top - top) * kUi - margin), width: round(all.width * kUi) } });
  }

  const bar = ctx.stage.querySelector<HTMLElement>(".lm-menubar");
  if (shown(bar)) {
    const r = bar.getBoundingClientRect();
    items.push({ id: "menuBar", kind: "menuBar", rect: rectOf(r), values: { x: round((r.left - stage.left) * kUi), y: round((r.top - stage.top) * kUi) } });
  }

  for (const el of ctx.layers.sprites.querySelectorAll<HTMLElement>(":scope > .sprite[data-who]")) {
    const who = el.dataset.who!;
    const sprite = state?.sprites[who];
    const entry = cast[who];
    if (!sprite || !entry || !shown(el)) continue;
    const appearance = appearanceKey(entry, sprite.appearance);
    const set = entry.appearances?.[appearance];
    const variant = sprite.variant.split("+")[0] || baseVariant(set) || "";
    const v = set?.variants[variant];
    if (!v) continue;
    const img = el.querySelector<HTMLImageElement>(":scope > img");
    const r = el.getBoundingClientRect();
    items.push({
      id: `sprite:${who}`,
      kind: "sprite",
      rect: rectOf(r),
      // 枠の左上（舞台の px）。動かし中のずらし（translate）は含めない
      values: { x: round(px(el.style.left)), y: round(px(el.style.top)) },
      sprite: {
        who,
        appearance,
        variant,
        at: sprite.at,
        framed: !!v.frame,
        natural: { width: img?.naturalWidth || round(r.width * kStage), height: img?.naturalHeight || round(r.height * kStage) },
        movable: !sprite.autoLayout && sprite.at !== AUTO_POSITION && sprite.x === undefined && sprite.y === undefined,
      },
    });
  }
  // 常駐の表示（std の @hud-button・@hud-text。hud の層に data-hud の名前で置く。位置と大きさは舞台の px）
  for (const el of ctx.layers.hud.querySelectorAll<HTMLElement>(":scope > .lim-hud > [data-hud]")) {
    const button = el.classList.contains("lim-hud-button");
    if (!button && !el.classList.contains("lim-hud-text")) continue;
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    const name = el.dataset.hud!;
    const size = button ? { width: round(px(el.style.width) || r.width * kStage), height: round(px(el.style.height) || r.height * kStage) } : {};
    items.push({ id: `hud:${button ? "button" : "text"}:${name}`, kind: button ? "hudButton" : "hudText", rect: rectOf(r), values: { x: round(px(el.style.left)), y: round(px(el.style.top)), ...size }, hud: name });
  }
  return { type: "liminalia:layout-report", stage: rectOf(stage), screen: { ...ctx.screen }, uiScale: ctx.uiScale, items };
}

/** 常駐の表示を、その位置と大きさ（舞台の px）に置く（"button:<名前>"・"text:<名前>" → 値。保存はしない）。 */
export function placeHud(ctx: RenderContext, places: Record<string, Partial<LayoutRect>>): void {
  for (const el of ctx.layers.hud.querySelectorAll<HTMLElement>(":scope > .lim-hud > [data-hud]")) {
    const p = places[`${el.classList.contains("lim-hud-button") ? "button" : "text"}:${el.dataset.hud}`];
    if (!p) continue;
    if (p.x !== undefined) el.style.left = `${p.x}px`;
    if (p.y !== undefined) el.style.top = `${p.y}px`;
    if (p.width !== undefined) el.style.width = `${p.width}px`;
    if (p.height !== undefined) el.style.height = `${p.height}px`;
  }
}

/** 引いている間、立ち絵を舞台の px でずらして見せる（保存はしない）。書かなかった人物のずらしは外す。 */
export function nudgeSprites(ctx: RenderContext, offsets: Record<string, { dx: number; dy: number }>): void {
  for (const el of ctx.layers.sprites.querySelectorAll<HTMLElement>(":scope > .sprite[data-who]")) {
    const o = offsets[el.dataset.who!];
    if (o) el.style.translate = `${o.dx}px ${o.dy}px`;
    else el.style.removeProperty("translate");
  }
}
