import type { BinaryOp, Expr } from "./ast.ts";

/**
 * 式言語。JavaScript の部分集合に見えるが、評価はエンジンが行い、
 * 暗黙の型変換をしない（== は型も比較する）。代入は @set / @let でだけ行う。
 */

export class ExprError extends Error {
  constructor(
    message: string,
    /** 式の先頭からの位置（0 始まり）。 */
    readonly offset: number,
  ) {
    super(message);
  }
}

type Token =
  | { t: "num"; v: number; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "id"; v: string; at: number }
  | { t: "op"; v: string; at: number }
  | { t: "eof"; at: number };

const OPERATORS = ["&&", "||", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "!", "?", ":", ".", ",", "(", ")", "[", "]", "{", "}"];
const ID_START = /[\p{ID_Start}_]/u;
const ID_CONTINUE = /[\p{ID_Continue}_]/u;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = String.fromCodePoint(src.codePointAt(i)!);
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      tokens.push({ t: "num", v: Number(m[0]), at: i });
      i += m[0].length;
      continue;
    }
    if (c === '"') {
      const start = i;
      let value = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new ExprError("文字列が閉じていません", start);
        const d = src[i]!;
        if (d === '"') break;
        if (d === "\\") {
          const e = src[i + 1];
          if (e === undefined) throw new ExprError("文字列が閉じていません", start);
          value += e === "n" ? "\n" : e;
          i += 2;
          continue;
        }
        value += d;
        i++;
      }
      i++;
      tokens.push({ t: "str", v: value, at: start });
      continue;
    }
    if (c === "'") throw new ExprError("文字列は \"…\" で書きます", i);
    if (ID_START.test(c)) {
      const start = i;
      let id = "";
      for (const ch of src.slice(i)) {
        if (!ID_CONTINUE.test(ch)) break;
        id += ch;
      }
      i += id.length;
      tokens.push({ t: "id", v: id, at: start });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) {
      if (src.startsWith("=", i)) throw new ExprError("比較は == で書きます（代入は @set で行います）", i);
      throw new ExprError(`式に使えない文字があります: ${c}`, i);
    }
    tokens.push({ t: "op", v: op, at: i });
    i += op.length;
  }
  tokens.push({ t: "eof", at: src.length });
  return tokens;
}

const BINARY: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

export function parseExpr(src: string): Expr {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos]!;
  const next = () => tokens[pos++]!;
  const isOp = (v: string) => {
    const t = peek();
    return t.t === "op" && t.v === v;
  };
  const expect = (v: string) => {
    const t = next();
    if (t.t !== "op" || t.v !== v) throw new ExprError(`${v} が必要です`, t.at);
  };

  const primary = (): Expr => {
    const t = next();
    switch (t.t) {
      case "num":
        return { kind: "literal", value: t.v };
      case "str":
        return { kind: "literal", value: t.v };
      case "id":
        if (t.v === "true" || t.v === "false") return { kind: "literal", value: t.v === "true" };
        if (t.v === "null") return { kind: "literal", value: null };
        if (isOp("(")) {
          next();
          const args: Expr[] = [];
          if (!isOp(")")) {
            do args.push(conditional());
            while (isOp(",") && next());
          }
          expect(")");
          return { kind: "call", callee: t.v, args };
        }
        return { kind: "name", name: t.v };
      case "op":
        if (t.v === "(") {
          const inner = conditional();
          expect(")");
          return inner;
        }
        if (t.v === "[") {
          const items: Expr[] = [];
          if (!isOp("]")) {
            do items.push(conditional());
            while (isOp(",") && next());
          }
          expect("]");
          return { kind: "array", items };
        }
        if (t.v === "{") {
          // 辞書のリテラル。キーは "文字列" か名前（{"a": 1, b: 2}）
          const entries: { key: string; value: Expr }[] = [];
          if (!isOp("}")) {
            do {
              const k = next();
              if (k.t !== "str" && k.t !== "id") throw new ExprError("辞書のキーは \"文字列\" か名前で書きます", k.at);
              if (entries.some((e) => e.key === k.v)) throw new ExprError(`辞書のキー ${k.v} が二回あります`, k.at);
              expect(":");
              entries.push({ key: k.v, value: conditional() });
            } while (isOp(",") && next());
          }
          expect("}");
          return { kind: "object", entries };
        }
        if (t.v === "!" || t.v === "-") return { kind: "unary", op: t.v, operand: postfix(primary()) };
        throw new ExprError(`ここに ${t.v} は置けません`, t.at);
      case "eof":
        throw new ExprError("式が途中で終わっています", t.at);
    }
  };

  const postfix = (expr: Expr): Expr => {
    for (;;) {
      if (isOp(".")) {
        next();
        const t = next();
        if (t.t !== "id") throw new ExprError(". のあとに名前が必要です", t.at);
        expr = { kind: "member", object: expr, property: t.v };
      } else if (isOp("[")) {
        next();
        const index = conditional();
        expect("]");
        expr = { kind: "index", object: expr, index };
      } else {
        return expr;
      }
    }
  };

  const binary = (minPrec: number): Expr => {
    let left = postfix(primary());
    for (;;) {
      const t = peek();
      const prec = t.t === "op" ? BINARY[t.v] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      next();
      const right = binary(prec + 1);
      left = { kind: "binary", op: (t as { v: string }).v as BinaryOp, left, right };
    }
  };

  const conditional = (): Expr => {
    const test = binary(1);
    if (!isOp("?")) return test;
    next();
    const then = conditional();
    expect(":");
    const otherwise = conditional();
    return { kind: "conditional", test, then, otherwise };
  };

  const result = conditional();
  const rest = peek();
  if (rest.t !== "eof") throw new ExprError("式のあとに余分なものがあります", rest.at);
  return result;
}

