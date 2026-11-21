import { normalizeBooleanArgs } from "@liminalia/lang";
import { parseArgs, parseLiteral, parseTargetText, replaceArgumentValue, scanHtml, TARGET_FUNCTIONS, type Argument, type CommandSpec, type Expr, type Inline, type Script, type Statement, type Target } from "@liminalia/lang";
import { findInlineCommands } from "./rewrite.ts";

/**
 * シーン（ラベル）の名前の変更で、.lim と設定の字面を書き換える中身（画面なし・ファイルなし）。開発サーバーの server/labels.ts が使う。
 *
 * 書き換えるもの: ラベルの行、@jump・@call・選択肢の飛び先（`#ラベル` も `ファイル#ラベル` も）、式の飛び先の中の文字列と to= の候補、
 * target 型の引数（本文の中の `{@…}` も）、@html の data-jump、式の visits("#ラベル")・read("ファイル#ラベル") の文字。
 * 飛び先に使う変数へ入れる文字列（@set・@let・設定の初期値）: `#ラベル` は飛ぶ側のファイルで解決するので、同じ名前のラベルが作品に一つだけのときだけ書き換える。
 * マクロ（@define）の引数と既定値: 型に target が無いので飛び先かどうか確定できない。`ファイル#ラベル` は確定できるので書き換え、`#ラベル` は書き換えない。
 * 書き換えられないもの（@script の中・プラグインのデータなど）は remainingRefs と leftInConfig で拾って書き手に知らせる。
 */

export interface LabelTarget {
  file: string;
  from: string;
  to: string;
  /** ラベルを別のファイルへ移すとき、移した先のファイル（無ければ file のまま）。 */
  toFile?: string;
  /** 書き換えた字面を置くファイル（ほかのファイルへ移す行を書き換えるとき。無ければ字面を書いたファイル）。 */
  outFile?: string;
}

/**
 * 書き換えられなかった参照のわけ。expr: 式で決まる飛び先、script: @script の中、plugin: プラグインの命令が教える行き先、conflict: ほかで変更されたファイル、
 * ambiguous: 変数へ入れる `#ラベル` で、同じ名前のラベルがほかのファイルにもある、macro: マクロの引数と既定値の `#ラベル`、
 * test: 台本のテスト（tests/*.limtest）の式の中の、ファイルを省いた `#ラベル`、chapter: 新しい名前に当たらなくなる chapters のワイルドカード。
 */
export type LeftReason = "expr" | "script" | "plugin" | "conflict" | "ambiguous" | "macro" | "test" | "chapter";

export interface LeftRef {
  file: string;
  line: number;
  reason: LeftReason;
  /** liminalia.json の中のとき、その場所（行は 0。"variables.game.next" など）。 */
  config?: string;
}

/** 命令名 → 仕様（組み込み・プラグインと @define）。 */
export type SpecOf = (name: string) => CommandSpec | undefined;

/**
 * 飛び先の字面が、inFile から見てそのラベルを指すなら、書き換えた字面。指さなければ null。
 * 形はそのまま（`#ラベル` は `#ラベル`、`ファイル#ラベル` は `ファイル#ラベル`）。ラベルがほかのファイルへ移るときは、
 * 字面を置くファイルから見て別のファイルになるなら `ファイル#ラベル` にする。
 */
export function retarget(text: string, inFile: string, t: LabelTarget): string | null {
  const parsed = parseTargetText(text.trim());
  if (!parsed || parsed.label !== t.from || (parsed.file ?? inFile) !== t.file) return null;
  const dest = t.toFile ?? t.file;
  const qualify = parsed.file !== null || dest !== (t.outFile ?? inFile);
  return `${qualify ? dest : ""}#${t.to}`;
}

/** 飛び先の字面がそのラベルを指すか。 */
const pointsAt = (text: string, inFile: string, t: LabelTarget) => retarget(text, inFile, t) !== null;

function walk(body: readonly Statement[], fn: (s: Statement) => void): void {
  for (const s of body) {
    fn(s);
    if (s.kind === "if") for (const b of s.branches) walk(b.body, fn);
    if (s.kind === "define") walk(s.body, fn);
  }
}

