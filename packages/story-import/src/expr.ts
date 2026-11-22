import { parseExpr } from "@liminalia/lang";

/**
 * Ink と Yarn Spinner の式を .lim の式にする。
 *
 * - 演算子: and / or / not（Yarn は xor・is・eq・neq・gt・lt・gte・lte も）を && || ! などに、Ink の mod を % に
 * - 変数: env.variable が .lim の変数（game.x・@let の名前）か値を返す
 * - Ink のノット・ステッチの名前と READ_COUNT、Yarn の visited / visited_count は、訪れた回数の変数（env.visits）
 * - 関数: 乱数・切り捨て・切り上げ・四捨五入・最小・最大。ほかの関数とリストの演算は変換しない
 * 変換できなければ env.fail に理由を渡して null を返す。
 */
export interface ExprEnv {
  lang: "ink" | "yarn";
  /** 名前（Ink は識別子、Yarn は $ を除いた名前）→ .lim の式。知らない名前は null。 */
  variable(name: string): string | null;
  /** ノット・ステッチ・ノードの名前 → 訪れた回数の変数。無ければ null。 */
  visits(path: string): string | null;
  fail(message: string): void;
  /**
   * 組み込みに無い関数の呼び出し（Ink の関数、LIST の道具）。args は変換した .lim の式、raw は Ink の字面の引数。
   * 変換した式を返す。扱わない関数なら undefined（変換できないと報告する）。
   */
  call?(name: string, args: string[], raw: string[]): string | undefined;
}

type Tok = { t: "num" | "str" | "id" | "var" | "op" | "divert"; v: string };

const INK_WORDS: Record<string, string> = { and: "&&", or: "||", not: "!", mod: "%" };
const YARN_WORDS: Record<string, string> = { and: "&&", or: "||", not: "!", xor: "!=", is: "==", eq: "==", neq: "!=", gt: ">", lt: "<", gte: ">=", lte: "<=" };
const OPS = ["->", "==", "!=", "<=", ">=", "&&", "||", "!?", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", ",", "?", "^"];

function tokenize(src: string, lang: "ink" | "yarn"): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i))!;
      out.push({ t: "num", v: m[0].startsWith(".") ? `0${m[0]}` : m[0] });
      i += m[0].length;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
          continue;
        }
        s += src[j];
        j++;
      }
      if (j >= src.length) return "文字列が閉じていません";
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (lang === "yarn" && c === "$") {
      const m = /^\$([\p{L}_][\p{L}\p{N}_]*)/u.exec(src.slice(i));
      if (!m) return `変数の名前を読めません: ${src.slice(i, i + 10)}`;
      out.push({ t: "var", v: m[1]! });
      i += m[0].length;
      continue;
    }
    if (/[\p{L}_]/u.test(c)) {
      const m = (lang === "ink" ? /^[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*/u : /^[\p{L}_][\p{L}\p{N}_]*/u).exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) {
      if (c === "=") {
        out.push({ t: "op", v: "==" });
        i++;
        continue;
      }
      return `読めない記号があります: ${c}`;
    }
    if (op === "->") {
      const m = /^->\s*([\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*)/u.exec(src.slice(i));
      if (!m) return "-> の後ろにノットの名前がありません";
      out.push({ t: "divert", v: m[1]! });
      i += m[0].length;
      continue;
    }
    out.push({ t: "op", v: op });
    i += op.length;
  }
  return out;
}

