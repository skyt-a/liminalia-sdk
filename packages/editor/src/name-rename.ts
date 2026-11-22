import { normalizeBooleanArgs } from "@liminalia/lang";
import {
  assetReferences,
  chapterOf,
  extraAssetReferences,
  inlineAssetSites,
  isVariablePath,
  itemAssetReferences,
  renameVariableInLine,
  replaceArgumentValue,
  TARGET_FUNCTIONS,
  uiAssetReferences,
  variableUses,
  type Cast,
  type ChapterInfo,
  type CommandSpec,
  type Inline,
  type Registry,
  type Script,
  type Statement,
  type TranslationEntry,
  type TranslationFile,
  type UiConfig,
  type VoiceLock,
  type VoiceLockEntry,
} from "@liminalia/lang";
import { commandSiteAt, indentOf, inlineCommands, namedArgs, type CommandSite } from "@liminalia/lang/line-syntax";
import type { StudioState } from "./protocol.ts";
import type { TranslationMoves } from "./label-follow.ts";

/**
 * 名前の変更（変数、キャラクター、話者、素材、シナリオのファイル、マクロ）で、.lim と設定の字面を書き換える中身（画面なし・ファイルなし）。
 * 制作画面の開発サーバー（server/manage.ts。lim rename もこれを通す）と VS Code の拡張機能（packages/vscode の rename.ts）が使う。
 * ファイルの読み書きと、書けなかったときに元へ戻すのは使う側がする。シーン（ラベル）の名前の変更は label-rename.ts と label-follow.ts。
 *
 * 台本の書き換えはどれも行の数を変えない（書き換えた行の番号を changed に返す）。訳の鍵と voice-lock.json の鍵は原文から作るので、
 * 本文の中を書き換えた行は、使う側が label-follow.ts の translationMoves・voiceLockMoves と moveTranslationEntries で付け替える。
 */

/** 命令名 → 仕様（組み込み・プラグインと @define）。 */
export type SpecOf = (name: string) => CommandSpec | undefined;

/** 一つの台本を書き換えた結果。changed は書き換えた行（1 始まり）、left は書き換えられなかった参照の行。 */
export interface ScriptRewrite {
  text: string;
  changed: number[];
  left: number[];
}

/** マクロ（@define）の名前に使える形（構文解析器と同じ）。 */
export const MACRO_NAME = /^[a-z][a-z0-9-]*$/;

/** 構文として読む書き方の言葉（マクロの名前にできない。@liminalia/lang の check.ts と同じ）。 */
export const FLOW_KEYWORDS: ReadonlySet<string> = new Set(["if", "elif", "else", "end", "while", "with", "content", "choice", "define", "script", "set", "let", "jump", "call", "return", "use"]);

/** マクロの名前に使えない名前なら、その理由（使えれば null）。commands は組み込みとプラグインの命令。 */
export function macroNameProblem(name: string, commands: { has(name: string): boolean }): string | null {
  if (!MACRO_NAME.test(name)) return `マクロの名前に使えるのは英小文字、数字、- だけです（英小文字で始めます）: ${name}`;
  if (FLOW_KEYWORDS.has(name)) return `@${name} は予約語なので、マクロの名前にできません`;
  if (commands.has(name)) return `@${name} は組み込みかプラグインのコマンドと同じ名前です`;
  return null;
}

