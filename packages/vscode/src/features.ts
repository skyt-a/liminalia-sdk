import { opensBody, appearanceKey, AUTO_POSITION, CHOICE_OPTION, commandExample, commandSummary, englishDiagnostic, GUARD_PARAM, paramDoc, FRAME_POSITIONS, positionNames, renamedParam, resolveTargetText, resolveVariant, targetSiteAt, uiParamNames, type CommandSpec, type Diagnostic, type ParamSpec, type ParamType } from "@liminalia/lang";
import type {
  CompletionItem,
  Diagnostic as LspDiagnostic,
  DocumentSymbol,
  FoldingRange,
  Hover,
  Location,
  Position,
  Range,
} from "vscode-languageserver";
import type { Lang } from "./actions.ts";
import { walk, type DefineInfo, type LimProject } from "./model.ts";
import { exprCompletions, exprHover, exprSiteAt } from "./expr.ts";
import { argNames, blockAt, commandSiteAt, indentOf, namedArgs, optionSite, tokenAt, trimIndent, type CommandSite, type Token } from "@liminalia/lang/line-syntax";

/**
 * 補完・説明・定義へ移動・目次・診断の変換。LimProject（ファイルに触らないプロジェクト）から求める。
 * 戻り値は LSP の形。定数は vscode-languageserver の値と同じ数を使う（型だけ読み、実行時には読み込まない）。
 */

const CompletionKind = { Text: 1, Function: 3, Field: 5, Variable: 6, Keyword: 14, Snippet: 15, File: 17, Reference: 18, EnumMember: 20, Value: 12 } as const;
const SymbolKind = { Namespace: 3, Function: 12, Key: 20 } as const;
const Severity = { error: 1, warning: 2, info: 3 } as const;
const InsertTextFormat = { PlainText: 1, Snippet: 2 } as const;

/** 構文解析器が自分で読む命令（レジストリには無い）。 */
export const KEYWORDS: Readonly<Record<string, { summary: string; summaryEn: string; example: string; block?: boolean }>> = {
  if: { summary: "条件分岐。@elif、@else を挟み、@end で閉じる", summaryEn: "Conditional branch. Add @elif and @else as needed and close with @end", example: "@if game.trust >= 2", block: true },
  elif: { summary: "前の条件が偽のときの別の条件", summaryEn: "Another condition, checked when the previous ones are false", example: "@elif game.trust == 1" },
  else: { summary: "どの条件にも当てはまらないとき", summaryEn: "When none of the conditions match", example: "@else" },
  end: {
    summary: "@if、@while、@with、@choice、@define、@script と、中身を持つコマンド（@html、file= の無い @staff-roll）を閉じる",
    summaryEn: "Close @if, @while, @with, @choice, @define, @script and commands with a body (@html, and @staff-roll without file=)",
    example: "@end",
  },
  while: { summary: "条件が真の間、@end までを繰り返す", summaryEn: "Repeat the lines up to @end while the condition is true", example: "@while temp.count < 3", block: true },
  with: { summary: "@end までの行を中身としてマクロに渡す（マクロの中の @content で実行する）", summaryEn: "Pass the lines up to @end to a macro as its content (the macro runs them with @content)", example: "@with flashback time=1s", block: true },
  content: { summary: "@define の中で、@with で渡された中身を実行する", summaryEn: "Inside @define, run the content passed with @with", example: "@content" },
  choice: { summary: "選択肢を表示する。中は `- テキスト -> ジャンプ先` の行だけで、@end で閉じる", summaryEn: "Show choices. Inside, write only `- text -> target` lines, and close with @end", example: "@choice", block: true },
  define: { summary: "マクロ（自分で作るコマンド）を定義する。@end で閉じる", summaryEn: "Define a macro (your own command). Close with @end", example: "@define title-card(text: string, time: duration = 1s)", block: true },
  script: { summary: "TypeScript を直接書く。@end だけの行までをそのまま扱う", summaryEn: "Write TypeScript directly. Everything up to a line with only @end is taken as is", example: "@script", block: true },
  set: { summary: "変数に代入する（= += -= *= /=）", summaryEn: "Assign to a variable (= += -= *= /=)", example: "@set game.trust += 1" },
  let: { summary: "ローカル変数を作る（そのファイル、または @define の中だけ）", summaryEn: "Create a local variable (only within the file or the @define)", example: "@let count = game.trust * 2" },
  jump: { summary: "ジャンプする（`#ラベル`、`ファイル`、`ファイル#ラベル`）", summaryEn: "Jump (`#label`, `file` or `file#label`)", example: "@jump chapter2#start" },
  call: { summary: "サブルーチンを呼び出す。@return で戻る", summaryEn: "Call a subroutine. @return comes back", example: "@call common#interlude" },
  return: { summary: "@call した位置へ戻る", summaryEn: "Return to where @call was made", example: "@return" },
  use: { summary: "別のファイルの @define をこのファイルで使う（ファイルの一番外側に書く）", summaryEn: "Use the @define macros of another file in this file (write it at the top level of the file)", example: "@use common" },
  for: { summary: "配列の要素（辞書ならキー）を一つずつ名前に入れて、@end までをくり返す", summaryEn: "Repeat the lines up to @end, putting each element of an array (or each key of a dictionary) in the name", example: "@for item in game.items", block: true },
  function: { summary: "式で呼べる関数を作る（中身は式一つ。ファイルの一番外側に書く）", summaryEn: "Make a function you can call in expressions (the body is one expression; write it at the top level of the file)", example: '@function rank(score) = score >= 80 ? "A" : "B"' },
};

