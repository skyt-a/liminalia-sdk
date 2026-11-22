import type { Value } from "@liminalia/runtime";
import { systemText, type Renderer, type RenderContext } from "@liminalia/web";
import { LEAVE_COLOR } from "../commands/chapter.ts";
import "./chapter.css";

/**
 * 章の扉と章末（@chapter-card・@chapter-end）の描画。メッセージ枠の上（overlay）に画面いっぱいの札を出し、出す、置く、消す。
 * 色と書体はテーマ（--lm-title-bg、--lm-fg、--lm-accent、--lm-text-font）から取るので、テーマを替えると見た目も替わる。
 * leave=mask なら黒へ溶かしてから暗転で覆い（ctx.mask.cover）、札を片付ける。スキップ中は出さず、暗転だけ残す。
 * 出しているあいだはメッセージ枠を隠し、通知などを待たせる（host.coverUi）。片付けはロードのときにエンジンが scope ごと行う。
 * 出したら題（番号、題、副題か終わりの表記）をスクリーンリーダーとテキスト読み上げに渡す（system.announce）。
 */

type Args = Record<string, Value>;
const str = (v: Value | undefined): string => (typeof v === "string" ? v : "");
const num = (v: Value | undefined, d: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : d);


function line(parent: HTMLElement, cls: string, text: string): HTMLElement | null {
  if (text === "") return null;
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  parent.append(el);
  return el;
}

function build(ctx: RenderContext, kind: "card" | "end", a: Args): { root: HTMLDivElement; parts: HTMLElement[]; veil: HTMLDivElement; label: string } {
  const root = document.createElement("div");
  root.className = `lim-chapter lim-chapter--${kind}`;
  root.setAttribute("role", "img");
  const image = str(a.image);
  if (image) {
    const img = document.createElement("img");
    img.className = "lim-chapter-image";
    img.src = ctx.asset("bgimage", image);
    img.alt = "";
    img.draggable = false;
    root.append(img);
  }
  const body = document.createElement("div");
  body.className = "lim-chapter-body";
  root.append(body);
  const number = str(a.number);
  const title = str(a.title);
  const subtitle = str(a.subtitle);
  const parts: (HTMLElement | null)[] = [line(body, "lim-chapter-number", number), line(body, "lim-chapter-title", title)];
  if (kind === "card") {
    if (subtitle) {
      const rule = document.createElement("div");
      rule.className = "lim-chapter-rule";
      body.append(rule);
      parts.push(rule);
    }
    parts.push(line(body, "lim-chapter-subtitle", subtitle));
  } else {
    const end = str(a.text) || systemText().chapter.end;
    parts.push(line(body, "lim-chapter-end", end));
  }
  const label = [number, title, kind === "card" ? subtitle : str(a.text) || systemText().chapter.end].filter(Boolean).join(" ");
  root.setAttribute("aria-label", label);
  const veil = document.createElement("div");
  veil.className = "lim-chapter-veil";
  root.append(veil);
  return { root, parts: parts.filter((p): p is HTMLElement => p !== null), veil, label };
}

async function show(ctx: RenderContext, kind: "card" | "end", a: Args, wait: boolean): Promise<void> {
  const leave = wait && a.leave === "mask";
  // スキップ中は出さない（暗転を残すなら覆うだけ）
  if (ctx.skipping) {
    if (leave) ctx.mask.cover(LEAVE_COLOR);
    return;
  }
  const scope = ctx.scope();
  scope.defer(ctx.host.coverUi());
  const releaseWindow = ctx.window.hide();
  const { root, parts, veil, label } = build(ctx, kind, a);
  scope.add(root);
  ctx.layers.overlay.append(root);
  // 章が変わったことを、目で見ない人にも伝える
  ctx.system?.announce(label);
  const fade = num(a.fade, kind === "card" ? 800 : 1000);
  const time = num(a.time, kind === "card" ? 2500 : 3000);
  const ease = { easing: "ease", fill: "both" as const };
  const done = (anim: Animation) => anim.finished.then(() => undefined).catch(() => undefined);
  // 地を出し、文字を一行ずつ浮かべる
  const jobs = [done(root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ctx.time(fade), ...ease }))];
  parts.forEach((el, i) => {
    const from = { opacity: 0, transform: "translateY(0.4em)" };
    const to = { opacity: 1, transform: "none" };
    jobs.push(done(el.animate([from, to], { duration: ctx.time(fade), delay: ctx.time(fade * 0.4 + i * Math.min(240, fade * 0.3)), ...ease })));
  });
  await Promise.all(jobs);
  if (!scope.disposed) await scope.sleep(time);
  if (scope.disposed) return releaseWindow();
  if (leave) {
    // 黒へ溶かし、暗転で覆ってから片付ける（覆いは次の @mask-off で開く）
    await done(veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ctx.time(fade), ...ease }));
    if (!scope.disposed) ctx.mask.cover(LEAVE_COLOR);
    // 覆っているあいだは前の本文を見せない。次のページで枠を戻す
    const off = ctx.on("page", () => {
      off();
      releaseWindow();
    });
  } else {
    await done(root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ctx.time(fade), ...ease }));
    releaseWindow();
  }
  scope.dispose();
}

const run =
  (kind: "card" | "end"): Renderer =>
  (ctx, a, wait) => {
    const job = show(ctx, kind, a, wait).catch((e: unknown) => console.warn(e));
    return wait ? job : undefined;
  };

export const renderers: Record<string, Renderer> = {
  "chapter-card": run("card"),
  "chapter-end": run("end"),
};