/** キャラクター名と話者名に使えない名前なら、その理由（使えれば null）。 */
export function castNameProblem(name: string): string | null {
  return name.trim() !== name || name === "" || /[\s"=()#@]/.test(name) ? `名前として使えません: ${name}` : null;
}

function visit(body: readonly Statement[], fn: (s: Statement) => void): void {
  for (const s of body) {
    fn(s);
    if (s.kind === "if") for (const b of s.branches) visit(b.body, fn);
    if (s.kind === "define") visit(s.body, fn);
  }
}

/** 書き換えた行だけを差し替えた台本と、変わった行。 */
function finish(text: string, lines: string[], left: number[] = []): ScriptRewrite {
  const old = text.split("\n");
  const changed: number[] = [];
  lines.forEach((l, i) => {
    if (l !== old[i]) changed.push(i + 1);
  });
  return { text: changed.length > 0 ? lines.join("\n") : text, changed, left };
}

// ---- 台本の中の場所（VS Code の参照の一覧も使う） ----

/** 台本の中の名前の場所（line は 1 始まり、start と end は行の中の 0 始まりの位置。end は含まない）。 */
export interface NameSite {
  line: number;
  start: number;
  end: number;
}

/** 本文（台詞・地の文・選択肢の文）の中に、その名前の命令 {@…} がある行。 */
function hasInlineCommand(content: readonly Inline[], name: string | null): boolean {
  return content.some((n) => (n.kind === "command" && (name === null || n.name === name)) || ("children" in n && hasInlineCommand(n.children, name)));
}

/** 命令（行の命令か本文の中の {@…}）がある行（1 始まり）。name を渡せばその名前の命令だけ。 */
function commandLines(script: Script, name: string | null): Set<number> {
  const out = new Set<number>();
  visit(script.body, (s) => {
    if (s.kind === "command" && (name === null || s.name === name)) out.add(s.line);
    else if ((s.kind === "say" || s.kind === "prose") && hasInlineCommand(s.content, name)) out.add(s.line);
    else if (s.kind === "choice") for (const o of s.options) if (hasInlineCommand(o.content, name)) out.add(o.line);
  });
  return out;
}

/** 行の命令と本文の中の {@…}（@script と @html の中身の行は渡さない）。 */
function sitesOfLine(line: string): CommandSite[] {
  const indent = indentOf(line);
  if (line[indent] === "@") {
    const site = commandSiteAt(line, indent, "root");
    return site ? [site] : [];
  }
  return inlineCommands(line);
}

/** 引数の値の範囲（"…" で囲んでいれば中身）と値。 */
function valueRange(line: string, token: { start: number; end: number; valueStart: number }): { start: number; end: number; value: string } {
  const raw = line.slice(token.valueStart, token.end);
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return { start: token.valueStart + 1, end: token.end - 1, value: raw.slice(1, -1) };
  return { start: token.valueStart, end: token.end, value: raw };
}

/**
 * キャラクター（cast 型の引数）の場所。行の命令と本文の中の {@…} の、字面で書いた引数（"…" は中身）。
 * マクロの引数も、specOf が @define の仕様を返せば見る。
 */
export function castSites(text: string, script: Script, specOf: SpecOf, name: string): NameSite[] {
  const lines = text.split("\n");
  const out: NameSite[] = [];
  for (const n of [...commandLines(script, null)].sort((a, b) => a - b)) {
    const line = lines[n - 1] ?? "";
    for (const site of sitesOfLine(line)) {
      const spec = specOf(site.name);
      if (!spec) continue;
      for (const [param, { token }] of namedArgs(site.args, spec.positional)) {
        if (spec.params[param]?.type.kind !== "cast") continue;
        const v = valueRange(line, token);
        if (v.value === name) out.push({ line: n, start: v.start, end: v.end });
      }
    }
  }
  return out;
}

/** 台詞の話者の場所（行頭の名前）。 */
export function speakerSites(text: string, script: Script, name: string): NameSite[] {
  const lines = text.split("\n");
  const out: NameSite[] = [];
  visit(script.body, (s) => {
    if (s.kind !== "say" || s.speaker !== name) return;
    const line = lines[s.line - 1] ?? "";
    const lead = /^\s*/.exec(line)![0].length;
    if (line.startsWith(name, lead)) out.push({ line: s.line, start: lead, end: lead + name.length });
  });
  return out;
}

/** 変数の場所（式・@set・{= …}・変数の型の引数。game.x.y の game.x も）。 */
export function variableSites(text: string, script: Script, registry: Registry, name: string): NameSite[] {
  const lines = text.split("\n");
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\p{ID_Continue}_.])${esc}(?![\\p{ID_Continue}_])`, "gu");
  const out: NameSite[] = [];
  for (const n of [...new Set(variableUses(script, registry).filter((u) => u.path === name).map((u) => u.line))].sort((a, b) => a - b)) {
    for (const m of (lines[n - 1] ?? "").matchAll(pattern)) out.push({ line: n, start: m.index!, end: m.index! + name.length });
  }
  return out;
}

/** マクロの場所（@define の名前、呼び出しの命令の名前、本文の中の {@…}、@with の名前）。 */
export function macroSites(text: string, script: Script, name: string): NameSite[] {
  const lines = text.split("\n");
  const out: NameSite[] = [];
  const at = new Set<number>(commandLines(script, name));
  visit(script.body, (s) => {
    if ((s.kind === "define" && s.name === name) || (s.kind === "if" && s.with?.name === name)) at.add(s.line);
  });
  for (const n of [...at].sort((a, b) => a - b)) {
    const line = lines[n - 1] ?? "";
    const indent = indentOf(line);
    const head = /^@(define|with)([ \t]+)([a-z][a-z0-9-]*)/.exec(line.slice(indent));
    if (head && head[3] === name) {
      const start = indent + 1 + head[1]!.length + head[2]!.length;
      out.push({ line: n, start, end: start + name.length });
      continue;
    }
    for (const site of sitesOfLine(line)) if (site.name === name) out.push({ line: n, start: site.nameStart, end: site.nameEnd });
  }
  return out;
}

/** 場所を後ろから to に置き換えた行。 */
function replaceSites(text: string, sites: readonly NameSite[], to: string): string[] {
  const lines = text.split("\n");
  for (const s of [...sites].sort((a, b) => b.line - a.line || b.start - a.start)) {
    const line = lines[s.line - 1] ?? "";
    lines[s.line - 1] = line.slice(0, s.start) + to + line.slice(s.end);
  }
  return lines;
}

// ---- 台本の書き換え ----

/** 変数の名前を変えた台本。 */
export function rewriteVariableInScript(text: string, script: Script, registry: Registry, from: string, to: string): ScriptRewrite {
  const lines = text.split("\n");
  for (const n of new Set(variableUses(script, registry).filter((u) => u.path === from).map((u) => u.line))) lines[n - 1] = renameVariableInLine(lines[n - 1] ?? "", from, to);
  return finish(text, lines);
}

/** キャラクターの名前を変えた台本（cast 型の引数。本文の中の {@…} も）。名前に空白や " を含めないので、"…" で囲んだものは中身だけ替える。 */
export function rewriteCastInScript(text: string, script: Script, specOf: SpecOf, from: string, to: string): ScriptRewrite {
  return finish(text, replaceSites(text, castSites(text, script, specOf, from), to));
}

/** 話者の名前を変えた台本（台詞の行頭）。 */
export function rewriteSpeakerInScript(text: string, script: Script, from: string, to: string): ScriptRewrite {
  return finish(text, replaceSites(text, speakerSites(text, script, from), to));
}

/** マクロの名前を変えた台本（@define、呼び出し、本文の中の {@…}、@with）。 */
export function rewriteMacroInScript(text: string, script: Script, from: string, to: string): ScriptRewrite {
  return finish(text, replaceSites(text, macroSites(text, script, from), to));
}

/** 素材の名前の比べ方（濁点などの合成の違いは同じとみなす。素材の実在の確かめ assetNameResolver と同じ）。 */
const assetKey = (path: string) => path.normalize("NFC");

/** 本文の中に書く素材の名前の字面（空白、"、\、{、} を含むものと、( で始まるものは "…" で囲む）。 */
const inlineValue = (value: string) => (value !== "" && !/[\s"\\{}]/.test(value) && !value.startsWith("(") ? value : JSON.stringify(value));

/**
 * 素材の名前を変えた台本（素材の参照。moves は古いパス → 新しいパス）。書き換えられなかった参照（式で書いたものなど）の行は left。
 * 本文の中の命令（{@se x.wav}）と画像（{img …}）は、行の字面から探し直して書き換える。macros は作品の @define の仕様（素材の型の引数も書き換える）。
 */
export function rewriteAssetInScript(text: string, script: Script, registry: Registry, kind: string, moves: ReadonlyMap<string, string>, macros?: ReadonlyMap<string, CommandSpec>): ScriptRewrite {
  const to = new Map([...moves].map(([a, b]) => [assetKey(a), b]));
  const refs = assetReferences(script, registry, macros).filter((r) => r.folder === kind && to.has(assetKey(r.path)));
  const lines = text.split("\n");
  const left: number[] = [];
  const inline = new Set<number>();
  // 同じ行に二つあるときに桁がずれないよう、後ろの引数から書き換える
  for (const r of refs.sort((a, b) => b.line - a.line || b.column - a.column)) {
    // 本文の中の命令と画像、@staff-roll の {img …} の行は、行の字面から探し直す
    if (r.form === "inline-command" || r.form === "inline-image" || r.form === "staff-roll-image") {
      inline.add(r.line);
      continue;
    }
    // @html の <img src="…">: 桁がパスの頭を指す
    if (r.form === "html-image") {
      const line = lines[r.line - 1] ?? "";
      const next = to.get(assetKey(r.path))!;
      if (line.startsWith(r.path, r.column - 1) && !/["'<>]/.test(next)) lines[r.line - 1] = line.slice(0, r.column - 1) + next + line.slice(r.column - 1 + r.path.length);
      else left.push(r.line);
      continue;
    }
    const next = replaceArgumentValue(lines[r.line - 1] ?? "", r.column, to.get(assetKey(r.path))!, r.path);
    if (next === null) left.push(r.line);
    else lines[r.line - 1] = next;
  }
  for (const n of inline) {
    const next = rewriteInlineAssets(lines[n - 1] ?? "", registry, kind, moves, macros);
    if (next === null) left.push(n);
    else lines[n - 1] = next;
  }
  return finish(text, lines, [...new Set(left)].sort((a, b) => a - b));
}

/**
 * 文の中の本文の中の命令（{@se x.wav}）と画像（{img …}）の素材の名前を替えた文（台本の一行か、訳文）。替えるものが無いか、
 * 書けない名前（{img …} に空白など）なら null。
 */
export function rewriteInlineAssets(line: string, registry: Registry, kind: string, moves: ReadonlyMap<string, string>, macros?: ReadonlyMap<string, CommandSpec>): string | null {
  const to = new Map([...moves].map(([a, b]) => [assetKey(a), b]));
  const sites = inlineAssetSites(line, registry, macros).filter((site) => site.folder === kind && to.has(assetKey(site.path)));
  // {img …} の名前には空白を書けない
  if (sites.length === 0 || sites.some((site) => site.form === "inline-image" && /[\s{}]/.test(to.get(assetKey(site.path))!))) return null;
  return [...sites].reverse().reduce((l, site) => {
    const next = to.get(assetKey(site.path))!;
    return l.slice(0, site.start) + (site.form === "inline-image" ? next : inlineValue(next)) + l.slice(site.end);
  }, line);
}

/** 素材の参照の場所（VS Code の参照の一覧）。字面が見つからない参照は行の頭。 */
export function assetSites(text: string, script: Script, registry: Registry, kind: string, path: string): NameSite[] {
  const lines = text.split("\n");
  const want = assetKey(path);
  const out: NameSite[] = [];
  const inlineLines = new Set<number>();
  for (const r of assetReferences(script, registry)) {
    if (r.folder !== kind || assetKey(r.path) !== want) continue;
    const line = lines[r.line - 1] ?? "";
    if (r.form === "inline-command" || r.form === "inline-image" || r.form === "staff-roll-image") {
      if (inlineLines.has(r.line)) continue;
      inlineLines.add(r.line);
      const sites = inlineAssetSites(line, registry).filter((site) => site.folder === kind && assetKey(site.path) === want);
      if (sites.length === 0) out.push({ line: r.line, start: 0, end: 0 });
      for (const site of sites) out.push({ line: r.line, start: site.start, end: site.end });
      continue;
    }
    const at = line.indexOf(r.path, Math.max(0, r.column - 1));
    const found = at >= 0 ? at : line.indexOf(r.path);
    out.push(found >= 0 ? { line: r.line, start: found, end: found + r.path.length } : { line: r.line, start: 0, end: 0 });
  }
  return out;
}

/**
 * シナリオのファイル from を指す飛び先を to にした台本（@jump・@call・@use・選択肢・飛び先の型の引数。本文の中の {@…} の引数と、
 * 式の visits("ファイル#ラベル")・read("ファイル") も）。
 */
export function rewriteFileInScript(text: string, script: Script, specOf: SpecOf, from: string, to: string): ScriptRewrite {
  const lines = text.split("\n");
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const at = (n: number, pattern: RegExp) => {
    const line = lines[n - 1];
    if (line !== undefined) lines[n - 1] = line.replace(pattern, (_m, head: string) => head + to);
  };
  visit(script.body, (s) => {
    if ((s.kind === "jump" || s.kind === "call") && s.target.file === from) at(s.line, new RegExp(`(@(?:jump|call)\\s+)${esc}(?=#|\\s|$)`));
    if (s.kind === "use" && s.file === from) at(s.line, new RegExp(`(@use\\s+)${esc}(?=\\s|$)`));
    if (s.kind === "choice") for (const o of s.options) if (o.target.file === from) at(o.line, new RegExp(`( -> )${esc}(?=#|\\s|$)`));
    if (s.kind === "command") {
      const spec = specOf(s.name);
      if (!spec) return;
      let pos = 0;
      const edits: { column: number; value: string; next: string }[] = [];
      for (const a of normalizeBooleanArgs(spec, s.args)) {
        const key = a.key ?? spec.positional[pos++];
        if (!key || spec.params[key]?.type.kind !== "target" || a.value.kind !== "string") continue;
        const v = a.value.value;
        if (v === from || v.startsWith(`${from}#`)) edits.push({ column: a.column, value: v, next: to + v.slice(from.length) });
      }
      for (const e of edits.sort((a, b) => b.column - a.column)) {
        const next = replaceArgumentValue(lines[s.line - 1] ?? "", e.column, e.next, e.value);
        if (next !== null) lines[s.line - 1] = next;
      }
    }
  });
  const renamed = (v: string) => (v === from || v.startsWith(`${from}#`) ? to + v.slice(from.length) : null);
  // 本文と選択肢の文の中の {@…} の target 型の引数（`{@cutin x target=ファイル#ラベル}`）
  for (const n of [...commandLines(script, null)].sort((a, b) => a - b)) {
    const line = lines[n - 1] ?? "";
    const edits: { start: number; end: number; next: string }[] = [];
    for (const site of inlineCommands(line)) {
      const spec = specOf(site.name);
      if (!spec) continue;
      for (const [param, { token }] of namedArgs(site.args, spec.positional)) {
        if (spec.params[param]?.type.kind !== "target") continue;
        const v = valueRange(line, token);
        const next = renamed(v.value);
        if (next !== null) edits.push({ start: v.start, end: v.end, next });
      }
    }
    lines[n - 1] = edits.sort((a, b) => b.start - a.start).reduce((l, e) => l.slice(0, e.start) + e.next + l.slice(e.end), line);
  }
  // 式の中の飛び先の関数（visits("ファイル#ラベル")、read("ファイル")）。条件、@set、{= …}、命令の if=(…) と式の引数
  for (const n of expressionLines(script)) {
    const line = lines[n - 1];
    if (line === undefined) continue;
    lines[n - 1] = line.replace(TARGET_CALL, (whole, head: string, literal: string) => {
      let value: unknown;
      try {
        value = JSON.parse(literal);
      } catch {
        // 文字の値として読めないものは書き換えない
        return whole;
      }
      const next = typeof value === "string" ? renamed(value) : null;
      return next === null ? whole : `${head}${JSON.stringify(next)}`;
    });
  }
  return finish(text, lines);
}

