import { h } from "./dom.ts";
import { PS } from "./strings.ts";

export interface SplitterOptions {
  /** つまみを置く欄の入れ物（position: relative）。 */
  host: HTMLElement;
  /** 幅を持つ欄が入れ物の左端か右端か（つまみはその欄の内側の境目に置く）。 */
  side: "left" | "right";
  /** 幅を入れる CSS の変数（その時に効いているもの。「拡大」で替わる欄のため関数）。 */
  variable: () => string;
  min: number;
  /** 入れ物の幅から、欄に使ってよい最大の幅。 */
  max: (hostWidth: number) => number;
  /** 幅を覚えるキー（変数ごと）。 */
  storageKey: (variable: string) => string;
  /** 幅が変わったとき（台本の測り直しなど）。 */
  onChange?: () => void;
}

/**
 * 欄の境目をドラッグして幅を変えるつまみ。幅は入れ物の CSS の変数（px）に入れ、localStorage に覚える。ダブルクリックで既定の幅に戻す。
 * 舞台（iframe）の上を通ってもドラッグが切れないよう、押したらポインタを捕まえる。
 * 覚えた幅が入れ物に収まらないとき（狭い窓で開いた、窓を狭めた）は収まる幅まで縮めて入れ、広がれば覚えた幅に戻す。
 */
export class Splitter {
  readonly el: HTMLElement;
  /** 覚えている幅（0 なら CSS の既定の幅）。 */
  private wanted = 0;

  constructor(private readonly o: SplitterOptions) {
    this.el = h("div", { class: `splitter splitter-${o.side}`, role: "separator", "aria-orientation": "vertical", title: PS.splitterTitle });
    this.el.addEventListener("pointerdown", (e) => this.drag(e));
    this.el.addEventListener("dblclick", () => this.reset());
    o.host.append(this.el);
    this.restore();
    new ResizeObserver(() => this.fit()).observe(o.host);
  }

  /** 覚えている幅を入れる（「拡大」で変数が替わったときにも呼ぶ）。 */
  restore(): void {
    const v = this.o.variable();
    let px = 0;
    try {
      px = Number(localStorage.getItem(this.o.storageKey(v)));
    } catch {
      // 覚えられない環境では既定の幅
    }
    this.wanted = px > 0 ? px : 0;
    this.fit();
  }

  /** 覚えている幅を、入れ物に収まるよう縮めて入れる（入れ物がまだ置かれていなければそのまま）。 */
  private fit(): void {
    const v = this.o.variable();
    if (this.wanted <= 0) {
      this.o.host.style.removeProperty(v);
      return;
    }
    const width = this.o.host.getBoundingClientRect().width;
    const px = `${width > 0 ? this.clamp(this.wanted, width) : this.wanted}px`;
    if (this.o.host.style.getPropertyValue(v) === px) return;
    this.o.host.style.setProperty(v, px);
    this.o.onChange?.();
  }

  private clamp(px: number, hostWidth: number): number {
    return Math.round(Math.max(this.o.min, Math.min(this.o.max(hostWidth), px)));
  }

  private set(px: number): number {
    const w = this.clamp(px, this.o.host.getBoundingClientRect().width);
    this.o.host.style.setProperty(this.o.variable(), `${w}px`);
    this.o.onChange?.();
    return w;
  }

  private drag(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.el.setPointerCapture(e.pointerId);
    this.el.classList.add("dragging");
    document.documentElement.classList.add("resizing");
    const rect = this.o.host.getBoundingClientRect();
    let last = 0;
    const move = (ev: PointerEvent) => {
      last = this.set(this.o.side === "left" ? ev.clientX - rect.left : rect.right - ev.clientX);
    };
    const up = () => {
      this.el.classList.remove("dragging");
      document.documentElement.classList.remove("resizing");
      this.el.removeEventListener("pointermove", move);
      if (last > 0) {
        this.wanted = last;
        try {
          localStorage.setItem(this.o.storageKey(this.o.variable()), String(last));
        } catch {
          // 覚えられない環境では、この画面の間だけ
        }
      }
    };
    this.el.addEventListener("pointermove", move);
    this.el.addEventListener("pointerup", up, { once: true });
    this.el.addEventListener("pointercancel", up, { once: true });
  }

  private reset(): void {
    const v = this.o.variable();
    this.wanted = 0;
    this.o.host.style.removeProperty(v);
    try {
      localStorage.removeItem(this.o.storageKey(v));
    } catch {
      // 覚えられない環境
    }
    this.o.onChange?.();
  }
}
