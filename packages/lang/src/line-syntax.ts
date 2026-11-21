/**
 * 書きかけの行を読む部品。構文解析器（parse）は書き終えた行を読むので、補完・説明・定義へ移動のために、
 * カーソルの位置で何を書いているかをここで見分ける（VS Code の拡張機能と、Studio のジャンプ先へ移動が使う。goto.ts）。
 */

import { normalizeBooleanArgs, parseLiteral } from "./args.ts";
import type { Argument } from "./ast.ts";
import { opensBody } from "./credits.ts";
import type { CommandSpec } from "./registry.ts";

/** 行がどのブロックの中か。choice は選択肢の行、script は @script の中身。 */
export type Block = "root" | "choice" | "script";

const BLOCKS = new Set(["if", "while", "for", "with", "choice", "define"]);

/** 行頭と行末の字下げ（ASCII の空白とタブ）を除く。全角空白は本文なので残す。 */
export function trimIndent(line: string): string {
  return line.replace(/^[ \t]+/, "").replace(/[ \t\r]+$/, "");
}

export function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)![0].length;
}

/** line 行目（0 始まり）がどのブロックの中か。前の行の @if・@choice・@define・@script・@html と @end を数える（@html の中身は @script と同じく script）。 */
export function blockAt(lines: readonly string[], line: number): Block {
  const stack: string[] = [];
  let script = false;
  for (let i = 0; i < line && i < lines.length; i++) {
    const t = trimIndent(lines[i]!);
    if (script) {
      if (t === "@end") script = false;
      continue;
    }
    if (t === "" || t.startsWith("//")) continue;
    if (stack.at(-1) === "choice" && t !== "@end") continue;
    const m = /^@(\S*)(?:\s+(.*))?$/.exec(t);
    if (!m) continue;
    if (m[1] === "script" || opensBody(m[1]!, m[2] ?? "")) script = true;
    else if (BLOCKS.has(m[1]!)) stack.push(m[1]!);
    else if (m[1] === "end") stack.pop();
  }
  if (script) return "script";
  return stack.at(-1) === "choice" ? "choice" : "root";
}

/** 引数の一つ（`key=value` か位置引数）。位置は行の中の位置（0 始まり）。 */
export interface Token {
  start: number;
  end: number;
  text: string;
  /** key= のある引数の key。 */
  key: string | null;
  /** 値の始まり（key= の後ろ）。 */
  valueStart: number;
}

/**
 * line の from から to までを引数に分ける（@liminalia/lang の parseArgs と同じ区切り方。
 * 空白で区切るが、"…" と (…) の中の空白では区切らない）。
 */
export function tokenize(line: string, from: number, to: number = line.length): Token[] {
  const out: Token[] = [];
  let i = from;
  while (i < to) {
    if (line[i] === " " || line[i] === "\t") {
      i++;
      continue;
    }
    const start = i;
    let quoted = false;
    let depth = 0;
    while (i < to && (quoted || depth > 0 || (line[i] !== " " && line[i] !== "\t"))) {
      if (quoted && line[i] === "\\") i++;
      else if (line[i] === '"') quoted = !quoted;
      else if (!quoted && line[i] === "(") depth++;
      else if (!quoted && line[i] === ")") depth--;
      i++;
    }
    const end = Math.min(i, to);
    const text = line.slice(start, end);
    const kv = /^([a-z][a-z0-9-]*)=/.exec(text);
    out.push({ start, end, text, key: kv ? kv[1]! : null, valueStart: kv ? start + kv[0].length : start });
  }
  return out;
}

/** 命令の書かれている場所（行の命令 `@名前 …` か、本文の中の `{@名前 …}`）。 */
export interface CommandSite {
  name: string;
  /** `@` の位置。 */
  at: number;
  nameStart: number;
  nameEnd: number;
  /** 引数の部分の始まりと終わり。 */
  argsStart: number;
  end: number;
  args: Token[];
  inline: boolean;
}

function siteFrom(line: string, at: number, end: number, inline: boolean): CommandSite {
  const nameStart = at + 1;
  let nameEnd = nameStart;
  while (nameEnd < end && !/\s/.test(line[nameEnd]!)) nameEnd++;
  const argsStart = Math.min(end, nameEnd + 1);
  return { name: line.slice(nameStart, nameEnd), at, nameStart, nameEnd, argsStart, end, args: tokenize(line, argsStart, end), inline };
}

