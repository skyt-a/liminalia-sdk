import { playSound } from "../ui-parts.ts";

/**
 * キーボードの矢印とゲームパッドで、画面のボタンを選んで押す。
 * - navigate: いま選んでいるもの（document.activeElement）から、その向きにいちばん近いボタンへ移る
 * - GamepadInput: 標準の配置のゲームパッドのボタンとスティックを、押した・離した の知らせにする
 */

export type Direction = "up" | "down" | "left" | "right";

const FOCUSABLE = "button:not([disabled]):not([hidden]), input:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * 遊んでいる最中（画面も選択肢も出していないとき）に、矢印キーと十字キーで選べるものの範囲の印（std の常駐の表示の根など）。
 * 舞台の中のこの印の付いた要素の、見えているボタンを選ぶ（input.ts）。
 */
export const PLAY_NAV = "[data-lm-play-nav]";

/**
 * キーを割り当てた操作の部品の印（data-lm-key に KeyboardEvent.key の名前。std の @hud-button key= など）。
 * 遊んでいる最中と選択肢を出している間に、そのキーで押す（既定のシステム画面）。英字は大文字と小文字を同じに扱う。
 */
export const KEYED = "[data-lm-key]";

/** 押したキー（KeyboardEvent.key）が、割り当てたキーの名前に当たるか（一文字なら大文字と小文字を同じに見る）。 */
export function keyMatches(assigned: string | undefined, key: string): boolean {
  if (!assigned) return false;
  return assigned.length === 1 && key.length === 1 ? assigned.toLowerCase() === key.toLowerCase() : assigned === key;
}

/** 見えていて押せる（隠したもの、裏に回したもの、大きさの無いもの、見えなくしたものでない）。 */
export function shown(el: HTMLElement): boolean {
  // 隠したもの、裏に回したもの（inert。おまけの CG を大きく見ている間の一覧など）は選ばない
  if (el.closest("[hidden], [inert]")) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

/** root の中で見えている、選べるもの。 */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(shown);
}

/**
 * root の中で、向きに沿っていちばん近いものを選ぶ。選んでいるものが root の外なら、最初のものを選ぶ。
 * つまみ（input[type=range]）を選んでいるときの左右は、値を一目盛り動かす。動かしたら true。
 */
export function navigate(root: HTMLElement, dir: Direction): boolean {
  return navigateAmong(focusables(root), dir);
}

/** navigate と同じ選び方を、選べるものの並び（見えているもの）の中で行う。今選んでいるものが並びに無ければ、最初のものを選ぶ。 */
export function navigateAmong(items: readonly HTMLElement[], dir: Direction): boolean {
  if (items.length === 0) return false;
  const current = document.activeElement instanceof HTMLElement && items.includes(document.activeElement) ? document.activeElement : null;
  if (!current) {
    items[0]!.focus({ preventScroll: false });
    playSound("hover");
    return true;
  }
  if (current instanceof HTMLInputElement && current.type === "range" && (dir === "left" || dir === "right")) {
    if (dir === "left") current.stepDown();
    else current.stepUp();
    // キーとパッドで一目盛り動かしたら、そこで決まったことにする（音量の欄の試聴など）
    current.dispatchEvent(new Event("input", { bubbles: true }));
    current.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  const from = current.getBoundingClientRect();
  const vertical = dir === "up" || dir === "down";
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    // 向きの側にあるもの（中心がその向きにずれているもの）だけ
    const dx = r.left + r.width / 2 - (from.left + from.width / 2);
    const dy = r.top + r.height / 2 - (from.top + from.height / 2);
    const center = dir === "down" ? dy : dir === "up" ? -dy : dir === "right" ? dx : -dx;
    if (center <= 1) continue;
    // 端どうしの距離（向きの方向）と、横（縦）にどれだけ外れているか（重なっていれば 0）で比べる。
    // 中心どうしで比べると、横に長いつまみのようなものが遠く見えるため
    const main = Math.max(0, dir === "down" ? r.top - from.bottom : dir === "up" ? from.top - r.bottom : dir === "right" ? r.left - from.right : from.left - r.right);
    const gap = vertical ? Math.max(0, r.left - from.right, from.left - r.right) : Math.max(0, r.top - from.bottom, from.top - r.bottom);
    const score = main + gap + center * 0.001;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) return false;
  best.focus();
  best.scrollIntoView({ block: "nearest" });
  playSound("hover");
  return true;
}

