import type { Expr } from "./ast.ts";

/** 試す組み合わせの数の上限（これを超えるときは確かめられないものとする）。 */
const MAX_CASES = 4096;

/** 比べたどの値とも違う値（変数に入っていうる「ほかの値」。真とみなす）。 */
const OTHER = Symbol("other");
type Atom = string | number | boolean | null | typeof OTHER;

/**
 * 選択肢の条件（if=）のどれかが必ず真になるか。変数をそのまま真偽に使うか、文字・数・真偽と == / != で比べ、
 * !・&&・|| でつないだ条件だけを扱い、変数の値のありうる組み合わせをすべて試す。
 * true・false とだけ比べる変数（とそのまま真偽に使う変数）は真か偽のどちらか、ほかの変数は比べた値・未設定（null）・それ以外のどれかとみなす。
 * 扱えない式があるとき・組み合わせが多すぎるときは false（確かめられない）。
 */
export function someConditionAlwaysTrue(conditions: readonly Expr[]): boolean {
  const compared = new Map<string, Set<Atom>>();
  for (const c of conditions) if (!collect(c, compared)) return false;
  const paths = [...compared.keys()];
  const domains = paths.map((p) => {
    const values = [...compared.get(p)!];
    if (values.every((v) => typeof v === "boolean")) return [true, false] as Atom[];
    return [...new Set<Atom>([...values, null, OTHER])];
  });
  if (domains.reduce((n, d) => n * d.length, 1) > MAX_CASES) return false;

  const env = new Map<string, Atom>();
  const tryAll = (i: number): boolean => {
    if (i === paths.length) return conditions.some((c) => truthy(evaluate(c, env)));
    for (const v of domains[i]!) {
      env.set(paths[i]!, v);
      if (!tryAll(i + 1)) return false;
    }
    return true;
  };
  return tryAll(0);
}

/** 変数の道筋（game.a.b）。変数でなければ null。 */
function pathOf(e: Expr): string | null {
  if (e.kind === "name") return e.name;
  if (e.kind === "member") {
    const o = pathOf(e.object);
    return o === null ? null : `${o}.${e.property}`;
  }
  return null;
}

/** 扱える式か確かめながら、変数と比べる値を集める。 */
function collect(e: Expr, compared: Map<string, Set<Atom>>): boolean {
  const note = (path: string, v?: Atom) => {
    const set = compared.get(path) ?? new Set<Atom>();
    if (v !== undefined) set.add(v);
    compared.set(path, set);
  };
  const path = pathOf(e);
  if (path !== null) {
    // そのまま真偽に使う変数は、真か偽かだけを見る
    note(path, true);
    note(path, false);
    return true;
  }
  switch (e.kind) {
    case "literal":
      return true;
    case "unary":
      return e.op === "!" && collect(e.operand, compared);
    case "binary":
      if (e.op === "&&" || e.op === "||") return collect(e.left, compared) && collect(e.right, compared);
      if (e.op === "==" || e.op === "!=") {
        const [p, lit] = pathOf(e.left) !== null ? [pathOf(e.left), e.right] : [pathOf(e.right), e.left];
        if (p === null || lit.kind !== "literal") return false;
        note(p, lit.value);
        return true;
      }
      return false;
    default:
      return false;
  }
}

function evaluate(e: Expr, env: Map<string, Atom>): Atom {
  const path = pathOf(e);
  if (path !== null) return env.get(path) ?? null;
  switch (e.kind) {
    case "literal":
      return e.value;
    case "unary":
      return !truthy(evaluate(e.operand, env));
    case "binary": {
      if (e.op === "&&") {
        const a = evaluate(e.left, env);
        return truthy(a) ? evaluate(e.right, env) : a;
      }
      if (e.op === "||") {
        const a = evaluate(e.left, env);
        return truthy(a) ? a : evaluate(e.right, env);
      }
      const same = evaluate(e.left, env) === evaluate(e.right, env);
      return e.op === "==" ? same : !same;
    }
    default:
      return OTHER;
  }
}

function truthy(v: Atom): boolean {
  return !(v === false || v === null || v === 0 || v === "");
}