/** 変数の式（`game.next`・`x`）のパス。 */
function exprPath(e: Expr): string | null {
  if (e.kind === "name") return e.name;
  if (e.kind === "member") {
    const object = exprPath(e.object);
    return object === null ? null : `${object}.${e.property}`;
  }
  return null;
}

/** 式の飛び先に使っている変数のパス（この変数に文字列を入れる @set・@let も書き換える）。 */
export function targetVariables(scripts: Iterable<Script>): Set<string> {
  const out = new Set<string>();
  const visit = (e: Expr) => {
    if (e.kind === "conditional") {
      visit(e.then);
      visit(e.otherwise);
      return;
    }
    const path = exprPath(e);
    if (path) out.add(path);
  };
  const target = (t: Target) => {
    if (t.expr) visit(t.expr);
  };
  for (const script of scripts) {
    walk(script.body, (s) => {
      if (s.kind === "jump" || s.kind === "call") target(s.target);
      if (s.kind === "choice") for (const o of s.options) target(o.target);
    });
  }
  return out;
}

/** 字面の中の `"…"` のうち、そのラベルを指すものを書き換える（from・to の範囲の中だけ）。 */
function rewriteStrings(line: string, from: number, to: number, inFile: string, t: LabelTarget): string {
  let out = line.slice(0, from);
  let i = from;
  while (i < to) {
    if (line[i] !== '"') {
      out += line[i++];
      continue;
    }
    let j = i + 1;
    while (j < to && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
    const literal = parseLiteral(line.slice(i, j + 1));
    const next = literal.kind === "string" ? retarget(literal.value, inFile, t) : null;
    out += next ? JSON.stringify(next) : line.slice(i, j + 1);
    i = j + 1;
  }
  return out + line.slice(to);
}

/** `to=#a,#b` の候補を書き換える（引用符はそのまま）。 */
function rewriteCandidates(tail: string, inFile: string, t: LabelTarget): string {
  return tail.replace(/(^|\s)to=("?)([^"\s]*)\2/, (_m, head: string, quote: string, list: string) => `${head}to=${quote}${list.split(",").map((c) => retarget(c, inFile, t) ?? c).join(",")}${quote}`);
}

/** `(式) to=…` か、飛び先の字面一つ（後ろに引数があってもよい）。at は飛び先の始まり。 */
function rewriteTargetAt(line: string, at: number, target: Target, inFile: string, t: LabelTarget): string {
  if (target.expr) {
    const close = closeParen(line, at);
    if (close < 0) return line;
    const head = rewriteStrings(line.slice(0, close + 1), at, close + 1, inFile, t);
    return head + rewriteCandidates(line.slice(close + 1), inFile, t);
  }
  const m = /^\S+/.exec(line.slice(at));
  const next = m && retarget(m[0], inFile, t);
  return next ? line.slice(0, at) + next + line.slice(at + m[0].length) : line;
}

function closeParen(line: string, at: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = at; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === "\\") i++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** 引数の値の字面（target 型は `#abc` が色に読まれることがある）。 */
function targetValue(a: Argument): string | null {
  return a.value.kind === "string" || a.value.kind === "color" ? a.value.value : null;
}

/** ファイルまで書いてあって、そのラベルを指すと確定できる字面か。 */
function pointsExactly(value: string, t: LabelTarget): boolean {
  const parsed = parseTargetText(value.trim());
  return parsed !== null && parsed.file === t.file && parsed.label === t.from;
}

/** マクロの引数の字面のうち、そのラベルかもしれないもの（`#ラベル` はマクロの本文のどこで飛ぶかで決まるので、どのファイルでも数える）。 */
function mayPointAt(value: string, t: LabelTarget): boolean {
  const parsed = parseTargetText(value.trim());
  return parsed !== null && parsed.label === t.from && (parsed.file === null || parsed.file === t.file);
}