/** 式の中の飛び先を受け取る関数の呼び出し（@liminalia/lang の TARGET_FUNCTIONS）と、その最初の引数の "…"。 */
const TARGET_CALL = new RegExp(`(\\b(?:${[...TARGET_FUNCTIONS].join("|")})\\(\\s*)("(?:\\\\.|[^"\\\\])*")`, "g");

/** 式を書ける行（条件の @if と @elif、@set、@let、@function、@return、命令、本文と選択肢、@jump と @call）。コメントと @script、@html の中は入れない。 */
function expressionLines(script: Script): number[] {
  const out = new Set<number>();
  visit(script.body, (s) => {
    if (s.kind === "if") {
      for (const b of s.branches) if (b.condition) out.add(b.line);
    } else if (s.kind === "choice") for (const o of s.options) out.add(o.line);
    else if (s.kind !== "label" && s.kind !== "script" && s.kind !== "define") out.add(s.line);
  });
  return [...out].sort((a, b) => a - b);
}

// ---- liminalia.json ----

/** 設定の中の条件（鍵 "if" の文字列）の変数の名前を替える。替えたら true。 */
function renameInConditions(node: unknown, from: string, to: string): boolean {
  if (!node || typeof node !== "object") return false;
  let changed = false;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "if" && typeof v === "string") {
      const next = renameVariableInLine(v, from, to);
      if (next !== v) {
        (node as Record<string, unknown>)[k] = next;
        changed = true;
      }
    } else if (renameInConditions(v, from, to)) changed = true;
  }
  return changed;
}

