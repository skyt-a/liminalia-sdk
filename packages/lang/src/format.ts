import { normalizeBooleanArgs, parseArgs, parseLiteral, printLiteral } from "./args.ts";
import type { Argument } from "./ast.ts";
import { opensBody } from "./credits.ts";
import { formatExpr } from "./expr.ts";
import { parse } from "./parser.ts";
import { splitBom } from "./encoding.ts";
import type { Registry } from "./registry.ts";

export interface FormatOptions {
  /** 命令の引数の並びを決める（名前付きの引数を、命令の定義の順に並べる）。無ければ並べ替えない。 */
  registry?: Registry;
  speakers?: readonly string[];
  /**
   * 行頭の字下げ。数ならブロック（@if・@while・@with・@choice・@define）の深さ一つにつき、その数の空白、"tab" ならタブ一つ。
   * 省くと字下げは変えない（liminalia.json の fmt.indent）。
   */
  indent?: number | "tab";
  /** false なら式の空白を整えない（前の lim fmt の動き。liminalia.json の fmt.expressions）。省くと整える。 */
  expressions?: boolean;
}

/** 式の空白を整える関数（整えないなら、そのまま返す）。 */
type ExprFormatter = (src: string) => string;
const keepExpr: ExprFormatter = (src) => src;

/** 字下げの一段（変えないなら null）。 */
export function indentUnit(indent: unknown): string | null {
  if (indent === "tab") return "\t";
  return typeof indent === "number" && Number.isInteger(indent) && indent >= 0 && indent <= 8 ? " ".repeat(indent) : null;
}

/** 中の行を一段深くするブロックの命令（@end で閉じる）。 */
const BLOCKS = new Set(["if", "while", "with", "choice", "define"]);

export type FormatResult = { ok: true; text: string; changed: boolean } | { ok: false; reason: string };

/** 引数を一つずつ区切る（空白で区切り、"…" と (…) の中では区切らない。parseArgs と同じ）。 */
function tokens(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === " " || text[i] === "\t") {
      i++;
      continue;
    }
    const start = i;
    let quoted = false;
    let depth = 0;
    while (i < text.length && (quoted || depth > 0 || (text[i] !== " " && text[i] !== "\t"))) {
      if (quoted && text[i] === "\\") i++;
      else if (text[i] === '"') quoted = !quoted;
      else if (!quoted && text[i] === "(") depth++;
      else if (!quoted && text[i] === ")") depth--;
      i++;
    }
    out.push(text.slice(start, i));
  }
  return out;
}

const KEY = /^([a-z][a-z0-9-]*)=/;

/** `(式)` と `名前=(式)` の引数の式の空白を整える。 */
function formatExprToken(token: string, fx: ExprFormatter): string {
  const kv = KEY.exec(token);
  const key = kv ? kv[0] : "";
  const value = token.slice(key.length);
  if (!value.startsWith("(") || !value.endsWith(")")) return token;
  return `${key}(${fx(value.slice(1, -1))})`;
}

