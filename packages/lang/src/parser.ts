import type {
  Argument,
  ChoiceOption,
  Diagnostic,
  DiagnosticFix,
  Expr,
  IfBranch,
  IgnoreDirective,
  Inline,
  Param,
  Script,
  Severity,
  Statement,
  Target,
} from "./ast.ts";
import { parseArgs as parseArgsText, parseLiteral, parseTargetText, printLiteral } from "./args.ts";
import { ExprError, parseExpr } from "./expr.ts";
import { parseInline } from "./inline.ts";
import { opensBody } from "./credits.ts";
import { splitLineId } from "./line-ids.ts";
import { speechOpenAt } from "./speech.ts";
import { commandShape } from "./fix.ts";
import { splitBom, stripBom } from "./encoding.ts";

export interface ParseOptions {
  /**
   * 台詞の話者として認める名前。行頭がこの名前で、直後が 「 『 （ ( " “ のどれかなら台詞になる（" と “ の前には半角の空白を一つ書いてもよい）。
   * 登録されていない名前は地の文として扱う（`それは「愛」だった` を台詞にしないため）。
   */
  speakers?: Iterable<string>;
}

export const NAME_PATTERN = /^[\p{L}\p{N}_-]+$/u;

/** if=(式) を書けない書き方の言葉（ブロックを開く・閉じるもの、ファイルの外側の宣言）。 */
const NO_GUARD: ReadonlySet<string> = new Set(["if", "elif", "else", "end", "while", "for", "with", "choice", "define", "function", "script", "use"]);

/**
 * 命令の行の `if=(式)` を探す（"…" と (…) の外で、頭か空白の後ろにあるもの）。at と end は rest の中の if=(…) の範囲、
 * source は ( ) の中。無いか、( が閉じていなければ null。
 */
export function takeGuard(rest: string): { at: number; end: number; source: string } | null {
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && rest.startsWith("if=(", i) && (i === 0 || /\s/.test(rest[i - 1]!))) {
      const close = closingParen(rest.slice(i + 3));
      if (close < 0) return null;
      const end = i + 3 + close + 1;
      if (end < rest.length && !/\s/.test(rest[end]!)) return null;
      return { at: i, end, source: rest.slice(i + 4, end - 1) };
    }
  }
  return null;
}

/** 引数でなく式や飛び先を書く行。if=(式) は書けるが、(…) の無い if= は parseArgs を通らないので takeBareGuard で拾う。 */
const EXPRESSION_LINE: ReadonlySet<string> = new Set(["set", "let", "jump", "call", "return"]);

/** 命令の行の、(…) で書いていない `if=…`（"…" と (…) の外で、頭か空白の後ろにあるもの）。値は行の終わりまで。 */
function takeBareGuard(rest: string): { at: number; value: string } | null {
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && rest.startsWith("if=", i) && rest[i + 3] !== "(" && (i === 0 || /\s/.test(rest[i - 1]!))) {
      const value = rest.slice(i + 3).trim();
      return value === "" ? null : { at: i, value };
    }
  }
  return null;
}
const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;
/** @end までを中身にするブロックを開く書き方（@html と @staff-roll は中身を書いたときだけ。credits.ts の opensBody）。 */
const BLOCK_OPENERS: ReadonlySet<string> = new Set(["if", "while", "for", "with", "choice", "define", "script"]);

type Frame =
  | { kind: "root"; body: Statement[] }
  | { kind: "if"; node: Extract<Statement, { kind: "if" }>; body: Statement[] }
  /** @while・@for・@with（構文木は loop・each・with の付いた if）。@elif・@else は書けない。 */
  | { kind: "while" | "for" | "with"; node: Extract<Statement, { kind: "if" }>; body: Statement[] }
  | { kind: "define"; node: Extract<Statement, { kind: "define" }>; body: Statement[] }
  | { kind: "choice"; node: Extract<Statement, { kind: "choice" }>; body: Statement[] };

/**
 * .lim を構文木にする。行頭の字下げは見た目だけで意味を持たない
 * （本文の字下げは全角空白で書く。全角空白は取り除かない）。
 */
/** 幅ゼロの文字（どの行でも知らせる）と、区切りにならない空白（命令・ラベル・選択肢の飛び先で知らせる）。 */
const ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\ufeff]/;
const ODD_SPACE = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/;
const SPACE_NAMES: Record<string, string> = {
  "\u00a0": "ノーブレークスペース",
  "\u3000": "全角スペース",
  "\u200b": "幅ゼロの空白",
  "\u200c": "幅ゼロの非接合子",
  "\u200d": "幅ゼロの接合子",
  "\u2060": "単語結合子",
  "\ufeff": "BOM",
};

const NAME_OPEN = "{name ";

/** `// lim-ignore コード…`（次の行）と `// lim-ignore-file コード…`（ファイル全体）。 */
const IGNORE_COMMENT = /^\/\/\s*lim-ignore(-file)?(?:\s+(.*))?$/;
/** ファイルの先頭のコメントの `// lim: draft`（下書き）。 */
const DRAFT_COMMENT = /^\/\/\s*lim:\s*draft\s*$/;

/** 台本の先頭のコメントの行に `// lim: draft` があるか（下書き。parse の Script.draft と同じ。読まずに見分ける所が使う）。 */
export function isDraftSource(source: string): boolean {
  for (const raw of stripBom(source).split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (!line.startsWith("//")) return false;
    if (DRAFT_COMMENT.test(line)) return true;
  }
  return false;
}

/** 下書きの印の行（ファイルの先頭に足す。消すときは DRAFT_COMMENT に合う行を消す）。 */
export const DRAFT_LINE = "// lim: draft";

/** 台本を下書きにする（on）か、下書きから戻す（off）。先頭のコメントの印を足すか消す。変わらなければそのまま返す。 */
export function setDraftSource(source: string, on: boolean): string {
  if (isDraftSource(source) === on) return source;
  // 頭の BOM はそのまま頭に残す（印の行の後ろに回さない）
  const { bom, text } = splitBom(source);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  if (on) return `${bom}${DRAFT_LINE}${newline}${text}`;
  const rows = text.split(newline);
  const at = rows.findIndex((r) => DRAFT_COMMENT.test(r.trim()));
  rows.splice(at, 1);
  return bom + rows.join(newline);
}

