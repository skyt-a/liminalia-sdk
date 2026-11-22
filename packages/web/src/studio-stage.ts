import type { AudioPlayer } from "./audio.ts";

/**
 * 制作画面の舞台（`?studio=1`）を止める・音を消す仕組み。プレイヤーの main.ts が、制作画面からの頼み
 * （stage-pause・stage-resume・stage-mute）を受けてここを動かす。
 *
 * 止める間は、今の画面をそのままにして、時間で進むものをすべて止める。
 * - 音: 描画側の AudioPlayer の AudioContext を止める（BGM・効果音は止めた位置から続く）。<audio>・<video> は pause()
 * - 演出: document の Web Animations と CSS のアニメーション・トランジション（止めた後に始まったものも）
 * - 文字送り・オート・@wait・システム画面やプラグインのタイマー: setTimeout・requestAnimationFrame を TimerGate で
 *   包み、止めている間に来た呼び出しは控えて、再開のときに順に呼ぶ（setInterval はその間の回を飛ばす）
 * - 入力: 舞台を押す・キーで送ると先へ進んでしまうので、止めている間は受けない（blockInputWhilePaused）
 * システム画面に手を入れないので、プラグインがシステム画面を差し替えた作品でも同じように効く。
 */

type Callback = (...args: unknown[]) => void;

/** TimerGate が包むタイマー（window のもの、確かめでは差し替え）。 */
export interface Timers {
  setTimeout(handler: Callback, ms?: number, ...args: unknown[]): number;
  clearTimeout(id: number | undefined): void;
  setInterval(handler: Callback, ms?: number, ...args: unknown[]): number;
  clearInterval(id: number | undefined): void;
  requestAnimationFrame(cb: (time: number) => void): number;
  cancelAnimationFrame(id: number): void;
}

/**
 * 止められるタイマー。timers が包んだ版で、止めている間に時刻の来た setTimeout・requestAnimationFrame は呼ばずに控え、
 * resume で来た順に呼ぶ。setInterval は止めている間の回を飛ばす。控えたものも clearTimeout・cancelAnimationFrame で取り消せる。
 * 包む前のタイマー（real）は止まらないので、プレイヤー自身の待ち（頼みの順番など）に使う。
 */
export class TimerGate {
  private stopped = false;
  /** 控えた呼び出し（"t" か "f" と id → 呼ぶもの）。Map は入れた順に回る。 */
  private readonly held = new Map<string, () => void>();
  private seq = 0;
  readonly timers: Timers;

  constructor(
    readonly real: Timers,
    private readonly now: () => number = () => performance.now(),
  ) {
    const gate = this;
    this.timers = {
      setTimeout(handler, ms, ...args) {
        if (typeof handler !== "function") return real.setTimeout(handler, ms, ...args);
        const id: number = real.setTimeout(() => {
          if (gate.stopped) gate.held.set(`t${id}`, () => handler(...args));
          else handler(...args);
        }, ms);
        return id;
      },
      clearTimeout(id) {
        gate.held.delete(`t${id}`);
        real.clearTimeout(id);
      },
      setInterval(handler, ms, ...args) {
        if (typeof handler !== "function") return real.setInterval(handler, ms, ...args);
        return real.setInterval(() => {
          if (!gate.stopped) handler(...args);
        }, ms);
      },
      clearInterval(id) {
        real.clearInterval(id);
      },
      requestAnimationFrame(cb) {
        const id: number = real.requestAnimationFrame((time) => {
          if (gate.stopped) gate.held.set(`f${id}`, () => cb(gate.now()));
          else cb(time);
        });
        return id;
      },
      cancelAnimationFrame(id) {
        gate.held.delete(`f${id}`);
        real.cancelAnimationFrame(id);
      },
    };
  }

  get paused(): boolean {
    return this.stopped;
  }

  /** 控えている呼び出しの数（確かめるため）。 */
  get pending(): number {
    return this.held.size;
  }

  pause(): void {
    this.stopped = true;
  }

  /** 控えた呼び出しを来た順に呼ぶ。一つが投げても残りは呼ぶ（投げたものは後で投げ直す）。 */
  resume(): void {
    this.stopped = false;
    const calls = [...this.held.values()];
    this.held.clear();
    for (const [i, call] of calls.entries()) {
      // 呼んだものが止め直したら、残りはまた控える
      if (this.stopped) {
        for (const rest of calls.slice(i)) this.held.set(`r${++this.seq}`, rest);
        return;
      }
      try {
        call();
      } catch (e) {
        this.real.setTimeout(() => {
          throw e;
        }, 0);
      }
    }
  }

  /** window のタイマーを包んだ版に差し替える。 */
  install(win: Window): void {
    Object.assign(win, this.timers);
  }
}

