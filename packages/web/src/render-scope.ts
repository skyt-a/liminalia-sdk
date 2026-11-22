/**
 * 演出の後始末を受け持つもの（RenderContext.scope）。
 * 一回きりの演出（コマ送り・反転のコマ・瞬きなど）が使うタイマー・requestAnimationFrame・要素・受け口をまとめて持ち、
 * ロード（組み立て直し）とスキップの始まりに、エンジンが自動で片付ける。作品が演出ごとに台帳を作らなくてよい。
 */
export interface EffectScope {
  /** 片付けたら止まる（fetch などに渡す）。 */
  readonly signal: AbortSignal;
  /** 片付け済みか（sleep のあとの続きを書く前に見る）。 */
  readonly disposed: boolean;
  /** setTimeout と同じ（片付けると呼ばない）。時間はそのまま（演出の時間なら sleep を使う）。 */
  setTimeout(fn: () => void, ms: number): number;
  /** setInterval と同じ（片付けると止まる）。 */
  setInterval(fn: () => void, ms: number): number;
  /** setTimeout・setInterval で作ったものを止める。 */
  clearTimer(id: number): void;
  /** requestAnimationFrame と同じ（片付けると呼ばない）。 */
  requestAnimationFrame(fn: (now: number) => void): number;
  /** 毎フレーム fn を呼ぶ。false を返すか片付けると止まる。 */
  frame(fn: (now: number) => boolean | void): void;
  /** 要素を片付けのときに外す（足した要素をそのまま返す）。 */
  add<T extends Element>(el: T): T;
  /** 受け口を付け、片付けのときに外す。 */
  listen(target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions): void;
  /** 片付けのときに呼ぶ（付けた CSS を戻すなど。後に足したものから呼ぶ）。 */
  defer(fn: () => void): void;
  /**
   * 演出の待ち。スキップ中・クリックで早送りした命令を描いている間は待たず、早送りされたらその場で終わる。
   * 片付けたときも終わる（そのあとは disposed を見て続きを書かない）。
   */
  sleep(ms: number): Promise<void>;
  /** クリックで演出を早送りしたときに呼ぶ（片付けると外れる）。 */
  onFastForward(finish: () => void): void;
  /** 今すぐ片付ける（演出が終わったら呼ぶ）。二度呼んでもよい。 */
  dispose(): void;
}

/** scope を作るときの選び方。 */
export interface EffectScopeOptions {
  /** スキップが始まっても片付けない（ロードでは片付ける）。既定は片付ける。 */
  keepOnSkip?: boolean;
}

/** scope が描画側から受け取るもの。 */
export interface ScopeHost {
  /** 演出の時間（スキップ中と早送り中は 0）。 */
  effectTime(ms: number): number;
  onFastForward(finish: () => void): () => void;
}

/** 片付けの台帳。 */
export class RenderScope implements EffectScope {
  private readonly controller = new AbortController();
  private readonly timers = new Set<number>();
  private readonly intervals = new Set<number>();
  private readonly frames = new Set<number>();
  private readonly nodes = new Set<Element>();
  private readonly cleanups: (() => void)[] = [];
  private readonly sleepers = new Set<() => void>();

  constructor(
    private readonly host: ScopeHost,
    readonly options: EffectScopeOptions,
    private readonly forget: (scope: RenderScope) => void,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get disposed(): boolean {
    return this.controller.signal.aborted;
  }

  setTimeout(fn: () => void, ms: number): number {
    if (this.disposed) return 0;
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  setInterval(fn: () => void, ms: number): number {
    if (this.disposed) return 0;
    const id = window.setInterval(() => {
      if (!this.disposed) fn();
    }, ms);
    this.intervals.add(id);
    return id;
  }

  clearTimer(id: number): void {
    if (this.timers.delete(id)) clearTimeout(id);
    if (this.intervals.delete(id)) clearInterval(id);
  }

  requestAnimationFrame(fn: (now: number) => void): number {
    if (this.disposed) return 0;
    const id = window.requestAnimationFrame((now) => {
      this.frames.delete(id);
      if (!this.disposed) fn(now);
    });
    this.frames.add(id);
    return id;
  }

  frame(fn: (now: number) => boolean | void): void {
    const step = (now: number) => {
      if (fn(now) !== false) this.requestAnimationFrame(step);
    };
    this.requestAnimationFrame(step);
  }

  add<T extends Element>(el: T): T {
    if (this.disposed) el.remove();
    else this.nodes.add(el);
    return el;
  }

  listen(target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions): void {
    if (this.disposed) return;
    target.addEventListener(type, listener, options);
    this.cleanups.push(() => target.removeEventListener(type, listener, options));
  }

  defer(fn: () => void): void {
    if (this.disposed) fn();
    else this.cleanups.push(fn);
  }

  sleep(ms: number): Promise<void> {
    const time = this.host.effectTime(ms);
    if (this.disposed || time <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        this.sleepers.delete(done);
        resolve();
      };
      const timer = window.setTimeout(done, time);
      const off = this.host.onFastForward(done);
      this.sleepers.add(done);
    });
  }

  onFastForward(finish: () => void): void {
    if (this.disposed) return;
    this.cleanups.push(this.host.onFastForward(finish));
  }

  dispose(): void {
    if (this.disposed) return;
    this.controller.abort();
    for (const id of this.timers) clearTimeout(id);
    for (const id of this.intervals) clearInterval(id);
    for (const id of this.frames) cancelAnimationFrame(id);
    this.timers.clear();
    this.intervals.clear();
    this.frames.clear();
    for (const fn of this.cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch (e) {
        console.warn("演出の片付けに失敗しました", e);
      }
    }
    for (const el of this.nodes) el.remove();
    this.nodes.clear();
    for (const wake of [...this.sleepers]) wake();
    this.forget(this);
  }
}
