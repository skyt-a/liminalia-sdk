import type { Value } from "@liminalia/runtime";
import type { Renderer, RenderContext } from "@liminalia/web";
import { backingScale } from "./pixels.ts";
import "./manga.css";

/**
 * 漫画的な一回きりの演出（@speedlines・@burst）の描画。どれも ctx.scope() に預けるので、ロードとスキップの始まりにエンジンが片付ける。
 * 待ちは scope.sleep で書き、クリックの早送りで縮む。スキップ中は出さない。
 */

type Args = Record<string, Value>;
const num = (v: Value | undefined, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: Value | undefined, d = ""): string => (typeof v === "string" && v !== "" ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function layerOf(ctx: RenderContext, name: string): HTMLElement {
  return name === "fx" ? ctx.layers.fx : ctx.layers.overlay;
}

function run(wait: boolean, job: Promise<void>): Promise<void> | void {
  const safe = job.catch((e: unknown) => console.warn(e));
  return wait ? safe : undefined;
}

// ---- @speedlines ----

interface Line {
  /** 角度（集中線）か位置（流線。0〜1）。 */
  at: number;
  /** 太さ（集中線は角度の幅、流線は px）。 */
  width: number;
  /** 線の始まり（集中線は中心からの距離の割合、流線は流れの向きの位置の割合）。 */
  from: number;
  length: number;
}

function makeLines(type: string, density: number): Line[] {
  const count = Math.round(type === "focus" ? 60 + 140 * density : 24 + 72 * density);
  return Array.from({ length: count }, () => ({
    at: Math.random(),
    width: type === "focus" ? 0.004 + Math.random() * 0.012 : 1 + Math.random() * 3,
    from: Math.random() * 0.25,
    length: 0.25 + Math.random() * 0.5,
  }));
}

function drawLines(g: CanvasRenderingContext2D, w: number, h: number, type: string, a: Args, lines: Line[], shift: number): void {
  g.clearRect(0, 0, w, h);
  g.fillStyle = str(a.color, "#000000");
  if (type === "focus") {
    const cx = num(a.x, w / 2);
    const cy = num(a.y, h / 2);
    const far = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    const inner = clamp(num(a.inner, 0.35), 0, 0.9) * Math.min(w, h) * 0.5;
    for (const l of lines) {
      const ang = (l.at + shift * 0.003) * Math.PI * 2;
      // 外から中心へ細くなる三角
      const r0 = far;
      const r1 = inner + (far - inner) * l.from * (0.6 + 0.4 * Math.sin(shift + l.at * 40));
      g.beginPath();
      g.moveTo(cx + Math.cos(ang - l.width) * r0, cy + Math.sin(ang - l.width) * r0);
      g.lineTo(cx + Math.cos(ang + l.width) * r0, cy + Math.sin(ang + l.width) * r0);
      g.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      g.closePath();
      g.fill();
    }
    return;
  }
  const dir = str(a.dir, "left");
  const horizontal = dir === "left" || dir === "right";
  const span = horizontal ? w : h;
  const across = horizontal ? h : w;
  for (const l of lines) {
    // 流れの向きへ動かす（shift は 0〜1 を回る）
    const head = ((l.from + shift * (0.9 + l.length)) % 1.6) - 0.3;
    const p0 = (dir === "left" || dir === "up" ? 1 - head : head) * span;
    const len = l.length * span * 0.6;
    const q = l.at * across;
    const start = dir === "left" || dir === "up" ? p0 : p0 - len;
    if (horizontal) g.fillRect(start, q, len, l.width);
    else g.fillRect(q, start, l.width, len);
  }
}

async function speedlines(ctx: RenderContext, a: Args): Promise<void> {
  if (ctx.skipping) return;
  const scope = ctx.scope();
  const type = str(a.type, "focus");
  const canvas = scope.add(document.createElement("canvas"));
  canvas.className = `lim-speedlines lim-speedlines--${type}`;
  const { width: w, height: h } = ctx.screen;
  const scale = backingScale(ctx.stage, w);
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const g = canvas.getContext("2d");
  if (!g) return scope.dispose();
  g.scale(scale, scale);
  layerOf(ctx, str(a.layer, "fx")).append(canvas);
  const lines = makeLines(type, clamp(num(a.density, 0.5), 0, 1));
  const opacity = clamp(num(a.opacity, 0.8), 0, 1);
  const total = Math.max(120, num(a.time, 800));
  drawLines(g, w, h, type, a, lines, 0);
  canvas.style.opacity = "0";
  // 出入りは不透明度。線は 60ms ごとに描き直してちらつかせる
  const fadeMs = Math.min(150, total / 4);
  const appear = canvas.animate([{ opacity: 0 }, { opacity }], { duration: ctx.time(fadeMs), fill: "forwards" });
  let step = 0;
  const tick = () => {
    if (scope.disposed) return;
    step++;
    drawLines(g, w, h, type, a, type === "focus" ? makeLines(type, clamp(num(a.density, 0.5), 0, 1)) : lines, type === "focus" ? step : (step * 60) / total);
    scope.setTimeout(tick, 60);
  };
  scope.setTimeout(tick, 60);
  await appear.finished.catch(() => undefined);
  await scope.sleep(Math.max(0, total - fadeMs * 2));
  if (!scope.disposed) await canvas.animate([{ opacity }, { opacity: 0 }], { duration: ctx.time(fadeMs), fill: "forwards" }).finished.catch(() => undefined);
  scope.dispose();
}

// ---- @burst ----

const SVG_NS = "http://www.w3.org/2000/svg";

/** ギザギザの形（とげの先と谷を交互に。少しずつ長さを揺らす）。 */
function burstPath(spikes: number, size: number): string {
  const r1 = size / 2;
  const r0 = r1 * 0.62;
  const n = Math.max(5, Math.min(40, Math.round(spikes)));
  const points: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? r1 * (0.86 + Math.random() * 0.14) : r0 * (0.9 + Math.random() * 0.15);
    const ang = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    points.push(`${(Math.cos(ang) * r).toFixed(1)},${(Math.sin(ang) * r).toFixed(1)}`);
  }
  return `M${points.join("L")}Z`;
}