/** window のタイマー（this を window に結んだもの）。 */
export function windowTimers(win: Window): Timers {
  return {
    setTimeout: win.setTimeout.bind(win) as Timers["setTimeout"],
    clearTimeout: win.clearTimeout.bind(win),
    setInterval: win.setInterval.bind(win) as Timers["setInterval"],
    clearInterval: win.clearInterval.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  };
}

/** 止めている間に受けない入力。 */
const INPUT_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel", "touchstart", "touchend", "keydown", "keyup"] as const;

/**
 * 止めている間は舞台への入力（押す・キー・ホイール）を受けない（送ると先へ進んでしまうため）。
 * システム画面・プラグインより先に受けるよう、それらを組み立てる前に呼ぶ。
 * 制作画面のキー（⌘／Ctrl と Shift の組み合わせ・Esc）は制作画面が舞台の window で受けるので通す。
 */
export function blockInputWhilePaused(win: Window, gate: TimerGate): void {
  const block = (e: Event) => {
    if (!gate.paused) return;
    if (e instanceof KeyboardEvent && (((e.metaKey || e.ctrlKey) && e.shiftKey) || e.key === "Escape")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  for (const type of INPUT_EVENTS) win.addEventListener(type, block, { capture: true, passive: false });
}

/** 止めている間に CSS のアニメーションを始めさせない（止めた後に足された要素の分）。 */
const FREEZE_CSS = "*, *::before, *::after { animation-play-state: paused !important; }";

/** 舞台を止める・再開する（TimerGate のほかに、音と演出）。 */
export class StageFreeze {
  private readonly animations = new Set<Animation>();
  private readonly media = new Set<HTMLMediaElement>();
  private style: HTMLStyleElement | null = null;

  constructor(
    private readonly gate: TimerGate,
    private readonly audio: AudioPlayer,
  ) {
    // 止めた後に始まった演出・動画も止める
    const animate = Element.prototype.animate;
    const freeze = this;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      const a = animate.apply(this, args);
      if (freeze.paused) freeze.hold(a);
      return a;
    };
    const later = () => {
      if (this.paused) this.holdAnimations();
    };
    document.addEventListener("transitionrun", later, true);
    document.addEventListener("animationstart", later, true);
    // 再生は泡立たないので、取り込みの段で受ける
    document.addEventListener(
      "play",
      (e) => {
        if (this.paused && e.target instanceof HTMLMediaElement) this.holdMedia(e.target);
      },
      true,
    );
  }

  get paused(): boolean {
    return this.gate.paused;
  }

  pause(): void {
    if (this.paused) return;
    this.gate.pause();
    void this.audio.context.suspend().catch(() => undefined);
    this.style = document.createElement("style");
    this.style.textContent = FREEZE_CSS;
    document.head.append(this.style);
    this.holdAnimations();
    for (const m of document.querySelectorAll("audio, video")) if (m instanceof HTMLMediaElement && !m.paused) this.holdMedia(m);
  }

  resume(): void {
    if (!this.paused) return;
    this.style?.remove();
    this.style = null;
    for (const a of this.animations) if (a.playState === "paused") a.play();
    this.animations.clear();
    for (const m of this.media) if (m.isConnected) void m.play().catch(() => undefined);
    this.media.clear();
    void this.audio.context.resume().catch(() => undefined);
    this.gate.resume();
  }

  private holdAnimations(): void {
    for (const a of document.getAnimations()) this.hold(a);
  }

  private hold(a: Animation): void {
    if (a.playState !== "running" && a.pending !== true) return;
    a.pause();
    this.animations.add(a);
  }

  private holdMedia(m: HTMLMediaElement): void {
    m.pause();
    this.media.add(m);
  }
}

/**
 * 舞台の音を消す。AudioPlayer の出口を 0 にし、<audio>・<video> は muted にする（あとから鳴り始めたものも）。
 * 戻すときは、こちらで消したものだけを元の muted に戻す。
 */
export class StageMute {
  private muted = false;
  /** こちらで消した要素 → 消す前の muted。 */
  private readonly changed = new Map<HTMLMediaElement, boolean>();

  constructor(private readonly audio: AudioPlayer) {
    const onMedia = (e: Event) => {
      if (this.muted && e.target instanceof HTMLMediaElement) this.mute(e.target);
    };
    document.addEventListener("play", onMedia, true);
    document.addEventListener("loadstart", onMedia, true);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  set(muted: boolean): void {
    this.muted = muted;
    this.audio.setMuted(muted);
    if (muted) {
      for (const m of document.querySelectorAll("audio, video")) if (m instanceof HTMLMediaElement) this.mute(m);
    } else {
      for (const [m, before] of this.changed) m.muted = before;
      this.changed.clear();
    }
  }

  private mute(m: HTMLMediaElement): void {
    if (!this.changed.has(m)) this.changed.set(m, m.muted);
    m.muted = true;
  }
}
