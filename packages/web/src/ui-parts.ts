import type { Value } from "@liminalia/runtime";
import type { Settings, SettingsPatch } from "./system/settings.ts";

/**
 * 見た目を持たない UI 部品。作品が作った要素（DOM と CSS、画像）に、押す・選ぶ・つまむ動きと決まりごとだけを付ける。
 * 状態は要素の属性に出す（見た目は作品の CSS で決める）:
 *   data-lm-hover（マウスが乗っている）・data-lm-focus（キーボードで選んでいる）・data-lm-pressed（押している間）・
 *   data-lm-disabled（押せない）・data-lm-selected（指で一度目に触れて選んだ）・data-lm-on（切り替えが入）・
 *   aria-pressed（選択の中で選ばれている）・--lm-value（つまみの位置 0〜1）
 * システム画面の外でも使える（舞台の上の作品の部品など）。押したクリックは舞台（本文の送り）へ流さない。
 */

/** 押せる範囲。box は要素の矩形（既定）、矩形は要素の左上からの px、alpha は画像の透明でない部分。 */
export type HitArea = "box" | { x: number; y: number; width: number; height: number } | { alpha: true; threshold?: number; image?: string };

export interface ButtonOptions {
  onPress(e: Event): void;
  /** 押せないか（関数なら押すたびに確かめる）。 */
  disabled?: boolean | (() => boolean);
  hit?: HitArea;
  /** 押したときの効果音（sound からのパス）。 */
  se?: string;
  /** マウスが乗ったときの効果音。 */
  hoverSe?: string;
  /**
   * se を書かないときに鳴らす、システム画面の効果音（liminalia.json の ui.sound.ui）の種類。既定は select（押したとき）。
   * 閉じるボタンなら cancel、タブなら page。false なら鳴らさない（マウスが乗ったときの hover も）。
   */
  sound?: UiSoundKind | false;
  /** 指で触れる端末では、一度目のタップで選び（data-lm-selected）、二度目で押す（ホバーの代わり）。 */
  tapToSelect?: boolean;
  /** 読み上げの名前（要素に文が無いとき）。 */
  label?: string;
}

export interface ButtonHandle {
  readonly el: HTMLElement;
  setDisabled(disabled: boolean): void;
  dispose(): void;
}

/** 設定に結び付ける（system.settings の項目。作品独自の値は "custom.名前"）。 */
export interface SettingBinding {
  system: { readonly settings?: Readonly<Settings>; updateSettings?(patch: SettingsPatch): Readonly<Settings>; onSettingsChange?(l: (s: Readonly<Settings>) => void): () => void };
  key: string;
}

// ---- 効果音 ----

let sound: ((file: string) => void) | null = null;
/** 部品の効果音を鳴らす口（DomHost が作ったときに入れる）。 */
export function setUiSound(play: ((file: string) => void) | null): void {
  sound = play;
}

/** システム画面の効果音の種類（liminalia.json の ui.sound.ui）。 */
export type UiSoundKind = "hover" | "select" | "cancel" | "open" | "close" | "page" | "choice";
/** 種類 → 効果音（sound からのパス）。 */
let uiSounds: Partial<Record<UiSoundKind, string>> = {};
/** 最後に押した音（select・cancel）を鳴らした時刻。続けて来る画面の開閉の音は鳴らさない（押した音と重ねない）。 */
let pressedAt = -Infinity;

/** システム画面の効果音を決める（DomHost が ui.sound.ui から入れる）。 */
export function setUiSounds(map: Readonly<Partial<Record<UiSoundKind, string>>> | undefined): void {
  uiSounds = { ...(map ?? {}) };
}

/**
 * システム画面の効果音（ui.sound.ui）を鳴らす。決めていなければ何もしない。効果音の音量で鳴らす。
 * open・close は、押した音（select・cancel）のすぐ後なら鳴らさない（ボタンで画面を開いたときに二つ重ねない）。
 * 作品が作ったシステム画面から、画面を開いた・閉じたときなどに呼べる。
 */
export function playSound(kind: UiSoundKind): void {
  const now = performance.now();
  if ((kind === "open" || kind === "close") && now - pressedAt < 200) return;
  const file = uiSounds[kind];
  if (!file) return;
  if (kind === "select" || kind === "cancel" || kind === "choice") pressedAt = now;
  sound?.(file);
}