/** 外しても同じ文字列に読める "…" を外す（空白・"・\・( を含むもの、数や真偽などに読めるもの、key= に見えるものは外さない）。 */
function unquote(token: string): string {
  const kv = KEY.exec(token);
  const key = kv ? kv[0] : "";
  const value = token.slice(key.length);
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return token;
  const literal = parseLiteral(value);
  if (literal.kind !== "string") return token;
  const s = literal.value;
  if (s === "" || /[\s"\\(){}]/.test(s) || s.startsWith("//") || (!kv && KEY.test(s))) return token;
  const parsed = parseArgs(key + s, 1);
  const bare = parsed.args[0];
  const singleArg = parsed.errors.length === 0 && parsed.args.length === 1;
  const sameKey = bare?.key === (kv?.[1] ?? null);
  const sameValue = bare?.value.kind === "string" && bare.value.value === s;
  return singleArg && sameKey && sameValue ? key + s : token;
}

function sameArgument(a: Argument, b: Argument): boolean {
  if (a.key !== b.key || a.value.kind !== b.value.kind) return false;
  if (a.value.kind === "string" && b.value.kind === "string") return a.value.value === b.value.value;
  return printLiteral(a.value) === printLiteral(b.value);
}

/** 命令の引数を整える: 区切りを空白一つに、要らない "…" を外し、名前付きの引数を定義の順に並べる（同じ名前が二度あれば並べない）。 */
function formatArgs(name: string, text: string, registry: Registry | undefined, fx: ExprFormatter): string {
  const spec = registry?.get(name);
  const tokenList = tokens(text);
  const parsed = parseArgs(text, 1);
  const original = parsed.args;
  const aligned = parsed.errors.length === 0 && original.length === tokenList.length && original.every((arg, i) => arg.text === tokenList[i]);
  const normalized = spec ? normalizeBooleanArgs(spec, original) : original;
  const list = tokenList.map((token, i) => {
    const candidate = unquote(token);
    if (!aligned) return formatExprToken(token, fx);
    if (!spec || candidate === token) return formatExprToken(candidate, fx);
    const args = [...original];
    args[i] = parseArgs(candidate, 1).args[0]!;
    const same = normalizeBooleanArgs(spec, args).every((arg, j) => sameArgument(arg, normalized[j]!));
    if (same) original[i] = args[i]!;
    return formatExprToken(same ? candidate : token, fx);
  });
  if (!spec) return list.join(" ");
  const order = Object.keys(spec.params);
  const keyOf = (t: string) => KEY.exec(t)?.[1] ?? null;
  const keys = list.map(keyOf).filter((k): k is string => k !== null);
  if (new Set(keys).size !== keys.length) return list.join(" ");
  const positional = list.filter((t) => keyOf(t) === null);
  const named = list.filter((t) => keyOf(t) !== null);
  const rank = (t: string) => {
    const r = order.indexOf(keyOf(t)!);
    return r < 0 ? order.length : r;
  };
  // 定義に無い名前は元の並びのまま最後に
  const sorted = named.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i);
  return [...positional, ...sorted.map((x) => x.t)].join(" ");
}

/**
 * .lim の命令の行を整える（lim fmt）。本文・台詞の行は中身を変えない（行末の空白を消し、indent を決めたときは字下げだけそろえる）。
 * - 命令: 名前と引数の間・引数どうしの区切りを空白一つに、要らない "…" を外し、名前付きの引数を定義の順に
 * - 式（@if・@elif・@while の条件、@set・@let の値、`(式)` の引数）: 演算子の前後を空白一つに（expr.ts の formatExpr）
 * - 選択肢: `-> ` から後ろの飛び先と引数を命令と同じように
 * - ラベル・注釈: 行末の空白を消す
 * - 字下げ: indent を決めたときは、ブロックの深さにそろえる（決めなければ変えない）。@script・@html の中は一切変えない
 * 構文の誤りがあるファイルは整えない（どこが命令かを取り違えないため）。整えた結果は、整える前と同じ構文木になる。
 */
export function formatLim(source: string, file: string, options: FormatOptions = {}): FormatResult {
  const parsed = parse(source, file, options.speakers ? { speakers: options.speakers } : {});
  const errors = parsed.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) return { ok: false, reason: `構文エラーがあります（${errors[0]!.line} 行目: ${errors[0]!.message}）` };

  // 頭の BOM は外して整え、書くときに頭に戻す（1 行目の命令も整える）
  const { bom, text: body } = splitBom(source);
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const rows = body.split(/\r?\n/);
  const out: string[] = [];
  const unit = indentUnit(options.indent);
  const fx = options.expressions === false ? keepExpr : formatExpr;
  /** 開いているブロック（@choice の中は選択肢の行）。 */
  const blocks: string[] = [];
  /** その行の字下げ（決めていなければ元のまま）。back はブロックを閉じる・枝を替える行（一段浅く）。 */
  const indentOf = (original: string, back = false) => (unit === null ? original : unit.repeat(Math.max(0, blocks.length - (back ? 1 : 0))));
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]!;
    const indent = /^[ \t]*/.exec(raw)![0];
    const line = raw.slice(indent.length).replace(/[ \t]+$/, "");
    if (line === "") {
      out.push("");
      continue;
    }
    if (blocks.at(-1) === "choice" && line !== "@end" && !line.startsWith("//")) {
      out.push(indentOf(indent) + formatOption(line, fx));
      continue;
    }
    if (!line.startsWith("@")) {
      out.push(indentOf(indent) + line);
      continue;
    }
    const m = /^@(\S*)(?:\s+(.*))?$/u.exec(line)!;
    const name = m[1]!;
    const rest = (m[2] ?? "").trim();
    if (name === "script" || opensBody(name, rest)) {
      // @end だけの行まで、そのまま写す（@html と @staff-roll は引数の行だけ整える）
      const at = indentOf(indent);
      out.push(at + (name === "script" ? "@script" : formatCommand(name, rest, options.registry, fx)));
      let j = i + 1;
      for (; j < rows.length && rows[j]!.trim() !== "@end"; j++) out.push(rows[j]!);
      if (j < rows.length) out.push(unit === null ? rows[j]!.replace(/[ \t]+$/, "") : `${at}@end`);
      i = j;
      continue;
    }
    if (name === "end") {
      out.push(indentOf(indent, true) + "@end");
      blocks.pop();
      continue;
    }
    if (name === "elif" || name === "else") {
      out.push(indentOf(indent, true) + formatCommand(name, rest, options.registry, fx));
      continue;
    }
    out.push(indentOf(indent) + formatCommand(name, rest, options.registry, fx));
    if (BLOCKS.has(name)) blocks.push(name);
  }
  const text = bom + out.join(newline);
  return { ok: true, text, changed: text !== source };
}

