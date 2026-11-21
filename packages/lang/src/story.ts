import type { Argument, Diagnostic, Expr, Inline, Script, Statement } from "./ast.ts";
import { parseTargetText } from "./args.ts";
import { plainText } from "./inline.ts";
import { STORY_FUNCTIONS, TARGET_FUNCTIONS } from "./registry.ts";

/**
 * 進み具合の関数（visits・read・chosen など。registry.ts の STORY_FUNCTIONS）の呼び出しを台本から集め、
 * 文字列で書いた引数が指すラベル・ファイル・選択肢があるかを確かめる。
 */

/** 式の中の関数の呼び出し（入れ子も）。 */
export function* callsIn(expr: Expr): Generator<Extract<Expr, { kind: "call" }>> {
  switch (expr.kind) {
    case "call":
      yield expr;
      for (const a of expr.args) yield* callsIn(a);
      break;
    case "member":
      yield* callsIn(expr.object);
      break;
    case "index":
      yield* callsIn(expr.object);
      yield* callsIn(expr.index);
      break;
    case "array":
      for (const a of expr.items) yield* callsIn(a);
      break;
    case "object":
      for (const e of expr.entries) yield* callsIn(e.value);
      break;
    case "unary":
      yield* callsIn(expr.operand);
      break;
    case "binary":
      yield* callsIn(expr.left);
      yield* callsIn(expr.right);
      break;
    case "conditional":
      yield* callsIn(expr.test);
      yield* callsIn(expr.then);
      yield* callsIn(expr.otherwise);
      break;
    case "literal":
    case "name":
      break;
  }
}

/** 台本のすべての式（@set・@let・@if・本文の {= …}・コマンドと選択肢の (…)・式のジャンプ先）を行つきで。@script の中は見ない。 */
export function* expressionsIn(body: readonly Statement[]): Generator<{ expr: Expr; line: number }> {
  const args = function* (list: readonly Argument[], line: number) {
    for (const a of list) if (a.value.kind === "expr") yield { expr: a.value.expr, line };
  };
  const inline = function* (content: readonly Inline[], line: number): Generator<{ expr: Expr; line: number }> {
    for (const c of content) {
      if (c.kind === "value") yield { expr: c.expr, line };
      else if (c.kind === "command") yield* args(c.args, line);
      else if ("children" in c) yield* inline(c.children, line);
    }
  };
  for (const s of body) {
    switch (s.kind) {
      case "say":
        if (s.name) yield* inline(s.name, s.line);
        yield* inline(s.content, s.line);
        break;
      case "prose":
        yield* inline(s.content, s.line);
        break;
      case "set":
        yield { expr: s.target, line: s.line };
        yield { expr: s.value, line: s.line };
        break;
      case "let":
        yield { expr: s.value, line: s.line };
        break;
      case "command":
        yield* args(s.args, s.line);
        break;
      case "jump":
      case "call":
        if (s.target.expr) yield { expr: s.target.expr, line: s.line };
        break;
      case "if":
        if (s.each) yield { expr: s.each.list, line: s.line };
        for (const b of s.branches) {
          if (b.condition) yield { expr: b.condition, line: b.line };
          yield* expressionsIn(b.body);
        }
        break;
      case "function":
        yield { expr: s.body, line: s.line };
        break;
      case "return":
        if (s.value) yield { expr: s.value, line: s.line };
        break;
      case "choice":
        if (s.args) yield* args(s.args, s.line);
        for (const o of s.options) {
          yield* inline(o.content, o.line);
          yield* args(o.args, o.line);
          if (o.target.expr) yield { expr: o.target.expr, line: o.line };
        }
        break;
      case "define":
        yield* expressionsIn(s.body);
        break;
      default:
        break;
    }
  }
}

/** 進み具合の関数の呼び出しで、一つ目の引数を文字列で書いたもの。 */
export function storyCalls(script: Script): { callee: string; value: string; line: number }[] {
  const out: { callee: string; value: string; line: number }[] = [];
  for (const { expr, line } of expressionsIn(script.body)) {
    for (const c of callsIn(expr)) {
      const first = c.args[0];
      if (STORY_FUNCTIONS.has(c.callee) && first?.kind === "literal" && typeof first.value === "string") out.push({ callee: c.callee, value: first.value, line });
    }
  }
  return out;
}

/** 台本の選択肢の文（飾りを外したもの。chosen() が比べる文）。 */
export function optionTexts(scripts: Iterable<readonly [string, Script]>): Set<string> {
  const out = new Set<string>();
  const visit = (body: readonly Statement[]) => {
    for (const s of body) {
      if (s.kind === "choice") for (const o of s.options) out.add(plainText(o.content));
      if (s.kind === "if") for (const b of s.branches) visit(b.body);
      if (s.kind === "define") visit(s.body);
    }
  };
  for (const [, script] of scripts) visit(script.body);
  return out;
}

/**
 * 進み具合の関数の引数の検査（プロジェクト単位）。visits・read のジャンプ先の形と、ラベル・ファイルがあるか（labels はファイル → ラベル）、
 * chosen の文がどこかの選択肢にあるか（無ければ警告。いつまでも false になるため）。
 */
export function checkStoryCalls(scripts: ReadonlyMap<string, Script>, labels: ReadonlyMap<string, ReadonlySet<string>>): Diagnostic[] {
  const out: Diagnostic[] = [];
  let options: Set<string> | null = null;
  for (const [file, script] of scripts) {
    for (const c of storyCalls(script)) {
      if (TARGET_FUNCTIONS.has(c.callee)) {
        const t = parseTargetText(c.value.trim());
        if (!t || t.expr) {
          out.push({ severity: "error", code: "bad-arguments", message: `${c.callee}() にはジャンプ先（#ラベル、ファイル、ファイル#ラベル）を渡します: ${JSON.stringify(c.value)}`, file, line: c.line, hint: `${c.callee}("#ラベル")` });
          continue;
        }
        const target = t.file ?? file;
        const own = labels.get(target);
        if (!own) out.push({ severity: "error", code: "unknown-file", message: `ファイル ${target} がありません`, file, line: c.line });
        else if (t.label !== null && !own.has(t.label)) out.push({ severity: "error", code: "unknown-label", message: t.file === null ? `ラベル #${t.label} がこのファイルにありません` : `ラベル #${t.label} が ${t.file} にありません`, file, line: c.line });
      } else if (c.callee === "chosen") {
        options ??= optionTexts(scripts);
        if (!options.has(c.value)) {
          out.push({ severity: "warning", code: "unknown-option", message: `選択肢「${c.value}」はどのシナリオにもありません（chosen() はいつも false になります）`, file, line: c.line, hint: "選択肢の文（ルビは親文字）をそのまま書きます" });
        }
      }
    }
  }
  return out;
}
