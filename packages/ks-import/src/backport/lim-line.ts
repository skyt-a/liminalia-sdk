import { normalizeBooleanArgs, opensBody, parseArgs, parseInline, printInline, speakerWithName, speechOpenAt, splitLineId, takeGuard, type Argument, type Inline, type Literal, type Registry } from "@liminalia/lang";

/**
 * 書き戻しで扱う .lim の一行。構文木（parse）は行の対応を落とすものがあるので、行ごとに読む。
 * ブロック（@if・@choice・@script・@html・@define）の対応はファイル全体を前から読んで決める（readLimLines）。
 */
export type LimLine =
  | { kind: "blank" }
  | { kind: "comment"; text: string }
  | { kind: "label"; name: string }
  /** name は台詞の {name …} の中身（この行だけの名前欄の名前。.ks には戻せない）。 */
  | { kind: "text"; speaker: string; name?: string; body: string; content: Inline[] }
  /** cond は行の if=(式) の式（.ks の cond= に書き戻す）。 */
  | { kind: "command"; name: string; rest: string; args: Argument[]; cond?: string }
  | { kind: "set"; rest: string; cond?: string }
  | { kind: "jump"; name: "jump" | "call"; target: string; cond?: string }
  | { kind: "if" | "elif"; expr: string }
  | { kind: "else" }
  | { kind: "end"; closes: Block | null }
  | { kind: "choice" }
  | { kind: "option"; body: string; content: Inline[]; target: string; args: Argument[] }
  /** @script の行（open）と、その中の行（@html の中の行も）。 */
  | { kind: "script"; code: string; open?: true }
  | { kind: "define"; text: string }
  | { kind: "use"; file: string };

/**
 * 閉じるブロック。while・with・body（@staff-roll の中身）は TyranoScript に無いので、書き戻しは戻せない箇所として知らせる
 * （@staff-roll の中身の行はコメントとして読む）。
 */
type Block = "if" | "choice" | "script" | "html" | "define" | "while" | "for" | "with" | "body";

/** ファイル全体を行ごとに読む。話者は台詞の行を見分けるのに使う（parse と同じく長い名前を先に試す）。 */
export function readLimLines(source: string, speakers: Iterable<string>): LimLine[] {
  const names = [...speakers].sort((a, b) => b.length - a.length);
  const rows = source.replace(/\n$/, "").split("\n");
  const out: LimLine[] = [];
  const stack: Block[] = [];
  for (const raw of rows) {
    let line = raw.replace(/\r$/, "").replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    const top = stack.at(-1);
    if (top === "body") {
      if (line === "@end") {
        stack.pop();
        out.push({ kind: "end", closes: top });
      } else out.push({ kind: "comment", text: raw });
      continue;
    }
    if (top === "script" || top === "html") {
      if (line === "@end") {
        stack.pop();
        out.push({ kind: "end", closes: top });
      } else out.push({ kind: "script", code: raw });
      continue;
    }
    if (line === "") {
      out.push({ kind: "blank" });
      continue;
    }
    if (top === "define" && line !== "@end") {
      out.push({ kind: "define", text: raw });
      continue;
    }
    if (line.startsWith("//")) {
      out.push({ kind: "comment", text: line.slice(2) });
      continue;
    }
    if (top === "choice" && line !== "@end") {
      // 行の終わりの固定の行 ID（#line:ID）は訳とボイスの鍵で、.ks には戻さない
      out.push(readOption(withoutLineId(line)) ?? { kind: "comment", text: line });
      continue;
    }
    if (line.startsWith("# ")) {
      out.push({ kind: "label", name: line.slice(2).trim() });
      continue;
    }
    const m = /^@([a-z][a-z0-9-]*)(?: (.*))?$/.exec(line);
    if (m) {
      const name = m[1]!;
      let rest = (m[2] ?? "").trim();
      // 行の if=(式)（偽なら飛ばす）は、.ks の cond= にする。ブロックを開く言葉には書けない（構文の誤り）
      const g = ["if", "elif", "else", "end", "while", "for", "with", "choice", "define", "function", "script", "use"].includes(name) ? null : takeGuard(rest);
      const cond = g ? { cond: g.source.trim() } : {};
      if (g) rest = `${rest.slice(0, g.at)}${rest.slice(g.end)}`.replace(/\s+/g, " ").trim();
      switch (name) {
        case "if":
          stack.push("if");
          out.push({ kind: "if", expr: rest });
          continue;
        case "while":
        case "for":
        case "with":
          stack.push(name);
          out.push({ kind: "command", name, rest, args: [] });
          continue;
        case "elif":
          out.push({ kind: "elif", expr: rest });
          continue;
        case "else":
          out.push({ kind: "else" });
          continue;
        case "end":
          out.push({ kind: "end", closes: stack.pop() ?? null });
          continue;
        case "choice":
          stack.push("choice");
          out.push({ kind: "choice" });
          continue;
        case "script":
          stack.push("script");
          out.push({ kind: "script", code: "", open: true });
          continue;
        case "define":
          stack.push("define");
          out.push({ kind: "define", text: raw });
          continue;
        case "function":
          // 式の関数は TyranoScript に無い（@define と同じく、足したものは書き戻せない）
          out.push({ kind: "define", text: raw });
          continue;
        case "set":
          out.push({ kind: "set", rest, ...cond });
          continue;
        case "jump":
        case "call":
          out.push({ kind: "jump", name, target: rest, ...cond });
          continue;
        case "use":
          out.push({ kind: "use", file: rest });
          continue;
        default:
          // @html は @end までの中身をそのまま持つ
          if (name === "html") stack.push("html");
          else if (opensBody(name, rest)) stack.push("body");
          out.push({ kind: "command", name, rest, args: parseArgs(rest, 1).args, ...cond });
          continue;
      }
    }
    // 話者「…」と 話者 "…"（引用符の前の半角の空白一つは本文に入れない。.ks には本文を引用符から書く）
    // 行の終わりの固定の行 ID（#line:ID）は訳とボイスの鍵で、本文ではないので .ks には戻さない
    line = withoutLineId(line);
    const speaker = names.find((s) => line.startsWith(s) && speechOpenAt(line, s.length) >= 0) ?? "";
    const named = speaker === "" ? speakerWithName(line, names) : null;
    if (named) {
      const body = line.slice(named.end);
      out.push({ kind: "text", speaker: named.speaker, name: named.inner, body, content: parseInline(body).content });
      continue;
    }
    const body = line.slice(speaker === "" ? 0 : speechOpenAt(line, speaker.length));
    out.push({ kind: "text", speaker, body, content: parseInline(body).content });
  }
  return out;
}

