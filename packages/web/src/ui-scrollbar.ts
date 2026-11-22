import { button } from "./ui-parts.ts";

export interface ScrollbarOptions {
  /** つまみが動く溝（作品が作った要素）。押したところへ送る。 */
  track: HTMLElement;
  /** つまみ（track の中に置いた要素）。ドラッグで送る。 */
  thumb: HTMLElement;
  /** 一つ上・左へ送るボタン（任意。送れないときは data-lm-disabled、button なら disabled も）。 */
  back?: HTMLElement;
  /** 一つ下・右へ送るボタン（任意）。 */
  forward?: HTMLElement;
  /** 向き（既定 vertical）。 */
  orientation?: "vertical" | "horizontal";
  /** つまみの最小の長さ（px。既定 24）。 */
  minThumb?: number;
  /** ボタンで送る量（px。既定は見えている長さの 8 割）。 */
  step?: number;
}

export interface ScrollbarHandle {
  /** 中身の大きさが変わったあとに、つまみを合わせ直す（ResizeObserver が見張るので、ふつうは要らない）。 */
  update(): void;
  dispose(): void;
}

/**
 * 流れる中身（overflow: auto などの要素）に、作品が作った溝とつまみのスクロールバーを付ける。つまみの長さと位置は px で
 * 書き（縦なら height・top、横なら width・left。つまみは溝の中で position: absolute にする）、送った割合を content の
 * --lm-value（0〜1）に、送れるかを track の data-lm-scrollable に出す。舞台が拡大・縮小していても、ドラッグはつまみについてくる。
 * ブラウザのスクロールバーは作品の CSS で隠す（scrollbar-width: none）。
 */
export function scrollbar(content: HTMLElement, o: ScrollbarOptions): ScrollbarHandle {
  const vertical = o.orientation !== "horizontal";
  const minThumb = o.minThumb ?? 24;
  const pos = () => (vertical ? content.scrollTop : content.scrollLeft);
  const max = () => Math.max(0, vertical ? content.scrollHeight - content.clientHeight : content.scrollWidth - content.clientWidth);
  const view = () => (vertical ? content.clientHeight : content.clientWidth);
  const trackLength = () => (vertical ? o.track.clientHeight : o.track.clientWidth);
  const thumbLength = () => {
    const total = vertical ? content.scrollHeight : content.scrollWidth;
    const t = trackLength();
    return total > 0 ? Math.min(t, Math.max(minThumb, Math.round((t * view()) / total))) : t;
  };
  const scrollTo = (v: number, smooth = false) => {
    const to = Math.max(0, Math.min(max(), v));
    content.scrollTo({ [vertical ? "top" : "left"]: to, behavior: smooth ? "smooth" : "auto" });
    // scroll の出来事を待たずに合わせる（scrollTo を持たない環境・同じ位置への送り）
    if (!smooth) update();
  };
  const update = () => {
    const m = max();
    const t = trackLength();
    const len = thumbLength();
    const at = m > 0 ? Math.round(((t - len) * pos()) / m) : 0;
    if (vertical) Object.assign(o.thumb.style, { height: `${len}px`, top: `${at}px` });
    else Object.assign(o.thumb.style, { width: `${len}px`, left: `${at}px` });
    content.style.setProperty("--lm-value", String(m > 0 ? pos() / m : 0));
    o.track.toggleAttribute("data-lm-scrollable", m > 0);
    const ends: [HTMLElement | undefined, boolean][] = [
      [o.back, pos() <= 1],
      [o.forward, pos() >= m - 1],
    ];
    for (const [b, off] of ends) {
      if (!b) continue;
      b.toggleAttribute("data-lm-disabled", off);
      if (b instanceof HTMLButtonElement) b.disabled = off;
    }
  };
  /** 画面の px を要素の px にする（舞台の拡大・縮小を戻す）。 */
  const scale = () => {
    const r = o.track.getBoundingClientRect();
    const shown = vertical ? r.height : r.width;
    return shown > 0 ? trackLength() / shown : 1;
  };
  const step = () => o.step ?? Math.max(16, Math.round(view() * 0.8));
  const cleanups: (() => void)[] = [];
  const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
    el.addEventListener(type, fn, opts);
    cleanups.push(() => el.removeEventListener(type, fn, opts));
  };
  on(content, "scroll", update, { passive: true });
  // 溝を押したら、そこへつまみの真ん中が来るように送る
  on(o.track, "pointerdown", (e) => {
    if (e.target !== o.track) return;
    e.stopPropagation();
    const r = o.track.getBoundingClientRect();
    const at = (vertical ? e.clientY - r.top : e.clientX - r.left) * scale() - thumbLength() / 2;
    const room = trackLength() - thumbLength();
    scrollTo(room > 0 ? (at / room) * max() : 0, true);
  });
  on(o.thumb, "pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const start = vertical ? e.clientY : e.clientX;
    const from = pos();
    const k = scale();
    const room = Math.max(1, trackLength() - thumbLength());
    o.thumb.setPointerCapture?.(e.pointerId);
    o.thumb.setAttribute("data-lm-pressed", "");
    const move = (m: PointerEvent) => scrollTo(from + (((vertical ? m.clientY : m.clientX) - start) * k * max()) / room);
    const up = () => {
      o.thumb.removeAttribute("data-lm-pressed");
      o.thumb.removeEventListener("pointermove", move);
      o.thumb.removeEventListener("pointerup", up);
      o.thumb.removeEventListener("pointercancel", up);
    };
    o.thumb.addEventListener("pointermove", move);
    o.thumb.addEventListener("pointerup", up);
    o.thumb.addEventListener("pointercancel", up);
  });
  // 溝とつまみのクリックは本文の送りへ流さない
  for (const el of [o.track, o.thumb]) on(el, "click", (e) => e.stopPropagation());
  const buttons = [o.back ? button(o.back, { onPress: () => scrollTo(pos() - step(), true) }) : null, o.forward ? button(o.forward, { onPress: () => scrollTo(pos() + step(), true) }) : null];
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => update()) : null;
  observer?.observe(content);
  observer?.observe(o.track);
  for (const child of Array.from(content.children)) observer?.observe(child);
  update();
  return {
    update,
    dispose() {
      for (const c of cleanups.splice(0)) c();
      for (const b of buttons) b?.dispose();
      observer?.disconnect();
    },
  };
}