// ---- ボタン ----

interface Registered {
  el: HTMLElement;
  o: ButtonOptions;
  disabled: boolean;
}

/** 要素 → ボタン（要素が捨てられたら一緒に消える）。 */
const buttons = new WeakMap<HTMLElement, Registered>();
let hovered: Registered | null = null;
let pressed: Registered | null = null;
let lastPointer: string = "mouse";
let installed = false;

const isNative = (el: HTMLElement) => el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLAnchorElement;

function registeredFrom(node: Element | null): Registered | null {
  for (let n: Element | null = node; n && n !== document.body; n = n.parentElement) {
    const b = buttons.get(n as HTMLElement);
    if (b) return b;
  }
  return null;
}

function isDisabled(b: Registered): boolean {
  return b.disabled || (typeof b.o.disabled === "function" ? b.o.disabled() : b.o.disabled === true);
}

/** 画像の透明度の控え（src → 画素）。読めるまでは矩形で当てる。 */
const alphaCache = new Map<string, { width: number; height: number; data: Uint8ClampedArray } | "loading" | "failed">();

function alphaSource(b: Registered, hit: { image?: string }): string | null {
  if (hit.image) return hit.image;
  if (b.el instanceof HTMLImageElement) return b.el.currentSrc || b.el.src;
  const m = /url\(["']?(.+?)["']?\)/.exec(getComputedStyle(b.el).backgroundImage);
  return m ? m[1]! : null;
}

function alphaAt(src: string, u: number, v: number, threshold: number): boolean {
  const c = alphaCache.get(src);
  if (c === undefined) {
    alphaCache.set(src, "loading");
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const g = canvas.getContext("2d")!;
        g.drawImage(img, 0, 0);
        alphaCache.set(src, { width: canvas.width, height: canvas.height, data: g.getImageData(0, 0, canvas.width, canvas.height).data });
      } catch {
        alphaCache.set(src, "failed");
      }
    };
    img.onerror = () => alphaCache.set(src, "failed");
    img.src = src;
    return true;
  }
  if (c === "loading" || c === "failed") return true;
  const x = Math.min(c.width - 1, Math.max(0, Math.floor(u * c.width)));
  const y = Math.min(c.height - 1, Math.max(0, Math.floor(v * c.height)));
  return c.data[(y * c.width + x) * 4 + 3]! > threshold;
}

/** その点（画面の座標）がボタンの押せる範囲か。 */
function hits(b: Registered, x: number, y: number): boolean {
  const r = b.el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0 || x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
  const hit = b.o.hit ?? "box";
  if (hit === "box") return true;
  // 舞台は拡大・縮小して置いているので、要素の中の px に直す
  const lx = ((x - r.left) / r.width) * (b.el.offsetWidth || r.width);
  const ly = ((y - r.top) / r.height) * (b.el.offsetHeight || r.height);
  if ("alpha" in hit) {
    const src = alphaSource(b, hit);
    return src ? alphaAt(src, (x - r.left) / r.width, (y - r.top) / r.height, hit.threshold ?? 0) : true;
  }
  return lx >= hit.x && lx <= hit.x + hit.width && ly >= hit.y && ly <= hit.y + hit.height;
}

/**
 * その点で押せる一番上のボタン。一番上のボタンの押せる範囲の外（透明な部分など）なら、すぐ下のボタンを確かめる。
 * ボタンでない要素に当たったらそこで止める（文字の枠などの下のボタンは押さない）。
 */
function topAt(x: number, y: number): Registered | null {
  const tried = new Set<Registered>();
  for (const node of document.elementsFromPoint(x, y)) {
    const b = registeredFrom(node);
    if (!b) return null;
    if (tried.has(b)) continue;
    if (hits(b, x, y)) return b;
    tried.add(b);
  }
  return null;
}

function setHover(b: Registered | null): void {
  if (hovered === b) return;
  hovered?.el.removeAttribute("data-lm-hover");
  hovered = b;
  if (b) {
    b.el.setAttribute("data-lm-hover", "");
    if (!isDisabled(b)) {
      if (b.o.hoverSe) sound?.(b.o.hoverSe);
      else if (b.o.sound !== false) playSound("hover");
    }
  }
}