/** 行の終わりの `#line:ID` を外す（ID の形でないものは本文のまま）。 */
function withoutLineId(line: string): string {
  return splitLineId(line).body.replace(/[ \t]+$/, "");
}

function readOption(line: string): LimLine | null {
  const arrow = line.lastIndexOf(" -> ");
  if (!line.startsWith("- ") || arrow < 0) return null;
  const after = line.slice(arrow + 4).trim();
  const space = after.indexOf(" ");
  const body = line.slice(2, Math.max(2, arrow));
  return {
    kind: "option",
    body,
    content: parseInline(body).content,
    target: space < 0 ? after : after.slice(0, space),
    args: space < 0 ? [] : parseArgs(after.slice(space + 1).trim(), 1).args,
  };
}

/** 値を比べるための字面（時間はミリ秒、色は小文字、文字列は引用符を外す）。 */
export function literalKey(v: Literal): string {
  switch (v.kind) {
    case "string":
      return `s:${v.value}`;
    case "number":
      return `n:${v.value}`;
    case "duration":
      return `d:${v.ms}`;
    case "bool":
      return `b:${v.value}`;
    case "color":
      return `c:${v.value.toLowerCase()}`;
    case "expr":
      return `e:${v.source.replace(/\s+/g, "")}`;
  }
}

/**
 * 命令の行を、意味で比べられる形にする。引数の順は問わず、既定値と同じ名前付き引数は書いていないのと同じにする
 * （registry に命令の仕様があるとき）。
 */
export function commandKey(name: string, args: readonly Argument[], registry?: Registry): { name: string; positional: string[]; named: Map<string, string> } {
  const spec = registry?.get(name);
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (const a of spec ? normalizeBooleanArgs(spec, args) : args) {
    if (a.key === null) positional.push(literalKey(a.value));
    else named.set(a.key, literalKey(a.value));
  }
  if (spec) {
    for (const [key, p] of Object.entries(spec.params)) {
      if (p.default === undefined || !named.has(key)) continue;
      const def = parseArgs(p.default, 1).args[0];
      if (def && literalKey(def.value) === named.get(key)) named.delete(key);
    }
  }
  return { name, positional, named };
}

/**
 * 一行を、意味で比べる字面にする。空行とコメントは null（比べない）。
 * 本文は書き方の揺れ（エスケープ）をそろえ、命令は引数の順と既定値の書き方をそろえる。
 */
export function normalizeLimLine(line: LimLine, registry?: Registry): string | null {
  switch (line.kind) {
    case "blank":
    case "comment":
    case "use":
      return null;
    case "text":
      return `text:${line.speaker}:${printInline(line.content)}`;
    case "option":
      return `option:${printInline(line.content)}->${line.target}:${argsText("", line.args, registry)}`;
    case "command":
      return argsText(line.name, line.args, registry) + condKey(line.cond);
    case "set":
      return `set:${line.rest.replace(/\s+/g, "")}${condKey(line.cond)}`;
    case "jump":
      return `${line.name}:${line.target}${condKey(line.cond)}`;
    case "if":
    case "elif":
      return `${line.kind}:${line.expr.replace(/\s+/g, "")}`;
    case "end":
      return `end:${line.closes ?? ""}`;
    case "label":
      return `label:${line.name}`;
    case "script":
      return `script:${line.code.trim()}`;
    case "define":
      return `define:${line.text.trim()}`;
    case "else":
    case "choice":
      return line.kind;
  }
}

/** 行の if=(式) を比べる字面（無ければ空）。 */
function condKey(cond: string | undefined): string {
  return cond === undefined ? "" : ` if:${cond.replace(/\s+/g, "")}`;
}

function argsText(name: string, args: readonly Argument[], registry?: Registry): string {
  const k = commandKey(name, args, registry);
  return `@${name} ${k.positional.join(" ")} ${[...k.named].sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${key}=${v}`).join(" ")}`.trim();
}
