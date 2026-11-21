import type { Inline, Script, Statement } from "./ast.ts";
import { splitBom, stripBom } from "./encoding.ts";
import { parse } from "./parser.ts";
import { hash } from "./text-hash.ts";

/**
 * 校正のための道具。
 * - 校正用の台本（lim script-export、制作画面の書き出し）: 本文（台詞・地の文・選択肢の文）とシーンの見出しだけを、ファイルごとに
 *   テキストか HTML で書き出す。話者名を添え、ルビはテキストなら ｜親文字《よみ》、HTML なら <ruby>
 * - 本文の抜き出しと書き戻し（lim prose extract / apply）: 本文の行だけを行の鍵付きで書き出し、直したものを読み、本文以外
 *   （行の種類、話者、本文の中のコマンドと値、選択肢のジャンプ先）が変わっていないことを確かめてから元の行に戻す
 * - 《》のルビ（青空文庫の書き方）と {r 親文字|よみ} の行き来（テキストのインポートでも使う）
 */

/**
 * 《》のルビ（｜親文字《よみ》と、漢字《かなのよみ》）。｜の無い形は読みが仮名だけのもの（「絵画《星月夜》」のような題の括弧は当てない）。
 * 親文字は 1 か 2、読みは 3 か 4 に入る。構文チェックの aozora-ruby も使う。
 */
export const AOZORA_RUBY = /[｜|]([^｜|《》\s]+)《([^《》]+)》|([\p{sc=Han}々〆ヵヶ]+)《([\p{sc=Hiragana}\p{sc=Katakana}ー]+)》/gu;

/** 本文の《》のルビを {r 親文字|よみ} にする（テキストのインポート、lim prose apply）。{ } と \ はルビの中で使えないので、それを含むものは変えない。 */
export function aozoraToRuby(text: string): string {
  return text.replace(AOZORA_RUBY, (all, a?: string, b?: string, c?: string, d?: string) => {
    const base = a ?? c!;
    const reading = b ?? d!;
    return /[{}\\|]/.test(base + reading) ? all : `{r ${base}|${reading}}`;
  });
}

/** .lim の本文の行の {r 親文字|よみ} を ｜親文字《よみ》 にする（lim prose extract の既定）。 */
export function rubyToAozora(text: string): string {
  return text.replace(/\{r ([^|{}\\]+)\|([^{}\\]+)\}/g, (_all, base: string, reading: string) => `｜${base}《${reading}》`);
}

// ---- 校正用の台本 ----

export type ScriptExportFormat = "text" | "html";

