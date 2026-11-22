import type { CommandSpec, ParamSpec } from "@liminalia/lang";
import type { CommandImpl } from "@liminalia/runtime";
import type { CommandDefinition, } from "@liminalia/sdk";

/** 約束（命令の定義の型と t）は @liminalia/sdk にある。ここは定義を仕様と実装にするエンジンの側。 */
export { t, type CommandDefinition, type CommandDiagnostic, type CommandValidateContext, type ParamDefinition } from "@liminalia/sdk";

export function toSpec(c: CommandDefinition): CommandSpec {
  const params: Record<string, ParamSpec> = {};
  for (const [name, p] of Object.entries(c.params)) {
    const spec: ParamSpec = { type: p.type, doc: p.doc };
    if (p.docEn !== undefined) spec.docEn = p.docEn;
    if (p.default !== undefined) spec.default = p.default;
    if (p.required) spec.required = true;
    params[name] = spec;
  }
  const waits = c.waits ?? c.params.wait?.default === "true";
  return { name: c.name, summary: c.summary, ...(c.summaryEn ? { summaryEn: c.summaryEn } : {}), positional: c.positional ?? [], ...(c.bare ? { bare: c.bare } : {}), params, example: c.example, ...(c.exampleEn ? { exampleEn: c.exampleEn } : {}), ...(waits ? { waits } : {}), ...(c.ends ? { ends: true } : {}), ...(c.category ? { category: c.category } : {}), ...(c.keywords?.length ? { keywords: c.keywords } : {}), ...(c.keywordsEn?.length ? { keywordsEn: c.keywordsEn } : {}) };
}

export function toImplementation(c: CommandDefinition): CommandImpl {
  return {
    spec: toSpec(c),
    run: async (args, ctx) => {
      if (c.run) return c.run(args, ctx);
      c.apply?.(args, ctx.state.stage.extra);
      await ctx.present(args, typeof args.wait === "boolean" ? args.wait : (c.waits ?? false));
    },
    ...(c.autoplay ? { autoplay: c.autoplay } : {}),
  };
}