function activate(b: Registered, e: Event): void {
  if (isDisabled(b)) return;
  // 指で一度目に触れたら選ぶだけ（二度目で押す）
  if (b.o.tapToSelect && lastPointer === "touch" && !b.el.hasAttribute("data-lm-selected")) {
    for (const other of document.querySelectorAll("[data-lm-selected]")) other.removeAttribute("data-lm-selected");
    b.el.setAttribute("data-lm-selected", "");
    b.el.focus({ preventScroll: true });
    if (b.o.sound !== false) playSound("hover");
    return;
  }
  b.el.removeAttribute("data-lm-selected");
  if (b.o.se) {
    sound?.(b.o.se);
    pressedAt = performance.now();
  } else if (b.o.sound !== false) playSound(b.o.sound ?? "select");
  b.o.onPress(e);
}

function install(): void {
  if (installed) return;
  installed = true;
  // ホバーは一コマに一回だけ確かめる（マウスを動かすたびに重なりを調べない）
  let move: PointerEvent | null = null;
  document.addEventListener(
    "pointermove",
    (e) => {
      lastPointer = e.pointerType;
      if (move === null)
        requestAnimationFrame(() => {
          const m = move!;
          move = null;
          setHover(m.pointerType === "touch" ? null : topAt(m.clientX, m.clientY));
        });
      move = e;
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (e) => {
      lastPointer = e.pointerType;
      const b = topAt(e.clientX, e.clientY);
      pressed?.el.removeAttribute("data-lm-pressed");
      pressed = b && !isDisabled(b) ? b : null;
      pressed?.el.setAttribute("data-lm-pressed", "");
    },
    true,
  );
  const release = () => {
    pressed?.el.removeAttribute("data-lm-pressed");
    pressed = null;
  };
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
  // 重なり・押せる範囲の外のクリックだけをここで扱う（ふつうはボタンの要素が自分で受ける）
  document.addEventListener(
    "click",
    (e) => {
      // キーボードで押したクリック（Enter・Space）は座標を持たないので、ボタンの要素に任せる
      if (e.detail === 0) return;
      const inside = registeredFrom(e.target as Element | null);
      if (!inside) return;
      const top = topAt(e.clientX, e.clientY);
      if (top === inside) return;
      // 押せる範囲の外（透明な部分）なら下のボタンを押し、どれでもなければ何もしない（どちらも舞台へは流さない）
      e.stopPropagation();
      e.preventDefault();
      if (top) activate(top, e);
    },
    true,
  );
}

/** 作品の要素をボタンにする。<button> 以外の要素は、キーボードで選べるようにする（tabindex・role）。 */
export function button(el: HTMLElement, o: ButtonOptions): ButtonHandle {
  install();
  const b: Registered = { el, o, disabled: false };
  buttons.set(el, b);
  if (!isNative(el)) {
    if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
    if (!el.hasAttribute("role")) el.setAttribute("role", "button");
  }
  if (o.label) el.setAttribute("aria-label", o.label);
  const onKey = (e: KeyboardEvent) => {
    if (isNative(el) || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    e.stopPropagation();
    activate(b, e);
  };
  // 押したクリックは舞台（本文の送り）へ流さない
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    activate(b, e);
  };
  el.addEventListener("click", onClick);
  const onFocus = () => el.setAttribute("data-lm-focus", "");
  const onBlur = () => {
    el.removeAttribute("data-lm-focus");
    el.removeAttribute("data-lm-selected");
  };
  el.addEventListener("keydown", onKey);
  el.addEventListener("focus", onFocus);
  el.addEventListener("blur", onBlur);
  const sync = () => {
    const off = isDisabled(b);
    el.toggleAttribute("data-lm-disabled", off);
    el.setAttribute("aria-disabled", String(off));
  };
  sync();
  return {
    el,
    setDisabled(disabled) {
      b.disabled = disabled;
      sync();
    },
    dispose() {
      buttons.delete(el);
      if (hovered === b) setHover(null);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("click", onClick);
      el.removeEventListener("focus", onFocus);
      el.removeEventListener("blur", onBlur);
    },
  };
}

// ---- 設定への結び付け ----

function readSetting(binding: SettingBinding): Value | undefined {
  const s = binding.system.settings;
  if (!s) return undefined;
  if (binding.key.startsWith("custom.")) return s.custom[binding.key.slice(7)];
  return (s as unknown as Record<string, Value>)[binding.key];
}

function writeSetting(binding: SettingBinding, value: Value): void {
  const patch: SettingsPatch = binding.key.startsWith("custom.") ? { custom: { [binding.key.slice(7)]: value } } : ({ [binding.key]: value } as SettingsPatch);
  binding.system.updateSettings?.(patch);
}

// ---- つまみ ----

export interface SliderOptions {
  min: number;
  max: number;
  /** 刻み（既定 1）。 */
  step?: number;
  /** 初めの値（setting を結び付けたら設定の値）。 */
  value?: number;
  /** 動かしている間、値が変わるたびに呼ぶ（その場で反映する）。 */
  onChange?(value: number): void;
  /** 動かし終えたとき（指を離した・キーを離した）。 */
  onCommit?(value: number): void;
  orientation?: "horizontal" | "vertical";
  /** つまみの要素。あれば位置を合わせる（横は left、縦は bottom を %）。無ければ el の --lm-value（0〜1）だけを変える。 */
  thumb?: HTMLElement;
  /** 設定に結び付ける（変えたら system.updateSettings で保存して反映し、ほかで変わったら合わせる）。 */
  setting?: SettingBinding;
  label?: string;
}

export interface SliderHandle {
  readonly value: number;
  set(value: number): void;
  dispose(): void;
}

/**
 * 作品の要素をつまみにする。<input type="range"> ならその動きを使い、ほかの要素なら、ドラッグ（指も）・
 * 矢印キー・Page Up/Down・Home/End で動かす（role="slider"）。
 */
export function slider(el: HTMLElement, o: SliderOptions): SliderHandle {
  const step = o.step ?? 1;
  const clamp = (v: number) => Math.min(o.max, Math.max(o.min, Math.round((v - o.min) / step) * step + o.min));
  const bound = o.setting ? readSetting(o.setting) : undefined;
  let value = clamp(typeof bound === "number" ? bound : (o.value ?? o.min));
  const show = () => {
    const ratio = o.max === o.min ? 0 : (value - o.min) / (o.max - o.min);
    el.style.setProperty("--lm-value", String(ratio));
    if (o.thumb) {
      if (o.orientation === "vertical") o.thumb.style.bottom = `${ratio * 100}%`;
      else o.thumb.style.left = `${ratio * 100}%`;
    }
    if (el instanceof HTMLInputElement) el.value = String(value);
    else {
      el.setAttribute("aria-valuenow", String(value));
    }
  };
  const change = (v: number, commit: boolean) => {
    const next = clamp(v);
    if (next !== value) {
      value = next;
      show();
      if (o.setting) writeSetting(o.setting, value);
      o.onChange?.(value);
    }
    if (commit) o.onCommit?.(value);
  };
  const cleanups: (() => void)[] = [];
  const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
    el.addEventListener(type, fn);
    cleanups.push(() => el.removeEventListener(type, fn));
  };
  if (o.label) el.setAttribute("aria-label", o.label);
  if (el instanceof HTMLInputElement) {
    el.type = "range";
    el.min = String(o.min);
    el.max = String(o.max);
    el.step = String(step);
    on("input", () => change(Number(el.value), false));
    on("change", () => change(Number(el.value), true));
  } else {
    el.setAttribute("role", "slider");
    if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
    el.setAttribute("aria-valuemin", String(o.min));
    el.setAttribute("aria-valuemax", String(o.max));
    if (o.orientation === "vertical") el.setAttribute("aria-orientation", "vertical");
    const fromPoint = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const ratio = o.orientation === "vertical" ? (r.bottom - e.clientY) / r.height : (e.clientX - r.left) / r.width;
      return o.min + Math.min(1, Math.max(0, ratio)) * (o.max - o.min);
    };
    let dragging = false;
    on("pointerdown", (e) => {
      dragging = true;
      el.setPointerCapture(e.pointerId);
      el.setAttribute("data-lm-pressed", "");
      change(fromPoint(e), false);
      e.stopPropagation();
    });
    on("pointermove", (e) => {
      if (dragging) change(fromPoint(e), false);
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      el.removeAttribute("data-lm-pressed");
      change(fromPoint(e), true);
    };
    on("pointerup", end);
    on("pointercancel", end);
    on("click", (e) => e.stopPropagation());
    on("keydown", (e) => {
      const big = Math.max(step, (o.max - o.min) / 10);
      const delta: Record<string, number> = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: big, PageDown: -big };
      if (e.key in delta) change(value + delta[e.key]!, true);
      else if (e.key === "Home") change(o.min, true);
      else if (e.key === "End") change(o.max, true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    on("focus", () => el.setAttribute("data-lm-focus", ""));
    on("blur", () => el.removeAttribute("data-lm-focus"));
  }
  // ほかで設定が変わったら合わせる
  if (o.setting?.system.onSettingsChange) {
    cleanups.push(
      o.setting.system.onSettingsChange(() => {
        const v = readSetting(o.setting!);
        if (typeof v === "number" && clamp(v) !== value) {
          value = clamp(v);
          show();
        }
      }),
    );
  }
  show();
  return {
    get value() {
      return value;
    },
    set(v) {
      change(v, true);
    },
    dispose() {
      for (const c of cleanups) c();
    },
  };
}

// ---- 切り替え・選択 ----

export interface ToggleOptions {
  value?: boolean;
  onChange?(value: boolean): void;
  setting?: SettingBinding;
  se?: string;
  label?: string;
}

export interface ToggleHandle {
  readonly value: boolean;
  set(value: boolean): void;
  dispose(): void;
}

/** 作品の要素を入・切の切り替えにする（押すたびに入れ替える。role="switch"・aria-checked・data-lm-on）。 */
export function toggle(el: HTMLElement, o: ToggleOptions): ToggleHandle {
  let value = o.setting && typeof readSetting(o.setting) === "boolean" ? (readSetting(o.setting) as boolean) : (o.value ?? false);
  const show = () => {
    el.setAttribute("aria-checked", String(value));
    el.toggleAttribute("data-lm-on", value);
  };
  const set = (v: boolean) => {
    if (v === value) return;
    value = v;
    show();
    if (o.setting) writeSetting(o.setting, value);
    o.onChange?.(value);
  };
  el.setAttribute("role", "switch");
  const handle = button(el, { onPress: () => set(!value), ...(o.se ? { se: o.se } : {}), ...(o.label ? { label: o.label } : {}) });
  const off = o.setting?.system.onSettingsChange?.(() => {
    const v = readSetting(o.setting!);
    if (typeof v === "boolean" && v !== value) {
      value = v;
      show();
    }
  });
  show();
  return {
    get value() {
      return value;
    },
    set,
    dispose() {
      handle.dispose();
      off?.();
    },
  };
}

export interface ChoiceOptions<T extends Value> {
  value?: T;
  onChange?(value: T): void;
  setting?: SettingBinding;
  se?: string;
}

export interface ChoiceHandle<T extends Value> {
  readonly value: T | undefined;
  set(value: T): void;
  dispose(): void;
}

/** いくつかの要素から一つを選ぶ（選ばれたものに aria-pressed="true"）。設定画面の「既読だけ・すべて」のような並び。 */
export function choice<T extends Value>(items: readonly { el: HTMLElement; value: T }[], o: ChoiceOptions<T>): ChoiceHandle<T> {
  let value = (o.setting ? (readSetting(o.setting) as T | undefined) : undefined) ?? o.value;
  const show = () => {
    for (const it of items) it.el.setAttribute("aria-pressed", String(it.value === value));
  };
  const handles = items.map((it) =>
    button(it.el, {
      ...(o.se ? { se: o.se } : {}),
      onPress: () => {
        if (it.value === value) return;
        value = it.value;
        show();
        if (o.setting) writeSetting(o.setting, value);
        o.onChange?.(value);
      },
    }),
  );
  const off = o.setting?.system.onSettingsChange?.(() => {
    const v = readSetting(o.setting!) as T | undefined;
    if (v !== value) {
      value = v;
      show();
    }
  });
  show();
  return {
    get value() {
      return value;
    },
    set(v: T) {
      value = v;
      show();
    },
    dispose() {
      for (const h of handles) h.dispose();
      off?.();
    },
  };
}

/** 作品が作った溝とつまみのスクロールバー（ui-scrollbar.ts）。 */
export { scrollbar, type ScrollbarHandle, type ScrollbarOptions } from "./ui-scrollbar.ts";
