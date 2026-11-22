import type { StageState, Value } from "@liminalia/runtime";
import { uiSpace } from "@liminalia/lang";
import type { Renderer, RenderContext, Restorer } from "@liminalia/web";
import { readParticles, type Particles } from "../commands/particles.ts";
import { backingScale } from "./pixels.ts";

/**
 * パーティクルの描画。名前ごとにキャンバスを一枚置き、一つの requestAnimationFrame でまとめて動かす。
 * 出すときは画面いっぱいに散らした状態から始める（空から降り始めるのを待たない。ロードしたときも同じ）。
 */

/** キャンバスの大きさ（文字と枠の座標で測った舞台の大きさ。1920×1080 の作品も 1280×720 に描いて伸ばすので、粒の大きさは画面に対して変わらない）。 */
let W = 1280;
let H = 720;

interface Look {
  count: number;
  /** 落ちる速さ（px/秒）の幅。負なら上へ昇る。 */
  fall: [number, number];
  wind: number;
  /** 大きさ（px）の幅。 */
  size: [number, number];
  color: string;
  /** 横の揺れの幅（px）。 */
  sway: number;
  /** 回るか。 */
  spin: boolean;
  /** 明滅するか。 */
  twinkle: boolean;
  draw: "streak" | "dot" | "petal" | "glow";
}

const LOOKS: Record<Particles["preset"], Look> = {
  rain: { count: 220, fall: [900, 1300], wind: -120, size: [16, 30], color: "rgba(200, 212, 232, 0.55)", sway: 0, spin: false, twinkle: false, draw: "streak" },
  snow: { count: 150, fall: [40, 110], wind: 12, size: [1.5, 4.5], color: "rgba(255, 255, 255, 0.9)", sway: 26, spin: false, twinkle: false, draw: "dot" },
  sakura: { count: 55, fall: [50, 105], wind: 40, size: [7, 12], color: "rgba(250, 196, 214, 0.92)", sway: 40, spin: true, twinkle: false, draw: "petal" },
  sparkle: { count: 60, fall: [-30, -8], wind: 0, size: [1.5, 3.5], color: "rgba(255, 244, 210, 1)", sway: 14, spin: false, twinkle: true, draw: "glow" },
  dust: { count: 90, fall: [-6, 10], wind: 6, size: [0.8, 2.2], color: "rgba(255, 250, 235, 0.55)", sway: 18, spin: false, twinkle: true, draw: "dot" },
};

interface Grain {
  x: number;
  y: number;
  vy: number;
  size: number;
  phase: number;
  rot: number;
  spin: number;
}

interface Emitter {
  name: string;
  config: Particles;
  look: Look;
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  grains: Grain[];
  image: HTMLImageElement | null;
  /** 消えていく途中なら、消え終わる時刻。 */
  dying: number | null;
  /** 描く細かさ（ゲーム画面の 1px あたりのキャンバスの画素。pixels.ts）と、次に見直すまでのコマ数。 */
  scale: number;
  recheck: number;
}

const emitters = new Map<string, Emitter>();
let frame = 0;
let last = 0;

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function layerOf(ctx: RenderContext, layer: Particles["layer"]): HTMLElement {
  if (layer === "back") {
    let el = ctx.camera.querySelector<HTMLDivElement>(":scope > .lim-particles-back");
    if (!el) {
      el = document.createElement("div");
      el.className = "lim-particles-back";
      Object.assign(el.style, { position: "absolute", inset: "0", pointerEvents: "none" });
      ctx.layers.background.after(el);
    }
    return el;
  }
  return layer === "front" ? ctx.layers.images : ctx.layers.fx;
}

function grain(look: Look, cfg: Particles, anywhere: boolean): Grain {
  const size = rand(look.size[0], look.size[1]) * cfg.size;
  const vy = rand(look.fall[0], look.fall[1]) * cfg.speed;
  return {
    x: rand(-40, W + 40),
    y: anywhere ? rand(-20, H + 20) : vy >= 0 ? rand(-60, -10) : rand(H + 10, H + 60),
    vy,
    size,
    phase: rand(0, Math.PI * 2),
    rot: rand(0, Math.PI * 2),
    spin: look.spin ? rand(-2.5, 2.5) : 0,
  };
}

function start(ctx: RenderContext, name: string, cfg: Particles, fadeMs: number): void {
  stopNow(name);
  const look = LOOKS[cfg.preset] ?? LOOKS.snow;
  ({ width: W, height: H } = uiSpace(ctx.screen));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.className = "lim-particles";
  canvas.dataset.name = name;
  Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", opacity: String(cfg.opacity / 100) });
  layerOf(ctx, cfg.layer).append(canvas);
  const count = cfg.count > 0 ? cfg.count : look.count;
  const e: Emitter = { name, config: cfg, look, canvas, g: canvas.getContext("2d")!, grains: Array.from({ length: count }, () => grain(look, cfg, true)), image: null, dying: null, scale: 1, recheck: 0 };
  if (cfg.image) {
    const img = new Image();
    img.src = ctx.asset("image", cfg.image);
    img.onload = () => (e.image = img);
  }
  emitters.set(name, e);
  if (fadeMs > 0) canvas.animate([{ opacity: 0 }, { opacity: cfg.opacity / 100 }], { duration: fadeMs, easing: "ease-out" });
  if (!frame) {
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }
}

