import type { Argument, DiagnosticFix, Literal, Target } from "./ast.ts";
import { ExprError, parseExpr } from "./expr.ts";
import type { CommandSpec } from "./registry.ts";
import type { CastEntry } from "./cast.ts";
import { renamedParam } from "./migrate.ts";

/**
 * 引数を仕様どおりの名前で読む形にする。
 * - 必須の位置引数を埋めたあとの、引用されていない真偽値の名前を name=true として読む。
 * - 前の版の引数の名前（fade=）を今の名前（time=）にする（migrate.ts の RENAMED_PARAMS。検査は renamed-param で知らせる）。
 * - 位置引数を埋めたあとの名前なしの値を、spec.bare の引数として読む（@mask 600ms → time=600ms）。
 */
export function normalizeBooleanArgs(spec: CommandSpec, args: readonly Argument[]): Argument[] {
  let position = 0;
  // time= も書いていれば、二つ目として読む（duplicate-param で知らせる）
  let bare = spec.bare !== undefined && spec.params[spec.bare] !== undefined;
  return args.map((arg) => {
    if (arg.key !== null) {
      const to = renamedParam(spec, arg.key);
      return to === null ? arg : { ...arg, key: to };
    }
    const next = spec.positional[position];
    const param = next === undefined ? undefined : spec.params[next];
    const word = arg.value.kind === "string" && !arg.value.quoted ? arg.value.value : null;
    // 最初の位置引数は省略可能でも名前に使われる（例: @kanim loop）。既存の台本の読み方を保つ。
    // ただし、ほかの引数を書いたので書けない位置引数（@bg color=… の image）や、列挙値にない名前なら真偽値として読む。
    const free = position === 0 && !!param && (args.some((a) => a.key !== null && spec.params[a.key]?.redundantWith?.includes(next!)) || (param.type.kind === "enum" && !param.type.values.includes(word!)));
    const required = param?.required === true || (position === 0 && next !== undefined && !free);
    if (!required && word !== null && Object.hasOwn(spec.params, word) && spec.params[word]!.type.kind === "bool" && !spec.positional.includes(word)) {
      return { ...arg, key: word, value: { kind: "bool", value: true } };
    }
    if (next === undefined && bare) {
      bare = false;
      return { ...arg, key: spec.bare! };
    }
    position++;
    return arg;
  });
}

/** 省略形が、同時に有効な未指定の位置引数にも読める場合。 */
export function booleanShorthandConflicts(spec: CommandSpec, args: readonly Argument[], cast?: Readonly<Record<string, CastEntry>>): { name: string; positional: string; column: number }[] {
  const normalized = normalizeBooleanArgs(spec, args);
  const positionalArgs = normalized.filter((a) => a.key === null);
  const castIndex = spec.positional.findIndex((key) => spec.params[key]?.type.kind === "cast");
  const castValue = castIndex >= 0 ? positionalArgs[castIndex]?.value : undefined;
  const entry = castValue?.kind === "string" ? cast?.[castValue.value] : undefined;
  const conflicts: { name: string; positional: string; column: number }[] = [];
  let position = 0;
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    const resolved = normalized[i]!;
    if (resolved === raw) {
      if (raw.key === null) position++;
      continue;
    }
    const positional = spec.positional[position];
    // 後続の位置引数がその位置を埋めるなら、名前は真偽値にしか読めない。
    if (!positional || position < positionalArgs.length || raw.value.kind !== "string") continue;
    const name = raw.value.value;
    const type = spec.params[positional]?.type;
    // 省略できる最初の位置引数を省略形にするのは、その位置引数に読めないときだけ
    if (!type || (position === 0 && spec.params[positional]?.required !== true)) continue;
    const collides = type.kind === "enum" ? type.values.includes(name)
      : type.kind === "variant" ? !!cast && (!entry || Object.values(entry.appearances).some((a) => name in a.variants))
      : type.kind === "appearance" ? !!cast && (!entry || name in entry.appearances)
      : type.kind === "cast" ? !!cast && name in cast
      : type.kind === "string" || type.kind === "asset" || type.kind === "target" || type.kind === "variable" || type.kind === "position";
    if (collides) conflicts.push({ name, positional, column: raw.column });
  }
  return conflicts;
}

export interface ArgError {
  code: string;
  message: string;
  /** 引数部分の先頭からの位置（0 始まり）。 */
  offset: number;
  /** 省くとエラー。読み方は分かるが直したほうがよいもの（全角の ＝ など）は警告。 */
  severity?: "warning";
  /** 行に当てられる直し方。 */
  fix?: DiagnosticFix;
}

/**
 * 命令の引数部分（`ユイカ serious at=left fade=300ms`）を解析する。
 * 半角の空白とタブで区切るが、"…" と (…) の中では区切らない（整形、lim migrate、VS Code の読み方と同じ）。
 * column は引数部分の先頭の桁（1 始まり）で、Argument.column の基準になる。
 */