/**
 * liminalia.json の変数の名前を替える（variables の初期値の名前と、ui と extra の条件 "if"）。temp の変数には初期値を置かない。替えたら true。
 */
export function rewriteConfigVariable(raw: Record<string, unknown>, from: string, to: string): boolean {
  let changed = false;
  const vars = raw.variables as Record<string, unknown> | undefined;
  if (vars && typeof vars === "object" && from in vars) {
    const initial = vars[from];
    const next = { ...vars };
    delete next[from];
    if (!to.startsWith("temp.")) next[to] = initial;
    raw.variables = next;
    changed = true;
  }
  for (const key of ["ui", "extra"]) if (renameInConditions(raw[key], from, to)) changed = true;
  return changed;
}

/**
 * liminalia.json の ui・extra・items にある、素材 kind の参照を moves のとおりに書き換える。書き換えた場所（"ui.title.background" など）を返す。
 * 素材の参照かどうかは、その値を目印に替えてみて uiAssetReferences などがその種類の素材として挙げるかで決める（同じ名前の文字列の項目は替えない）。
 */
export function rewriteConfigAssets(raw: Record<string, unknown>, kind: string, moves: ReadonlyMap<string, string>): string[] {
  const MARK = "\u0000liminalia-rename\u0000";
  const refs = () => [...uiAssetReferences(raw.ui as UiConfig | undefined), ...extraAssetReferences(raw.extra as Parameters<typeof extraAssetReferences>[0]), ...itemAssetReferences(raw.items)];
  const where: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (typeof v === "string") {
        const next = moves.get(v);
        if (next === undefined) continue;
        obj[key] = MARK;
        const hit = refs().find((r) => r.folder === kind && r.path === MARK);
        obj[key] = hit ? next : v;
        if (hit) where.push(hit.where);
      } else walk(v);
    }
  };
  for (const key of ["ui", "extra", "items"]) walk(raw[key]);
  return where;
}