/** target 型の引数を書き換える（マクロは全部の引数のうち、`ファイル#ラベル` で確定できるものだけ）。text は引数の桁（column）が指す字面。shift は桁に足す数。 */
function rewriteArgs(text: string, args: readonly Argument[], spec: CommandSpec | undefined, shift: number, inFile: string, t: LabelTarget): string {
  if (!spec) return text;
  const edits: { column: number; next: string }[] = [];
  let position = 0;
  for (const a of normalizeBooleanArgs(spec, args)) {
    if (spec.macro) {
      const value = targetValue(a);
      if (value !== null && pointsExactly(value, t)) edits.push({ column: a.column + shift, next: `${t.toFile ?? t.file}#${t.to}` });
      continue;
    }
    const key = a.key ?? spec.positional[position++];
    if (key === undefined || spec.params[key]?.type.kind !== "target") continue;
    const value = targetValue(a);
    const next = value === null ? null : retarget(value, inFile, t);
    if (next) edits.push({ column: a.column + shift, next });
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.column - a.column)) out = replaceArgumentValue(out, e.column, e.next) ?? out;
  return out;
}

/** 本文の中の `{@…}` の target 型の引数を書き換える（訳文にも使う）。 */
export function rewriteInlineTargets(line: string, inFile: string, t: LabelTarget, specOf: SpecOf): string {
  let out = line;
  for (const c of findInlineCommands(line).reverse()) {
    const m = /^([a-z][a-z0-9-]*)(\s+)(.*)$/s.exec(c.source);
    if (!m) continue;
    const base = m[1]!.length + m[2]!.length;
    const { args } = parseArgs(m[3]!, 1);
    const next = rewriteArgs(c.source, args, specOf(m[1]!), base, inFile, t);
    if (next !== c.source) out = `${out.slice(0, c.from)}{@${next}}${out.slice(c.to)}`;
  }
  return out;
}

