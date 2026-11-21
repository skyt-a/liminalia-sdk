import { ENGINE_VARIABLES, FUNCTION_ARITY, FUNCTION_DOCS, FUNCTION_DOCS_EN, FUNCTION_USAGE, FUNCTION_USAGE_EN, variableUses, type ItemsConfig } from "@liminalia/lang";
import { indentOf, optionSite, type Block } from "@liminalia/lang/line-syntax";
import type { CompletionItem, Hover, Range } from "vscode-languageserver";
import type { Lang } from "./actions.ts";
import type { LimProject } from "./model.ts";

/**
 * 式の中の補完と説明（@if・@elif・@while・@set・@let・@return の後ろ、パラメータの (…)、本文の {= …}）。
 * 変数（台本で使っているものと liminalia.json の variables の初期値、エンジンが値を入れるもの）、式の関数、
 * item("…") の持ち物の名前（liminalia.json の items）、visits("…")・read("…") のジャンプ先を出す。
 */

const CompletionKind = { Function: 3, Variable: 6, Module: 9, Keyword: 14, Reference: 18, Value: 12 } as const;
const InsertTextFormat = { PlainText: 1, Snippet: 2 } as const;

const range = (line: number, start: number, end: number): Range => ({ start: { line, character: start }, end: { line, character: end } });

/** 変数の頭（save はセーブの様子で、読むだけ）。 */
const ROOTS: readonly { name: string; doc: string; docEn: string }[] = [
  { name: "game", doc: "ゲームの変数（セーブに入る）", docEn: "Game variables (saved with the game)" },
  { name: "system", doc: "全セーブ共通の変数", docEn: "Variables shared by all saves" },
  { name: "temp", doc: "一時的な変数（セーブに入らない）", docEn: "Temporary variables (not saved)" },
  { name: "save", doc: "セーブの様子（読むだけ。save.version など）", docEn: "Save information (read only, such as save.version)" },
];

const WORDS = {
  ja: {
    variable: "変数",
    engine: "エンジンが値を入れる変数",
    initial: (v: string) => `初期値 \`${v}\`（liminalia.json の variables）`,
    noInitial: "初期値なし（liminalia.json の variables に無い）",
    uses: (w: number, r: number) => `書く所 ${w}、読む所 ${r}`,
    function: "式の関数",
    item: "持ち物",
    itemMissing: (k: string) => `持ち物 ${k} は liminalia.json の items にありません`,
    label: (f: string, l: number) => `${f} ${l} 行目`,
  },
  en: {
    variable: "Variable",
    engine: "A variable the engine sets",
    initial: (v: string) => `Initial value \`${v}\` (variables in liminalia.json)`,
    noInitial: "No initial value (not in variables in liminalia.json)",
    uses: (w: number, r: number) => `Written in ${w} ${w === 1 ? "place" : "places"}, read in ${r} ${r === 1 ? "place" : "places"}`,
    function: "Expression function",
    item: "Item",
    itemMissing: (k: string) => `The item ${k} isn't in items in liminalia.json`,
    label: (f: string, l: number) => `${f} line ${l}`,
  },
};

/** 式の中のカーソルの様子。string は "…" の中（callee はその文字列を最初の引数にする関数の名前）、word は名前を書いているところ。 */
export type ExprSite =
  | { kind: "string"; callee: string | null; start: number; end: number; value: string; prefix: string }
  | { kind: "word"; start: number; end: number; text: string; call: boolean };