/** 式のすぐ下の式（たどる処理を一か所にまとめるため）。 */
export function childExprs(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "literal":
    case "name":
      return [];
    case "array":
      return expr.items;
    case "object":
      return expr.entries.map((e) => e.value);
    case "member":
      return [expr.object];
    case "index":
      return [expr.object, expr.index];
    case "call":
      return expr.args;
    case "unary":
      return [expr.operand];
    case "binary":
      return [expr.left, expr.right];
    case "conditional":
      return [expr.test, expr.then, expr.otherwise];
  }
}

/** 式の中で使われている変数の根（game / system / temp / 局所変数名）を集める。 */
export function rootNames(expr: Expr, out = new Set<string>()): Set<string> {
  switch (expr.kind) {
    case "name":
      out.add(expr.name);
      break;
    case "member":
      rootNames(expr.object, out);
      break;
    case "index":
      rootNames(expr.object, out);
      rootNames(expr.index, out);
      break;
    case "call":
      for (const a of expr.args) rootNames(a, out);
      break;
    case "array":
      for (const a of expr.items) rootNames(a, out);
      break;
    case "object":
      for (const e of expr.entries) rootNames(e.value, out);
      break;
    case "unary":
      rootNames(expr.operand, out);
      break;
    case "binary":
      rootNames(expr.left, out);
      rootNames(expr.right, out);
      break;
    case "conditional":
      rootNames(expr.test, out);
      rootNames(expr.then, out);
      rootNames(expr.otherwise, out);
      break;
    case "literal":
      break;
  }
  return out;
}

/** 変数の名前、メンバー、添字のキーにできない名前（JavaScript のオブジェクトのプロトタイプに届くもの）。 */
export const FORBIDDEN_PROPERTIES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** 式の中の FORBIDDEN_PROPERTIES の名前（変数の名前、.メンバー、文字列の添字）。 */
export function forbiddenProperties(expr: Expr, out = new Set<string>()): Set<string> {
  switch (expr.kind) {
    case "name":
      if (FORBIDDEN_PROPERTIES.has(expr.name)) out.add(expr.name);
      break;
    case "member":
      if (FORBIDDEN_PROPERTIES.has(expr.property)) out.add(expr.property);
      forbiddenProperties(expr.object, out);
      break;
    case "index":
      if (expr.index.kind === "literal" && typeof expr.index.value === "string" && FORBIDDEN_PROPERTIES.has(expr.index.value)) out.add(expr.index.value);
      forbiddenProperties(expr.object, out);
      forbiddenProperties(expr.index, out);
      break;
    case "call":
      for (const a of expr.args) forbiddenProperties(a, out);
      break;
    case "array":
      for (const a of expr.items) forbiddenProperties(a, out);
      break;
    case "object":
      for (const e of expr.entries) {
        if (FORBIDDEN_PROPERTIES.has(e.key)) out.add(e.key);
        forbiddenProperties(e.value, out);
      }
      break;
    case "unary":
      forbiddenProperties(expr.operand, out);
      break;
    case "binary":
      forbiddenProperties(expr.left, out);
      forbiddenProperties(expr.right, out);
      break;
    case "conditional":
      forbiddenProperties(expr.test, out);
      forbiddenProperties(expr.then, out);
      forbiddenProperties(expr.otherwise, out);
      break;
    case "literal":
      break;
  }
  return out;
}

/** 前後に空白を置く二項の演算子と、条件式の ? と :。 */
const SPACED = new Set(["&&", "||", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "?", ":"]);

/**
 * 式の空白を整える（lim fmt）。二項の演算子と条件式の ? : の前後を空白一つに、「,」の後ろを空白一つに、括弧の内側と
 * 単項の - ! の後ろと「.」の前後は空白なしにする。文字列と数の書き方は変えない。読めない式と、整えると読み方が変わるもの
 * （整えた前と後の構文木が違うもの）はそのまま返す。
 */
export function formatExpr(src: string): string {
  let tokens: Token[];
  try {
    tokens = tokenize(src);
  } catch {
    return src;
  }
  let out = "";
  /** 次の字句の前に空白を置くか（前が二項の演算子か「,」）。 */
  let spaceNext = false;
  let prev: Token | null = null;
  for (let k = 0; k < tokens.length - 1; k++) {
    const tok = tokens[k]!;
    const text = src.slice(tok.at, tokens[k + 1]!.at).replace(/[ \t]+$/, "");
    if (tok.t === "op") {
      const prefix = prev === null || (prev.t === "op" && prev.v !== ")" && prev.v !== "]");
      if (tok.v === "!" || (tok.v === "-" && prefix)) {
        out += (spaceNext ? " " : "") + text;
        spaceNext = false;
      } else if (SPACED.has(tok.v)) {
        out += ` ${text}`;
        spaceNext = true;
      } else if (tok.v === ",") {
        out += text;
        spaceNext = true;
      } else if (tok.v === "(" || tok.v === "[") {
        out += (spaceNext ? " " : "") + text;
        spaceNext = false;
      } else {
        // ) ] .
        out += text;
        spaceNext = false;
      }
    } else {
      out += (spaceNext ? " " : "") + text;
      spaceNext = false;
    }
    prev = tok;
  }
  out = out.trim();
  if (out === src.trim()) return src;
  try {
    return JSON.stringify(parseExpr(out)) === JSON.stringify(parseExpr(src)) ? out : src;
  } catch {
    return src;
  }
}
