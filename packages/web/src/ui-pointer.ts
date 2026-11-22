import type { UiConfig } from "@liminalia/lang";

/**
 * マウスと指の見た目（liminalia.json の ui.cursor.animated と ui.tap）。
 * - 動くカーソル: OS のカーソルは GIF・APNG を動かさないので、画像を舞台の一番上に描いてマウスに付いて動かし、OS のカーソルは隠す。
 *   指で触る操作では出さない。舞台の外へ出たら隠す
 * - 押した（触れた）ところの演出: 画像を出して少し広げながら消し、効果音を鳴らす
 * 舞台は作品の画面の大きさを拡大・縮小して置いているので、画面の座標を舞台の座標に直して置く。
 */
export interface UiPointerTargets {
  stage: HTMLElement;
  asset(kind: "image", path: string): string;
  /** 効果音を一回鳴らす（sound からのパス）。 */
  playSe(file: string): void;
}

const TAP_TIME = 400;

export class UiPointer {
  private cursor: HTMLImageElement | null = null;
  private hot = { x: 0, y: 0 };
  private tap: NonNullable<UiConfig["tap"]> | null = null;

  constructor(private readonly t: UiPointerTargets) {
    const stage = t.stage;
    stage.addEventListener("pointermove", (e) => this.move(e));
    stage.addEventListener("pointerdown", (e) => {
      this.move(e);
      this.pressed(e);
    });
    stage.addEventListener("pointerleave", () => {
      if (this.cursor) this.cursor.hidden = true;
    });
  }

  set(ui: UiConfig | undefined): void {
    const c = ui?.cursor;
    if (c?.image && c.animated) {
      if (!this.cursor) {
        this.cursor = document.createElement("img");
        this.cursor.className = "lm-soft-cursor";
        this.cursor.alt = "";
        this.cursor.hidden = true;
        this.t.stage.append(this.cursor);
      }
      this.cursor.src = this.t.asset("image", c.image);
      this.hot = { x: c.x ?? 0, y: c.y ?? 0 };
    } else {
      this.cursor?.remove();
      this.cursor = null;
    }
    this.t.stage.classList.toggle("lm-cursor-hidden", this.cursor !== null);
    this.tap = ui?.tap && (ui.tap.image || ui.tap.se) ? ui.tap : null;
  }

  /** 画面の座標を舞台の座標に直す。 */
  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.t.stage.getBoundingClientRect();
    const scale = r.width / (this.t.stage.offsetWidth || 1);
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  }

  private move(e: PointerEvent): void {
    const c = this.cursor;
    if (!c) return;
    if (e.pointerType === "touch") {
      c.hidden = true;
      return;
    }
    const p = this.local(e);
    c.hidden = false;
    c.style.transform = `translate(${p.x - this.hot.x}px, ${p.y - this.hot.y}px)`;
  }

  private pressed(e: PointerEvent): void {
    const tap = this.tap;
    if (!tap || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (tap.se) this.t.playSe(tap.se);
    if (!tap.image) return;
    const p = this.local(e);
    const img = document.createElement("img");
    img.className = "lm-tap";
    img.alt = "";
    img.src = this.t.asset("image", tap.image);
    if (tap.size) img.style.width = `${tap.size}px`;
    img.style.left = `${p.x}px`;
    img.style.top = `${p.y}px`;
    this.t.stage.append(img);
    const time = tap.time ?? TAP_TIME;
    const anim = img.animate(
      [
        { opacity: 1, transform: "translate(-50%, -50%) scale(0.6)" },
        { opacity: 0, transform: "translate(-50%, -50%) scale(1.15)" },
      ],
      { duration: time, easing: "ease-out", fill: "forwards" },
    );
    anim.onfinish = () => img.remove();
    // 止められた（制作画面の舞台を止めた）ときも残さない
    setTimeout(() => img.remove(), time + 1000);
  }
}
