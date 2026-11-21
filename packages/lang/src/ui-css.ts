import type { Diagnostic } from "./ast.ts";

/**
 * 作品の CSS（liminalia.json の ui.css）。作品のフォルダからのパスで並べた CSS のファイルを、遊ぶ側がテーマとプラグインの CSS のあとに読む。
 * エンジンの CSS はカスケードレイヤー liminalia の中にあるので、作品の CSS は詳細度を競わずに勝つ。
 *
 * 作品の外は読まない: ファイルのパスも、CSS の中の url() と @import も、作品のフォルダの中を指す相対のパス（../ で上がってもよいが、
 * 作品のフォルダより上へは出ない）か data: だけ。http: などの絶対の URL と / で始まるパスは書き出しに入らず、書き出したゲームの
 * 決まり（Content-Security-Policy）でも読めないので、lim check が知らせる。
 *
 * 制作画面のゲームの画面のタブは、部品の欄から「セレクタ { 性質: 値; }」の一行を書き、同じセレクタと性質の行があれば書き換える（setCssRule）。
 */

/** ui.css が無いときに、制作画面が作って ui.css に足すファイル。 */
export const UI_CSS_DEFAULT = "ui/screens.css";

/** ui.css のファイルの並び（形の誤りは checkUi が知らせる。読めるものだけ）。 */
export function uiCssFiles(ui: unknown): string[] {
  const list = ui && typeof ui === "object" ? (ui as { css?: unknown }).css : undefined;
  return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string" && uiCssPathProblem(f) === null) : [];
}