/**
 * `話者{name 表示名}「…」`（`Yui{name ???} "…"`）の行なら、話者・{name …} の中身・本文の始まりの位置。{name …} の中は \ でエスケープでき、{= 式} を入れられる。
 * {name …} のすぐ後が台詞の括弧か引用符（引用符の前には半角の空白を一つ書いてもよい）でなければ台詞ではない（null）。
 */
export function speakerWithName(line: string, speakers: readonly string[]): { speaker: string; inner: string; end: number } | null {
  for (const s of speakers) {
    if (!line.startsWith(s) || !line.startsWith(NAME_OPEN, s.length)) continue;
    let depth = 1;
    let i = s.length + NAME_OPEN.length;
    for (; i < line.length && depth > 0; i++) {
      const c = line[i];
      if (c === "\\") i++;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    const start = depth === 0 ? speechOpenAt(line, i) : -1;
    if (start < 0) continue;
    return { speaker: s, inner: line.slice(s.length + NAME_OPEN.length, i - 1), end: start };
  }
  return null;
}

/**
 * 話者に登録していない名前の `名前{name 表示名}「…」` の形なら、speakerWithName と同じもの（speaker はその名前）。
 * 名前は空白や括弧を含まない 20 字までで、文字か数字を含むもの。
 */
function strangerWithName(line: string): { speaker: string; inner: string; end: number } | null {
  const m = /^([^\s{}「」『』（）()"“”：:【】\\]{1,20})\{name /u.exec(line);
  return m && /[\p{L}\p{N}]/u.test(m[1]!) ? speakerWithName(line, [m[1]!]) : null;
}

/** 飾りなどの中に {noclick} があるか。 */
function hasNestedNoclick(node: Inline): boolean {
  return "children" in node && node.children.some((c) => c.kind === "noclick" || hasNestedNoclick(c));
}

export function parse(source: string, file: string, options: ParseOptions = {}): Script {
  const diagnostics: Diagnostic[] = [];
  const speakers = [...(options.speakers ?? [])].sort((a, b) => b.length - a.length);
  const root: Frame = { kind: "root", body: [] };
  const stack: Frame[] = [root];
  const top = () => stack.at(-1)!;

  const report = (severity: Severity, code: string, line: number, message: string, extra: { column?: number; hint?: string; fix?: DiagnosticFix; fixes?: Diagnostic["fixes"] } = {}) => {
    const d: Diagnostic = { severity, code, message, file, line };
    if (extra.column !== undefined) d.column = extra.column;
    if (extra.hint !== undefined) d.hint = extra.hint;
    if (extra.fix !== undefined) d.fix = extra.fix;
    if (extra.fixes !== undefined) d.fixes = extra.fixes;
    diagnostics.push(d);
  };

  const inline = (text: string, line: number, column: number, where: "text" | "option" = "text"): Inline[] => {
    const { content, errors } = parseInline(text, column);
    for (const e of errors) {
      const extra: { column: number; hint?: string; fix?: DiagnosticFix } = { column: column + e.offset };
      if (e.hint !== undefined) extra.hint = e.hint;
      if (e.fix !== undefined) extra.fix = e.fix;
      report(e.severity ?? "error", e.code, line, e.message, extra);
    }
    // {noclick} は本文の行の最後にだけ書ける（飾りの中や、後ろに文字があるところには書けない）
    const at = text.indexOf("{noclick}");
    if (at >= 0) {
      const misplaced = content.some((n, i) => (n.kind === "noclick" && i !== content.length - 1) || hasNestedNoclick(n));
      if (where === "option") report("error", "noclick-in-option", line, "選択肢の文には {noclick} を書けません", { column: column + at, hint: "選択肢の前の本文の行の最後に {noclick} を書きます" });
      else if (misplaced) report("error", "noclick-not-last", line, "{noclick} は行の最後に書きます", { column: column + at, hint: "行の終わりでクリックを待たないなら、行の最後に {noclick} を書きます" });
    }
    return content;
  };

  /**
   * 見えない空白。幅ゼロの文字はどの行でも、ノーブレークスペースと全角スペースなどは命令・ラベルの行（"…" の中は除く）と
   * 選択肢の飛び先から後ろで知らせる（区切りとして読まれず、命令や名前の一部になって見つけにくい誤りになるため）。
   */
  const lintSpaces = (raw: string, line: number, kind: "command" | "option" | "text", shift = 0) => {
    const from = kind === "option" ? Math.max(0, raw.lastIndexOf(" -> ")) : 0;
    let quoted = false;
    // "…" の中の \" は書き逃し（"…" の外の \ はそのままの文字）。\\ の直後の " は本物の引用符（args.ts の読み方と同じ）
    let escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      const wasEscaped = escaped;
      escaped = false;
      if (kind === "command" && quoted && ch === "\\" && !wasEscaped) escaped = true;
      else if (kind === "command" && ch === '"' && !wasEscaped) quoted = !quoted;
      const zero = ZERO_WIDTH.test(ch);
      const odd = kind !== "text" && i >= from && !quoted && ODD_SPACE.test(ch);
      if (!zero && !odd) continue;
      const name = SPACE_NAMES[ch] ?? `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
      report("warning", "invisible-space", line, `見えない文字（${name}）があります`, { column: shift + i + 1, hint: zero ? "削除します" : "半角スペースに置き換えます" });
    }
  };

  /** 表示名（{name …} の中）。文字と {= 式} だけを書ける。空や、ほかの書き方ならエラーにして null。 */
  const displayName = (text: string, line: number, column: number): Inline[] | null => {
    const nodes = inline(text, line, column);
    if (nodes.some((n) => n.kind !== "text" && n.kind !== "value")) {
      report("error", "bad-speaker-name", line, "表示名に書けるのは文字と {= 式} だけです", { column, hint: "ユイ{name ？？？}「……」、主人公{name {= game.player}}「……」" });
      return null;
    }
    if (nodes.length === 0 || nodes.every((n) => n.kind === "text" && n.text.trim() === "")) {
      report("error", "bad-speaker-name", line, "表示名が空です", { column, hint: "ユイ{name ？？？}「……」" });
      return null;
    }
    return nodes;
  };

  const expr = (text: string, line: number, column: number): Expr | null => {
    if (text.trim() === "") {
      report("error", "missing-expression", line, "式が必要です", { column });
      return null;
    }
    try {
      return parseExpr(text);
    } catch (e) {
      const offset = e instanceof ExprError ? e.offset : 0;
      report("error", "bad-expression", line, e instanceof Error ? e.message : String(e), { column: column + offset });
      return null;
    }
  };

  /** このファイルの行 ID → 最初に書いた行。 */
  const seenIds = new Map<string, number>();

  /** すぐ上に続く // の行と、その最後の行（@define の要約にする）。 */
  let comments: string[] = [];
  let commentLine = -1;
  /** 診断を黙らせるコメント（次の行を待っているものは pending）。 */
  const ignores: IgnoreDirective[] = [];
  let pending: { line: number; codes: string[]; text: string }[] = [];
  /** コメントでない行がまだ無い（ファイルの先頭のコメントの中）。 */
  let head = true;
  let draft = false;

  // 頭の BOM は外して読む（splitBom）。1 行目の桁は BOM を数えた元の字面の桁のまま（修正案と名前の変更が元の行に当てる）
  const { bom, text: body } = splitBom(source);
  const rows = body.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const lineNo = i + 1;
    const raw = (rows[i] ?? "").replace(/\r$/, "");
    const indent = /^[ \t]*/.exec(raw)![0].length;
    const line = raw.slice(indent).replace(/[ \t]+$/, "");
    const shift = i === 0 ? bom.length : 0;
    const col = shift + indent + 1;
    if (line === "") continue;
    if (line.startsWith("//")) {
      if (commentLine !== lineNo - 1) comments = [];
      comments.push(line.slice(2).trim());
      commentLine = lineNo;
      const directive = IGNORE_COMMENT.exec(line);
      if (directive) {
        const codes = (directive[2] ?? "").split(/[\s,、]+/).filter((c) => c !== "");
        const text = line.trim().replace(/\s+/g, " ");
        if (directive[1]) ignores.push({ line: lineNo, target: "file", codes, text });
        else pending.push({ line: lineNo, codes, text });
      }
      if (head && DRAFT_COMMENT.test(line)) draft = true;
    } else {
      head = false;
      // 黙らせるコメントは、間のコメントの行を越えて、次のコメントでない行に効く
      for (const p of pending) ignores.push({ ...p, target: lineNo });
      pending = [];
    }
    lintWideHead(line, lineNo, col);

    const frame = top();
    lintSpaces(raw, lineNo, line.startsWith("@") || line.startsWith("#") ? "command" : frame.kind === "choice" && line !== "@end" ? "option" : "text", shift);

    // @choice の中は選択肢の行だけ。
    if (frame.kind === "choice" && line !== "@end" && !line.startsWith("//")) {
      const option = parseOption(line, lineNo, col);
      if (option) frame.node.options.push(option);
      continue;
    }

    if (line.startsWith("//")) continue;

    if (line.startsWith("#")) {
      const m = /^# (.+)$/.exec(line);
      if (!m || !NAME_PATTERN.test(m[1]!)) {
        const extra: { column: number; hint?: string } = { column: col };
        if (!line.startsWith("# ")) extra.hint = `本文なら \\${line}、ラベルなら # ${line.slice(1).trim()}`;
        report("error", "bad-label", lineNo, "ラベルは `# 名前` の形で書きます。名前に使えるのは文字、数字、_、- だけです", extra);
        continue;
      }
      frame.body.push({ kind: "label", name: m[1]!, line: lineNo });
      continue;
    }

    if (line.startsWith("@")) {
      const resumeAt = handleCommand(line, lineNo, col, i);
      if (resumeAt !== undefined) i = resumeAt;
      continue;
    }

    // 行末の固定の行 ID（#line:ID。line-ids.ts）は本文に入れない
    const { body: text, id } = lineId(line, lineNo, col);
    const withId = id ? { id } : {};
    // 話者「…」と 話者 "…"（引用符の前の半角の空白一つは本文に入れない）
    const speaker = speakers.find((s) => text.startsWith(s) && speechOpenAt(text, s.length) >= 0);
    // 話者{name 表示名}「…」: この行だけ名前欄の名前を替える（話者はそのまま）
    const named = speaker ? null : speakerWithName(text, speakers);
    let stranger: ReturnType<typeof speakerWithName> = null;
    if (speaker) {
      const start = speechOpenAt(text, speaker.length);
      frame.body.push({ kind: "say", speaker, content: inline(text.slice(start), lineNo, col + start), line: lineNo, ...withId });
    } else if (named) {
      const name = displayName(named.inner, lineNo, col + named.speaker.length + NAME_OPEN.length);
      frame.body.push({ kind: "say", speaker: named.speaker, ...(name ? { name } : {}), content: inline(text.slice(named.end), lineNo, col + named.end), line: lineNo, ...withId });
    } else if (speakers.some((s) => text.startsWith(s + NAME_OPEN))) {
      // 地の文として残す（{name の読めないところは、この一件の誤りにまとめる）
      report("error", "bad-speaker-name", lineNo, '{name …} のすぐ後には台詞の括弧（「『（(）か引用符（" “）を書きます', { column: col, hint: 'ユイ{name ？？？}「……」、Yui{name ???} "……"' });
      frame.body.push({ kind: "prose", content: parseInline(text, col).content, line: lineNo, ...withId });
    } else if ((stranger = strangerWithName(text))) {
      // 話者でない名前の {name …}「…」: 話者に足せば台詞になることを一つの警告で言う（{name の読めない誤りは重ねない）。
      // 地の文として残し、{name …} は本文に出さない（check の台詞の形の検査はこの行を見ない）
      const close = stranger.speaker.length + NAME_OPEN.length + stranger.inner.length + 1;
      report("warning", "unknown-speaker", lineNo, `${stranger.speaker} は話者に登録されていないため、この行は台詞ではなく地の文になります（{name …} は話者の台詞にだけ書けます）`, {
        column: col,
        hint: `${stranger.speaker} を話者（cast.json の speakers）に追加すると、名前の欄を ${stranger.inner} にした台詞になります`,
        fixes: [{ kind: "add-speaker", name: stranger.speaker }],
      });
      frame.body.push({ kind: "prose", content: [{ kind: "text", text: stranger.speaker }, ...inline(text.slice(close), lineNo, col + close)], line: lineNo, ...withId });
    } else {
      if (/^- .+ -> \S/.test(text)) {
        report("warning", "option-outside-choice", lineNo, "選択肢の行（- … -> 飛び先）が @choice の外にあるため、本文になります", { column: col, hint: "選択肢の行の前に @choice、後に @end を書きます" });
      }
      frame.body.push({ kind: "prose", content: inline(text, lineNo, col), line: lineNo, ...withId });
    }
    // 台詞と地の文の行末の // は本文として出る
    if (!text.startsWith("@") && !text.startsWith("#") && !text.startsWith("//") && frame.kind !== "choice") {
      const cut = trailingComment(text, false);
      // 括弧の中の // は台詞の文（閉じ括弧が後ろにある）
      if (cut >= 0 && !/[」』）)"”]/.test(text.slice(cut))) {
        report("warning", "trailing-comment", lineNo, "行末のコメントは書けません（// から後ろも本文として表示されます）", { column: col + cut, hint: "コメントは前の行に // で書きます", fix: { kind: "replace", find: text.slice(cut), with: "" } });
      }
    }
  }

  /**
   * 行末の固定の行 ID（`#line:ID`）を外す。同じファイルで二度使った ID はエラー（鍵が重なり、訳とボイスの番号を取り違えるため）。
   * `#line:` の後ろが ID の形でなければ警告にして、本文のまま残す。
   */
  function lineId(line: string, lineNo: number, col: number): { body: string; id: string | undefined } {
    const tagged = splitLineId(line);
    if (tagged.bad) report("warning", "bad-line-id", lineNo, "行 ID に使えるのは英数字、_、- だけです（#line: から後ろも本文として表示されます）", { column: col + tagged.column, hint: "ユイ「おはよう」 #line:a1b2c3d4" });
    if (!tagged.id) return { body: tagged.body, id: undefined };
    const first = seenIds.get(tagged.id);
    if (first !== undefined) report("error", "duplicate-line-id", lineNo, `行 ID ${tagged.id} は ${first} 行目でも使われています`, { column: col + tagged.column, hint: "どちらかの #line: を消して、lim i18n --stamp-ids で振り直します" });
    else seenIds.set(tagged.id, lineNo);
    return { body: tagged.body, id: tagged.id };
  }

  /**
   * 日本語入力のまま打った行頭の全角の記号（＠ ＃ ／／）。命令・ラベル・コメントにならず本文として出るので、半角にする直し方を付けて知らせる。
   */
  function lintWideHead(line: string, lineNo: number, col: number): void {
    const at = /^＠(?=[A-Za-zＡ-Ｚａ-ｚ])/.exec(line);
    // ＃ のあとに空白と名前、か英数字の名前（「＃１位」のような本文は当てない）
    const label = /^＃(?:[ 　](?=[\p{L}\p{N}_-]+$)|(?=[A-Za-z0-9_-]+$))/u.exec(line);
    const comment = /^(?:／／|／\/|\/／)/.exec(line);
    if (at) report("warning", "fullwidth-symbol", lineNo, "行頭の ＠ が全角のため、コマンドではなく本文になります（半角の @ で書きます）", { column: col, fix: { kind: "replace", find: "＠", with: "@" } });
    else if (label) report("warning", "fullwidth-symbol", lineNo, "行頭の ＃ が全角のため、ラベルではなく本文になります（半角の # と半角スペースで書きます）", { column: col, fix: { kind: "replace", find: label[0], with: "# " } });
    else if (comment) report("warning", "fullwidth-symbol", lineNo, "行頭の ／ が全角のため、コメントではなく本文になります（半角の // で書きます）", { column: col, fix: { kind: "replace", find: comment[0], with: "//" } });
  }

  for (const frame of stack.slice(1)) {
    const line = frame.kind === "root" ? 0 : frame.node.line;
    report("error", "unclosed-block", line, `@${frame.kind} が @end で閉じられていません`);
  }

  // 後ろに行の無い lim-ignore は、どこにも効かない（unused-ignore で知らせる）
  for (const p of pending) ignores.push({ ...p, target: p.line });
  return { file, body: root.body, diagnostics, ...(ignores.length > 0 ? { ignores } : {}), ...(draft ? { draft: true as const } : {}) };

  // ---- 命令 ----

  /** @script のように後続の行を読んだときは、最後に読んだ行の位置を返す。 */
  function handleCommand(line: string, lineNo: number, col: number, rowIndex: number): number | undefined {
    // 行末の // は命令の続きとして読まれ、見当違いの誤りになる。誤りにして、残りの行だけを読む
    const cut = trailingComment(line, true);
    if (cut >= 0) {
      report("error", "trailing-comment", lineNo, "行末のコメントは書けません", { column: col + cut, hint: "コメントは命令の前の行に // で書きます", fix: { kind: "replace", find: line.slice(cut), with: "" } });
      line = line.slice(0, cut).trimEnd();
    }
    // 命令名の後ろの区切りは空白なら何でも読む（ノーブレークスペースなどは lintSpaces が警告する）
    const m = /^@(\S*)(?:\s+(.*))?$/u.exec(line)!;
    const name = m[1]!;
    let rest = (m[2] ?? "").trim();
    const restCol = col + 1 + name.length + 1;
    const frame = top();

    if (!COMMAND_NAME.test(name)) {
      report("error", "bad-command-name", lineNo, `コマンド名に使えるのは英小文字、数字、- だけです: @${name}`, { column: col, hint: `本文なら \\${line}` });
      return;
    }

    // 行の if=(式): 偽ならその命令を飛ばす（@if で一行を囲んだのと同じ構文木にする）。ブロックを開く書き方の言葉には書けない
    let guard: { expr: Expr; source: string } | null = null;
    const g = takeGuard(rest);
    if (g) {
      if (NO_GUARD.has(name)) {
        report("error", "bad-guard", lineNo, `@${name} には if= を書けません`, { column: restCol + g.at, hint: name === "choice" ? "選択肢の行ごとに if=(式) を書くか、@if 〜 @end で囲みます" : "@if 〜 @end で囲みます" });
      } else {
        // 桁がずれないよう、if=(…) は空白に置き換えて読む
        rest = (rest.slice(0, g.at) + " ".repeat(g.end - g.at) + rest.slice(g.end)).trimEnd();
        const e = expr(g.source, lineNo, restCol + g.at + 4);
        if (e) guard = { expr: e, source: g.source.trim() };
      }
    } else if (EXPRESSION_LINE.has(name)) {
      // 式を書く行（@set など）は引数として読まないので、(…) で書いていない if= が式の中に入って見当違いの誤りになる。先に切り出して直し方を出す
      const bare = takeBareGuard(rest);
      if (bare) {
        report("error", "bad-guard", lineNo, "if= の値は (式) で書きます", { column: restCol + bare.at, hint: `if=(${bare.value})`, fix: { kind: "replace", find: `if=${bare.value}`, with: `if=(${bare.value})` } });
        rest = rest.slice(0, bare.at).trimEnd();
      }
    }
    const before = frame.body.length;
    const resume = dispatch();
    // 一行の命令（命令、@set、@let、@jump、@call、@return、@content）だけを、条件の枝に入れる
    if (guard && frame.body.length === before + 1 && top() === frame) {
      const stmt = frame.body.pop()!;
      frame.body.push({ kind: "if", branches: [{ condition: guard.expr, body: [stmt], line: lineNo }], guard: guard.source, line: lineNo });
    }
    return resume;

    function dispatch(): number | undefined {
      const noArgs = () => {
        if (rest !== "") report("error", "unexpected-argument", lineNo, `@${name} にはパラメータを書けません`, { column: restCol });
      };

      switch (name) {
        case "if": {
          const node: Extract<Statement, { kind: "if" }> = { kind: "if", branches: [], line: lineNo };
          const branch: IfBranch = { condition: expr(rest, lineNo, restCol), body: [], line: lineNo };
          node.branches.push(branch);
          frame.body.push(node);
          stack.push({ kind: "if", node, body: branch.body });
          return;
        }
        case "while": {
          const branch: IfBranch = { condition: expr(rest, lineNo, restCol), body: [], line: lineNo };
          const node: Extract<Statement, { kind: "if" }> = { kind: "if", branches: [branch], loop: true, line: lineNo };
          frame.body.push(node);
          stack.push({ kind: "while", node, body: branch.body });
          return;
        }
        case "for": {
          // @for 名前 in 配列の式 〜 @end。要素を一つずつ名前の局所変数に入れて中をくり返す
          const f = /^([\p{ID_Start}_][\p{ID_Continue}_]*)\s+in\s+(.+)$/u.exec(rest);
          if (!f) report("error", "bad-for", lineNo, "@for は `@for 名前 in 配列の式` の形で書き、@end までを配列の要素ごとにくり返します", { column: restCol, hint: "@for item in game.items" });
          const list = f ? expr(f[2]!, lineNo, restCol + rest.lastIndexOf(f[2]!)) : null;
          const branch: IfBranch = { condition: null, body: [], line: lineNo };
          const node: Extract<Statement, { kind: "if" }> = { kind: "if", branches: [branch], loop: true, each: { name: f?.[1] ?? "", list: list ?? { kind: "array", items: [] } }, line: lineNo };
          frame.body.push(node);
          stack.push({ kind: "for", node, body: branch.body });
          return;
        }
        case "with": {
          // @with マクロ パラメータ… 〜 @end。中身をマクロに渡す
          const w = /^([a-z][a-z0-9-]*)(?:\s+(.*))?$/.exec(rest);
          if (!w) {
            report("error", "bad-with", lineNo, "@with は `@with マクロ パラメータ…` の形で書き、@end までの行を中身としてマクロに渡します", { column: restCol, hint: "@with flashback time=1s" });
          }
          const args = w?.[2] ? parseArgs(w[2], lineNo, restCol + w[1]!.length + 1) : [];
          const branch: IfBranch = { condition: null, body: [], line: lineNo };
          const node: Extract<Statement, { kind: "if" }> = { kind: "if", branches: [branch], with: { name: w?.[1] ?? "", args }, line: lineNo };
          frame.body.push(node);
          stack.push({ kind: "with", node, body: branch.body });
          return;
        }
        case "content":
          noArgs();
          frame.body.push({ kind: "content", line: lineNo });
          return;
        case "elif":
        case "else": {
          if (frame.kind !== "if") {
            report("error", "orphan-branch", lineNo, `@${name} の前に対応する @if がありません`, { column: col });
            return;
          }
          if (frame.node.branches.at(-1)!.condition === null) {
            report("error", "branch-after-else", lineNo, `@else のあとに @${name} は置けません`, { column: col });
            return;
          }
          let condition: Expr | null = null;
          if (name === "elif") condition = expr(rest, lineNo, restCol);
          else noArgs();
          const branch: IfBranch = { condition, body: [], line: lineNo };
          frame.node.branches.push(branch);
          frame.body = branch.body;
          return;
        }
        case "end":
          noArgs();
          if (frame.kind === "root") {
            report("error", "orphan-end", lineNo, "対応するブロックのない @end です", { column: col });
            return;
          }
          stack.pop();
          return;
        case "choice": {
          const args = rest === "" ? [] : parseArgs(rest, lineNo, restCol);
          const node: Extract<Statement, { kind: "choice" }> = { kind: "choice", options: [], line: lineNo, ...(args.length > 0 ? { args } : {}) };
          frame.body.push(node);
          stack.push({ kind: "choice", node, body: [] });
          return;
        }
        case "define": {
          const d = /^([a-z][a-z0-9-]*)\((.*)\)$/.exec(rest);
          if (!d) {
            report("error", "bad-define", lineNo, "@define は `@define 名前(パラメータ: 型 = 既定値, …)` の形で書きます", {
              column: restCol,
              hint: "@define title-card(text: string, time: duration = 1s)",
            });
            stack.push({ kind: "define", node: { kind: "define", name: "", params: [], body: [], line: lineNo }, body: [] });
            return;
          }
          // すぐ上に続く // の行は、マクロの要約（補完と説明に出す）
          const doc = commentLine === lineNo - 1 ? comments.filter((c) => c !== "").join(" ") : "";
          const node: Extract<Statement, { kind: "define" }> = {
            kind: "define",
            name: d[1]!,
            params: parseParams(d[2]!, lineNo, restCol + d[1]!.length + 1),
            body: [],
            line: lineNo,
            ...(doc !== "" ? { doc } : {}),
          };
          if (frame.kind !== "root") report("error", "nested-define", lineNo, "@define はファイルの一番外側に置きます", { column: col });
          frame.body.push(node);
          stack.push({ kind: "define", node, body: node.body });
          return;
        }
        case "script": {
          noArgs();
          const { lines, end } = rawLines(rowIndex);
          if (end >= rows.length) report("error", "unclosed-block", lineNo, "@script が @end で閉じられていません");
          frame.body.push({ kind: "script", code: dedent(lines).text, line: lineNo });
          return end;
        }
        case "html":
        case "staff-roll": {
          // @staff-roll の file= は data/ の中身を使うので、@end までの行を持たない
          if (!opensBody(name, rest)) {
            frame.body.push({ kind: "command", name, args: parseArgs(rest, lineNo, restCol), line: lineNo });
            return;
          }
          // 引数のあと、@end だけの行までの中身をそのまま持つ（@html の中身は check が html.ts で確かめる）
          const args = parseArgs(rest, lineNo, restCol);
          const { lines, end } = rawLines(rowIndex);
          if (end >= rows.length) report("error", "unclosed-block", lineNo, `@${name} が @end で閉じられていません`);
          const { text, indent } = dedent(lines);
          frame.body.push({ kind: "command", name, args, body: { text, line: lineNo + 1, indent }, line: lineNo });
          return end;
        }
        case "set": {
          const s = /^(.+?)\s*(\+=|-=|\*=|\/=|=)\s*(.*)$/.exec(rest);
          if (!s) {
            report("error", "bad-set", lineNo, "@set は `@set 変数 = 式`（= += -= *= /=）の形で書きます", { column: restCol, hint: "@set game.trust += 1" });
            return;
          }
          const target = expr(s[1]!, lineNo, restCol);
          const value = expr(s[3]!, lineNo, restCol + rest.indexOf(s[3]!));
          if (target && !isAssignable(target)) {
            report("error", "bad-set-target", lineNo, "@set の左辺は変数（game.x / system.x / temp.x / ローカル変数）です", { column: restCol });
            return;
          }
          if (target && value) frame.body.push({ kind: "set", target, op: s[2] as "=", value, line: lineNo });
          return;
        }
        case "let": {
          // @let 名前 = 式。+= -= *= /= は @set と同じ（@let i += 1 は @let i = i + 1）
          const l = /^([\p{ID_Start}_][\p{ID_Continue}_]*)\s*([+\-*/]?)=\s*(.*)$/u.exec(rest);
          if (!l) {
            report("error", "bad-let", lineNo, "@let は `@let 名前 = 式` の形で書きます（= += -= *= /=）", { column: restCol, hint: "@let count = 0" });
            return;
          }
          const value = expr(l[3]!, lineNo, restCol + rest.lastIndexOf(l[3]!));
          if (!value) return;
          const op = l[2] as "" | "+" | "-" | "*" | "/";
          frame.body.push({ kind: "let", name: l[1]!, value: op === "" ? value : { kind: "binary", op, left: { kind: "name", name: l[1]! }, right: value }, line: lineNo });
          return;
        }
        case "function": {
          // @function 名前(引数, …) = 式。式で呼べる自前の関数
          const fn = /^([\p{ID_Start}_][\p{ID_Continue}_]*)\s*\(([^()]*)\)\s*=\s*(.+)$/u.exec(rest);
          if (!fn) {
            // = の無い `@function 名前(引数)` の後ろに @end までの行があるのは、手順を書いたブロックの形（関数は一行の式だけ）
            const head = /^([\p{ID_Start}_][\p{ID_Continue}_]*)\s*\(([^()]*)\)$/u.exec(rest);
            const block = head ? functionBlock(rowIndex) : null;
            if (head && block) return blockFunction(head[1]!, head[2]!, block, lineNo, restCol);
            report("error", "bad-function", lineNo, "@function は `@function 名前(引数, …) = 式` の形で書きます", { column: restCol, hint: '@function rank(score) = score >= 80 ? "A" : "B"' });
            return;
          }
          const params = fn[2]!.split(",").map((p) => p.trim()).filter((p) => p !== "");
          const badParam = params.find((p) => !/^[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(p));
          if (badParam !== undefined) {
            report("error", "bad-function", lineNo, `引数の名前に使えるのは文字、数字、_ だけです: ${badParam}`, { column: restCol });
            return;
          }
          const dup = params.find((p, i) => params.indexOf(p) !== i);
          if (dup !== undefined) report("error", "bad-function", lineNo, `引数 ${dup} が二回あります`, { column: restCol });
          if (frame.kind !== "root") report("error", "nested-function", lineNo, "@function はファイルの一番外側に置きます", { column: col });
          const body = expr(fn[3]!, lineNo, restCol + rest.lastIndexOf(fn[3]!));
          if (body) frame.body.push({ kind: "function", name: fn[1]!, params, body, line: lineNo });
          return;
        }
        case "jump":
        case "call": {
          // 式の飛び先は、閉じ括弧の後ろに候補（to=）を書ける
          const close = rest.startsWith("(") ? closingParen(rest) : -1;
          const tail = close >= 0 ? rest.slice(close + 1).trim() : "";
          const target = parseTarget(close >= 0 ? rest.slice(0, close + 1) : rest, lineNo, restCol);
          if (target && tail !== "") {
            const args = parseArgs(tail, lineNo, restCol + rest.indexOf(tail));
            for (const a of args) {
              if (a.key === "to" && a.value.kind === "string") target.candidates = splitCandidates(a.value.value);
              else report("error", "bad-target", lineNo, "式のジャンプ先のあとに書けるのは to=（ジャンプ先の候補）だけです", { column: a.column, hint: "@jump (game.next) to=#north,#south" });
            }
          }
          if (target) frame.body.push({ kind: name, target, line: lineNo });
          return;
        }
        case "return": {
          // @define の中では `@return (式)` で値を返せる（呼び出しの variable 型のパラメータに入れる）
          if (rest === "") {
            frame.body.push({ kind: "return", line: lineNo });
            return;
          }
          if (!rest.startsWith("(") || closingParen(rest) !== rest.length - 1) {
            report("error", "bad-return", lineNo, "@return のあとに書けるのは (式) だけです（@define の中で値を返すとき）", { column: restCol, hint: "@return (game.score * 2)" });
            return;
          }
          const value = expr(rest.slice(1, -1), lineNo, restCol + 1);
          if (value) frame.body.push({ kind: "return", value, line: lineNo });
          return;
        }
        case "use": {
          if (!/^[\w./-]+$/.test(rest)) {
            report("error", "bad-use", lineNo, "@use は `@use ファイル` の形で書きます（拡張子は付けません）", { column: restCol, hint: "@use common" });
            return;
          }
          if (frame.kind !== "root") report("error", "nested-use", lineNo, "@use はファイルの一番外側に置きます", { column: col });
          frame.body.push({ kind: "use", file: rest, line: lineNo });
          return;
        }
        default: {
          const args = parseArgs(rest, lineNo, restCol);
          // if= の値は必ず (式)
          const bare = args.find((a) => a.key === "if");
          if (bare) {
            // 値は書いたままの字面で囲む（直し方の find は書いた字面のまま）
            const written = bare.text ?? `if=${printLiteral(bare.value)}`;
            const value = written.replace(/^if[=＝]/, "");
            report("error", "bad-guard", lineNo, "if= の値は (式) で書きます", { column: bare.column, hint: `if=(${value})`, fix: { kind: "replace", find: written, with: `if=(${value})` } });
          }
          frame.body.push({ kind: "command", name, args: bare ? args.filter((a) => a !== bare) : args, line: lineNo });
        }
      }
    }
  }

  /** @script・@html のように、次の行から @end だけの行の前までをそのまま集める。end は @end の行の位置（無ければ行の数）。 */
  function rawLines(rowIndex: number): { lines: string[]; end: number } {
    const lines: string[] = [];
    let j = rowIndex + 1;
    for (; j < rows.length; j++) {
      const r = (rows[j] ?? "").replace(/\r$/, "");
      if (r.trim() === "@end") break;
      lines.push(r);
    }
    return { lines, end: j };
  }

  /**
   * `@function 名前(引数)` の次の行から、対応する @end までの中身（空行を除き、前後の空白を取ったもの）と、@end の行の位置。
   * 中の @if などのブロックの @end も数える。ラベルの行か、ファイルの終わりまで対応する @end が無ければ null（ブロックの形ではない）。
   */
  function functionBlock(rowIndex: number): { lines: string[]; end: number } | null {
    const lines: string[] = [];
    let depth = 1;
    for (let j = rowIndex + 1; j < rows.length; j++) {
      const r = (rows[j] ?? "").replace(/\r$/, "").trim();
      if (r.startsWith("#")) return null;
      const m = /^@([a-z][a-z0-9-]*)(?:\s+(.*))?$/.exec(r);
      if (m && m[1] === "end" && (m[2] ?? "") === "") {
        if (--depth === 0) return { lines, end: j };
      } else if (m && (BLOCK_OPENERS.has(m[1]!) || ((m[1] === "html" || m[1] === "staff-roll") && opensBody(m[1], m[2] ?? "")))) depth++;
      if (r !== "") lines.push(r);
    }
    return null;
  }

  /**
   * ブロックの形で書いた @function（関数は一行の式だけ）。一つの誤りにまとめ、中身と @end は読み飛ばす（@return と @end の誤りを重ねない）。
   * 使う所が「関数がありません」にならないよう、値の無い関数として残す。中身が @return 一つなら、一行の形にする直し方を付ける。
   * 返すのは最後に読んだ行（@end）の位置。
   */
  function blockFunction(name: string, paramText: string, block: { lines: string[]; end: number }, lineNo: number, column: number): number {
    const params = paramText.split(",").map((p) => p.trim()).filter((p) => p !== "");
    const head = `${name}(${params.join(", ")})`;
    // 間に空行もコメントも無く、中身が @return 一つ（行の数は @function、@return、@end の三つ）
    const only = block.end === lineNo + 1 ? /^@return\s+(.+)$/.exec(block.lines[0] ?? "") : null;
    let value = only ? only[1]!.trim() : null;
    if (value !== null && value.startsWith("(") && closingParen(value) === value.length - 1) value = value.slice(1, -1).trim();
    if (value !== null) {
      try {
        parseExpr(value);
      } catch {
        // 読めない式なら、一行の形にする直し方は付けない（手順の形と同じ案にする）
        value = null;
      }
    }
    const message = "関数は一行の式で書きます（@function 名前(引数) = 式）。手順を書くなら @define にします";
    if (value !== null) {
      const one = `@function ${head} = ${value}`;
      const fix: DiagnosticFix = { kind: "replace-lines", lines: [rows[lineNo - 1]!, block.lines[0]!, rows[block.end]!].map((r) => commandShape(r) ?? r.trim()), with: one };
      report("error", "bad-function", lineNo, message, { column, hint: `${one} と書きます`, fix });
    } else {
      // @define の戻り値は型 variable のパラメータに入る（8 章の「戻り値」）
      const signature = `${name}(${[...params.map((p) => `${p}: number`), "into: variable"].join(", ")})`;
      report("error", "bad-function", lineNo, message, { column, hint: `値を計算するだけなら @function ${head} = 式 の一行に、手順を書くなら @define ${signature} の中で @return (式) を書きます` });
    }
    if (top().kind === "root" && params.every((p) => /^[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(p))) top().body.push({ kind: "function", name, params, body: { kind: "literal", value: null }, line: lineNo });
    return block.end;
  }

  /** `- 表示する文 -> 飛び先 key=value…`。飛び先のあとの引数は見た目の指定（画像のボタンなど）。 */
  function parseOption(line: string, lineNo: number, col: number): ChoiceOption | null {
    // 行末の固定の行 ID（#line:ID）
    const tagged = lineId(line, lineNo, col);
    line = tagged.body;
    const withId = tagged.id ? { id: tagged.id } : {};
    const cut = trailingComment(line, true, Math.max(0, line.lastIndexOf(" -> ")));
    if (cut >= 0) {
      report("error", "trailing-comment", lineNo, "行末のコメントは書けません", { column: col + cut, hint: "コメントは選択肢の前の行に // で書きます", fix: { kind: "replace", find: line.slice(cut), with: "" } });
      line = line.slice(0, cut).trimEnd();
    }
    const arrow = line.lastIndexOf(" -> ");
    if (!line.startsWith("- ") || arrow < 0) {
      report("error", "bad-option", lineNo, "@choice の中に書けるのは `- 表示するテキスト -> ジャンプ先` の行だけです", { column: col, hint: "- 北の道を行く -> #north_road" });
      return null;
    }
    const after = line.slice(arrow + 4).trim();
    // 式の飛び先 `(…)` は閉じ括弧まで（中に空白があってよい）
    const close = after.startsWith("(") ? closingParen(after) : -1;
    const space = close >= 0 ? (after.length > close + 1 ? close + 1 : -1) : after.indexOf(" ");
    const targetText = space < 0 ? after : after.slice(0, space);
    const target = parseTarget(targetText, lineNo, col + arrow + 4);
    if (!target) return null;
    let args = space < 0 ? [] : parseArgs(after.slice(space + 1).trim(), lineNo, col + arrow + 4 + space + 1);
    // 式の飛び先の候補（to=）は飛び先のほうに持つ
    const to = target.expr ? args.find((a) => a.key === "to") : undefined;
    if (to && to.value.kind === "string") {
      target.candidates = splitCandidates(to.value.value);
      args = args.filter((a) => a !== to);
    }
    return { content: inline(line.slice(2, Math.max(2, arrow)), lineNo, col + 2, "option"), target, args, line: lineNo, ...withId };
  }

  function parseTarget(text: string, lineNo: number, col: number): Target | null {
    const t = text.trim();
    if (t.startsWith("(") && closingParen(t) === t.length - 1) {
      try {
        return { file: null, label: null, expr: parseExpr(t.slice(1, -1)) };
      } catch (e) {
        if (!(e instanceof ExprError)) throw e;
        report("error", "bad-expression", lineNo, `ジャンプ先の式を解釈できません: ${e.message}`, { column: col });
        return null;
      }
    }
    const target = parseTargetText(text);
    if (!target) report("error", "bad-target", lineNo, "ジャンプ先は `#ラベル`、`ファイル`、`ファイル#ラベル` のどれかで書きます", { column: col, hint: "#north_road / chapter2 / chapter2#start" });
    return target;
  }

  function parseParams(text: string, lineNo: number, col: number): Param[] {
    if (text.trim() === "") return [];
    const params: Param[] = [];
    for (const part of splitOutsideQuotes(text, ",")) {
      // 型は名前か、括弧の付いたもの（asset(bgimage)、enum(a|b)）
      const p = /^\s*([a-z][a-z0-9-]*)\s*:\s*([a-z]+(?:\([^()]*\))?)\s*(?:=\s*(.+?))?\s*$/.exec(part);
      if (!p) {
        report("error", "bad-param", lineNo, `パラメータは \`名前: 型 = 既定値\` の形で書きます: ${part.trim()}`, { column: col, hint: "time: duration = 1s" });
        continue;
      }
      params.push({ name: p[1]!, type: p[2]!, defaultValue: p[3] === undefined ? null : parseLiteral(p[3]) });
    }
    return params;
  }

  function parseArgs(text: string, lineNo: number, col: number): Argument[] {
    const { args, errors } = parseArgsText(text, col);
    for (const e of errors) report(e.severity ?? "error", e.code, lineNo, e.message, { column: col + e.offset, ...(e.fix ? { fix: e.fix } : {}) });
    return args;
  }
}


/** "…" の外にある sep で区切る（既定値の文字列に , を書けるように）。 */
function splitOutsideQuotes(text: string, sep: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted && c === "\\") {
      current += c + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === sep && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

/**
 * 行末のコメント（空白の後ろの //）の、前の空白の位置（無ければ -1）。"…" の中は見ない。args なら (…) の中も見ない（命令と選択肢の行）。
 * 本文なら {…} の中は見ない。https://… のように空白の後ろでない // は数えない。from より前は見ない。
 */
export function trailingComment(line: string, args: boolean, from = 0): number {
  let quoted = false;
  let depth = 0;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (args && c === '"') quoted = !quoted;
    else if (!quoted && (c === (args ? "(" : "{"))) depth++;
    else if (!quoted && (c === (args ? ")" : "}"))) depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0 && c === "/" && line[i + 1] === "/" && i > 0 && /[ \t\u3000]/.test(line[i - 1]!)) {
      let at = i;
      while (at > 0 && /[ \t\u3000]/.test(line[at - 1]!)) at--;
      return at;
    }
  }
  return -1;
}

function isAssignable(e: Expr): boolean {
  if (e.kind === "name") return true;
  if (e.kind === "member" || e.kind === "index") return isAssignable(e.object);
  return false;
}

function dedent(lines: string[]): { text: string; indent: number } {
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)![0].length);
  const n = indents.length > 0 ? Math.min(...indents) : 0;
  return { text: lines.map((l) => l.slice(n)).join("\n"), indent: n };
}

/** text[0] の "(" に対応する ")" の位置（"…" の中は数えない）。無ければ -1。 */
function closingParen(text: string): number {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** to= の候補（`#a,#b,ch2#start`。区切りはカンマ）。 */
function splitCandidates(text: string): string[] {
  return text.split(",").map((t) => t.trim()).filter((t) => t !== "");
}