/** 本文の中の `{@…}` を集める。閉じていないものは行末まで。 */
export function inlineCommands(line: string, from = 0): CommandSite[] {
  const out: CommandSite[] = [];
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c !== "{" || line[i + 1] !== "@") continue;
    let j = i + 2;
    let quoted = false;
    let depth = 0;
    while (j < line.length && (quoted || depth > 0 || line[j] !== "}")) {
      if (quoted && line[j] === "\\") j++;
      else if (line[j] === '"') quoted = !quoted;
      else if (!quoted && line[j] === "(") depth++;
      else if (!quoted && line[j] === ")") depth--;
      j++;
    }
    out.push(siteFrom(line, i + 1, Math.min(j, line.length), true));
    i = j;
  }
  return out;
}

/** カーソル（offset）のある命令。行の命令か、本文の中の `{@…}`。 */
export function commandSiteAt(line: string, offset: number, block: Block): CommandSite | null {
  if (block === "script") return null;
  const indent = indentOf(line);
  if (block === "root" && line[indent] === "@") {
    const end = line.replace(/[ \t\r]+$/, "").length;
    return offset >= indent ? siteFrom(line, indent, Math.max(end, offset), false) : null;
  }
  if (block === "root" && (line.startsWith("//", indent) || line[indent] === "#")) return null;
  return inlineCommands(line).find((s) => offset > s.at && offset <= s.end) ?? null;
}

/** 選択肢の行 `- 文 -> 飛び先 key=value…` の飛び先と引数。 */
export interface OptionSite {
  /** ` -> ` の位置。 */
  arrow: number;
  target: Token;
  args: Token[];
}

export function optionSite(line: string): OptionSite | null {
  const indent = indentOf(line);
  if (!line.startsWith("- ", indent) && !(line.slice(indent) === "-")) return null;
  const arrow = line.lastIndexOf(" -> ");
  if (arrow < indent) return null;
  const end = line.replace(/[ \t\r]+$/, "").length;
  let start = arrow + 4;
  while (start < end && line[start] === " ") start++;
  const tokens = tokenize(line, start, end);
  const first = tokens[0];
  const target: Token = first && first.start === start ? { ...first, key: null, valueStart: first.start } : { start, end: start, text: "", key: null, valueStart: start };
  return { arrow, target, args: tokens.slice(target.text === "" ? 0 : 1) };
}

/** offset を含む引数（端も含む）。 */
export function tokenAt(tokens: readonly Token[], offset: number): Token | null {
  return tokens.find((t) => offset >= t.start && offset <= t.end) ?? null;
}

/**
 * 引数をどの引数名に当たるかに直す（位置引数は順に positional の名前）。
 * 値は書いたままの文字列（"…" は外す）。
 * spec を渡すと、検査と実行器と同じ読み方（normalizeBooleanArgs）にする: 前の名前の fade= は今の名前（time）に、
 * 対象を取らない命令の名前なしの時間（@mask 600ms）は bare の名前に、真偽値の省略形（wait）はその名前に当てる。
 */
export function namedArgs(tokens: readonly Token[], positional: readonly string[], spec?: CommandSpec): Map<string, { token: Token; value: string }> {
  const out = new Map<string, { token: Token; value: string }>();
  const names = argNames(tokens, positional, spec);
  tokens.forEach((t, i) => {
    const name = names[i];
    if (name === undefined) return;
    const raw = t.text.slice(t.valueStart - t.start);
    const value = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
    out.set(name, { token: t, value });
  });
  return out;
}

/** 引数ごとの、当たる引数名（namedArgs の読み方。当たらなければ undefined）。 */
export function argNames(tokens: readonly Token[], positional: readonly string[], spec?: CommandSpec): (string | undefined)[] {
  const keys = spec
    ? normalizeBooleanArgs(
        spec,
        tokens.map((t): Argument => ({ key: t.key, value: parseLiteral(t.text.slice(t.valueStart - t.start)), column: t.start + 1 })),
      ).map((a) => a.key)
    : tokens.map((t) => t.key);
  let p = 0;
  return keys.map((key) => key ?? positional[p++]);
}

/** 位置引数として何番目か（key= のない引数を前から数える）。 */
export function positionalIndex(tokens: readonly Token[], token: Token | null, offset: number): number {
  let n = 0;
  for (const t of tokens) {
    if (token ? t === token : t.start >= offset) break;
    if (t.key === null) n++;
  }
  return n;
}