/** ui.css の一つのパスの誤り（無ければ null）。作品のフォルダの中の .css のファイルを、/ で区切った相対のパスで書く。 */
export function uiCssPathProblem(path: string): string | null {
  if (path === "" || !/\.css$/i.test(path)) return "は .css のファイルを書きます";
  if (path.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/") || normalizeInside(path) === null) return "は作品のフォルダの中のファイルを、作品のフォルダからの相対のパスで書きます";
  return null;
}

/** 作品のフォルダからの相対のパスを整える（. と .. を解く）。作品のフォルダより上へ出れば null。 */
function normalizeInside(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.length > 0 ? out.join("/") : null;
}

/** CSS の中の url() と @import が指すもの（行は 1 始まり）。 */
export interface CssReference {
  kind: "url" | "import";
  value: string;
  line: number;
}

/** CSS の字面の誤り（閉じていないコメント、文字列、括弧）。 */
export interface CssSyntaxProblem {
  line: number;
  reason: "comment" | "string" | "brace" | "paren";
}

/**
 * CSS を字ごとに読み、url() と @import の参照と、字面の誤りを集める（コメントと文字列の中は数えない）。
 * 細かな文法は見ない（ブラウザは読めない規則だけを飛ばすので、作品の画面が丸ごと崩れるのは閉じていない括弧などのとき）。
 */
export function scanCss(text: string): { references: CssReference[]; problem: CssSyntaxProblem | null } {
  const references: CssReference[] = [];
  let line = 1;
  let i = 0;
  const braces: number[] = [];
  const parens: number[] = [];
  const n = text.length;
  /** 引用符で囲んだ文字列を読み、中身を返す（閉じていなければ null）。 */
  const readString = (): string | null => {
    const quote = text[i]!;
    let out = "";
    i++;
    while (i < n) {
      const c = text[i]!;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === "\n") return null;
      if (c === quote) {
        i++;
        return out;
      }
      out += c;
      i++;
    }
    return null;
  };
  const skipSpace = () => {
    while (i < n && /\s/.test(text[i]!)) {
      if (text[i] === "\n") line++;
      i++;
    }
  };
  while (i < n) {
    const c = text[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return { references, problem: { line, reason: "comment" } };
      for (let k = i; k < end; k++) if (text[k] === "\n") line++;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const at = line;
      if (readString() === null) return { references, problem: { line: at, reason: "string" } };
      continue;
    }
    if (c === "{") braces.push(line);
    else if (c === "}") {
      if (braces.pop() === undefined) return { references, problem: { line, reason: "brace" } };
    } else if (c === "(") parens.push(line);
    else if (c === ")") {
      if (parens.pop() === undefined) return { references, problem: { line, reason: "paren" } };
    }
    // url(...)（引用符なしは閉じ括弧まで）
    if ((c === "u" || c === "U") && /^url\(/i.test(text.slice(i, i + 4)) && !/[\w-]/.test(text[i - 1] ?? "")) {
      const at = line;
      i += 4;
      skipSpace();
      let value: string | null;
      if (text[i] === '"' || text[i] === "'") value = readString();
      else {
        const end = text.indexOf(")", i);
        if (end < 0) return { references, problem: { line: at, reason: "paren" } };
        value = text.slice(i, end).trim();
        i = end;
      }
      if (value === null) return { references, problem: { line: at, reason: "string" } };
      skipSpace();
      if (text[i] !== ")") return { references, problem: { line: at, reason: "paren" } };
      i++;
      references.push({ kind: "url", value, line: at });
      continue;
    }
    // @import "x.css"（url() で書いたものは上の url で数える）
    if (c === "@" && /^@import\b/i.test(text.slice(i, i + 8))) {
      const at = line;
      i += 7;
      skipSpace();
      if (text[i] === '"' || text[i] === "'") {
        const value = readString();
        if (value === null) return { references, problem: { line: at, reason: "string" } };
        references.push({ kind: "import", value, line: at });
      }
      continue;
    }
    i++;
  }
  if (braces.length > 0) return { references, problem: { line: braces[braces.length - 1]!, reason: "brace" } };
  if (parens.length > 0) return { references, problem: { line: parens[parens.length - 1]!, reason: "paren" } };
  return { references, problem: null };
}

/**
 * CSS のファイル（作品のフォルダからのパス）の中の参照が指すもの。data: と #（SVG の中の印）は読まないもの（skip）、
 * 作品の外（絶対の URL、/ で始まるパス、作品のフォルダより上）は outside、ほかは作品のフォルダからのパス（? と # の後ろは外す）。
 */
export function resolveCssReference(cssFile: string, value: string): { skip: true } | { outside: true } | { path: string } {
  const v = value.trim();
  if (v === "" || v.startsWith("#") || /^data:/i.test(v)) return { skip: true };
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith("/") || v.startsWith("\\")) return { outside: true };
  const bare = v.replace(/[?#].*$/, "");
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // %の並びが崩れていればそのままのパスとして探す（無ければ ui-css-asset で知らせる）
  }
  const dir = cssFile.includes("/") ? cssFile.slice(0, cssFile.lastIndexOf("/")) : "";
  const path = normalizeInside(dir ? `${dir}/${decoded}` : decoded);
  return path === null ? { outside: true } : { path };
}

/**
 * CSS の中の url() と @import "…" の、作品のフォルダの中を指すものを to が返す URL に書き換える（data:、作品の外を指すものはそのまま）。
 * 束ねる道具（Vite）を通さずに CSS を渡すところ（スマホ版の制作画面）が使う。
 */
export function rewriteCssReferences(text: string, cssFile: string, to: (path: string) => string): string {
  const swap = (value: string): string | null => {
    const r = resolveCssReference(cssFile, value);
    return "path" in r ? to(r.path) : null;
  };
  return text
    .replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (m, _q: string, value: string) => {
      const url = swap(value);
      return url === null ? m : `url(${JSON.stringify(url)})`;
    })
    .replace(/@import\s+(["'])([^"']*)\1/gi, (m, _q: string, value: string) => {
      const url = swap(value);
      return url === null ? m : `@import ${JSON.stringify(url)}`;
    });
}

/** 作品のフォルダの中のファイルを読む口（パスは作品のフォルダからの / 区切り）。 */
export interface ProjectFiles {
  /** 字面（無い・読めないなら null）。 */
  text(path: string): string | null;
  exists(path: string): boolean;
}

const REASONS: Record<CssSyntaxProblem["reason"], string> = {
  comment: "閉じていないコメントがあります",
  string: "閉じていない引用符があります",
  brace: "波括弧の数が合いません",
  paren: "丸括弧の数が合いません",
};

/**
 * 作品の CSS（ui.css）の検査。無いファイル（ui-css-missing。liminalia.json の ui.css の行）、読めない CSS（ui-css-syntax）、
 * url() と @import の無いもの（ui-css-asset）、作品の外を指すもの（ui-css-outside）。CSS のファイルの診断は、そのファイルのその行に出す。
 */
export function checkUiCss(ui: unknown, files: ProjectFiles): Diagnostic[] {
  const out: Diagnostic[] = [];
  const list = ui && typeof ui === "object" ? (ui as { css?: unknown }).css : undefined;
  if (!Array.isArray(list)) return out;
  const seen = new Set<string>();
  /** 読んだ CSS（@import でたどるものも、一つのファイルは一度だけ）。 */
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = files.text(file);
    if (text === null) return;
    const { references, problem } = scanCss(text);
    if (problem) out.push({ severity: "error", code: "ui-css-syntax", message: `CSS を読めません（${REASONS[problem.reason]}）`, file, line: problem.line, hint: "閉じていない括弧やコメントを閉じてください" });
    for (const ref of references) {
      const r = resolveCssReference(file, ref.value);
      if ("skip" in r) continue;
      if ("outside" in r) {
        out.push({ severity: "error", code: "ui-css-outside", message: `${ref.value} は作品の外を指しています（作品の CSS からは、作品のフォルダの中のファイルか data: だけを読めます）`, file, line: ref.line, hint: "素材を作品のフォルダの中に置き、CSS のファイルからの相対のパスで書いてください" });
        continue;
      }
      if (!files.exists(r.path)) {
        out.push({ severity: "error", code: "ui-css-asset", message: `${ref.value} がありません（${r.path}）`, file, line: ref.line, hint: "パスを直すか、ファイルを置いてください" });
        continue;
      }
      if (ref.kind === "import" || /\.css$/i.test(r.path)) visit(r.path);
    }
  };
  list.forEach((f, i) => {
    if (typeof f !== "string" || uiCssPathProblem(f) !== null) return;
    const path = normalizeInside(f)!;
    if (!files.exists(path)) {
      out.push({ severity: "error", code: "ui-css-missing", message: `ui.css[${i}] の ${f} がありません`, file: "liminalia.json", line: 1, hint: `${f} を作るか、ui.css から外してください` });
      return;
    }
    visit(path);
  });
  return out;
}