/** l3・r3 はスティックを押し込んだとき。 */
export type PadButton = "a" | "b" | "x" | "y" | "lb" | "rb" | "lt" | "rt" | "select" | "start" | "l3" | "r3" | "up" | "down" | "left" | "right";

/** 標準の配置（https://w3c.github.io/gamepad/#remapping）のボタンの番号。 */
const BUTTONS: Record<number, PadButton> = { 0: "a", 1: "b", 2: "x", 3: "y", 4: "lb", 5: "rb", 6: "lt", 7: "rt", 8: "select", 9: "start", 10: "l3", 11: "r3", 12: "up", 13: "down", 14: "left", 15: "right" };
/** スティックを倒したとみなす深さ。 */
const STICK = 0.55;
/** 十字キー・スティックを押し続けたときの、繰り返しの始まりと間隔（ミリ秒）。 */
const REPEAT_DELAY = 380;
const REPEAT_EVERY = 120;

/** 右スティックを倒したとみなす深さ（これより浅いぶれは無視する）。 */
const RIGHT_STICK = 0.2;

export interface GamepadInputOptions {
  /** 右スティックを倒している間、毎フレーム（x・y は -1〜1、dt は前のフレームからのミリ秒）。 */
  onStick?(x: number, y: number, dt: number): void;
  /** 標準の配置（mapping が "standard"）でないゲームパッドをはじめて見たとき（ボタンの番号が合っていないことがある）。 */
  onNonstandard?(id: string): void;
}

/**
 * つないだゲームパッドを毎フレーム読み、ボタンの変化を知らせる。左スティックは十字キーと同じに扱う。
 * 向きのボタンは押し続けると繰り返す（repeat が true）。右スティックは onStick に倒した量を渡す。
 */
export class GamepadInput {
  private frame = 0;
  private readonly held = new Map<PadButton, { since: number; last: number }>();
  /** 標準の配置でないと知らせたゲームパッド（id）。 */
  private readonly warned = new Set<string>();
  private lastFrame = 0;

  constructor(
    private readonly onButton: (button: PadButton, pressed: boolean, repeat: boolean) => void,
    private readonly o: GamepadInputOptions = {},
  ) {
    window.addEventListener("gamepadconnected", () => this.start());
    if (typeof navigator.getGamepads === "function" && [...navigator.getGamepads()].some((p) => p)) this.start();
  }

  private start(): void {
    if (this.frame) return;
    const loop = (now: number) => {
      const pads = [...navigator.getGamepads()].filter((p): p is Gamepad => !!p);
      if (pads.length === 0) {
        this.frame = 0;
        this.lastFrame = 0;
        this.held.clear();
        return;
      }
      const down = new Set<PadButton>();
      let rx = 0;
      let ry = 0;
      for (const pad of pads) {
        if (pad.mapping !== "standard" && !this.warned.has(pad.id)) {
          this.warned.add(pad.id);
          this.o.onNonstandard?.(pad.id);
        }
        pad.buttons.forEach((b, i) => {
          const name = BUTTONS[i];
          if (name && b.pressed) down.add(name);
        });
        const [x = 0, y = 0, x2 = 0, y2 = 0] = pad.axes;
        if (x < -STICK) down.add("left");
        if (x > STICK) down.add("right");
        if (y < -STICK) down.add("up");
        if (y > STICK) down.add("down");
        // 右スティック（標準の配置の 3 本目と 4 本目の軸）
        if (Math.abs(x2) > Math.abs(rx)) rx = x2;
        if (Math.abs(y2) > Math.abs(ry)) ry = y2;
      }
      const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
      this.lastFrame = now;
      if (Math.hypot(rx, ry) > RIGHT_STICK) this.o.onStick?.(rx, ry, dt);
      for (const name of down) {
        const h = this.held.get(name);
        if (!h) {
          this.held.set(name, { since: now, last: now });
          this.onButton(name, true, false);
        } else if ((name === "up" || name === "down" || name === "left" || name === "right") && now - h.since > REPEAT_DELAY && now - h.last > REPEAT_EVERY) {
          h.last = now;
          this.onButton(name, true, true);
        }
      }
      for (const name of [...this.held.keys()]) {
        if (down.has(name)) continue;
        this.held.delete(name);
        this.onButton(name, false, false);
      }
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }
}