export function parseArgs(text: string, column: number): { args: Argument[]; errors: ArgError[] } {
  const args: Argument[] = [];
  const errors: ArgError[] = [];
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
    const token = text.slice(start, i);
    if (quoted) {
      errors.push({ code: "unclosed-string", message: "文字列が閉じていません", offset: start });
      continue;
    }
    if (depth > 0) {
      errors.push({ code: "unclosed-paren", message: "( が閉じていません", offset: start });
      continue;
    }
    let kv = /^([a-z][a-z0-9-]*)=(.*)$/s.exec(token);
    // 日本語入力のまま打った全角の ＝（fade＝300ms）。名前と値は分かるので読み、直し方を付ける
    const wide = kv ? null : /^([a-z][a-z0-9-]*)＝(.*)$/s.exec(token);
    if (wide) {
      errors.push({ code: "fullwidth-symbol", severity: "warning", message: `${wide[1]}＝ の ＝ が全角です（半角の = で書きます）`, offset: start, fix: { kind: "replace", find: `${wide[1]}＝`, with: `${wide[1]}=` } });
      kv = wide;
    }
    const key = kv ? kv[1]! : null;
    const valueText = kv ? kv[2]! : token;
    const valueOffset = start + (kv ? kv[1]!.length + 1 : 0);
    if (valueText === "") {
      errors.push({ code: "missing-value", message: `${key}= のあとに値がありません`, offset: start });
      continue;
    }
    if (valueText.startsWith("(") && valueText.endsWith(")")) {
      const source = valueText.slice(1, -1);
      try {
        args.push({ key, value: { kind: "expr", expr: parseExpr(source), source: source.trim() }, column: column + start, text: token });
      } catch (e) {
        const offset = valueOffset + 1 + (e instanceof ExprError ? e.offset : 0);
        errors.push({ code: "bad-expression", message: e instanceof Error ? e.message : String(e), offset });
      }
      continue;
    }
    args.push({ key, value: parseLiteral(valueText), column: column + start, text: token });
  }
  return { args, errors };
}

/** 命令の値の字面から型を決める。 */
export function parseLiteral(text: string): Literal {
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return { kind: "string", value: text.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c)), quoted: true };
  }
  const d = /^(-?\d+(?:\.\d+)?)(ms|s)$/.exec(text);
  if (d) return { kind: "duration", ms: Number(d[1]) * (d[2] === "s" ? 1000 : 1), source: text };
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return { kind: "number", value: Number(text) };
  if (text === "true" || text === "false") return { kind: "bool", value: text === "true" };
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(text)) return { kind: "color", value: text.toLowerCase() };
  return { kind: "string", value: text, quoted: false };
}

/** 書いた値が既定値（.lim の書き方の文字）と同じ値か（時間は長さで、色は 6 桁にそろえて比べる）。式は比べない。 */
export function sameLiteral(v: Literal, def: string | undefined): boolean {
  if (def === undefined || v.kind === "expr") return false;
  const d = parseLiteral(def);
  if (v.kind === "duration" && d.kind === "duration") return v.ms === d.ms;
  if (v.kind === "color" && d.kind === "color") return longColor(v.value) === longColor(d.value);
  if (v.kind === "string" && d.kind === "string") return v.value === d.value;
  if ((v.kind === "number" && d.kind === "number") || (v.kind === "bool" && d.kind === "bool")) return v.value === d.value;
  return false;
}

/** #abc → #aabbcc（小文字）。 */
function longColor(c: string): string {
  const s = c.toLowerCase();
  return s.length === 4 ? `#${[...s.slice(1)].map((x) => x + x).join("")}` : s;
}

/** 値を .lim の書き方に戻す。 */
export function printLiteral(v: Literal): string {
  switch (v.kind) {
    case "string":
      return v.quoted ? JSON.stringify(v.value) : v.value;
    case "number":
      return String(v.value);
    case "duration":
      return v.source;
    case "bool":
      return String(v.value);
    case "color":
      return v.value;
    case "expr":
      return `(${v.source})`;
  }
}

/**
 * 行の中の、column（Argument.column）から始まる引数の値を value（文字列）に書き換えた行を返す。キー（key=）はそのまま。
 * 空白・" ・( で始まるもの・文字列以外の値に読めるものは "…" で囲む。そこに引数が無いか、expect（今の値）と違えば null。
 */
export function replaceArgumentValue(line: string, column: number, value: string, expect?: string): string | null {
  const start = column - 1;
  if (start < 0 || start >= line.length || line[start] === " " || line[start] === "\t") return null;
  let i = start;
  let quoted = false;
  let depth = 0;
  while (i < line.length && (quoted || depth > 0 || (line[i] !== " " && line[i] !== "\t"))) {
    if (quoted && line[i] === "\\") i++;
    else if (line[i] === '"') quoted = !quoted;
    else if (!quoted && line[i] === "(") depth++;
    else if (!quoted && line[i] === ")") depth--;
    i++;
  }
  const token = line.slice(start, i);
  const kv = /^([a-z][a-z0-9-]*)=/.exec(token);
  if (expect !== undefined) {
    const now = parseLiteral(token.slice(kv ? kv[0].length : 0));
    if (now.kind !== "string" || now.value !== expect) return null;
  }
  const plain = parseLiteral(value);
  const printed = plain.kind === "string" && value !== "" && !/[\s"\\]/.test(value) && !value.startsWith("(") ? value : JSON.stringify(value);
  return line.slice(0, start) + (kv ? kv[0] : "") + printed + line.slice(i);
}

/** 飛び先の字面（`#ラベル`・`ファイル`・`ファイル#ラベル`）を読む。当てはまらなければ null。 */
export function parseTargetText(text: string): Target | null {
  const m = /^([\w./-]*)(?:#([\p{L}\p{N}_-]+))?$/u.exec(text);
  if (!m || (m[1] === "" && m[2] === undefined)) return null;
  return { file: m[1] === "" ? null : m[1]!, label: m[2] ?? null };
}

/** 変数の字面（`game.x` / `system.x.y` / `temp.x`）か。 */
export const VARIABLE_PATH = /^(game|system|temp)(\.[\p{ID_Start}_][\p{ID_Continue}_]*)+$/u;

/** @define の引数を中の式で参照するときの名前（- は _ に替える）。 */
export function paramLocalName(name: string): string {
  return name.replace(/-/g, "_");
}