function stop(name: string, fadeMs: number): void {
  const e = emitters.get(name);
  if (!e) return;
  if (fadeMs <= 0) return stopNow(name);
  e.dying = performance.now() + fadeMs;
  e.canvas.animate([{ opacity: e.config.opacity / 100 }, { opacity: 0 }], { duration: fadeMs, easing: "ease-in", fill: "forwards" });
}

function stopNow(name: string): void {
  const e = emitters.get(name);
  if (!e) return;
  e.canvas.remove();
  emitters.delete(name);
}

function tick(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const e of [...emitters.values()]) {
    if (e.dying !== null && now >= e.dying) {
      stopNow(e.name);
      continue;
    }
    // 舞台から外れた（ロードで作り直した）キャンバスは手放す
    if (!e.canvas.isConnected) {
      emitters.delete(e.name);
      continue;
    }
    step(e, dt, now / 1000);
  }
  frame = emitters.size > 0 ? requestAnimationFrame(tick) : 0;
}

function step(e: Emitter, dt: number, t: number): void {
  const { g, look, config: cfg } = e;
  // 表示される大きさに合わせて描く細かさを決める（ときどき見直す。高解像度の画面でぼやけない）
  if (--e.recheck <= 0) {
    e.recheck = 60;
    const k = backingScale(e.canvas, W);
    if (k !== e.scale || e.canvas.width !== Math.round(W * k)) {
      e.scale = k;
      e.canvas.width = Math.round(W * k);
      e.canvas.height = Math.round(H * k);
    }
    g.setTransform(k, 0, 0, k, 0, 0);
  }
  const wind = (cfg.wind ?? look.wind) * cfg.speed;
  g.clearRect(0, 0, W, H);
  g.fillStyle = g.strokeStyle = cfg.color || look.color;
  for (const p of e.grains) {
    p.y += p.vy * dt;
    p.x += wind * dt + (look.sway ? Math.sin(t * 1.3 + p.phase) * look.sway * dt : 0);
    p.rot += p.spin * dt;
    // 画面の外へ出たら反対側から入れ直す
    if ((p.vy >= 0 && p.y > H + 40) || (p.vy < 0 && p.y < -40) || p.x < -80 || p.x > W + 80) {
      const fresh = grain(look, cfg, false);
      if (p.x < -80) fresh.x = W + 40;
      else if (p.x > W + 80) fresh.x = -40;
      Object.assign(p, fresh);
    }
    g.globalAlpha = look.twinkle ? 0.35 + 0.65 * Math.abs(Math.sin(t * 1.7 + p.phase)) : 1;
    if (e.image) {
      const s = p.size * 3;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      g.drawImage(e.image, -s / 2, -s / 2, s, s);
      g.restore();
      continue;
    }
    switch (look.draw) {
      case "streak": {
        const len = p.size;
        const dx = (wind / Math.max(1, p.vy)) * len;
        g.lineWidth = 1.2 * cfg.size;
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(p.x - dx, p.y - len);
        g.stroke();
        break;
      }
      case "dot":
        g.beginPath();
        g.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        g.fill();
        break;
      case "petal":
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.scale(1, 0.55 + 0.45 * Math.abs(Math.sin(t * 2 + p.phase)));
        g.beginPath();
        g.ellipse(0, 0, p.size, p.size * 0.6, 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
        break;
      case "glow": {
        const r = p.size * 4;
        const grad = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        grad.addColorStop(0, cfg.color || look.color);
        grad.addColorStop(1, "rgba(255, 255, 255, 0)");
        g.fillStyle = grad;
        g.beginPath();
        g.arc(p.x, p.y, r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = cfg.color || look.color;
        break;
      }
    }
  }
  g.globalAlpha = 1;
}

const num = (v: Value | undefined, d: number) => (typeof v === "number" ? v : d);

export const renderers: Record<string, Renderer> = {
  particles: (ctx, a, _wait, stage) => {
    const name = typeof a.name === "string" ? a.name : String(a.preset ?? "snow");
    const cfg = readParticles(stage.extra)[name];
    if (cfg) start(ctx, name, cfg, ctx.time(num(a.time, 500)));
  },
  "particles-off": (ctx, a) => {
    const fade = ctx.time(num(a.time, 500));
    for (const name of typeof a.name === "string" ? [a.name] : [...emitters.keys()]) stop(name, fade);
  },
};

/** ロード時は、状態にあるものだけを散らした状態から出し直す。 */
export const restorers: Restorer[] = [
  (ctx: RenderContext, stage: StageState) => {
    for (const name of [...emitters.keys()]) stopNow(name);
    for (const [name, cfg] of Object.entries(readParticles(stage.extra))) start(ctx, name, cfg, 0);
  },
];
