import { normalizeBooleanArgs, parseArgs, parseLiteral, type CommandSpec, type Literal, type ParamType } from "@liminalia/lang";

/**
 * 命令の行を、札のフォームで変えた値で書き直す。
 * 既定値と同じ値は書かない。位置引数は仕様の順に前へ、ほかは `key=value` で、もとからあった順を保ち、新しいものは仕様の順で後ろへ足す。
 * 仕様に無い引数はそのまま残す（書いた人の字面を壊さない）。
 */

/** 引数名 → 新しい値の字面（.lim の書き方）。null は消す。 */
export type ArgEdits = Readonly<Record<string, string | null>>;

/** フォームに入れた値を、.lim の値の字面にする。空なら null（書かない）。 */
export function formatValue(type: ParamType, input: string): string | null {
  const v = input.trim();
  if (v === "") return null;
  // 式はそのまま。
  if (v.startsWith("(") && v.endsWith(")")) return v;
  switch (type.kind) {
    case "duration":
      return /^\d+(\.\d+)?$/.test(v) ? `${v}ms` : v;
    case "number":
    case "int":
    case "bool":
    case "color":
      return v;
    default:
      return /[\s"(){}]/.test(v) || (v.startsWith("#") && type.kind !== "target") ? JSON.stringify(v) : v;
  }
}

/** 二つの値が同じ意味か（1s と 1000ms など）。 */
export function sameValue(a: string, b: string): boolean {
  return literalKey(parseLiteral(a)) === literalKey(parseLiteral(b));
}

function literalKey(v: Literal): string {
  switch (v.kind) {
    case "duration":
      return `d:${v.ms}`;
    case "number":
      return `n:${v.value}`;
    case "string":
      return `s:${v.value}`;
    case "bool":
      return `b:${v.value}`;
    case "color":
      return `c:${v.value.toLowerCase()}`;
    case "expr":
      return `e:${v.source}`;
  }
}

interface Token {
  key: string | null;
  text: string;
  value: Literal;
}

/** 引数の字面を、もとの字面のまま区切る。 */
function tokens(argsText: string, spec: CommandSpec): Token[] {
  const { args } = parseArgs(argsText, 1);
  const normalized = normalizeBooleanArgs(spec, args);
  return args.map((a, i) => {
    const start = a.column - 1;
    const end = i + 1 < args.length ? args[i + 1]!.column - 1 : argsText.length;
    const raw = argsText.slice(start, end).trim();
    const resolved = normalized[i]!;
    // 名前だけで書いた真偽値（wait）は true。名前なしの時間（@mask 600ms）と前の名前（fade=）は書いた値のまま
    const shorthand = a.key === null && resolved.key !== null && resolved.value !== a.value;
    return { key: resolved.key, text: shorthand ? "true" : a.key === null ? raw : raw.slice(a.key.length + 1), value: resolved.value };
  });
}

/** 命令の字面（`show アカリ smile at=left`）を書き直す。 */
export function rewriteCommand(source: string, spec: CommandSpec, edits: ArgEdits): string {
  const m = /^@?([a-z][a-z0-9-]*)(?:\s+(.*))?$/s.exec(source.trim());
  if (!m) return source;
  const name = m[1]!;
  const given = tokens(m[2] ?? "", spec);

  // 今の値を引数名で持つ（位置引数は仕様の名前に）。
  const positional = new Map<string, string>();
  const keyed: { key: string; text: string }[] = [];
  const extraPositional: string[] = [];
  let position = 0;
  for (const t of given) {
    if (t.key === null) {
      const p = spec.positional[position++];
      if (p === undefined) extraPositional.push(t.text);
      else positional.set(p, t.text);
    } else keyed.push({ key: t.key, text: t.text });
  }

  for (const [param, value] of Object.entries(edits)) {
    const isPositional = spec.positional.includes(param);
    const def = spec.params[param]?.default;
    const drop = value === null || (def !== undefined && sameValue(value, def));
    if (isPositional) {
      if (drop && !spec.params[param]?.required) positional.delete(param);
      else if (value !== null) positional.set(param, value);
      continue;
    }
    const at = keyed.findIndex((k) => k.key === param);
    if (drop) {
      if (at >= 0) keyed.splice(at, 1);
    } else if (at >= 0) keyed[at] = { key: param, text: value! };
    else keyed.push({ key: param, text: value! });
  }

  // 新しく足した引数は仕様の順に並べる（もとからあったものの順は変えない）。
  const original = new Set(given.filter((t) => t.key !== null).map((t) => t.key!));
  const order = Object.keys(spec.params);
  const kept = keyed.filter((k) => original.has(k.key));
  const added = keyed.filter((k) => !original.has(k.key)).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  const parts: string[] = [];
  for (const p of spec.positional) {
    const v = positional.get(p);
    if (v === undefined) break;
    parts.push(v);
  }
  parts.push(...extraPositional);
  for (const k of [...kept, ...added]) parts.push(`${k.key}=${k.text}`);
  return [name, ...parts].join(" ");
}

/** 行（字下げごと）の命令を書き直す。 */
export function rewriteCommandLine(line: string, spec: CommandSpec, edits: ArgEdits): string {
  const indent = /^[ \t]*/.exec(line)![0];
  return `${indent}@${rewriteCommand(line.slice(indent.length).replace(/^@/, ""), spec, edits)}`;
}

/** 本文の中の `{@…}`。from・to は `{` と `}` を含む範囲（行の中の 0 始まりの位置）、source は @ の後ろ。 */
export interface InlineCommand {
  from: number;
  to: number;
  source: string;
}

/** 本文の行の中の `{@…}` を探す（\ のエスケープと、"…"・(…) の中の } を飛ばす）。 */
export function findInlineCommands(text: string): InlineCommand[] {
  const out: InlineCommand[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c !== "{" || text[i + 1] !== "@") continue;
    let j = i + 2;
    let quoted = false;
    let depth = 0;
    while (j < text.length && (quoted || depth > 0 || text[j] !== "}")) {
      if (quoted && text[j] === "\\") j++;
      else if (text[j] === '"') quoted = !quoted;
      else if (!quoted && text[j] === "(") depth++;
      else if (!quoted && text[j] === ")") depth--;
      j++;
    }
    if (j >= text.length) break;
    out.push({ from: i, to: j + 1, source: text.slice(i + 2, j) });
    i = j;
  }
  return out;
}

/** フォームに出す今の値（引数名 → 字面。文字列は引用符を外す）。 */
export function currentValues(source: string, spec: CommandSpec): Map<string, { text: string; literal: Literal }> {
  const m = /^@?([a-z][a-z0-9-]*)(?:\s+(.*))?$/s.exec(source.trim());
  const out = new Map<string, { text: string; literal: Literal }>();
  if (!m) return out;
  let position = 0;
  for (const t of tokens(m[2] ?? "", spec)) {
    const name = t.key ?? spec.positional[position++];
    if (name === undefined || out.has(name)) continue;
    out.set(name, { text: t.value.kind === "string" ? t.value.value : t.text, literal: t.value });
  }
  return out;
}