/**
 * liminalia.json の、シナリオのファイル from を指す飛び先を to にする（entry・afterLoad・extra.replay と extra.chapters の target・
 * extra.flowchart.titles の鍵・飛び先に使う変数の初期値・chapters の files（ワイルドカードでない名前）・scenes の鍵・check.sound.quiet）。
 * 書き換えた場所を返す。ワイルドカードの名前は書き換えない（新しい名前に当たらなくなるものは configFileLeft が挙げる）。
 */
export function rewriteConfigFile(raw: Record<string, unknown>, from: string, to: string, variables: ReadonlySet<string>): string[] {
  const where: string[] = [];
  const next = (v: unknown) => (typeof v !== "string" ? null : v === from ? to : v.startsWith(`${from}#`) ? to + v.slice(from.length) : null);
  // 章のシナリオファイル
  for (const c of Array.isArray(raw.chapters) ? (raw.chapters as { id?: unknown; files?: unknown }[]) : []) {
    if (!c || typeof c !== "object" || !Array.isArray(c.files) || !c.files.includes(from)) continue;
    c.files = c.files.map((p) => (p === from ? to : p));
    where.push(`chapters.${String(c.id ?? "")}.files`);
  }
  // 場面ごとの情報（鍵が `ファイル` か `ファイル#ラベル`）と、わざと無音にした場面
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
  for (const key of ["entry", "afterLoad"]) {
    const v = next(raw[key]);
    if (v !== null) {
      raw[key] = v;
      where.push(key);
    }
  }
  const extra = raw.extra as { replay?: { id?: string; target?: unknown }[]; chapters?: { id?: string; target?: unknown }[]; flowchart?: { titles?: Record<string, string> } } | undefined;
  for (const [name, list] of [["replay", extra?.replay], ["chapters", extra?.chapters]] as const) {
    for (const item of Array.isArray(list) ? list : []) {
      const v = next(item?.target);
      if (v !== null) {
        item.target = v;
        where.push(`extra.${name}.${item.id ?? ""}`);
      }
    }
  }
  const titles = extra?.flowchart && typeof extra.flowchart === "object" ? extra.flowchart.titles : undefined;
  if (titles && Object.keys(titles).some((k) => next(k) !== null)) {
    extra!.flowchart!.titles = Object.fromEntries(Object.entries(titles).map(([k, v]) => [next(k) ?? k, v]));
    where.push("extra.flowchart.titles");
  }
  const vars = raw.variables as Record<string, unknown> | undefined;
  for (const [path, value] of Object.entries(vars ?? {})) {
    const v = variables.has(path) ? next(value) : null;
    if (v === null) continue;
    vars![path] = v;
    where.push(`variables.${path}`);
  }
  return where;
}