/** 本文の中の書き方（`{` のあと）。 */
const MARKUP: readonly { label: string; snippet: string; doc: string; docEn: string }[] = [
  { label: "r", snippet: "r ${1:漢字}|${2:かんじ}}", doc: "ルビ", docEn: "Ruby (reading aid)" },
  { label: "br", snippet: "br}", doc: "同じページ内での改行", docEn: "Line break within the same page" },
  { label: "click", snippet: "click}", doc: "行の途中のクリック待ち", docEn: "Wait for a click in the middle of a line" },
  { label: "noclick", snippet: "noclick}", doc: "行の終わりでクリックを待たずに次へ進む（行の最後に書く）", docEn: "Continue without waiting for a click at the end of the line (write it at the end of the line)" },
  { label: "=", snippet: "= ${1:game.name}}", doc: "値の埋め込み", docEn: "Embed a value" },
  { label: "@", snippet: "@$1}", doc: "本文がその位置まで表示されたときにコマンドを実行する", docEn: "Run a command when the text has been shown up to this point" },
  { label: "b", snippet: "b $1}", doc: "太字", docEn: "Bold" },
  { label: "i", snippet: "i $1}", doc: "斜体", docEn: "Italic" },
  { label: "c", snippet: "c ${1:#cc3333} $2}", doc: "文字色", docEn: "Text color" },
  { label: "size", snippet: "size ${1:32} $2}", doc: "文字サイズ（px）", docEn: "Font size (px)" },
  { label: "mark", snippet: "mark ${1:#ffff66} $2}", doc: "蛍光ペンのような背景色", docEn: "Highlighter-style background color" },
  { label: "dot", snippet: "dot $1}", doc: "傍点（圏点）", docEn: "Emphasis dots" },
  { label: "img", snippet: "img ${1:icons/heart.png}}", doc: "本文の中の画像（image フォルダ）", docEn: "Inline image (image folder)" },
  { label: "speed", snippet: "speed ${1:600ms} $2}", doc: "囲んだ部分だけテキスト速度を変える（1 文字あたりの時間）", docEn: "Change the text speed for the enclosed part only (time per character)" },
  { label: "seq", snippet: "seq ${1:一度目}|${2:二度目}}", doc: "通るたびに順に出し、最後のものを出し続ける", docEn: "Shows them in order each time it's reached, then keeps showing the last" },
  { label: "cycle", snippet: "cycle ${1:朝}|${2:夜}}", doc: "通るたびに順に出し、頭に戻る", docEn: "Shows them in order each time it's reached, then starts over" },
  { label: "once", snippet: "once ${1:はじめまして}|}", doc: "通るたびに順に一度ずつ出し、出し終えたら何も出さない", docEn: "Shows each once in order, then nothing" },
  { label: "shuffle", snippet: "shuffle ${1:赤}|${2:青}}", doc: "通るたびにばらばらに出す（同じものを続けない）", docEn: "Shows one at random each time it's reached (never the same twice in a row)" },
];

