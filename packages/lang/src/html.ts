import { parseTargetText } from "./args.ts";
import type { Expr } from "./ast.ts";
import { ExprError, parseExpr } from "./expr.ts";

/**
 * @html の中身（JS なしの HTML）を読む。検査（check.ts・project.ts）・素材の参照（assets.ts）・分岐の地図（story-map.ts）・
 * 実行（@liminalia/std の @html）が使う。描画側（@liminalia/std/web）は DOMParser で読み直し、同じ一覧で掃除してから置く。
 *
 * - 使えるタグと属性は下の一覧だけ。<script>・<style>・<iframe>・on… の属性・外の URL は書けない
 *   （JS は実行の前に確かめられず、セーブに残らない形で画面を変えてしまうため、入れない）
 * - `{= 式}` は出すときに評価し、HTML として読まれない文字にして埋める。src・data-jump には書けない（検査で行き先と素材を確かめるため）
 * - `data-jump="#ラベル"`（`ファイル`・`ファイル#ラベル`）の要素は、wait=true のとき押すとそこへ飛ぶ
 * - `src` は image フォルダの素材（{img …} と同じ）
 */

export const HTML_TAGS: ReadonlySet<string> = new Set([
  "div", "span", "p", "br", "hr", "strong", "em", "b", "i", "u", "s", "small", "ruby", "rt", "rp", "img",
  "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th", "h1", "h2", "h3", "h4", "button",
]);

/** 閉じタグを書かない要素。 */
export const HTML_VOID_TAGS: ReadonlySet<string> = new Set(["br", "hr", "img"]);

export const HTML_ATTRIBUTES: ReadonlySet<string> = new Set(["class", "style", "src", "alt", "width", "height", "title", "data-jump"]);

/** 中身ごと書けないタグ（JS・CSS・外のページを持ち込むもの）。 */
const DANGEROUS_TAGS: Readonly<Record<string, string>> = {
  script: "<script> は書けません（@html では JS を使えません）",
  style: "<style> は書けません（見た目は style 属性か、作品の CSS の class で付けます）",
  iframe: "<iframe> は書けません（外のページは埋め込めません）",
  object: "<object> は書けません",
  embed: "<embed> は書けません",
  link: "<link> は書けません",
  meta: "<meta> は書けません",
  base: "<base> は書けません",
  form: "<form> は書けません（押して飛ぶボタンは <button data-jump=\"#ラベル\"> で作ります）",
  input: "<input> は書けません（文字の入力は @text-input を使います）",
  svg: "<svg> は書けません（画像は <img src> で置きます）",
  math: "<math> は書けません",
  a: "<a> は書けません（押して飛ぶものは <button data-jump=\"#ラベル\"> で作ります）",
};

export interface HtmlIssue {
  code: string;
  message: string;
  /** 中身の文字列の中の位置（0 始まり）。 */
  offset: number;
  hint?: string;
}

/** `{= 式}` の埋め込み。start〜end は `{` から `}` の後ろまで。 */
export interface HtmlValue {
  expr: Expr;
  source: string;
  start: number;
  end: number;
}

export interface HtmlJump {
  /** 書いたままの飛び先（`#ラベル`・`ファイル`・`ファイル#ラベル`）。 */
  target: string;
  /** 押すものの文字（画面なしで流すときの選択肢の文）。 */
  label: string;
  offset: number;
}

export interface HtmlSource {
  /** image フォルダの中のパス。 */
  path: string;
  offset: number;
}

export interface HtmlScan {
  issues: HtmlIssue[];
  values: HtmlValue[];
  jumps: HtmlJump[];
  sources: HtmlSource[];
}

/** 外の URL・JS の URL（`http:`・`javascript:`・`data:`・`//…`）。 */
const EXTERNAL_URL = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
/** `{= 式}` を伏せた文字（構造を読むときに、式の中の < や " を拾わないため）。 */
const MASK = "\u0000";

