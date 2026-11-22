/**
 * 書き戻しで .ks の行を部分ごとに書き換えるための道具。
 *
 * 字句解析（lexer.ts）は命令の位置を行番号でしか持たないので、ここで一行の中の
 * タグ・地の文の文字の範囲を同じ規則で求め、タグの引数の値だけを差し替えられるようにする。
 */

/** 一行の中の部分（タグは [ ] を含む範囲、`@` の行は @ からの全体）。 */
export interface KsPiece {
  kind: "tag" | "text";
  start: number;
  end: number;
}

/**
 * 一行の中のタグと地の文の範囲。lexer の一行の扱い（前後の空白を切る、`_` で始まる行、`[` `]` の入れ子と引用符、
 * `\` のエスケープ）に合わせる。`;` `#` `*` の行と、[iscript] の中の行は呼ぶ側で除く。
 */
export function scanKsLine(raw: string): KsPiece[] {
  const lead = raw.length - raw.trimStart().length;
  const row = raw.trim();
  const base = lead;
  if (row.startsWith("@")) return [{ kind: "tag", start: base, end: base + row.length }];
  const pieces: KsPiece[] = [];
  let i = row.startsWith("_") ? 1 : 0;
  let textStart = -1;
  let tagStart = -1;
  let depth = 0;
  let quote = "";
  let escaped = false;
  const flushText = (end: number) => {
    if (textStart >= 0 && end > textStart) pieces.push({ kind: "text", start: base + textStart, end: base + end });
    textStart = -1;
  };
  for (; i < row.length; i++) {
    const c = row[i]!;
    if (tagStart >= 0) {
      if (c === "]") {
        if (quote === "") {
          depth--;
          if (depth === 0) {
            pieces.push({ kind: "tag", start: base + tagStart, end: base + i + 1 });
            tagStart = -1;
          }
        }
      } else if (c === "[") {
        if (quote === "") depth++;
      } else if (c === '"' || c === "'" || c === "`") {
        if (quote === c) quote = "";
        else if (quote === "") quote = c;
      }
    } else if (escaped) {
      escaped = false;
    } else if (c === "[") {
      flushText(i);
      tagStart = i;
      depth = 1;
      quote = "";
    } else {
      if (textStart < 0) textStart = i;
      if (c === "\\") escaped = true;
    }
  }
  if (tagStart >= 0) pieces.push({ kind: "tag", start: base + tagStart, end: base + row.length });
  flushText(row.length);
  return pieces;
}

/** タグの部分（`[…]` か `@…`）から、中身（タグ名と引数）を取り出す。 */
export function tagBody(piece: string): string {
  const t = piece.trim();
  if (t.startsWith("@")) return t.slice(1);
  return t.endsWith("]") ? t.slice(1, -1) : t.slice(1);
}

interface AttrSpan {
  key: string;
  /** 引数の始まり（キーの先頭）と終わり（値の閉じ引用符の後）。 */
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
  quote: string;
}

/** タグの中身の、タグ名の終わりと引数ごとの範囲。parseTag と同じ区切り方。 */
function scanBody(body: string): { name: string; nameEnd: number; attrs: AttrSpan[] } {
  let i = 0;
  while (i < body.length && body[i] === " ") i++;
  const nameStart = i;
  while (i < body.length && body[i] !== " ") i++;
  const name = body.slice(nameStart, i);
  const nameEnd = i;
  const attrs: AttrSpan[] = [];
  while (i < body.length) {
    while (i < body.length && body[i] === " ") i++;
    if (i >= body.length) break;
    const start = i;
    while (i < body.length && body[i] !== " " && body[i] !== "=") i++;
    const key = body.slice(start, i);
    let j = i;
    while (j < body.length && body[j] === " ") j++;
    if (body[j] !== "=") {
      attrs.push({ key, start, end: i, valueStart: i, valueEnd: i, quote: "" });
      continue;
    }
    j++;
    while (j < body.length && body[j] === " ") j++;
    const q = body[j];
    if (q === '"' || q === "'" || q === "`") {
      let k = j + 1;
      while (k < body.length && body[k] !== q) {
        if (body[k] === "\\") k++;
        k++;
      }
      attrs.push({ key, start, end: Math.min(body.length, k + 1), valueStart: j + 1, valueEnd: Math.min(body.length, k), quote: q });
      i = k + 1;
    } else {
      let k = j;
      while (k < body.length && body[k] !== " ") k++;
      attrs.push({ key, start, end: k, valueStart: j, valueEnd: k, quote: "" });
      i = k;
    }
  }
  return { name, nameEnd, attrs };
}