/** 式を変換する。変換できなければ null（理由は env.fail）。 */
export function convertExpr(src: string, env: ExprEnv): string | null {
  const toks = tokenize(src, env.lang);
  if (typeof toks === "string") {
    env.fail(toks);
    return null;
  }
  let failed = false;
  const fail = (m: string) => {
    if (!failed) env.fail(m);
    failed = true;
  };
  const words = env.lang === "ink" ? INK_WORDS : YARN_WORDS;

  /** toks[from, to) を変換する。 */
  const convertRange = (from: number, to: number): string => {
    const parts: string[] = [];
    for (let i = from; i < to; i++) {
      const tk = toks[i]!;
      switch (tk.t) {
        case "num":
          parts.push(tk.v);
          break;
        case "str":
          parts.push(`"${tk.v.replace(/[\\"]/g, (c) => `\\${c}`)}"`);
          break;
        case "var": {
          const v = env.variable(tk.v);
          if (v === null) fail(`変数 $${tk.v} は宣言されていません`);
          parts.push(v ?? "null");
          break;
        }
        case "divert":
          fail(`ジャンプ先を値として使う式（-> ${tk.v}）は変換できません`);
          parts.push("null");
          break;
        case "op":
          if (tk.v === "?" || tk.v === "!?" || tk.v === "^") {
            fail(`リストの演算（${tk.v}）は変換できません`);
            parts.push("==");
          } else parts.push(tk.v);
          break;
        case "id": {
          const lower = tk.v.toLowerCase();
          if (words[lower] && !tk.v.includes(".")) {
            parts.push(words[lower]!);
            break;
          }
          if (lower === "true" || lower === "false" || lower === "null") {
            parts.push(lower);
            break;
          }
          if (toks[i + 1]?.t === "op" && toks[i + 1]!.v === "(") {
            // 関数の呼び出し: 閉じ括弧までの引数を , で分ける
            let depth = 0;
            let j = i + 1;
            const args: [number, number][] = [];
            let start = i + 2;
            for (; j < to; j++) {
              const x = toks[j]!;
              if (x.t === "op" && x.v === "(") depth++;
              else if (x.t === "op" && x.v === ")") {
                depth--;
                if (depth === 0) break;
              } else if (x.t === "op" && x.v === "," && depth === 1) {
                args.push([start, j]);
                start = j + 1;
              }
            }
            if (j >= to) {
              fail("括弧が閉じていません");
              return "null";
            }
            if (start < j) args.push([start, j]);
            parts.push(call(tk.v, args));
            i = j;
            break;
          }
          if (env.lang === "ink") {
            const v = env.variable(tk.v) ?? env.visits(tk.v);
            if (v === null) fail(`${tk.v} は変数でもノットでもありません`);
            parts.push(v ?? "null");
          } else {
            fail(`${tk.v} は読めません（変数は $ で始めます）`);
            parts.push("null");
          }
          break;
        }
      }
    }
    let s = "";
    parts.forEach((p, k) => {
      const prev = parts[k - 1];
      s += k === 0 || prev === "(" || prev === "!" || p === ")" || p === "," ? p : ` ${p}`;
    });
    return s;
  };

  const call = (name: string, args: [number, number][]): string => {
    const a = args.map(([f, t]) => convertRange(f, t));
    const n = env.lang === "ink" ? name : name.toLowerCase();
    const need = (k: number) => {
      if (a.length !== k) fail(`${name} の引数の数が違います`);
    };
    switch (n) {
      case "RANDOM":
      case "random_range":
        need(2);
        return `(${a[0]} + random(${a[1]} - (${a[0]}) + 1))`;
      case "random":
        if (env.lang === "yarn") {
          need(0);
          return "random()";
        }
        break;
      case "dice":
        need(1);
        return `(random(${a[0]}) + 1)`;
      case "INT":
      case "FLOOR":
      case "floor":
      case "int":
        need(1);
        return `floor(${a[0]})`;
      case "CEILING":
      case "ceil":
        need(1);
        return `ceil(${a[0]})`;
      case "round":
        need(1);
        return `round(${a[0]})`;
      case "FLOAT":
        // 1.0 を掛けて小数と分かる形にする（整数どうしの割り算の切り捨て（int-division.ts）から外すため）
        need(1);
        return `(${a[0]} * 1.0)`;
      case "MIN":
        need(2);
        return `min(${a.join(", ")})`;
      case "MAX":
        need(2);
        return `max(${a.join(", ")})`;
      case "READ_COUNT": {
        const [f] = args[0] ?? [0, 0];
        const tk = toks[f];
        if (args.length !== 1 || tk?.t !== "divert") break;
        const v = env.visits(tk.v);
        if (v === null) fail(`${tk.v} はノットではありません`);
        return v ?? "null";
      }
      case "visited":
      case "visited_count": {
        const [f, t] = args[0] ?? [0, 0];
        const tk = toks[f];
        if (args.length !== 1 || t - f !== 1 || tk?.t !== "str") break;
        const v = env.visits(tk.v);
        if (v === null) {
          fail(`ノード ${tk.v} がありません`);
          return "null";
        }
        return n === "visited" ? `(${v} > 0)` : v;
      }
    }
    const hooked = env.call?.(name, a, args.map(([f, t]) => toks.slice(f, t).map((x) => (x.t === "str" ? JSON.stringify(x.v) : x.t === "divert" ? `-> ${x.v}` : x.v)).join(" ")));
    if (hooked !== undefined) return hooked;
    fail(`関数 ${name}() は変換できません`);
    return "null";
  };

  const out = convertRange(0, toks.length);
  if (failed) return null;
  try {
    parseExpr(out);
  } catch (e) {
    env.fail(`変換した式を読めません: ${out}（${e instanceof Error ? e.message : String(e)}）`);
    return null;
  }
  return out;
}
