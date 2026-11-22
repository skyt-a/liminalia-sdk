import { parseExpr, type Expr } from "@liminalia/lang";

/**
 * Ink の整数どうしの割り算（`7 / 2` は 3）を .lim の式で同じにする。
 *
 * .lim の `/` はいつも小数の割り算なので、変換した .lim の式の中の割り算のうち、両方が整数と分かるものを `floor(a / b)` にする。
 * 整数かどうかは、数の書き方（`2` と `2.0`）、変数の初期値（VAR）と temp に入れた式、整数を返す関数から決める。
 * どちらかが小数と分かれば小数の割り算のまま。分からなければ小数の割り算のままにして、unknown で知らせる。
 * Ink は 0 の側へ切り捨てる（-7 / 2 は -3）が、floor は小さい側へ切り捨てる（-4）ので、負の数の割り算だけは違う。
 */
export type Kind = "int" | "float" | "string" | "bool" | "unknown";

export interface DivisionResult {
  /** 書き換えた式（割り算が無ければ元のまま）。 */
  expr: string;
  /** 切り捨てにした割り算の数。 */
  truncated: number;
  /** 整数どうしか分からず、小数の割り算のままにした割り算（.lim の式の字面）。 */
  unknown: string[];
}

const FLOAT = "__ink_float";

/** 小数の書き方の数を印の関数で包んで読む（"2.0" は .lim の式では 2 と同じに読まれるため。文字列の中は除く）。読めなければ null。 */
function parseMarked(src: string): Expr | null {
  const marked = mapOutsideStrings(src, (part) => part.replace(/(?<![\p{L}\p{N}_.])(\d+\.\d+)/gu, `${FLOAT}("$1")`));
  try {
    return parseExpr(marked);
  } catch {
    return null;
  }
}

const nameOf = (e: Expr): string | null => {
  if (e.kind === "name") return e.name;
  if (e.kind !== "member") return null;
  const o = nameOf(e.object);
  return o === null ? null : `${o}.${e.property}`;
};

/** 式の値の種類。kindOf は名前（game.x・temp.x・@let の名前）の種類。 */
function kindOfTree(e: Expr, kindOf: (name: string) => Kind): Kind {
  const kind = (x: Expr) => kindOfTree(x, kindOf);
  switch (e.kind) {
    case "literal":
      return typeof e.value === "number" ? (Number.isInteger(e.value) ? "int" : "float") : typeof e.value === "string" ? "string" : typeof e.value === "boolean" ? "bool" : "unknown";
    case "name":
    case "member": {
      const n = nameOf(e);
      return n === null ? "unknown" : kindOf(n);
    }
    case "call":
      if (e.callee === FLOAT) return "float";
      if (["floor", "ceil", "len", "randint", "index"].includes(e.callee)) return "int";
      if (e.callee === "round" || e.callee === "random") return e.args.length === 1 ? "int" : "float";
      if (e.callee === "min" || e.callee === "max") return join(e.args.map(kind));
      if (e.callee === "str" || e.callee === "join") return "string";
      return "unknown";
    case "unary":
      return e.op === "!" ? "bool" : kind(e.operand);
    case "binary":
      if (["==", "!=", "<", "<=", ">", ">=", "&&", "||"].includes(e.op)) return "bool";
      if (e.op === "+" && (kind(e.left) === "string" || kind(e.right) === "string")) return "string";
      return join([kind(e.left), kind(e.right)]);
    case "conditional": {
      const a = kind(e.then);
      return a === kind(e.otherwise) ? a : "unknown";
    }
    default:
      return "unknown";
  }
}

/** .lim の式の値の種類（temp に入れた値の種類を覚えるのに使う）。 */
export function exprKind(src: string, kindOf: (name: string) => Kind): Kind {
  const tree = parseMarked(src);
  return tree === null ? "unknown" : kindOfTree(tree, kindOf);
}

/** 割り算を書き換える。kindOf は名前（game.x・temp.x・@let の名前）の種類。 */
export function truncateIntDivision(src: string, kindOf: (name: string) => Kind): DivisionResult {
  if (!src.includes("/")) return { expr: src, truncated: 0, unknown: [] };
  const tree = parseMarked(src);
  if (tree === null) return { expr: src, truncated: 0, unknown: [] };
  let truncated = 0;
  const unknown: string[] = [];
  const kind = (e: Expr) => kindOfTree(e, kindOf);
  const visit = (e: Expr): Expr => {
    switch (e.kind) {
      case "binary": {
        const left = visit(e.left);
        const right = visit(e.right);
        const out: Expr = { ...e, left, right };
        if (e.op !== "/") return out;
        const k = [kind(left), kind(right)];
        if (k[0] === "int" && k[1] === "int") {
          truncated++;
          return { kind: "call", callee: "floor", args: [out] };
        }
        if (!k.includes("float")) unknown.push(printExpr(out));
        return out;
      }
      case "unary":
        return { ...e, operand: visit(e.operand) };
      case "call":
        return { ...e, args: e.args.map(visit) };
      case "array":
        return { ...e, items: e.items.map(visit) };
      case "member":
        return { ...e, object: visit(e.object) };
      case "index":
        return { ...e, object: visit(e.object), index: visit(e.index) };
      case "conditional":
        return { ...e, test: visit(e.test), then: visit(e.then), otherwise: visit(e.otherwise) };
      default:
        return e;
    }
  };
  const out = visit(tree);
  return { expr: truncated > 0 ? printExpr(out) : src, truncated, unknown };
}

function join(kinds: readonly Kind[]): Kind {
  if (kinds.includes("float")) return "float";
  if (kinds.length > 0 && kinds.every((k) => k === "int")) return "int";
  return "unknown";
}

/** 文字列（"…"）の外だけを f で書き換える。 */
function mapOutsideStrings(src: string, f: (part: string) => string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const q = src.indexOf('"', i);
    if (q < 0) {
      out += f(src.slice(i));
      break;
    }
    out += f(src.slice(i, q));
    let j = q + 1;
    while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
    out += src.slice(q, j + 1);
    i = j + 1;
  }
  return out;
}

const PREC: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };

/** .lim の式の木を字面に（括弧は要るところだけ）。 */
export function printExpr(e: Expr, min = 0): string {
  const wrap = (s: string, p: number) => (p < min ? `(${s})` : s);
  switch (e.kind) {
    case "literal":
      if (typeof e.value === "string") return `"${e.value.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, "\\n")}"`;
      return String(e.value);
    case "name":
      return e.name;
    case "member":
      return `${printExpr(e.object, 8)}.${e.property}`;
    case "index":
      return `${printExpr(e.object, 8)}[${printExpr(e.index)}]`;
    case "call":
      if (e.callee === FLOAT && e.args[0]?.kind === "literal") return String(e.args[0].value);
      return `${e.callee}(${e.args.map((a) => printExpr(a)).join(", ")})`;
    case "array":
      return `[${e.items.map((a) => printExpr(a)).join(", ")}]`;
    case "object":
      return `{${e.entries.map((x) => `${JSON.stringify(x.key)}: ${printExpr(x.value)}`).join(", ")}}`;
    case "unary":
      return wrap(`${e.op}${printExpr(e.operand, 7)}`, 7);
    case "binary": {
      const p = PREC[e.op]!;
      return wrap(`${printExpr(e.left, p)} ${e.op} ${printExpr(e.right, p + 1)}`, p);
    }
    case "conditional":
      return wrap(`${printExpr(e.test, 1)} ? ${printExpr(e.then)} : ${printExpr(e.otherwise)}`, 0.5);
  }
}
