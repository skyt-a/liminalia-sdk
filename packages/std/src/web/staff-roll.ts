import type { Value } from "@liminalia/runtime";
import type { Renderer, RenderContext } from "@liminalia/web";
import { parseCredits, type CreditLine } from "@liminalia/lang";
import "./staff-roll.css";

/**
 * スタッフロールの描画。画面いっぱいの層に中身を縦に並べ、画面の下から上へ time の時間で流す（Element.animate なので、
 * クリックの早送りで終わりまで進む。skip=false の命令は早送りしない）。スキップ中は流さずに進む。
 */
async function linesOf(ctx: RenderContext, a: Record<string, Value>): Promise<CreditLine[]> {
  if (Array.isArray(a.lines)) return a.lines as unknown as CreditLine[];
  if (typeof a.file !== "string" || a.file === "") return [];
  try {
    const data = await ctx.loadData(a.file);
    if (Array.isArray(data)) return parseCredits(data.map((v) => (typeof v === "string" ? v : "")));
    console.warn(`スタッフロールの ${a.file} は文字列の配列ではありません`);
  } catch (e) {
    console.warn(`スタッフロールの ${a.file} を読み込めません`, e);
  }
  return [];
}

export async function staffRoll(ctx: RenderContext, a: Record<string, Value>): Promise<void> {
  // leave=mask は流し終えたところで暗転を残す（スキップ中は流さずに覆うだけ）
  const leave = a.leave === "mask";
  if (ctx.skipping) {
    if (leave) ctx.mask.cover("#000000");
    return;
  }
  const lines = await linesOf(ctx, a);
  const layer = document.createElement("div");
  layer.className = "lim-staffroll";
  if (typeof a.bg === "string" && a.bg !== "") layer.style.background = a.bg;
  const roll = document.createElement("div");
  roll.className = "lim-staffroll-body";
  for (const line of lines) {
    if (line.kind === "gap") {
      roll.append(Object.assign(document.createElement("div"), { className: "lim-staffroll-gap" }));
    } else if (line.kind === "image") {
      const img = document.createElement("img");
      img.className = "lim-staffroll-image";
      img.src = ctx.asset("image", line.path);
      if (line.height !== undefined) img.style.height = `${line.height}px`;
      roll.append(img);
    } else {
      const el = document.createElement("div");
      el.className = line.kind === "heading" ? "lim-staffroll-heading" : "lim-staffroll-line";
      el.textContent = line.text;
      roll.append(el);
    }
  }
  layer.append(roll);
  ctx.layers.overlay.append(layer);
  // 画像の大きさが決まってから高さを測る
  await Promise.all(
    [...roll.querySelectorAll("img")].map((img) =>
      img.complete
        ? null
        : new Promise((r) => {
            img.addEventListener("load", r, { once: true });
            img.addEventListener("error", r, { once: true });
          }),
    ),
  );
  const height = ctx.screen.height;
  const total = roll.offsetHeight;
  const fade = ctx.time(typeof a.fade === "number" ? a.fade : 1000);
  const time = ctx.time(typeof a.time === "number" ? a.time : 60_000);
  await ctx.fade(layer, 1, fade);
  await roll.animate([{ transform: `translateY(${height}px)` }, { transform: `translateY(${-total}px)` }], { duration: Math.max(1, time), easing: "linear", fill: "forwards" }).finished.catch(() => undefined);
  if (leave) {
    // 黒へ溶かしてから暗転で覆う（次の @mask-off で開く）
    const veil = Object.assign(document.createElement("div"), { className: "lim-staffroll-veil" });
    Object.assign(veil.style, { position: "absolute", inset: "0", background: "#000000", opacity: "0" });
    layer.append(veil);
    await ctx.fade(veil, 1, fade);
    ctx.mask.cover("#000000");
  } else await ctx.fade(layer, 0, fade);
  layer.remove();
}

export const renderers: Record<string, Renderer> = {
  "staff-roll": (ctx, a) => staffRoll(ctx, a),
};