/** 補完と説明の言葉（日本語と英語。VS Code の表示言語で選ぶ）。 */
const WORDS = {
  ja: {
    asset: (folder: string) => `素材（${folder}）`,
    cast: "キャラクター ID",
    appearance: "立ち絵セット名",
    variant: "差分名",
    position: "立ち位置名 / `auto`",
    int: "整数",
    number: "数値",
    range: (min: number | undefined, max: number | undefined) => `（${min ?? ""}〜${max ?? ""}）`,
    kinds: { string: "文字列", bool: "真偽値", duration: "時間", color: "色", target: "ジャンプ先", variable: "変数", condition: "条件（式）" } as Record<string, string>,
    defineOf: (file: string) => `${file} の @define`,
    defineHead: (name: string, file: string) => `**@${name}**（${file} の @define）`,
    tableHead: "| パラメータ | 型 | 既定値 | 説明 |",
    positionalCell: (name: string, n: number) => `${name}（名前なし ${n}）`,
    positionalHead: (n: number) => `（名前なしのパラメータ ${n}）`,
    required: "必須",
    requiredUnless: (others: readonly string[]) => `${others.join("、")} が無ければ必須`,
    hasDefault: "あり",
    defaultValue: (v: string) => `既定値 \`${v}\``,
    noteSep: "、",
    valueCandidates: "値の候補",
    commandCandidates: "コマンドの候補",
    character: "キャラクター",
    spriteSet: "立ち絵セット",
    variantOf: (key: string) => `差分（${key}）`,
    standPosition: "立ち位置",
    defaultLabel: "既定値",
    lineOf: (file: string, line: number) => `${file} ${line} 行目`,
    line: (line: number) => `${line} 行目`,
    fileTop: "ファイルの先頭",
    speaker: "話者",
  },
  en: {
    asset: (folder: string) => `Asset (${folder})`,
    cast: "Character ID",
    appearance: "Sprite set name",
    variant: "Variant name",
    position: "Position name / `auto`",
    int: "Integer",
    number: "Number",
    range: (min: number | undefined, max: number | undefined) => (min !== undefined && max !== undefined ? ` (${min} to ${max})` : min !== undefined ? ` (${min} or more)` : ` (up to ${max})`),
    kinds: { string: "String", bool: "Boolean", duration: "Duration", color: "Color", target: "Jump target", variable: "Variable", condition: "Condition (expression)" } as Record<string, string>,
    defineOf: (file: string) => `@define in ${file}`,
    defineHead: (name: string, file: string) => `**@${name}** (@define in ${file})`,
    tableHead: "| Parameter | Type | Default | Description |",
    positionalCell: (name: string, n: number) => `${name} (unnamed ${n})`,
    positionalHead: (n: number) => ` (unnamed parameter ${n})`,
    required: "Required",
    requiredUnless: (others: readonly string[]) => `Required unless ${others.join(" or ")}`,
    hasDefault: "Yes",
    defaultValue: (v: string) => `Default \`${v}\``,
    noteSep: ", ",
    valueCandidates: "Value suggestions",
    commandCandidates: "Command suggestions",
    character: "Character",
    spriteSet: "Sprite set",
    variantOf: (key: string) => `Variant (${key})`,
    standPosition: "Position",
    defaultLabel: "Default",
    lineOf: (file: string, line: number) => `${file} line ${line}`,
    line: (line: number) => `Line ${line}`,
    fileTop: "Start of the file",
    speaker: "Speaker",
  },
};

const range = (line: number, start: number, end: number): Range => ({ start: { line, character: start }, end: { line, character: end } });

// ---- 型と説明 ----