/** タグの中身のタグ名。 */
export function tagName(body: string): string {
  return scanBody(body).name;
}

/** 値を書く引用符（元の書き方に合わせ、値に含まれない引用符を選ぶ）。 */
function quoteFor(value: string, preferred: string): string {
  if (preferred === "" && /^[^\s"'`\]\[=]+$/.test(value)) return "";
  // 値に \ があるときは " で囲む（" は \" と、\ は \\ と書いて読み通せるが、' や ` で囲むと引用符を閉じられない）
  if (value.includes("\\")) return '"';
  for (const q of [preferred || '"', '"', "'", "`"]) if (!value.includes(q)) return q;
  return '"';
}

/**
 * タグの中身の引数を書き換える（値が null の引数は消す）。元の書き方（引数の間の空白・引用符・並び）は保ち、
 * 新しい引数は最後の引数の後に同じ区切りで足す。
 */
export function editTagBody(body: string, edits: Readonly<Record<string, string | null>>): string {
  const { nameEnd, attrs } = scanBody(body);
  // 引数の間の区切り（TyranoBuilder は空白二つ）と引用符
  const sep = attrs.length > 0 ? body.slice(attrs.length > 1 ? attrs.at(-2)!.end : nameEnd, attrs.at(-1)!.start) || " " : / {2}/.test(body.slice(nameEnd)) ? "  " : " ";
  const preferredQuote = attrs.find((a) => a.quote !== "")?.quote ?? (attrs.length > 0 ? "" : '"');
  let out = body;
  const done = new Set<string>();
  // 後ろから書き換えると範囲がずれない
  for (const a of [...attrs].reverse()) {
    if (!(a.key in edits)) continue;
    done.add(a.key);
    const value = edits[a.key];
    if (value === null || value === undefined) {
      // 前の区切りの空白ごと消す
      let s = a.start;
      while (s > 0 && out[s - 1] === " ") s--;
      out = out.slice(0, s) + out.slice(a.end);
      continue;
    }
    const q = quoteFor(value, a.quote);
    out = out.slice(0, a.start) + `${a.key}=${q}${value}${q}` + out.slice(a.end);
  }
  const added = Object.entries(edits).filter(([k, v]) => !done.has(k) && v !== null && v !== undefined);
  if (added.length > 0) {
    const { attrs: now, nameEnd: end } = scanBody(out);
    const at = now.length > 0 ? now.at(-1)!.end : end;
    const text = added.map(([k, v]) => {
      const q = quoteFor(v!, preferredQuote);
      return `${sep}${k}=${q}${v}${q}`;
    });
    out = out.slice(0, at) + text.join("") + out.slice(at);
  }
  return out;
}

/** タグの中身を、元のタグの書き方（`[…]` か `@…`）で書く。 */
export function wrapTag(body: string, at: boolean): string {
  return at ? `@${body.trim()}` : `[${body}]`;
}

/** 地の文の文字を .ks に書く形にする（`\` と `[` をエスケープする）。 */
export function escapeKsText(text: string): string {
  return text.replace(/[\\[]/g, (c) => `\\${c}`);
}

/** 地の文の行の頭が、地の文以外（コメント・ラベル・話者・一行タグ・ブロックコメント）と読まれないようにする。 */
export function guardKsLine(text: string): string {
  return /^[;#*@_\s]|^\/\*/.test(text) ? `_${text}` : text;
}