/**
 * シナリオのファイルの名前を from から to に変えると、ワイルドカードの名前（chapters の files の `part*` など）で入っていた章から外れるか
 * 別の章に入るとき、その場所と名前（"chapters.ch2.files: part*"）。raw は rewriteConfigFile で書き換える前のもの。直すのは書き手。
 */
export function configFileLeft(raw: Record<string, unknown>, from: string, to: string): string[] {
  const chapters = Array.isArray(raw.chapters) ? (raw.chapters as ChapterInfo[]).filter((c) => c && typeof c === "object") : [];
  const before = chapterOf(chapters, from);
  if (!before || before.files?.includes(from)) return [];
  const after = chapterOf(chapters, to);
  if (after === before) return [];
  const patterns = (before.files ?? []).filter((p) => typeof p === "string" && p.includes("*") && chapterOf([{ ...before, files: [p] }], from) !== null);
  return patterns.map((p) => `chapters.${String(before.id ?? "")}.files: ${p}`);
}

/** システムボイスの担当のキャラクター（ui.systemVoice の character）を替える。替えたら true。 */
function renameVoiceCharacter(node: unknown, from: string, to: string): boolean {
  if (!node || typeof node !== "object") return false;
  let changed = false;
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v) && (v as { character?: unknown }).character === from) {
      (v as { character: string }).character = to;
      changed = true;
    } else if (renameVoiceCharacter(v, from, to)) changed = true;
  }
  return changed;
}

/** liminalia.json のキャラクターの名前を替える（ui.systemVoice の character）。替えたら true。 */
export function rewriteConfigCast(raw: Record<string, unknown>, from: string, to: string): boolean {
  return renameVoiceCharacter((raw.ui as { systemVoice?: unknown } | undefined)?.systemVoice, from, to);
}