/** @html の中身を読み、書けないものと、埋め込み・飛び先・素材を集める。 */
export function scanHtml(src: string): HtmlScan {
  const issues: HtmlIssue[] = [];
  const values: HtmlValue[] = [];
  const jumps: HtmlJump[] = [];
  const sources: HtmlSource[] = [];

  // 1. `{= 式}` を集め、同じ長さの伏せ字にする
  let masked = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "{" && src[i + 1] === "=") {
      const start = i;
      let j = i + 2;
      let quoted = false;
      while (j < src.length && (quoted || src[j] !== "}")) {
        if (src[j] === "\\" && quoted) j++;
        else if (src[j] === '"') quoted = !quoted;
        j++;
      }
      if (j >= src.length) {
        issues.push({ code: "unclosed-inline", message: "{= が } で閉じられていません", offset: start });
        masked += src.slice(i);
        break;
      }
      const source = src.slice(start + 2, j).trim();
      try {
        values.push({ expr: parseExpr(source), source, start, end: j + 1 });
      } catch (e) {
        if (!(e instanceof ExprError)) throw e;
        issues.push({ code: "bad-expression", message: e.message, offset: start + 2 });
      }
      masked += MASK.repeat(j + 1 - start);
      i = j + 1;
      continue;
    }
    masked += src[i];
    i++;
  }

  // 2. タグの並びを読む
  const stack: { name: string; offset: number; jump: number | null; textFrom: number }[] = [];
  i = 0;
  while (i < masked.length) {
    if (masked[i] !== "<") {
      i++;
      continue;
    }
    if (masked.startsWith("<!--", i)) {
      const close = masked.indexOf("-->", i + 4);
      if (close < 0) {
        issues.push({ code: "html-unclosed-tag", message: "<!-- が --> で閉じられていません", offset: i });
        break;
      }
      i = close + 3;
      continue;
    }
    const closing = masked[i + 1] === "/";
    const nameMatch = /^[A-Za-z][A-Za-z0-9-]*/.exec(masked.slice(i + (closing ? 2 : 1)));
    if (!nameMatch) {
      // `<` のあとが名前でなければ文字（ブラウザと同じ）
      i++;
      continue;
    }
    const tagStart = i;
    const name = nameMatch[0].toLowerCase();
    const end = tagEnd(masked, i + (closing ? 2 : 1) + nameMatch[0].length);
    if (end < 0) {
      issues.push({ code: "html-unclosed-tag", message: `<${closing ? "/" : ""}${nameMatch[0]} が > で閉じられていません`, offset: tagStart });
      break;
    }
    i = end + 1;

    if (closing) {
      if (HTML_VOID_TAGS.has(name)) {
        issues.push({ code: "html-bad-nesting", message: `<${name}> には閉じタグを書きません`, offset: tagStart, hint: `</${name}> を消します` });
        continue;
      }
      const at = stack.map((s) => s.name).lastIndexOf(name);
      if (at < 0) {
        issues.push({ code: "html-bad-nesting", message: `</${name}> に対応する <${name}> がありません`, offset: tagStart });
        continue;
      }
      if (at !== stack.length - 1) {
        const inner = stack[stack.length - 1]!;
        issues.push({ code: "html-bad-nesting", message: `<${inner.name}> を閉じる前に </${name}> があります（タグの入れ子が崩れています）`, offset: tagStart, hint: `</${name}> の前に </${inner.name}> を書きます` });
      }
      for (const open of stack.splice(at)) {
        if (open.jump !== null) jumps[open.jump]!.label = plain(masked.slice(open.textFrom, tagStart));
      }
      continue;
    }

    const dangerous = DANGEROUS_TAGS[name];
    if (dangerous !== undefined || !HTML_TAGS.has(name)) {
      issues.push({
        code: "html-tag-not-allowed",
        message: dangerous ?? `<${name}> は @html で使えません`,
        offset: tagStart,
        hint: `使えるタグ: ${[...HTML_TAGS].join(" ")}`,
      });
      const selfClosed = /\/\s*>$/.test(masked.slice(tagStart, end + 1));
      if (dangerous !== undefined) {
        // 中身ごと書けないタグは閉じタグまで読み飛ばす（中の JS や CSS をタグとして読まない）
        const close = selfClosed ? -1 : masked.toLowerCase().indexOf(`</${name}`, i);
        if (close >= 0) {
          const closeEnd = tagEnd(masked, close + 2 + name.length);
          i = closeEnd < 0 ? masked.length : closeEnd + 1;
        }
      } else if (!selfClosed) stack.push({ name, offset: tagStart, jump: null, textFrom: i });
      continue;
    }

    const selfClosing = /\/\s*>$/.test(masked.slice(tagStart, end + 1));
    let jump: number | null = null;
    for (const a of attributes(masked, tagStart + 1 + nameMatch[0].length, selfClosing ? end - 1 : end)) {
      const attr = a.name.toLowerCase();
      const value = a.value ?? "";
      const original = a.value === null ? "" : src.slice(a.valueStart, a.valueStart + value.length);
      if (attr.startsWith("on")) {
        issues.push({ code: "html-event-attribute", message: `${a.name}= は書けません（@html では JS を使えません）`, offset: a.offset, hint: "押して飛ぶボタンは data-jump=\"#ラベル\" で作ります" });
        continue;
      }
      if (!HTML_ATTRIBUTES.has(attr)) {
        issues.push({ code: "html-attribute-not-allowed", message: `属性 ${a.name}= は @html で使えません`, offset: a.offset, hint: `使える属性: ${[...HTML_ATTRIBUTES].join(" ")}` });
        continue;
      }
      if ((attr === "src" || attr === "data-jump") && value.includes(MASK)) {
        issues.push({ code: "html-dynamic-attribute", message: `${attr}= には {= 式} を書けません（行き先と素材を前もって確かめるため）`, offset: a.offset });
        continue;
      }
      if (/javascript\s*:/i.test(value)) {
        issues.push({ code: "html-external-url", message: `${attr}= に javascript: は書けません`, offset: a.offset });
        continue;
      }
      if (attr === "src") {
        if (EXTERNAL_URL.test(value)) {
          issues.push({ code: "html-external-url", message: `src= に外の URL は書けません: ${value}`, offset: a.offset, hint: "画像は作品の image フォルダに入れ、src=\"フォルダの中のパス\" と書きます" });
        } else if (value.trim() === "") {
          issues.push({ code: "html-empty-src", message: "src= が空です", offset: a.offset });
        } else {
          // 位置はパスの頭（引用の中で値の前に空白や改行があっても、修正案と名前の変更がパスの字に当たるように）
          sources.push({ path: original.trim(), offset: a.valueStart + (original.length - original.trimStart().length) });
        }
        continue;
      }
      if (attr === "style" && /url\s*\(|expression\s*\(|@import/i.test(value)) {
        issues.push({ code: "html-external-url", message: "style= に url() は書けません（外の画像や URL は読み込めません）", offset: a.offset, hint: "画像は <img src=\"image フォルダの中のパス\"> で置きます" });
        continue;
      }
      if (attr === "data-jump") {
        const target = original.trim();
        if (!parseTargetText(target)) {
          issues.push({ code: "bad-target", message: `data-jump の飛び先 ${JSON.stringify(target)} は \`#ラベル\`、\`ファイル\`、\`ファイル#ラベル\` のどの形でもありません`, offset: a.valueStart, hint: "data-jump=\"#north_road\"" });
          continue;
        }
        jump = jumps.length;
        jumps.push({ target, label: "", offset: a.valueStart });
      }
    }
    if (HTML_VOID_TAGS.has(name)) continue;
    if (selfClosing) {
      issues.push({ code: "html-bad-nesting", message: `<${name} /> の形では閉じられません`, offset: tagStart, hint: `<${name}></${name}> と書きます` });
      continue;
    }
    stack.push({ name, offset: tagStart, jump, textFrom: i });
  }
  for (const open of stack) {
    issues.push({ code: "html-bad-nesting", message: `<${open.name}> が閉じられていません`, offset: open.offset, hint: `</${open.name}> を書きます` });
    if (open.jump !== null) jumps[open.jump]!.label = plain(masked.slice(open.textFrom));
  }
  for (const j of jumps) if (j.label === "") j.label = j.target;
  return { issues, values, jumps, sources };
}

/** 埋め込みの値を HTML として読まれない文字にする。 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** `{= 式}` を値に置き換えた HTML（値は escapeHtml してから埋める）。 */
export function fillHtml(src: string, values: readonly HtmlValue[], valueOf: (v: HtmlValue) => string): string {
  let out = "";
  let at = 0;
  for (const v of values) {
    out += src.slice(at, v.start) + escapeHtml(valueOf(v));
    at = v.end;
  }
  return out + src.slice(at);
}

/** 中身の位置（0 始まり）を、中身の中の行と桁（どちらも 0 始まり）にする。 */
export function htmlPosition(src: string, offset: number): { line: number; column: number } {
  const before = src.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, column: offset - (before.lastIndexOf("\n") + 1) };
}