/** 本文の見え方（ルビは style のとおり、{br} は改行、値は {= 式} のまま、コマンドとクリック待ちは出さない）。 */
function shownText(content: readonly Inline[], style: ScriptExportFormat): string {
  let out = "";
  for (const n of content) {
    switch (n.kind) {
      case "text":
        out += style === "html" ? escapeHtml(n.text) : n.text;
        break;
      case "ruby":
        out += style === "html" ? `<ruby>${escapeHtml(n.base)}<rt>${escapeHtml(n.reading)}</rt></ruby>` : `｜${n.base}《${n.reading}》`;
        break;
      case "value":
        out += style === "html" ? `<code>{= ${escapeHtml(n.source)}}</code>` : `{= ${n.source}}`;
        break;
      case "br":
        out += style === "html" ? "<br>" : "\n";
        break;
      case "image":
        break;
      case "click":
      case "noclick":
      case "command":
        break;
      default:
        if ("children" in n) out += shownText(n.children, style);
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** 校正用の台本の一行（line は .lim の行）。 */
export interface ScriptExportLine {
  line: number;
  kind: "label" | "say" | "prose" | "option";
  /** 話者名（台詞だけ。{name …} があればその表示名）。 */
  speaker?: string;
  text: string;
}

/** 台本の本文とシーンの見出しを、書いた順に並べる（@if の枝の中も。コマンドは出さない）。 */
export function scriptExportLines(script: Script, style: ScriptExportFormat = "text"): ScriptExportLine[] {
  const out: ScriptExportLine[] = [];
  const visit = (body: readonly Statement[]) => {
    for (const s of body) {
      if (s.kind === "label") out.push({ line: s.line, kind: "label", text: s.name });
      else if (s.kind === "say") out.push({ line: s.line, kind: "say", speaker: s.name ? shownText(s.name, "text") : s.speaker, text: shownText(s.content, style) });
      else if (s.kind === "prose") out.push({ line: s.line, kind: "prose", text: shownText(s.content, style) });
      else if (s.kind === "choice") for (const o of s.options) out.push({ line: o.line, kind: "option", text: shownText(o.content, style) });
      else if (s.kind === "if") for (const b of s.branches) visit(b.body);
      else if (s.kind === "define") visit(s.body);
    }
  };
  visit(script.body);
  return out;
}

/** 台詞の話者名と本文のつなぎ（引用符の台詞 `Yui "…"` は空白を挟む）。 */
const joinSpeaker = (speaker: string, text: string) => `${speaker}${/^["“]/.test(text) ? " " : ""}${text}`;

/** 校正用の台本のテキスト（一ファイル分）。lines なら行の頭に .lim の行番号とタブを付ける。 */
export function scriptExportText(file: string, script: Script, o: { lines?: boolean; choiceLabel?: string } = {}): string {
  const rows: string[] = [`${file}.lim`, ""];
  const choice = o.choiceLabel ?? "選択肢";
  for (const l of scriptExportLines(script, "text")) {
    if (l.kind === "label") {
      // シーンの見出しの前は一行あける
      if (rows.at(-1) !== "") rows.push("");
      rows.push(`# ${l.text}`);
      continue;
    }
    const body = l.kind === "say" ? joinSpeaker(l.speaker!, l.text) : l.kind === "option" ? `${choice}: ${l.text}` : l.text;
    // {br} の改行の後ろは、行番号の欄をあけてそろえる
    const text = o.lines ? body.replace(/\n/g, "\n\t") : body;
    rows.push(o.lines ? `${l.line}\t${text}` : text);
  }
  return `${rows.join("\n")}\n`;
}

/** 校正用の台本の HTML（一ファイル分。印刷しても読める、外の素材を読まない一枚のページ）。 */
export function scriptExportHtml(file: string, script: Script, o: { lang?: string; choiceLabel?: string; title?: string } = {}): string {
  const choice = o.choiceLabel ?? "選択肢";
  const rows: string[] = [];
  for (const l of scriptExportLines(script, "html")) {
    const no = `<span class="no">${l.line}</span>`;
    if (l.kind === "label") rows.push(`<h2 id="${escapeHtml(l.text)}">${no}# ${escapeHtml(l.text)}</h2>`);
    else if (l.kind === "say") rows.push(`<p class="say">${no}<b>${escapeHtml(l.speaker!)}</b>${/^["“]/.test(l.text) ? " " : ""}${l.text}</p>`);
    else if (l.kind === "option") rows.push(`<p class="option">${no}<span class="mark">${escapeHtml(choice)}</span>${l.text}</p>`);
    else rows.push(`<p>${no}${l.text}</p>`);
  }
  const title = escapeHtml(o.title ? `${o.title} ${file}.lim` : `${file}.lim`);
  return `<!doctype html>
<html lang="${escapeHtml(o.lang ?? "ja")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body { font-family: serif; line-height: 1.9; max-width: 44em; margin: 2em auto; padding: 0 1em; color: #222; background: #fff; }
h1 { font-size: 1.2em; }
h2 { font-size: 1em; margin: 2em 0 0.5em; border-bottom: 0.5px solid #999; }
p { margin: 0.2em 0; padding-left: 3.5em; text-indent: -3.5em; white-space: pre-wrap; }
.no { display: inline-block; width: 3em; margin-right: 0.5em; color: #888; font-family: sans-serif; font-size: 0.8em; text-align: right; text-indent: 0; }
h2 .no { width: auto; }
.say b { margin-right: 0.2em; }
.mark { margin-right: 0.5em; color: #666; font-family: sans-serif; font-size: 0.8em; }
code { font-size: 0.85em; color: #555; }
@media print { body { margin: 0; } }
</style>
</head>
<body>
<h1>${title}</h1>
${rows.join("\n")}
</body>
</html>
`;
}

// ---- 本文の抜き出しと書き戻し（lim prose） ----

export type ProseRuby = "aozora" | "lim";

/** 抜き出した本文の一行。key は ファイル:行 と、元の行の中身の hash（書き戻すときに元の行が変わっていないかを見る）。 */
export interface ProseEntry {
  file: string;
  line: number;
  hash: string;
  /** 直す本文（台詞は話者から、選択肢は - から -> の前まで。字下げは含まない）。 */
  text: string;
}

/** 行の前後の半角の空白とタブを除く（全角の空白は本文なので残す）。 */
const strip = (row: string) => row.replace(/^[ \t]+|[ \t\r]+$/g, "");

/** 行の hash（字下げと行末の空白を除いた中身の 6 桁）。 */
const lineHash = (row: string) => hash(strip(row)).slice(0, 6);

/** 選択肢の行の、直す本文（`- 文`）と残りの ` -> 飛び先 …`。 */
function splitOption(row: string): { text: string; rest: string } | null {
  const trimmed = strip(row);
  const arrow = trimmed.lastIndexOf(" -> ");
  return trimmed.startsWith("- ") && arrow > 0 ? { text: trimmed.slice(0, arrow), rest: trimmed.slice(arrow) } : null;
}

/** 台本の本文の行（台詞・地の文・選択肢）を抜き出す。ruby が aozora なら {r 親|よみ} を ｜親《よみ》 にする。 */
export function proseEntries(file: string, source: string, speakers: readonly string[] = [], ruby: ProseRuby = "aozora"): ProseEntry[] {
  const rows = stripBom(source).split("\n").map((r) => r.replace(/\r$/, ""));
  const out: ProseEntry[] = [];
  for (const l of scriptExportLines(parse(source, file, { speakers }))) {
    if (l.kind === "label") continue;
    const row = rows[l.line - 1] ?? "";
    const text = l.kind === "option" ? (splitOption(row)?.text ?? null) : strip(row);
    if (text === null) continue;
    out.push({ file, line: l.line, hash: lineHash(row), text: ruby === "aozora" ? rubyToAozora(text) : text });
  }
  return out;
}

/** 抜き出した本文のファイルの頭（直す人への案内）。 */
const HEADER = {
  ja: "// lim prose: 行の頭の [ … ] は変えずに、その後ろの本文だけを直します。行を足したり消したりしません。",
  en: "// lim prose: Edit only the text after the [ … ] at the start of each line. Don't add or delete lines.",
};

/** 抜き出した本文を一つの文書にする（ファイルごとに // file: の行で区切る。頭に案内とルビの書き方）。 */
export function proseDocument(entries: readonly ProseEntry[], ruby: ProseRuby = "aozora", language: "ja" | "en" = "ja"): string {
  const rows = [HEADER[language], `// ruby: ${ruby}`];
  let current = "";
  for (const e of entries) {
    if (e.file !== current) {
      rows.push("", `// file: ${e.file}`);
      current = e.file;
    }
    rows.push(`[${e.file}:${e.line} ${e.hash}] ${e.text}`);
  }
  return `${rows.join("\n")}\n`;
}

/** 直した文書を読む。読めない行（鍵の形でない行。コメントと空行は除く）は problems に。 */
export function readProseDocument(text: string): { ruby: ProseRuby; entries: ProseEntry[]; problems: { line: number; text: string }[] } {
  let ruby: ProseRuby = "lim";
  const entries: ProseEntry[] = [];
  const problems: { line: number; text: string }[] = [];
  for (const [i, raw] of stripBom(text).split("\n").entries()) {
    const row = raw.replace(/\r$/, "");
    if (row.trim() === "") continue;
    if (row.startsWith("//")) {
      const m = /^\/\/\s*ruby:\s*(aozora|lim)\s*$/.exec(row);
      if (m) ruby = m[1] as ProseRuby;
      continue;
    }
    const m = /^\[([^\]]+):(\d+) ([0-9a-f]{6})\] ?(.*)$/.exec(row);
    if (!m) {
      problems.push({ line: i + 1, text: row });
      continue;
    }
    entries.push({ file: m[1]!, line: Number(m[2]), hash: m[3]!, text: m[4]! });
  }
  return { ruby, entries, problems };
}

/** 本文以外の形（行の種類、話者、表示名の有無、本文の中のコマンドと値の並び）。直す前と後で同じでなければ書き戻さない。 */
function skeleton(statement: Statement | undefined): string | null {
  if (!statement) return null;
  const inline = (content: readonly Inline[]): unknown[] =>
    content.flatMap((n): unknown[] => {
      if (n.kind === "command") return [{ command: n.name, args: n.args.map((a) => ({ key: a.key, value: a.value.kind === "expr" ? a.value.source : a.value })) }];
      if (n.kind === "value") return [{ value: n.source }];
      if (n.kind === "click" || n.kind === "noclick") return [n.kind];
      return "children" in n ? inline(n.children) : [];
    });
  if (statement.kind === "say") return JSON.stringify({ say: statement.speaker, name: !!statement.name, inline: inline(statement.content) });
  if (statement.kind === "prose") return JSON.stringify({ prose: true, inline: inline(statement.content) });
  if (statement.kind === "choice") {
    const o = statement.options[0];
    return o ? JSON.stringify({ option: true, target: o.target, args: o.args.map((a) => ({ key: a.key, value: a.value.kind === "expr" ? a.value.source : a.value })), inline: inline(o.content) }) : null;
  }
  return null;
}

/** 一行だけを読んで、本文以外の形を取る（選択肢は @choice の中として読む）。読めない（誤りがある）なら null。 */
function rowSkeleton(row: string, option: boolean, speakers: readonly string[]): string | null {
  const text = option ? `@choice\n${row}\n@end` : row;
  const script = parse(text, "prose", { speakers });
  if (script.diagnostics.some((d) => d.severity === "error") || script.body.length !== 1) return null;
  return skeleton(script.body[0]);
}

export interface ProseApplyResult {
  /** 書き戻した台本（変わらなければ元のまま）。 */
  text: string;
  applied: number;
  unchanged: number;
  /** 書き戻さなかった行と理由（stale: 抜き出したあとで元の行が変わった、shape: 本文以外が変わった・読めない、missing: 行が無い）。 */
  rejected: { line: number; reason: "stale" | "shape" | "missing"; text: string }[];
}

/**
 * 直した本文を一つのファイルに書き戻す。元の行が抜き出したときのまま（hash が同じ）で、直した行の本文以外が変わっていないものだけを当てる。
 * 字下げと、選択肢の -> から後ろはそのまま残す。ruby が aozora なら ｜親《よみ》 と 漢字《かな》 を {r 親|よみ} に戻す。
 */
export function applyProse(source: string, entries: readonly ProseEntry[], speakers: readonly string[] = [], ruby: ProseRuby = "lim"): ProseApplyResult {
  // 頭の BOM は外して読み、書き戻すときに頭に戻す（proseEntries と同じ読み方）
  const { bom, text: body } = splitBom(source);
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const rows = body.split(/\r?\n/);
  const out: ProseApplyResult = { text: source, applied: 0, unchanged: 0, rejected: [] };
  for (const e of entries) {
    const row = rows[e.line - 1];
    if (row === undefined) {
      out.rejected.push({ line: e.line, reason: "missing", text: e.text });
      continue;
    }
    if (lineHash(row) !== e.hash) {
      out.rejected.push({ line: e.line, reason: "stale", text: e.text });
      continue;
    }
    const indent = /^[ \t]*/.exec(row)![0];
    const option = splitOption(row);
    const text = ruby === "aozora" ? aozoraToRuby(e.text) : e.text;
    const next = option ? `${indent}${strip(text)}${option.rest}` : `${indent}${strip(text)}`;
    if (next === row) {
      out.unchanged++;
      continue;
    }
    const before = rowSkeleton(strip(row), !!option, speakers);
    const after = rowSkeleton(strip(next), !!option, speakers);
    if (before === null || after === null || before !== after || (option && !strip(text).startsWith("- "))) {
      out.rejected.push({ line: e.line, reason: "shape", text: e.text });
      continue;
    }
    rows[e.line - 1] = next;
    out.applied++;
  }
  if (out.applied > 0) out.text = bom + rows.join(newline);
  return out;
}

/** 抜き出しの鍵の hash（テストと、書き戻す前の確かめに使う）。 */
export function proseLineHash(row: string): string {
  return lineHash(row);
}
