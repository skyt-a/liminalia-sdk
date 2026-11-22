/**
 * 積み上げる通知（RenderContext.notify と std の @notify）。
 * - 上限（max）を超えたら、いちばん古いものを早めに下げる
 * - 同じ鍵（既定は文）の通知が出ていれば、新しく積まずにそれを出し直す（出しておく時間を延ばし、data-lm-count を一つ増やす）
 * - 全画面の演出（host.coverUi）の間は待たせ、覆いが外れたら少しずつずらして出す
 * - スキップ中は時間を 1/10 にする。ロード（組み立て直し）で消す
 * 見た目は CSS（.lm-notice・data-kind・data-lm-state）か、WebPlugin.screens.toast で要素ごと差し替える。
 */
export interface NoticeOptions {
  /** 種類（info・success・warning・error か、作品の名前）。要素の data-kind と class の lm-notice--<種類> になる。既定 info。 */
  kind?: string;
  /** 見出し（任意）。 */
  title?: string;
  /** 出しておく時間（ミリ秒。既定 3000）。 */
  time?: number;
  /** 出すまでの間（ミリ秒。既定 0）。 */
  delay?: number;
  /** 出すときに鳴らす効果音（sound からのパス）。 */
  se?: string;
  /** 重なりを一つにする鍵（既定は文）。 */
  key?: string;
  /** 同時に積む上限（既定 3。この通知を積むときに効く）。 */
  max?: number;
  /** 見た目の差し替え（WebPlugin.screens.toast）に渡す値（@notify は命令の引数をそのまま渡す）。 */
  args?: Readonly<Record<string, unknown>>;
}

/** 通知の見た目を差し替える関数に渡すもの（WebPlugin.screens.toast）。 */
export interface ToastApi {
  text: string;
  kind: string;
  title: string | null;
  /** 引数（@notify の引数そのまま。作品の独自の値を読む）。 */
  args: Readonly<Record<string, unknown>>;
}

export interface NoticeHost {
  /** 通知を置く層。 */
  layer(): HTMLElement;
  skipping(): boolean;
  /** 全画面の演出が覆っているか。 */
  covered(): boolean;
  onCoverChange(listener: () => void): () => void;
  playSe(file: string): void;
  /** 見た目の差し替え（WebPlugin.screens.toast）。 */
  look(): ((api: ToastApi) => HTMLElement) | undefined;
}

interface Item {
  el: HTMLElement;
  key: string;
  timers: number[];
  leaving: boolean;
  count: number;
}

const EXIT_MS = 320;
const PENDING_MAX = 8;

export class Notices {
  private readonly items: Item[] = [];
  private readonly pending: { text: string; o: NoticeOptions }[] = [];
  private box: HTMLElement | null = null;
  private watching: (() => void) | null = null;

  constructor(private readonly host: NoticeHost) {}

  /** 通知を出す。 */
  show(text: string, o: NoticeOptions = {}): void {
    if (this.host.covered()) {
      this.pending.push({ text, o });
      while (this.pending.length > PENDING_MAX) this.pending.shift();
      this.watchCover();
      return;
    }
    const mag = this.host.skipping() ? 10 : 1;
    const hold = Math.max(0, Math.round((o.time ?? 3000) / mag));
    const delay = Math.max(0, Math.round((o.delay ?? 0) / mag));
    const key = o.key ?? text;
    const same = this.items.find((it) => !it.leaving && it.key === key);
    if (same) {
      same.timers.forEach(clearTimeout);
      same.count++;
      same.el.setAttribute("data-lm-count", String(same.count));
      same.timers = [window.setTimeout(() => this.leave(same), hold)];
      return;
    }
    const max = Math.max(1, Math.floor(o.max ?? 3));
    const alive = this.items.filter((it) => !it.leaving);
    while (alive.length >= max) this.leave(alive.shift()!);
    const kind = o.kind || "info";
    const look = this.host.look();
    const el = look ? look({ text, kind, title: o.title ?? null, args: o.args ?? {} }) : this.build(text, kind, o.title ?? null);
    el.classList.add("lm-notice", `lm-notice--${kind.replace(/[^A-Za-z0-9_-]/g, "_")}`);
    el.dataset.kind = kind;
    el.setAttribute("data-lm-state", "enter");
    el.setAttribute("data-lm-count", "1");
    const item: Item = { el, key, timers: [], leaving: false, count: 1 };
    this.items.push(item);
    this.container().append(el);
    item.timers.push(
      window.setTimeout(() => {
        el.setAttribute("data-lm-state", "in");
        if (o.se) this.host.playSe(o.se);
        item.timers.push(window.setTimeout(() => this.leave(item), hold));
      }, Math.max(delay, 16)),
    );
  }

  /** すべて消す（ロード）。待たせていたものも捨てる。 */
  clear(): void {
    this.pending.length = 0;
    for (const it of this.items.splice(0)) {
      it.timers.forEach(clearTimeout);
      it.el.remove();
    }
  }

  private container(): HTMLElement {
    const layer = this.host.layer();
    if (!this.box || this.box.parentElement !== layer) {
      this.box = document.createElement("div");
      this.box.className = "lm-notices";
      this.box.setAttribute("aria-live", "polite");
      this.box.setAttribute("role", "status");
      layer.append(this.box);
    }
    return this.box;
  }

  private build(text: string, kind: string, title: string | null): HTMLElement {
    const el = document.createElement("div");
    if (title) {
      const h = document.createElement("div");
      h.className = "lm-notice-title";
      h.textContent = title;
      el.append(h);
    }
    const p = document.createElement("div");
    p.className = "lm-notice-text";
    p.textContent = text;
    el.append(p);
    el.setAttribute("aria-label", kind === "info" ? text : `${kind}: ${text}`);
    return el;
  }

  private leave(it: Item): void {
    if (it.leaving) return;
    it.leaving = true;
    it.timers.forEach(clearTimeout);
    it.el.setAttribute("data-lm-state", "out");
    it.timers = [
      window.setTimeout(() => {
        it.el.remove();
        const i = this.items.indexOf(it);
        if (i >= 0) this.items.splice(i, 1);
      }, this.host.skipping() ? 40 : EXIT_MS),
    ];
  }

  private watchCover(): void {
    if (this.watching) return;
    this.watching = this.host.onCoverChange(() => {
      if (this.host.covered()) return;
      this.watching?.();
      this.watching = null;
      this.pending.splice(0).forEach((p, i) => window.setTimeout(() => this.show(p.text, p.o), i * 120));
    });
  }
}