export function typeName(t: ParamType, lang: Lang = "ja"): string {
  const w = WORDS[lang];
  switch (t.kind) {
    case "enum":
      return t.values.map((v) => `\`${v}\``).join(" / ");
    case "asset":
      return w.asset(t.folder);
    case "cast":
      return w.cast;
    case "appearance":
      return w.appearance;
    case "variant":
      return w.variant;
    case "position":
      return w.position;
    case "number":
    case "int": {
      const r = t.min !== undefined || t.max !== undefined ? w.range(t.min, t.max) : "";
      return `${t.kind === "int" ? w.int : w.number}${r}`;
    }
    default:
      return w.kinds[t.kind]!;
  }
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** 命令の説明（要約・例・引数の表）。 */
export function commandMarkdown(spec: CommandSpec, define?: DefineInfo, lang: Lang = "ja"): string {
  const w = WORDS[lang];
  const out: string[] = [];
  // マクロの要約は @define のすぐ上の // の行（@liminalia/lang の defineSpec）
  if (define) out.push(w.defineHead(spec.name, define.file), ...(spec.summary ? ["", spec.summary] : []), "", "```lim", defineSignature(define), "```");
  else out.push(`**@${spec.name}** — ${commandSummary(spec, lang === "en")}`, "", "```lim", commandExample(spec, lang === "en"), "```");
  const params = Object.entries(spec.params);
  if (params.length > 0) {
    out.push("", w.tableHead, "|---|---|---|---|");
    for (const [name, p] of params) {
      const pos = spec.positional.indexOf(name);
      const label = pos >= 0 ? w.positionalCell(name, pos + 1) : name;
      out.push(`| ${cell(label)} | ${cell(typeName(p.type, lang))} | ${cell(defaultText(p, define, name, lang))} | ${cell(paramDoc(p, lang === "en"))} |`);
    }
  }
  return out.join("\n");
}

function defaultText(p: ParamSpec, define: DefineInfo | undefined, name: string, lang: Lang): string {
  if (p.required) return WORDS[lang].required;
  if (p.requiredUnless) return WORDS[lang].requiredUnless(p.requiredUnless);
  if (p.default !== undefined) return `\`${p.default}\``;
  const d = define?.node.params.find((x) => x.name === name)?.defaultValue;
  return d ? WORDS[lang].hasDefault : "";
}

function defineSignature(d: DefineInfo): string {
  return `@define ${d.name}(${d.node.params.map((p) => `${p.name}: ${p.type}`).join(", ")})`;
}

export function paramMarkdown(spec: CommandSpec, name: string, lang: Lang = "ja"): string {
  const w = WORDS[lang];
  const p = spec.params[name];
  if (!p) return "";
  const pos = spec.positional.indexOf(name);
  const head = `**${name}**${pos >= 0 ? w.positionalHead(pos + 1) : "="} — ${typeName(p.type, lang)}`;
  const notes = [p.required ? w.required : p.requiredUnless ? w.requiredUnless(p.requiredUnless) : null, p.default !== undefined ? w.defaultValue(p.default) : null].filter((x) => x !== null);
  return [head, "", paramDoc(p, lang === "en"), ...(notes.length > 0 ? ["", notes.join(w.noteSep)] : [])].join("\n");
}

// ---- 補完 ----

export function completions(project: LimProject, file: string, pos: Position, lang: Lang = "ja"): CompletionItem[] {
  const lines = project.lines(file);
  const line = lines[pos.line] ?? "";
  const offset = Math.min(pos.character, line.length);
  const block = blockAt(lines, pos.line);
  if (block === "script") return [];

  // 式の中（@if・@set などの後ろ、パラメータの (…)、本文の {= …}）は変数と式の関数
  const expr = exprSiteAt(line, offset, block);
  if (expr) return exprCompletions(project, pos.line, expr, lang, (prefix, r) => targetCompletions(project, file, prefix, r, lang));

  const site = commandSiteAt(line, offset, block);
  if (site) return commandCompletions(project, file, pos.line, site, offset, lang);

  if (block === "choice") {
    const option = optionSite(line);
    if (!option || offset < option.arrow + 4) return markupCompletions(line, pos.line, offset, lang);
    const t = option.target;
    if (offset <= t.end && (t.text !== "" || option.args.length === 0 || offset < option.args[0]!.start)) {
      return targetCompletions(project, file, line.slice(t.start, offset), range(pos.line, t.start, Math.max(t.end, offset)), lang);
    }
    return argCompletions(project, file, CHOICE_OPTION, option.args, pos.line, offset, lang);
  }

  const markup = markupCompletions(line, pos.line, offset, lang);
  if (markup.length > 0) return markup;
  return speakerCompletions(project, line, pos.line, offset, lang);
}

function commandCompletions(project: LimProject, file: string, lineNo: number, site: CommandSite, offset: number, lang: Lang): CompletionItem[] {
  const w = WORDS[lang];
  if (offset <= site.nameEnd) {
    const r = range(lineNo, site.nameStart, site.nameEnd);
    const items: CompletionItem[] = [];
    for (const spec of project.registry.values()) {
      items.push({ label: spec.name, kind: CompletionKind.Function, detail: commandSummary(spec, lang === "en"), documentation: { kind: "markdown", value: commandMarkdown(spec, undefined, lang) }, textEdit: { range: r, newText: spec.name } });
    }
    for (const d of project.visibleDefines(file).values()) {
      items.push({ label: d.name, kind: CompletionKind.Function, detail: w.defineOf(d.file), documentation: { kind: "markdown", value: commandMarkdown(d.spec, d, lang) }, textEdit: { range: r, newText: d.name } });
    }
    if (!site.inline) {
      for (const [name, k] of Object.entries(KEYWORDS)) {
        items.push({ label: name, kind: CompletionKind.Keyword, detail: lang === "en" ? k.summaryEn : k.summary, documentation: { kind: "markdown", value: `\`\`\`lim\n${k.example}\n\`\`\`` }, textEdit: { range: r, newText: name } });
      }
    }
    return items;
  }
  if (!site.inline && (site.name === "jump" || site.name === "call")) {
    const start = site.args[0]?.start ?? offset;
    return targetCompletions(project, file, site.args[0] ? lineText(project, file, lineNo).slice(start, offset) : "", range(lineNo, start, Math.max(site.args[0]?.end ?? offset, offset)), lang);
  }
  if (!site.inline && site.name === "use") {
    const t = tokenAt(site.args, offset);
    const r = range(lineNo, t?.start ?? offset, t?.end ?? offset);
    return [...project.input.files.keys()].filter((f) => f !== file).map((f) => ({ label: f, kind: CompletionKind.File, textEdit: { range: r, newText: f } }));
  }
  if (KEYWORDS[site.name]) return [];
  const spec = project.registry.get(site.name) ?? project.visibleDefines(file).get(site.name)?.spec;
  if (!spec) return [];
  return argCompletions(project, file, spec, site.args, lineNo, offset, lang, !site.inline);
}

function lineText(project: LimProject, file: string, lineNo: number): string {
  return project.lines(file)[lineNo] ?? "";
}

/** 引数の補完。key= の後ろなら値、そうでなければ引数名と（位置引数の場所なら）その値。 */
/** guard なら、どの命令の行にも書ける if=(式) も候補に出す（本文の中の {@…} と選択肢の行では出さない）。 */
function argCompletions(project: LimProject, file: string, spec: CommandSpec, args: readonly Token[], lineNo: number, offset: number, lang: Lang, guard = false): CompletionItem[] {
  const token = tokenAt(args, offset);
  const line = lineText(project, file, lineNo);
  // 検査と同じ読み方で、書いた引数がどの引数名に当たるか（前の名前の fade= と名前なしの時間は time に当たり、time= を候補に出さない）
  const given = namedArgs(args, spec.positional, spec);
  if (token && token.key !== null && offset >= token.valueStart) {
    const r = range(lineNo, token.valueStart, token.end);
    return valueCompletions(project, file, spec, renamedParam(spec, token.key) ?? token.key, given, line.slice(token.valueStart, offset), r, lang);
  }
  const start = token?.start ?? offset;
  const end = token ? token.end : offset;
  const r = range(lineNo, start, end);
  const items: CompletionItem[] = [];
  for (const [name, p] of Object.entries(spec.params)) {
    if (spec.positional.includes(name)) continue;
    if (given.has(name) && given.get(name)!.token !== token) continue;
    items.push({
      label: `${name}=`,
      kind: CompletionKind.Field,
      detail: typeName(p.type, lang),
      documentation: { kind: "markdown", value: paramMarkdown(spec, name, lang) },
      sortText: `1${name}`,
      textEdit: { range: r, newText: `${name}=` },
      command: { title: WORDS[lang].valueCandidates, command: "editor.action.triggerSuggest" },
    });
  }
  // どの命令の行にも書ける if=(式)（偽ならその行を飛ばす）
  if (guard && !("if" in spec.params) && !given.has("if")) {
    items.push({ label: "if=", kind: CompletionKind.Field, detail: typeName(GUARD_PARAM.type, lang), documentation: { kind: "markdown", value: lang === "en" ? GUARD_PARAM.docEn! : GUARD_PARAM.doc }, sortText: "2if", textEdit: { range: r, newText: "if=($1)" }, insertTextFormat: InsertTextFormat.Snippet });
  }
  const positional = nextPositional(spec, args, token, offset);
  if (positional !== undefined) {
    for (const item of valueCompletions(project, file, spec, positional, given, line.slice(start, offset), r, lang)) items.push({ ...item, sortText: `0${item.label}` });
  }
  return items;
}

/** offset に書く位置引数の名前（token はそこにある引数。その前の引数を検査と同じ読み方で数える）。 */
function nextPositional(spec: CommandSpec, args: readonly Token[], token: Token | null, offset: number): string | undefined {
  const before = args.filter((t) => (token ? t !== token && t.start < token.start : t.start < offset));
  const names = argNames(before, spec.positional, spec);
  const used = names.filter((n, i) => n !== undefined && before[i]!.key === null && spec.positional.includes(n)).length;
  return spec.positional[used];
}

/** 引数の型に応じた値の候補。 */
function valueCompletions(project: LimProject, file: string, spec: CommandSpec, param: string, given: ReturnType<typeof namedArgs>, prefix: string, r: Range, lang: Lang): CompletionItem[] {
  const w = WORDS[lang];
  const p = spec.params[param];
  if (!p) return [];
  const values = (labels: Iterable<string>, kind: NonNullable<CompletionItem["kind"]>, detail?: string): CompletionItem[] =>
    [...labels].map((v) => ({ label: v, kind, ...(detail ? { detail } : {}), textEdit: { range: r, newText: quoteIfNeeded(v) } }));
  const t = p.type;
  switch (t.kind) {
    case "enum":
      return values(t.values, CompletionKind.EnumMember);
    case "bool":
      return values(["true", "false"], CompletionKind.Value);
    case "asset": {
      const folder = "folder" in spec.params ? (given.get("folder")?.value ?? t.folder) : t.folder;
      return values(project.input.assets?.(folder) ?? [], CompletionKind.File, folder);
    }
    case "cast":
      return values(Object.keys(project.input.cast), CompletionKind.Value, w.character);
    case "appearance": {
      const entry = castOf(project, spec, given);
      return values(Object.keys(entry?.appearances ?? {}), CompletionKind.Value, w.spriteSet);
    }
    case "variant": {
      const entry = castOf(project, spec, given);
      if (!entry) return [];
      const key = appearanceKey(entry, argOfKind(spec, given, "appearance") ?? "");
      return values(Object.keys(entry.appearances?.[key]?.variants ?? {}), CompletionKind.Value, w.variantOf(key));
    }
    case "position": {
      const entry = castOf(project, spec, given);
      let names: string[] = [...FRAME_POSITIONS];
      if (entry) {
        const variant = resolveVariant(entry, argOfKind(spec, given, "appearance") ?? "", argOfKind(spec, given, "variant") ?? "").variant;
        if (variant) names = positionNames(variant);
      }
      return values([...names, AUTO_POSITION], CompletionKind.Value, w.standPosition);
    }
    case "target":
      return targetCompletions(project, file, prefix, r, lang);
    case "string": {
      // 作品の設定で決める名前（ui.tones の色調、ui.nvlStyles の NVL の見た目）と、決まった名前（制作画面の補完と同じ）
      const names = new Set([...(t.suggest ?? []), ...uiParamNames(t, project.input.config?.ui)]);
      if (names.size > 0) return values(names, CompletionKind.Value);
      return p.default !== undefined ? values([p.default], CompletionKind.Value, w.defaultLabel) : [];
    }
    default:
      return p.default !== undefined ? values([p.default], CompletionKind.Value, w.defaultLabel) : [];
  }
}

function quoteIfNeeded(v: string): string {
  return /[\s"]/.test(v) ? JSON.stringify(v) : v;
}

function argOfKind(spec: CommandSpec, given: ReturnType<typeof namedArgs>, kind: ParamType["kind"]): string | undefined {
  const name = Object.keys(spec.params).find((n) => spec.params[n]!.type.kind === kind);
  return name === undefined ? undefined : given.get(name)?.value;
}

function castOf(project: LimProject, spec: CommandSpec, given: ReturnType<typeof namedArgs>) {
  const who = argOfKind(spec, given, "cast");
  return who === undefined ? undefined : project.castEntries()[who];
}

/** 飛び先の候補。`ファイル#` まで書いていればそのファイルのラベル、それ以外はこのファイルのラベル・ファイル・ファイル#ラベル。 */
export function targetCompletions(project: LimProject, file: string, prefix: string, r: Range, lang: Lang = "ja"): CompletionItem[] {
  const w = WORDS[lang];
  const hash = prefix.indexOf("#");
  if (hash >= 0) {
    const filePart = prefix.slice(0, hash);
    const target = filePart === "" ? file : filePart;
    return project.labels(target).map((l) => ({ label: `${filePart}#${l.name}`, kind: CompletionKind.Reference, detail: w.lineOf(target, l.line), textEdit: { range: r, newText: `${filePart}#${l.name}` } }));
  }
  const items: CompletionItem[] = [];
  for (const l of project.labels(file)) items.push({ label: `#${l.name}`, kind: CompletionKind.Reference, detail: w.line(l.line), sortText: `0${l.name}`, textEdit: { range: r, newText: `#${l.name}` } });
  for (const f of project.input.files.keys()) {
    items.push({ label: f, kind: CompletionKind.File, detail: w.fileTop, sortText: `1${f}`, textEdit: { range: r, newText: f } });
    if (f === file) continue;
    for (const l of project.labels(f)) items.push({ label: `${f}#${l.name}`, kind: CompletionKind.Reference, detail: w.lineOf(f, l.line), sortText: `2${f}#${l.name}`, textEdit: { range: r, newText: `${f}#${l.name}` } });
  }
  return items;
}

/** 本文の `{` の直後なら、本文の中の書き方の候補。 */
function markupCompletions(line: string, lineNo: number, offset: number, lang: Lang): CompletionItem[] {
  const before = line.slice(0, offset);
  const m = /(?:^|[^\\])\{([a-z=@]*)$/.exec(before);
  if (!m) return [];
  const start = offset - m[1]!.length;
  return MARKUP.map((k) => ({
    label: `{${k.label}`,
    filterText: k.label,
    kind: CompletionKind.Snippet,
    detail: lang === "en" ? k.docEn : k.doc,
    insertTextFormat: InsertTextFormat.Snippet,
    textEdit: { range: range(lineNo, start, offset), newText: k.snippet },
    ...(k.label === "@" ? { command: { title: WORDS[lang].commandCandidates, command: "editor.action.triggerSuggest" } } : {}),
  }));
}

/** 行頭なら話者の名前（括弧も入れる。原文が英語の作品なら引用符の形 `Yui "…"`）。 */
function speakerCompletions(project: LimProject, line: string, lineNo: number, offset: number, lang: Lang): CompletionItem[] {
  const indent = indentOf(line);
  if (offset < indent) return [];
  const prefix = line.slice(indent, offset);
  if (/[\s「『（("“@#{\\/]/.test(prefix) || /^[@#]/.test(line.slice(indent))) return [];
  const rest = line.slice(offset);
  const open = rest === "";
  const languages = project.input.config?.languages;
  const english = Array.isArray(languages) && typeof languages[0] === "string" && /^en(?:-|$)/i.test(languages[0]);
  return project.input.speakers.map((s) => ({
    label: s,
    kind: CompletionKind.Variable,
    detail: WORDS[lang].speaker,
    insertTextFormat: open ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
    textEdit: { range: range(lineNo, indent, offset), newText: open ? `${s.replace(/[$}\\]/g, "\\$&")}${english ? ' "$0"' : "「$0」"}` : s },
  }));
}

// ---- 説明 ----

export function hover(project: LimProject, file: string, pos: Position, lang: Lang = "ja"): Hover | null {
  const lines = project.lines(file);
  const line = lines[pos.line] ?? "";
  const offset = pos.character;
  const block = blockAt(lines, pos.line);
  const expr = exprSiteAt(line, offset, block);
  if (expr) {
    const h = exprHover(project, pos.line, expr, lang, (text) => {
      const place = resolveTargetText(text, file, { has: (f) => project.input.files.has(f), labels: (f) => project.labels(f) });
      return place ? { file: place.file, line: place.line } : null;
    });
    if (h) return h;
  }
  const site = commandSiteAt(line, offset, block);
  if (site) {
    if (offset <= site.nameEnd) {
      const r = range(pos.line, site.at, site.nameEnd);
      const keyword = site.inline ? undefined : KEYWORDS[site.name];
      if (keyword) return { range: r, contents: { kind: "markdown", value: `**@${site.name}** — ${lang === "en" ? keyword.summaryEn : keyword.summary}\n\n\`\`\`lim\n${keyword.example}\n\`\`\`` } };
      const spec = project.registry.get(site.name);
      if (spec) return { range: r, contents: { kind: "markdown", value: commandMarkdown(spec, undefined, lang) } };
      const d = project.visibleDefines(file).get(site.name) ?? project.findDefine(site.name);
      if (d) return { range: r, contents: { kind: "markdown", value: commandMarkdown(d.spec, d, lang) } };
      return null;
    }
    const spec = project.registry.get(site.name) ?? project.visibleDefines(file).get(site.name)?.spec;
    return spec ? paramHover(spec, site.args, pos.line, offset, lang) : null;
  }
  if (block === "choice") {
    const option = optionSite(line);
    if (option && offset > option.target.end) return paramHover(CHOICE_OPTION, option.args, pos.line, offset, lang);
  }
  return null;
}

function paramHover(spec: CommandSpec, args: readonly Token[], lineNo: number, offset: number, lang: Lang): Hover | null {
  const token = tokenAt(args, offset);
  if (!token) return null;
  // 検査と同じ読み方（前の名前の fade= は time、名前なしの時間は bare の名前）
  const name = argNames(args, spec.positional, spec)[args.indexOf(token)];
  if (name === undefined || !spec.params[name]) return null;
  return { range: range(lineNo, token.start, token.key !== null && offset < token.valueStart ? token.valueStart - 1 : token.end), contents: { kind: "markdown", value: paramMarkdown(spec, name, lang) } };
}

// ---- 定義へ移動 ----

export function definition(project: LimProject, file: string, pos: Position): Location | null {
  const lines = project.lines(file);
  const line = lines[pos.line] ?? "";
  const offset = pos.character;
  const block = blockAt(lines, pos.line);
  const site = commandSiteAt(line, offset, block);
  if (site && offset <= site.nameEnd) {
    const d = project.visibleDefines(file).get(site.name) ?? project.findDefine(site.name);
    return d ? locationOf(project, d.file, d.line - 1, d.name) : null;
  }
  if (site && !site.inline && site.name === "use") {
    const t = site.args[0];
    return t && project.input.files.has(t.text) ? locationOf(project, t.text, 0) : null;
  }
  // ジャンプ先（@jump・@call・target 型のパラメータ・選択肢）は Studio の「ジャンプ先へ移動」と同じ解決（@liminalia/lang の goto.ts）
  const target = targetSiteAt(lines, pos.line, offset, (name) => project.registry.get(name) ?? project.visibleDefines(file).get(name)?.spec);
  return target ? targetLocation(project, file, target.text) : null;
}

function targetLocation(project: LimProject, file: string, text: string): Location | null {
  const place = resolveTargetText(text, file, { has: (f) => project.input.files.has(f), labels: (f) => project.labels(f) });
  return place ? locationOf(project, place.file, place.line - 1) : null;
}

function locationOf(project: LimProject, file: string, line: number, word?: string): Location {
  const text = project.lines(file)[line] ?? "";
  const at = word ? text.indexOf(word) : -1;
  return { uri: project.input.files.get(file)!.uri, range: at >= 0 ? range(line, at, at + word!.length) : range(line, 0, 0) };
}

// ---- 目次 ----

/** ラベル（次のラベルまでを範囲にする）と @define。 */
export function documentSymbols(project: LimProject, file: string): DocumentSymbol[] {
  const lines = project.lines(file);
  const lastLine = Math.max(0, lines.length - 1);
  const labels = project.labels(file);
  const out: DocumentSymbol[] = [];
  labels.forEach((l, i) => {
    const line = l.line - 1;
    const end = Math.max(line, i + 1 < labels.length ? labels[i + 1]!.line - 2 : lastLine);
    const at = Math.max(0, (lines[line] ?? "").lastIndexOf(l.name));
    out.push({
      name: `# ${l.name}`,
      kind: SymbolKind.Key,
      range: { start: { line, character: 0 }, end: { line: end, character: (lines[end] ?? "").length } },
      selectionRange: range(line, at, at + l.name.length),
    });
  });
  for (const d of project.defines(file)) {
    const line = d.line - 1;
    const end = blockEnd(lines, line);
    const text = lines[line] ?? "";
    const at = text.indexOf(d.name);
    out.push({
      name: `@${d.name}`,
      detail: `(${d.node.params.map((p) => p.name).join(", ")})`,
      kind: SymbolKind.Function,
      range: { start: { line, character: 0 }, end: { line: end, character: (lines[end] ?? "").length } },
      selectionRange: range(line, Math.max(0, at), Math.max(0, at) + d.name.length),
    });
  }
  return out.sort((a, b) => a.range.start.line - b.range.start.line);
}

// ---- 折りたたみ ----

/**
 * 折りたたみの範囲を構文解析から求める。シーン（ラベルから次のラベルの前まで。後ろの空行とコメントは次のシーンに付ける）、
 * @if（@elif・@else の枝ごと）、@while、@with、@choice、@define、@script、中身を持つ命令（@html、file= の無い @staff-roll）、続いた // の行。
 * ブロックは @end の行を残して畳む。
 */
export function foldingRanges(project: LimProject, file: string): FoldingRange[] {
  const lines = project.lines(file);
  const script = project.script(file);
  if (!script) return [];
  const out: FoldingRange[] = [];
  const add = (start: number, end: number, kind?: "comment" | "region") => {
    if (end > start) out.push({ startLine: start, endLine: end, ...(kind ? { kind } : {}) });
  };
  const isFiller = (t: string) => t === "" || t.startsWith("//");
  const labels = project.labels(file);
  labels.forEach((l, i) => {
    const start = l.line - 1;
    let end = i + 1 < labels.length ? labels[i + 1]!.line - 2 : lines.length - 1;
    while (end > start && isFiller(trimIndent(lines[end] ?? ""))) end--;
    add(start, end, "region");
  });
  walk(script.body, (st) => {
    const start = st.line - 1;
    if (st.kind === "if") {
      const close = blockEnd(lines, start);
      if (close === start) return;
      st.branches.forEach((b, i) => add(b.line - 1, (i + 1 < st.branches.length ? st.branches[i + 1]!.line - 1 : close) - 1));
    } else if (st.kind === "choice" || st.kind === "define" || st.kind === "script" || (st.kind === "command" && st.body)) {
      const close = blockEnd(lines, start);
      if (close > start) add(start, close - 1);
    }
  });
  // 続いた // の行
  for (let i = 0; i < lines.length; i++) {
    if (!trimIndent(lines[i]!).startsWith("//")) continue;
    let j = i;
    while (j + 1 < lines.length && trimIndent(lines[j + 1]!).startsWith("//")) j++;
    add(i, j, "comment");
    i = j;
  }
  return out.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}

/** line 行目で始まるブロックを閉じる @end の行。見つからなければ line。 */
function blockEnd(lines: readonly string[], line: number): number {
  let depth = 0;
  let script = false;
  for (let i = line; i < lines.length; i++) {
    const t = trimIndent(lines[i]!);
    if (script) {
      if (t === "@end") {
        script = false;
        if (--depth === 0) return i;
      }
      continue;
    }
    const m = /^@(\S*)(?:\s+(.*))?$/.exec(t);
    if (!m) continue;
    if (m[1] === "script" || opensBody(m[1]!, m[2] ?? "")) {
      script = true;
      depth++;
    } else if (m[1] === "if" || m[1] === "while" || m[1] === "for" || m[1] === "with" || m[1] === "choice" || m[1] === "define") depth++;
    else if (m[1] === "end" && --depth === 0) return i;
  }
  return line;
}

// ---- 診断 ----

/** lim の診断を LSP の診断にする。桁があればそこから空白までを、無ければ行の字下げの後ろから行末までを指す。 */
/** 診断を LSP の形にする。lang が en なら文とヒントを英語にする（lim check --lang en と同じ englishDiagnostic）。 */
export function toLspDiagnostic(d: Diagnostic, lines: readonly string[], lang: Lang = "ja"): LspDiagnostic {
  const lineNo = Math.max(0, Math.min(d.line - 1, lines.length - 1));
  const text = lines[lineNo] ?? "";
  let start: number;
  let end: number;
  if (d.column !== undefined) {
    start = Math.min(d.column - 1, text.length);
    end = start;
    while (end < text.length && text[end] !== " " && text[end] !== "\t") end++;
    if (end === start) end = Math.min(text.length, start + 1);
  } else {
    start = indentOf(text);
    end = text.replace(/[ \t\r]+$/, "").length;
    if (end <= start) end = start;
  }
  const words = lang === "en" ? englishDiagnostic(d) : d;
  return {
    severity: Severity[d.severity],
    range: range(lineNo, start, end),
    message: words.hint ? `${words.message}\n→ ${words.hint}` : words.message,
    code: d.code,
    source: "lim",
    // Quick Fix（actions.ts の quickFixes）が当てる直し方
    ...(d.fix ? { data: { fix: d.fix, ...(d.column !== undefined ? { column: d.column } : {}) } } : {}),
  };
}