/** @html の data-jump を書き換える。 */
function rewriteDataJump(line: string, inFile: string, t: LabelTarget): string {
  return line.replace(/(data-jump\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi, (whole, head: string, raw: string) => {
    const quote = /^["']/.test(raw) ? raw[0]! : "";
    const next = retarget(quote ? raw.slice(1, -1) : raw, inFile, t);
    return next ? `${head}${quote}${next}${quote}` : whole;
  });
}

export interface LabelRewrite {
  text: string;
  /** 書き換えた行（行の数は変わらない）。 */
  changed: { line: number; before: string; after: string }[];
}

/**
 * 一つのファイルの字面を書き換える（ラベルの行はそのファイルのときだけ）。variables は targetVariables の結果。
 * unique は、変えるラベルと同じ名前のラベルが作品の中に一つだけか（uniqueLabel）。
 */
export function rewriteScript(text: string, script: Script, t: LabelTarget, specOf: SpecOf, variables: ReadonlySet<string>, unique: boolean): LabelRewrite {
  const inFile = script.file;
  const lines = text.split("\n");
  const edit = (n: number, fn: (line: string) => string) => {
    const line = lines[n - 1];
    if (line !== undefined) lines[n - 1] = fn(line);
  };
  /** @set・@let の右辺が飛び先の文字列のとき。`#ラベル` は飛ぶ側のファイルで解決するので、ラベルが作品に一つだけのときだけ（書いたファイルにはよらない）。 */
  const assignment = (n: number, value: Expr, path: string | null) => {
    if (path === null || !variables.has(path) || value.kind !== "literal" || typeof value.value !== "string" || !assignedPoints(value.value, t, unique)) return;
    // 変数へ入れる字面は、飛ぶ側のファイルで解決するので、ラベルが移るなら必ず `ファイル#ラベル` にする
    edit(n, (l) => rewriteStrings(l, l.indexOf("=") + 1, l.length, t.file, { ...t, outFile: t.file }));
  };
  walk(script.body, (s) => {
    switch (s.kind) {
      case "label":
        if (inFile === t.file && s.name === t.from) edit(s.line, (l) => l.replace(/^(\s*#\s+)\S+/, `$1${t.to}`));
        break;
      case "jump":
      case "call":
        edit(s.line, (l) => {
          const m = /^\s*@(?:jump|call)\s+/.exec(l);
          return m ? rewriteTargetAt(l, m[0].length, s.target, inFile, t) : l;
        });
        break;
      case "choice":
        for (const o of s.options) {
          edit(o.line, (l) => {
            const arrow = l.lastIndexOf(" -> ");
            if (arrow < 0) return l;
            const after = rewriteTargetAt(l, arrow + 4, o.target, inFile, t);
            return rewriteInlineTargets(after.slice(0, arrow), inFile, t, specOf) + after.slice(arrow);
          });
        }
        break;
      case "command": {
        edit(s.line, (l) => rewriteArgs(l, s.args, specOf(s.name), 0, inFile, t));
        if (s.body) {
          const count = s.body.text.split("\n").length;
          for (let n = s.body.line; n < s.body.line + count; n++) edit(n, (l) => rewriteDataJump(l, inFile, t));
        }
        break;
      }
      case "say":
      case "prose":
        edit(s.line, (l) => rewriteInlineTargets(l, inFile, t, specOf));
        break;
      case "define":
        // 既定値もマクロの引数と同じ（型に target が無いので、確定できる `ファイル#ラベル` だけ）
        for (const p of s.params) {
          const value = defaultText(p);
          if (value === null || !pointsExactly(value, t)) continue;
          const pattern = new RegExp(`(\\b${escapeRegExp(p.name)}\\s*:\\s*[\\w-]+\\s*=\\s*)("?)${escapeRegExp(value)}"?`, "i");
          edit(s.line, (l) => l.replace(pattern, (_m, head: string, quote: string) => `${head}${quote}${t.toFile ?? t.file}#${t.to}${quote}`));
        }
        break;
      case "set":
        if (s.op === "=") assignment(s.line, s.value, exprPath(s.target));
        break;
      case "let":
        assignment(s.line, s.value, s.name);
        break;
      default:
        break;
    }
  });
  // 式の中の飛び先の関数（visits("#ラベル")、read("ファイル#ラベル")）。`#ラベル` は書いたファイルで解決する
  for (const n of expressionLines(script)) {
    edit(n, (l) =>
      l.replace(TARGET_CALL, (whole, head: string, literal: string) => {
        const value = parseLiteral(literal);
        const next = value.kind === "string" ? retarget(value.value, inFile, t) : null;
        return next ? `${head}${JSON.stringify(next)}` : whole;
      }),
    );
  }
  const before = text.split("\n");
  const changed = lines.flatMap((after, i) => (after !== before[i] ? [{ line: i + 1, before: before[i]!, after }] : []));
  return { text: lines.join("\n"), changed };
}

/** 式の中の飛び先を受け取る関数の呼び出し（@liminalia/lang の TARGET_FUNCTIONS）と、その最初の引数の "…"。 */
const TARGET_CALL = new RegExp(`(\\b(?:${[...TARGET_FUNCTIONS].join("|")})\\(\\s*)("(?:\\\\.|[^"\\\\])*")`, "g");

/** 式を書ける行（条件の @if と @elif、@set、@let、@function、@return、命令、本文と選択肢、@jump と @call）。コメントと @script、@html の中は入れない。 */
function expressionLines(script: Script): number[] {
  const out = new Set<number>();
  walk(script.body, (s) => {
    if (s.kind === "if") {
      for (const b of s.branches) if (b.condition) out.add(b.line);
    } else if (s.kind === "choice") for (const o of s.options) out.add(o.line);
    else if (s.kind !== "label" && s.kind !== "script" && s.kind !== "define") out.add(s.line);
  });
  return [...out].sort((a, b) => a - b);
}

/** @define の引数の既定値の字面。 */
function defaultText(p: Extract<Statement, { kind: "define" }>["params"][number]): string | null {
  return p.defaultValue && (p.defaultValue.kind === "string" || p.defaultValue.kind === "color") ? p.defaultValue.value : null;
}

/** 変数へ入れる字面が、そのラベルを指すと言えるか（`ファイル#ラベル` は確定、`#ラベル` はラベルが作品に一つだけのときだけ）。 */
function assignedPoints(value: string, t: LabelTarget, unique: boolean): boolean {
  return pointsExactly(value, t) || (unique && retarget(value, t.file, t) !== null);
}

/** 変数へ入れる字面が `#ラベル` で、同じ名前のラベルがほかにもあるので決められないか。 */
function assignedAmbiguous(value: string, t: LabelTarget, unique: boolean): boolean {
  const parsed = parseTargetText(value.trim());
  return !unique && parsed !== null && parsed.file === null && parsed.label === t.from;
}

/** そのラベルと同じ名前のラベルが作品の中に一つだけか。 */
export function uniqueLabel(scripts: Iterable<Script>, name: string): boolean {
  let count = 0;
  for (const script of scripts) {
    walk(script.body, (s) => {
      if (s.kind === "label" && s.name === name) count++;
    });
  }
  return count <= 1;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inlineHasTarget(content: readonly Inline[], inFile: string, t: LabelTarget, specOf: SpecOf): boolean {
  return content.some((n) => {
    if (n.kind === "command") return argsPoint(n.args, specOf(n.name), inFile, t);
    return "children" in n && inlineHasTarget(n.children, inFile, t, specOf);
  });
}

function argsPoint(args: readonly Argument[], spec: CommandSpec | undefined, inFile: string, t: LabelTarget): boolean {
  if (!spec) return false;
  if (spec.macro) {
    return args.some((a) => {
      const value = targetValue(a);
      return value !== null && mayPointAt(value, t);
    });
  }
  let position = 0;
  return normalizeBooleanArgs(spec, args).some((a) => {
    const key = a.key ?? spec.positional[position++];
    if (key === undefined || spec.params[key]?.type.kind !== "target") return false;
    const value = targetValue(a);
    return value !== null && pointsAt(value, inFile, t);
  });
}

/**
 * 書き換えたあとの台本に、まだ古いラベルを指す参照が残っていないか（残っていれば書き手に知らせる）。
 * candidates は式の飛び先の候補を割り出す関数（@liminalia/lang の targetCandidates）。variables と unique は rewriteScript と同じ。
 */
export function remainingRefs(scripts: ReadonlyMap<string, Script>, t: LabelTarget, specOf: SpecOf, candidates: (target: Target, file: string) => string[] | null, variables: ReadonlySet<string>, unique: boolean): LeftRef[] {
  const out: LeftRef[] = [];
  for (const [file, script] of scripts) {
    const add = (line: number, reason: LeftReason) => out.push({ file, line, reason });
    const target = (x: Target, line: number) => {
      if (x.expr) {
        if (candidates(x, file)?.some((c) => pointsAt(c, file, t))) add(line, "expr");
      } else if (x.label === t.from && (x.file ?? file) === t.file) add(line, "expr");
    };
    const assigned = (line: number, value: Expr, path: string | null) => {
      if (path !== null && variables.has(path) && value.kind === "literal" && typeof value.value === "string" && assignedAmbiguous(value.value, t, unique)) add(line, "ambiguous");
    };
    walk(script.body, (s) => {
      if (s.kind === "jump" || s.kind === "call") target(s.target, s.line);
      else if (s.kind === "choice") {
        for (const o of s.options) {
          target(o.target, o.line);
          if (inlineHasTarget(o.content, file, t, specOf)) add(o.line, "expr");
        }
      } else if (s.kind === "command") {
        if (argsPoint(s.args, specOf(s.name), file, t)) add(s.line, specOf(s.name)?.macro ? "macro" : "expr");
        if (s.body && s.name === "html") for (const j of scanHtml(s.body.text).jumps) if (pointsAt(j.target, file, t)) add(s.line, "expr");
      } else if ((s.kind === "say" || s.kind === "prose") && inlineHasTarget(s.content, file, t, specOf)) add(s.line, "expr");
      else if (s.kind === "script" && mentionsLabel(s.code, file, t)) add(s.line, "script");
      else if (s.kind === "define") {
        for (const p of s.params) {
          const value = defaultText(p);
          if (value !== null && mayPointAt(value, t)) add(s.line, "macro");
        }
      } else if (s.kind === "set" && s.op === "=") assigned(s.line, s.value, exprPath(s.target));
      else if (s.kind === "let") assigned(s.line, s.value, s.name);
    });
  }
  return out;
}

/** @script の中の文字列に、そのラベルを指す字面があるか（JavaScript は書き換えない）。 */
function mentionsLabel(code: string, file: string, t: LabelTarget): boolean {
  const name = escapeRegExp(t.from);
  const own = file === t.file ? `(?:${escapeRegExp(t.file)})?` : escapeRegExp(t.file);
  return new RegExp(`["'\`]${own}#${name}["'\`]`, "u").test(code);
}

// ---- 設定と覚え書き ----

/**
 * liminalia.json のうち、ラベルを持つところ（entry・afterLoad・おまけの回想と章・フローチャートの題・飛び先に使う変数の初期値・scenes の鍵・check.sound.quiet）。
 * unique は rewriteScript と同じ。
 */
export function rewriteConfig(raw: Record<string, unknown>, t: LabelTarget, variables: ReadonlySet<string>, unique: boolean): string[] {
  const where: string[] = [];
  // 設定の字面は `ファイル` か `ファイル#ラベル`（ファイルを省いた形は書けない）
  const next = (v: unknown) => (typeof v === "string" ? retarget(v, "", t) : null);
  for (const key of ["entry", "afterLoad"]) {
    const v = next(raw[key]);
    if (v) {
      raw[key] = v;
      where.push(key);
    }
  }
  const extra = raw.extra as { replay?: { id?: string; target?: unknown }[]; chapters?: { id?: string; target?: unknown }[]; flowchart?: unknown } | undefined;
  for (const [name, list] of [["replay", extra?.replay], ["chapters", extra?.chapters]] as const) {
    for (const item of Array.isArray(list) ? list : []) {
      const v = next(item?.target);
      if (v) {
        item.target = v;
        where.push(`extra.${name}.${item.id ?? ""}`);
      }
    }
  }
  // 場面ごとの情報（鍵が `ファイル#ラベル`）と、わざと無音にした場面
  const scenes = raw.scenes;
  if (scenes && typeof scenes === "object" && !Array.isArray(scenes) && Object.keys(scenes).some((k) => next(k) !== null)) {
    raw.scenes = Object.fromEntries(Object.entries(scenes).map(([k, v]) => [next(k) ?? k, v]));
    where.push("scenes");
  }
  const sound = (raw.check as { sound?: { quiet?: unknown } } | undefined)?.sound;
  if (sound && typeof sound === "object" && Array.isArray(sound.quiet) && sound.quiet.some((q) => next(q) !== null)) {
    sound.quiet = sound.quiet.map((q) => next(q) ?? q);
    where.push("check.sound.quiet");
  }
  const titles = extra?.flowchart && typeof extra.flowchart === "object" ? (extra.flowchart as { titles?: Record<string, string> }).titles : undefined;
  if (titles) {
    const key = `${t.file}#${t.from}`;
    if (Object.hasOwn(titles, key)) {
      (extra!.flowchart as { titles: Record<string, string> }).titles = Object.fromEntries(Object.entries(titles).map(([k, v]) => [k === key ? `${t.toFile ?? t.file}#${t.to}` : k, v]));
      where.push("extra.flowchart.titles");
    }
  }
  const vars = raw.variables as Record<string, unknown> | undefined;
  for (const [path, value] of Object.entries(vars ?? {})) {
    // 初期値の `#ラベル` も飛ぶ側のファイルで解決する
    if (!variables.has(path) || typeof value !== "string" || !assignedPoints(value, t, unique)) continue;
    vars![path] = retarget(value, t.file, t)!;
    where.push(`variables.${path}`);
  }
  return where;
}

/** 飛び先に使う変数の初期値のうち、どのファイルのラベルか決められないので書き換えなかったもの。 */
export function leftInConfig(raw: Record<string, unknown>, t: LabelTarget, variables: ReadonlySet<string>, unique: boolean): LeftRef[] {
  const vars = raw.variables as Record<string, unknown> | undefined;
  return Object.entries(vars ?? {}).flatMap(([path, value]) => (variables.has(path) && typeof value === "string" && assignedAmbiguous(value, t, unique) ? [{ file: "liminalia.json", line: 0, reason: "ambiguous" as const, config: `variables.${path}` }] : []));
}

/** フローチャートで動かした位置の鍵（`ファイル#ラベル`）を付け替える。変わらなければ同じものを返す。 */
export function rewriteMapPositions<T>(positions: Record<string, T> | undefined, t: LabelTarget): Record<string, T> | undefined {
  const key = `${t.file}#${t.from}`;
  if (!positions || !Object.hasOwn(positions, key)) return positions;
  return Object.fromEntries(Object.entries(positions).map(([k, v]) => [k === key ? `${t.toFile ?? t.file}#${t.to}` : k, v]));
}
