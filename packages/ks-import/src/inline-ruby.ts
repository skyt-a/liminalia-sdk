/**
 * 本文中のルビ記法 `｜対象《ルビ》`（半角の `|` も可）を切り分ける。
 * TyranoScript の auto_ruby プラグインがパーサに足す記法で、[srb text=ルビ]対象[erb] に展開される。
 * `\｜` `\|` `\《` `\》` はその文字そのもの。記法として閉じていなければ、ただの文字として残す。
 */
export type InlineRubyPart = { text: string } | { base: string; reading: string };

export function hasInlineRuby(text: string): boolean {
  return (text.includes("｜") || text.includes("|")) && text.includes("《") && text.includes("》");
}

export function splitInlineRuby(text: string): InlineRubyPart[] {
  if (!hasInlineRuby(text)) return [{ text }];
  const parts: InlineRubyPart[] = [];
  let buf = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if ((ch === "｜" || ch === "|") && text[i - 1] !== "\\") {
      const open = text.indexOf("《", i + 1);
      const close = open >= 0 ? text.indexOf("》", open + 1) : -1;
      if (open > i + 1 && close > open + 1) {
        if (buf) parts.push({ text: buf });
        buf = "";
        parts.push({ base: text.slice(i + 1, open), reading: text.slice(open + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (ch === "\\" && "｜|《》".includes(text[i + 1] ?? "")) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf) parts.push({ text: buf });
  return parts;
}

/** 表示される文字列（ルビは親文字だけ）。 */
export function inlineRubyPlain(text: string): string {
  return splitInlineRuby(text)
    .map((p) => ("text" in p ? p.text : p.base))
    .join("");
}