function formatCommand(name: string, rest: string, registry: Registry | undefined, fx: ExprFormatter): string {
  if (rest === "") return `@${name}`;
  switch (name) {
    case "if":
    case "elif":
    case "while":
    case "return":
      // 条件と戻り値の式の空白を整える
      return `@${name} ${fx(rest)}`;
    case "for":
    case "function":
    case "define":
    case "use":
      return `@${name} ${rest}`;
    case "with": {
      // @with マクロ パラメータ… はマクロの呼び出しと同じに整える
      const m = /^(\S+)(?:\s+(.*))?$/.exec(rest)!;
      return m[2] ? `@with ${m[1]} ${formatArgs(m[1]!, m[2], registry, fx)}` : `@with ${m[1]}`;
    }
    case "set": {
      const s = /^(.+?)\s*(\+=|-=|\*=|\/=|=)\s*(.*)$/.exec(rest)!;
      return `@set ${fx(s[1]!)} ${s[2]} ${fx(s[3]!)}`;
    }
    case "let": {
      const l = /^(\S+?)\s*([+\-*/]?=)\s*(.*)$/u.exec(rest)!;
      return `@let ${l[1]} ${l[2]} ${fx(l[3]!)}`;
    }
    case "jump":
    case "call":
      return `@${name} ${tokens(rest).map(unquote).map((t) => formatExprToken(t, fx)).join(" ")}`;
    default:
      return `@${name} ${formatArgs(name, rest, registry, fx)}`;
  }
}

/** `- 表示する文 -> 飛び先 引数…`。表示する文は変えない。 */
function formatOption(line: string, fx: ExprFormatter): string {
  const arrow = line.lastIndexOf(" -> ");
  if (arrow < 0) return line;
  return `${line.slice(0, arrow)} -> ${tokens(line.slice(arrow + 4)).map(unquote).map((t) => formatExprToken(t, fx)).join(" ")}`;
}
