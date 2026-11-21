import { normalizeBooleanArgs } from "./args.ts";
import type { Argument, Inline, Statement } from "./ast.ts";
import type { CommandSpec, ParamType } from "./registry.ts";

type Define = Extract<Statement, { kind: "define" }>;

/**
 * マクロの人物の引数のうち、表示中の立ち絵の人物に効くもの（型の shown）を、本文から決めて specs に書く（@define の型の書き方は増やさない）。
 * 本文の順で、その引数をそのまま（`(who)`）最初に渡す先が人物の引数で shown なら効く。最初に @chara のような、これから出す人物を受ける引数へ
 * 渡すマクロは、あとで同じ人物を揺らしても効かない（表示していない人物にも使うマクロなので）。式の一部として渡すもの（`(who + "2")`）は数えない。
 * 分岐の中と本文の中の命令（`{@…}`）も、書いた順に見る。ほかのマクロへ渡すときはそのマクロの決め方に従い、決まるまでくり返す。
 * specOf は組み込みとプラグインの命令（同じ名前のマクロがあればマクロが先。実行器と同じ）。制作画面の補完だけが使う（検査と実行には使わない）。
 */
export function markShownCast(defines: ReadonlyMap<string, Define>, specs: Map<string, CommandSpec>, specOf: (name: string) => CommandSpec | undefined): void {
  const lookup = (name: string) => specs.get(name) ?? specOf(name);
  // 効くかは決まっていないものから効くものへしか変わらないので、変わらなくなるまでくり返せば終わる
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, define] of defines) {
      const spec = specs.get(name);
      if (!spec) continue;
      for (const p of define.params) {
        const type = spec.params[p.name]?.type;
        if (type?.kind !== "cast" || type.shown) continue;
        if (firstCastUse(define.body, p.name.replaceAll("-", "_"), lookup)?.shown !== true) continue;
        const now = specs.get(name)!;
        specs.set(name, { ...now, params: { ...now.params, [p.name]: { ...now.params[p.name]!, type: { kind: "cast", shown: true } } } });
        changed = true;
      }
    }
  }
}

/** 本文の順で、名前 param の値をそのまま渡す最初の人物の引数の型（無ければ null）。 */
function firstCastUse(body: readonly Statement[], param: string, specOf: (name: string) => CommandSpec | undefined): Extract<ParamType, { kind: "cast" }> | null {
  const fromArgs = (name: string, args: readonly Argument[]) => {
    const spec = specOf(name);
    if (!spec) return null;
    let position = 0;
    for (const a of normalizeBooleanArgs(spec, args)) {
      const key = a.key ?? spec.positional[position++];
      const type = key === undefined ? undefined : spec.params[key]?.type;
      if (type?.kind === "cast" && a.value.kind === "expr" && a.value.expr.kind === "name" && a.value.expr.name === param) return type;
    }
    return null;
  };
  const inline = (content: readonly Inline[]): Extract<ParamType, { kind: "cast" }> | null => {
    for (const i of content) {
      const found = i.kind === "command" ? fromArgs(i.name, i.args) : "children" in i ? inline(i.children) : null;
      if (found) return found;
    }
    return null;
  };
  for (const s of body) {
    let found: Extract<ParamType, { kind: "cast" }> | null = null;
    if (s.kind === "command") found = fromArgs(s.name, s.args);
    else if (s.kind === "say" || s.kind === "prose") found = inline(s.content);
    else if (s.kind === "if") {
      if (s.with) found = fromArgs(s.with.name, s.with.args);
      for (const b of s.branches) found ??= firstCastUse(b.body, param, specOf);
    }
    if (found) return found;
  }
  return null;
}