/** `<name` の後ろから、タグを閉じる `>` の位置（"…" '…' の中は数えない）。無ければ -1。 */
function tagEnd(text: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

interface RawAttribute {
  name: string;
  /** 値を書いていなければ null。 */
  value: string | null;
  offset: number;
  /** 値の始まり（引用符の内側）。 */
  valueStart: number;
}

/** タグの中（名前の後ろから > の前まで）の属性。 */
function attributes(text: string, from: number, to: number): RawAttribute[] {
  const out: RawAttribute[] = [];
  let i = from;
  while (i < to) {
    while (i < to && /\s/.test(text[i]!)) i++;
    if (i >= to) break;
    const m = /^[^\s"'>/=]+/.exec(text.slice(i, to));
    if (!m) {
      i++;
      continue;
    }
    const offset = i;
    i += m[0].length;
    let j = i;
    while (j < to && /\s/.test(text[j]!)) j++;
    if (text[j] !== "=") {
      out.push({ name: m[0], value: null, offset, valueStart: i });
      continue;
    }
    j++;
    while (j < to && /\s/.test(text[j]!)) j++;
    const q = text[j];
    if (q === '"' || q === "'") {
      const close = text.indexOf(q, j + 1);
      const end = close < 0 || close > to ? to : close;
      out.push({ name: m[0], value: text.slice(j + 1, end), offset, valueStart: j + 1 });
      i = end + 1;
    } else {
      const v = /^[^\s>]*/.exec(text.slice(j, to))![0];
      out.push({ name: m[0], value: v, offset, valueStart: j });
      i = j + v.length;
    }
  }
  return out;
}

/** タグと伏せ字を除いた文字（押すものの見出し）。 */
function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replaceAll(MASK, "")
    .replace(/\s+/g, " ")
    .trim();
}