/** liminalia.json のマクロの名前を替える（commandDefaults の鍵）。並びは保つ。替えたら true。 */
export function rewriteConfigMacro(raw: Record<string, unknown>, from: string, to: string, keep = false): boolean {
  const defaults = raw.commandDefaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults) || !(from in defaults) || to in defaults) return false;
  // keep: 同じ名前のマクロがほかのファイルにも残るので、元の鍵は残して新しい鍵へ写す
  raw.commandDefaults = keep
    ? { ...defaults, [to]: structuredClone((defaults as Record<string, unknown>)[from]) }
    : Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k === from ? to : k, v]));
  return true;
}

// ---- cast.json ----

/**
 * cast.json の名前を替える。kind が cast ならキャラクターの鍵（キャラクター名がそのまま話者名だったものは、話者名を保つ）、
 * speaker なら speakers と、話者がその名前のキャラクターの speaker。
 */
export function renameInCast(cast: Cast, file: { speakers: string[] }, kind: "cast" | "speaker", from: string, to: string): void {
  if (kind === "cast") {
    const entries = Object.entries(cast);
    for (const k of Object.keys(cast)) delete cast[k];
    for (const [k, v] of entries) {
      if (k === from && v.speaker === undefined && file.speakers.includes(from)) v.speaker = from;
      cast[k === from ? to : k] = v;
    }
    return;
  }
  file.speakers = file.speakers.map((s) => (s === from ? to : s));
  for (const [k, v] of Object.entries(cast)) {
    if (v.speaker === from || (v.speaker === undefined && k === from)) v.speaker = to;
    // 表示名が ID と同じになったら書かない（ID の変更と一緒に表示名も変えたとき。台詞の名前が ID と同じなら speaker は要らない）
    if (v.speaker === k && file.speakers.includes(k)) delete v.speaker;
  }
}

/** cast.json の立ち絵の画像（image と口パク・まばたきの画像）のパスを moves のとおりに替える。替えたら true。 */
export function moveCastImages(cast: Cast, moves: ReadonlyMap<string, string>): boolean {
  let changed = false;
  for (const entry of Object.values(cast)) {
    for (const a of Object.values(entry.appearances ?? {})) {
      for (const v of Object.values(a.variants ?? {})) {
        const image = moves.get(v.image);
        if (image) {
          v.image = image;
          changed = true;
        }
        for (const part of ["lip", "blink"] as const) {
          const list = v[part];
          if (!list?.some((p) => moves.has(p))) continue;
          v[part] = list.map((p) => moves.get(p) ?? p);
          changed = true;
        }
      }
    }
  }
  return changed;
}

// ---- 訳と voice-lock.json ----

/** 鍵が "ファイル:…" の表の、ファイルの部分を from から to にする。 */
export function renameKeyFile<T>(table: Record<string, T>, from: string, to: string): Record<string, T> {
  return Object.fromEntries(Object.entries(table).map(([k, v]) => [k.slice(0, k.lastIndexOf(":")) === from ? `${to}${k.slice(k.lastIndexOf(":"))}` : k, v]));
}

/** 訳の鍵のファイルの部分を替えたもの（台本の名前を変えたとき。訳はそのまま使われ続ける）。 */
export function renameTranslationFileKeys(file: TranslationFile, from: string, to: string): TranslationFile {
  return { ...file, ...(file.lines ? { lines: renameKeyFile(file.lines, from, to) } : {}), ...(file.stale ? { stale: renameKeyFile(file.stale, from, to) } : {}) };
}

/** 訳の話者名の表（speakers）の鍵と、訳す人に見せる話者（speaker）を替えたもの。 */
export function renameTranslationSpeaker(file: TranslationFile, from: string, to: string): TranslationFile {
  const fix = (table: Record<string, TranslationEntry> | undefined) => table && Object.fromEntries(Object.entries(table).map(([k, e]) => [k, e.speaker === from ? { ...e, speaker: to } : e]));
  const speakers = file.speakers && from in file.speakers && !(to in file.speakers) ? Object.fromEntries(Object.entries(file.speakers).map(([k, v]) => [k === from ? to : k, v])) : file.speakers;
  return { ...file, ...(speakers ? { speakers } : {}), ...(file.lines ? { lines: fix(file.lines)! } : {}), ...(file.stale ? { stale: fix(file.stale)! } : {}) };
}

/**
 * 訳の鍵を、同じ行の新しい鍵へ付け替えたもの（本文の中を書き換えた行。label-follow.ts の translationMoves）。訳文は rewrite で書き換える
 * （訳文の中の {= 変数} や {@マクロ} も同じ名前に）。変わらなければ null。
 */
