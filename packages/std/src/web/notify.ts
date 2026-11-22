import type { Value } from "@liminalia/runtime";
import type { Renderer, RenderContext } from "@liminalia/web";

/** 通知（@notify）の描画。積み方・まとめ方・待たせ方はエンジンの RenderContext.notify が受け持つ。 */

const num = (v: Value | undefined, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: Value | undefined, d = ""): string => (typeof v === "string" ? v : d);

function notify(ctx: RenderContext, a: Record<string, Value>): void {
  ctx.notify(str(a.text), {
    kind: str(a.kind, "info"),
    ...(typeof a.title === "string" && a.title !== "" ? { title: a.title } : {}),
    time: num(a.time, 3000),
    delay: num(a.delay, 0),
    ...(typeof a.se === "string" && a.se !== "" ? { se: a.se } : {}),
    max: num(a.max, 3),
    ...(typeof a.key === "string" && a.key !== "" ? { key: a.key } : {}),
    args: a,
  });
}

export const renderers: Record<string, Renderer> = {
  notify: (ctx, a) => notify(ctx, a),
};