async function burst(ctx: RenderContext, a: Args): Promise<void> {
  if (ctx.skipping) return;
  const scope = ctx.scope();
  const size = Math.max(40, num(a.size, 360));
  const root = scope.add(document.createElement("div"));
  root.className = "lim-burst";
  Object.assign(root.style, { left: `${num(a.x, ctx.screen.width / 2)}px`, top: `${num(a.y, ctx.screen.height / 2)}px`, width: `${size}px`, height: `${size}px` });
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `${-size / 2} ${-size / 2} ${size} ${size}`);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", burstPath(num(a.spikes, 14), size * 0.96));
  path.setAttribute("fill", str(a.color, "#ffffff"));
  path.setAttribute("stroke", str(a.edge, "#000000"));
  path.setAttribute("stroke-width", String(Math.max(2, size / 60)));
  path.setAttribute("stroke-linejoin", "miter");
  svg.append(path);
  root.append(svg);
  const text = str(a.text);
  if (text) {
    const label = document.createElement("div");
    label.className = "lim-burst-text";
    label.textContent = text;
    label.style.color = str(a["text-color"], "#000000");
    label.style.fontSize = `${Math.round(size / Math.max(2.2, [...text].length * 0.9))}px`;
    root.append(label);
  }
  const rotate = num(a.rotate, -8);
  layerOf(ctx, str(a.layer, "overlay")).append(root);
  const place = (scale: number, opacity: number) => ({ transform: `translate(-50%, -50%) rotate(${rotate}deg) scale(${scale})`, opacity });
  root.style.transform = place(1, 1).transform;
  // 弾ける（小さく出て大きく膨らみ、少し戻る）
  const pop = [place(0.2, 0), { ...place(1.12, 1), offset: 0.7 }, place(1, 1)];
  await root.animate(pop, { duration: ctx.time(180), easing: "cubic-bezier(0.2, 0.9, 0.3, 1.2)", fill: "forwards" }).finished.catch(() => undefined);
  await scope.sleep(num(a.time, 500));
  if (!scope.disposed) await root.animate([place(1, 1), place(1.08, 0)], { duration: ctx.time(200), easing: "ease-in", fill: "forwards" }).finished.catch(() => undefined);
  scope.dispose();
}

export const renderers: Record<string, Renderer> = {
  speedlines: (ctx, a, wait) => run(wait, speedlines(ctx, a)),
  burst: (ctx, a, wait) => run(wait, burst(ctx, a)),
};