export function moveTranslationEntries(file: TranslationFile, moves: TranslationMoves, rewrite: (text: string) => string = (t) => t): TranslationFile | null {
  if (moves.size === 0) return null;
  const move = (table: Record<string, TranslationEntry>): Record<string, TranslationEntry> =>
    Object.fromEntries(
      Object.entries(table).map(([k, e]) => {
        const m = moves.get(k);
        if (!m) return [k, e];
        const contexts = e.contexts ? Object.fromEntries(Object.entries(e.contexts).map(([c, v]) => [c, rewrite(v)])) : undefined;
        return [m.key, { ...e, source: m.source, text: rewrite(e.text), ...(contexts ? { contexts } : {}) }];
      }),
    );
  const next: TranslationFile = { ...file, ...(file.lines ? { lines: move(file.lines) } : {}), ...(file.stale ? { stale: move(file.stale) } : {}) };
  return JSON.stringify(next) === JSON.stringify(file) ? null : next;
}

/** voice-lock.json の鍵（"ファイル:v…"）のファイルの部分を替えたもの（台本の名前を変えたとき。番号はそのまま）。 */
export function renameVoiceLockFileKeys(lock: VoiceLock, from: string, to: string): VoiceLock {
  return { ...lock, lines: renameKeyFile(lock.lines ?? {}, from, to), ...(lock.retired ? { retired: renameKeyFile(lock.retired, from, to) } : {}) };
}

/** voice-lock.json の話者を替えたもの（鍵の付け替えは label-follow.ts の moveVoiceLock で先に行う）。 */
export function renameVoiceLockSpeaker(lock: VoiceLock, from: string, to: string): VoiceLock {
  const fix = (table: Record<string, VoiceLockEntry>) => Object.fromEntries(Object.entries(table).map(([k, e]) => [k, e.speaker === from ? { ...e, speaker: to } : e]));
  return { ...lock, lines: fix(lock.lines ?? {}), ...(lock.retired ? { retired: fix(lock.retired) } : {}) };
}

// ---- .liminalia/studio.json ----

/** 覚え書きの、変数の名前（ブレークポイントの条件）を替えたもの。変わらなければ null。 */
export function renameStateVariable(st: StudioState, from: string, to: string): StudioState | null {
  if (!st.breakpoints?.some((b) => b.cond !== undefined && renameVariableInLine(b.cond, from, to) !== b.cond)) return null;
  return { ...st, breakpoints: st.breakpoints.map((b) => (b.cond === undefined ? b : { ...b, cond: renameVariableInLine(b.cond, from, to) })) };
}

/** 覚え書きの、キャラクターの名前（顔の切り出しと覚え書き）を替えたもの。変わらなければ null。 */
export function renameStateCast(st: StudioState, from: string, to: string): StudioState | null {
  if (!st.faces?.[from] && !st.castNotes?.[from]) return null;
  const rename = <T>(table: Record<string, T> | undefined) => (table && from in table ? Object.fromEntries(Object.entries(table).map(([k, v]) => [k === from ? to : k, v])) : table);
  const faces = rename(st.faces);
  const notes = rename(st.castNotes);
  return { ...st, ...(faces ? { faces } : {}), ...(notes ? { castNotes: notes } : {}) };
}

/** 覚え書きの、立ち絵の画像のパス（頭の印）を替えたもの（fgimage の素材の名前を変えたとき）。変わらなければ null。 */
export function renameStateAssets(st: StudioState, moves: ReadonlyMap<string, string>): StudioState | null {
  if (!st.heads || !Object.keys(st.heads).some((k) => moves.has(k))) return null;
  return { ...st, heads: Object.fromEntries(Object.entries(st.heads).map(([k, v]) => [moves.get(k) ?? k, v])) };
}

/** 覚え書きの、シナリオのファイルの名前（ブックマーク、ブレークポイント、最後に開いていた場所、フローチャートの位置、シーンの印）を替えたもの。 */
export function renameStateFile(st: StudioState, from: string, to: string): StudioState {
  const moveId = (id: string) => (id === from ? to : id.startsWith(`${from}#`) ? to + id.slice(from.length) : id);
  const next = { ...st };
  if (next.bookmarks?.[from]) next.bookmarks = Object.fromEntries(Object.entries(next.bookmarks).map(([k, v]) => [k === from ? to : k, v]));
  if (next.breakpoints) next.breakpoints = next.breakpoints.map((b) => (b.file === from ? { ...b, file: to } : b));
  if (next.lastOpen?.file === from) next.lastOpen = { ...next.lastOpen, file: to };
  if (next.mapPositions) next.mapPositions = Object.fromEntries(Object.entries(next.mapPositions).map(([k, v]) => [moveId(k), v]));
  if (next.sceneMarks) next.sceneMarks = Object.fromEntries(Object.entries(next.sceneMarks).map(([k, v]) => [moveId(k), v]));
  return next;
}

/** 変数の名前として使える形か（game.名前・system.名前・temp.名前）。 */
export { isVariablePath };