// ---- 部品の欄が書く一行（セレクタ { 性質: 値; }） ----

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 一つの性質だけを書いた規則の行（「.lm-menu { color: #fff; }」）。一つ目の組はファイルの頭の BOM（書き換えても残す）、二つ目が値。 */
function ruleLine(selector: string, property: string): RegExp {
  const sel = selector.trim().split(/\s+/).map(escapeRe).join("\\s+");
  return new RegExp(`^(\uFEFF?)[ \\t]*${sel}[ \\t]*\\{[ \\t]*${escapeRe(property)}[ \\t]*:[ \\t]*([^;{}\\n]*?)[ \\t]*;?[ \\t]*\\}[ \\t]*$`, "m");
}

/** 部品の欄が書いた行の値（同じセレクタと性質の一行の規則。無ければ undefined）。 */
export function cssRuleValue(text: string, selector: string, property: string): string | undefined {
  return ruleLine(selector, property).exec(text)?.[2];
}

/**
 * セレクタと性質の一行を書く。同じセレクタと性質の一行があれば書き換え（value が undefined なら消す）、無ければ終わりに足す。
 * ほかの行（作者が手で書いたもの）は変えない。
 */
export function setCssRule(text: string, selector: string, property: string, value: string | undefined): string {
  const re = ruleLine(selector, property);
  const line = value === undefined ? null : `${selector.trim()} { ${property}: ${value.trim()}; }`;
  const m = re.exec(text);
  if (m) {
    if (line !== null) return text.slice(0, m.index) + m[1] + line + text.slice(m.index + m[0].length);
    // 行ごと消す（改行も。CRLF なら \r\n まで）
    const after = m.index + m[0].length;
    const end = text.startsWith("\r\n", after) ? after + 2 : text[after] === "\n" ? after + 1 : after;
    return text.slice(0, m.index) + m[1] + text.slice(end);
  }
  if (line === null) return text;
  // 足す行の改行は、ファイルの改行に合わせる（CRLF のファイルに LF を混ぜない）
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = text === "" || text.endsWith("\n") ? text : `${text}${eol}`;
  return `${body}${line}${eol}`;
}

/** 部品の欄が書く一つの値（性質と値。value が undefined なら外す）。 */
export interface CssRuleEdit {
  selector: string;
  property: string;
  value?: string | undefined;
}

/** いくつかの値をまとめて書く。 */
export function setCssRules(text: string, edits: readonly CssRuleEdit[]): string {
  return edits.reduce((t, e) => setCssRule(t, e.selector, e.property, e.value), text);
}