/** from から offset までが式だとして、カーソルの様子を求める。 */
function siteIn(line: string, from: number, offset: number): ExprSite {
  let quote = -1;
  for (let i = from; i < offset; i++) {
    const c = line[i];
    if (quote >= 0) {
      if (c === "\\") i++;
      else if (c === '"') quote = -1;
    } else if (c === '"') quote = i;
  }
  if (quote >= 0) {
    let end = offset;
    while (end < line.length && line[end] !== '"') end += line[end] === "\\" ? 2 : 1;
    const callee = /([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*$/.exec(line.slice(from, quote))?.[1] ?? null;
    return { kind: "string", callee, start: quote + 1, end: Math.min(end, line.length), value: line.slice(quote + 1, Math.min(end, line.length)), prefix: line.slice(quote + 1, offset) };
  }
  const before = /[\p{L}\p{N}_.]*$/u.exec(line.slice(from, offset))![0];
  const after = /^[\p{L}\p{N}_]*/u.exec(line.slice(offset))![0];
  const end = offset + after.length;
  return { kind: "word", start: offset - before.length, end, text: line.slice(offset - before.length, end), call: /^\s*\(/.test(line.slice(end)) };
}

/** (…) の中か。from から offset までの、"…" の外の括弧の深さが 1 以上なら、その括弧の中身の始まり。 */
function openParen(line: string, from: number, offset: number): number | null {
  const stack: number[] = [];
  let quoted = false;
  for (let i = from; i < offset; i++) {
    const c = line[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "(") stack.push(i + 1);
    else if (c === ")") stack.pop();
  }
  return stack.length > 0 ? stack[0]! : null;
}

/** 本文の {= …} の中か。中なら式の始まり。 */
function openValue(line: string, offset: number): number | null {
  let start: number | null = null;
  for (let i = 0; i < offset; i++) {
    const c = line[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (start === null && c === "{" && line[i + 1] === "=") {
      start = i + 2;
      i++;
    } else if (start !== null && c === "}") start = null;
  }
  return start;
}

/** カーソルが式の中なら、その様子（式の中でなければ null）。 */
export function exprSiteAt(line: string, offset: number, block: Block): ExprSite | null {
  if (block === "script") return null;
  const indent = indentOf(line);
  const head = line.slice(indent);
  if (head.startsWith("//") || (block === "root" && head.startsWith("#"))) return null;
  if (block === "root" && head.startsWith("@")) {
    const kw = /^@(if|elif|while|set|let|return)(?=\s)/.exec(head);
    const from = kw ? indent + kw[0].length + 1 : null;
    if (from !== null && offset >= from) return siteIn(line, from, offset);
    const paren = openParen(line, indent, offset);
    return paren !== null ? siteIn(line, paren, offset) : null;
  }
  if (block === "choice") {
    const option = optionSite(line);
    if (option && offset > option.arrow) {
      const paren = openParen(line, option.arrow, offset);
      return paren !== null ? siteIn(line, paren, offset) : null;
    }
  }
  // 本文の {= …} と、本文の中の {@… (…)}
  const value = openValue(line, offset);
  if (value !== null) return siteIn(line, value, offset);
  const at = line.lastIndexOf("{@", offset);
  const close = at >= 0 ? line.indexOf("}", at) : -1;
  if (at >= 0 && (close < 0 || close >= offset)) {
    const paren = openParen(line, at, offset);
    if (paren !== null) return siteIn(line, paren, offset);
  }
  return null;
}

/** 作品で使っている変数（台本で読み書きするものと、liminalia.json の variables の初期値）。 */
export function knownVariables(project: LimProject): Map<string, { initial?: unknown; writes: number; reads: number }> {
  const out = new Map<string, { initial?: unknown; writes: number; reads: number }>();
  const get = (path: string) => {
    let v = out.get(path);
    if (!v) out.set(path, (v = { writes: 0, reads: 0 }));
    return v;
  };
  const initial = project.input.config?.variables;
  if (initial && typeof initial === "object") for (const [path, value] of Object.entries(initial as Record<string, unknown>)) get(path).initial = value;
  for (const script of project.scripts().values()) {
    for (const u of variableUses(script, project.registry)) {
      const v = get(u.path);
      if (u.write) v.writes++;
      else v.reads++;
    }
  }
  return out;
}

function items(project: LimProject): ItemsConfig {
  const raw = project.input.config?.items;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ItemsConfig) : {};
}

const usageOf = (name: string, lang: Lang) => (lang === "en" ? FUNCTION_USAGE_EN[name] : FUNCTION_USAGE[name]) ?? [`${name}()`];
const docOf = (name: string, lang: Lang) => (lang === "en" ? FUNCTION_DOCS_EN[name] : FUNCTION_DOCS[name]) ?? "";

/** 式の中の補完。targets は visits("…")・read("…") の中のジャンプ先の候補（features.ts の targetCompletions）。 */
export function exprCompletions(project: LimProject, lineNo: number, site: ExprSite, lang: Lang, targets: (prefix: string, r: Range) => CompletionItem[]): CompletionItem[] {
  const w = WORDS[lang];
  if (site.kind === "string") {
    const r = range(lineNo, site.start, site.end);
    if (site.callee === "item") {
      return Object.entries(items(project)).map(([key, def]) => ({
        label: key,
        kind: CompletionKind.Value,
        detail: `${w.item}: ${def.name}`,
        ...(def.description ? { documentation: def.description } : {}),
        textEdit: { range: r, newText: key },
      }));
    }
    if (site.callee === "visits" || site.callee === "read") return targets(site.prefix, r);
    return [];
  }
  const r = range(lineNo, site.start, site.end);
  const text = site.text;
  const variables = knownVariables(project);
  for (const name of ENGINE_VARIABLES) if (!variables.has(name)) variables.set(name, { writes: 0, reads: 0 });
  const variableItems = (): CompletionItem[] =>
    [...variables].map(([path, v]) => ({
      label: path,
      kind: CompletionKind.Variable,
      detail: ENGINE_VARIABLES.has(path) ? w.engine : v.initial !== undefined ? w.initial(JSON.stringify(v.initial)) : w.variable,
      sortText: `0${path}`,
      textEdit: { range: r, newText: path },
    }));
  if (text.includes(".")) return variableItems();
  const out: CompletionItem[] = [];
  for (const root of ROOTS) out.push({ label: root.name, kind: CompletionKind.Module, detail: lang === "en" ? root.docEn : root.doc, sortText: `1${root.name}`, textEdit: { range: r, newText: `${root.name}.` }, command: { title: "", command: "editor.action.triggerSuggest" } });
  for (const [name, [min]] of Object.entries(FUNCTION_ARITY)) {
    const usage = usageOf(name, lang);
    out.push({
      label: name,
      kind: CompletionKind.Function,
      detail: usage.join(" / "),
      documentation: docOf(name, lang),
      sortText: `2${name}`,
      insertTextFormat: InsertTextFormat.Snippet,
      // 呼び出しの括弧がもう書いてあれば名前だけ
      textEdit: { range: r, newText: site.call ? name : min === 0 ? `${name}()` : name === "item" || name === "visits" || name === "read" || name === "chosen" ? `${name}("$1")` : `${name}($1)` },
      ...(name === "item" || name === "visits" || name === "read" ? { command: { title: "", command: "editor.action.triggerSuggest" } } : {}),
    });
  }
  for (const k of ["true", "false", "null"]) out.push({ label: k, kind: CompletionKind.Keyword, sortText: `3${k}`, textEdit: { range: r, newText: k } });
  return [...variableItems(), ...out];
}

/** 式の中の説明（関数、変数、item("…") の持ち物、visits("…")・read("…") のジャンプ先）。 */
export function exprHover(project: LimProject, lineNo: number, site: ExprSite, lang: Lang, resolveTarget: (text: string) => { file: string; line: number } | null): Hover | null {
  const w = WORDS[lang];
  if (site.kind === "string") {
    const r = range(lineNo, site.start, site.end);
    if (site.callee === "item") {
      const def = items(project)[site.value];
      return { range: r, contents: { kind: "markdown", value: def ? `**${w.item}: ${def.name}**${def.description ? `\n\n${def.description}` : ""}` : w.itemMissing(site.value) } };
    }
    if (site.callee === "visits" || site.callee === "read") {
      const place = resolveTarget(site.value);
      return place ? { range: r, contents: { kind: "markdown", value: `\`${site.value}\` — ${w.label(place.file, place.line)}` } } : null;
    }
    return null;
  }
  const word = site.text;
  if (word === "") return null;
  const r = range(lineNo, site.start, site.end);
  if (site.call && Object.hasOwn(FUNCTION_ARITY, word)) {
    return { range: r, contents: { kind: "markdown", value: `**${word}** — ${w.function}\n\n\`\`\`lim\n${usageOf(word, lang).join("\n")}\n\`\`\`\n\n${docOf(word, lang)}` } };
  }
  const m = /^(game|system|temp)\.[\p{ID_Start}_][\p{ID_Continue}_]*/u.exec(word);
  if (!m) return null;
  const path = m[0];
  const v = knownVariables(project).get(path);
  const lines = [`**${path}** — ${ENGINE_VARIABLES.has(path) ? w.engine : w.variable}`];
  if (!ENGINE_VARIABLES.has(path)) lines.push("", v?.initial !== undefined ? w.initial(JSON.stringify(v.initial)) : w.noInitial);
  if (v) lines.push("", w.uses(v.writes, v.reads));
  return { range: range(lineNo, site.start, site.start + path.length), contents: { kind: "markdown", value: lines.join("\n") } };
}
