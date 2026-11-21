import type { Inline } from "./ast.ts";

/**
 * 台詞の行の始まりの印。話者名（と {name …}）のすぐ後に、日本語の括弧（「 『 （ (）か英語の引用符（" “）が来る行が台詞になる。
 * 引用符だけは、話者名とのあいだに半角の空白を一つ書いてもよい（`Yui "Hello."`）。空白は本文に入れず、本文は引用符から始まる。
 * 括弧も引用符も本文の一部で、ゲームには書いたまま出す（ui.text.quotes が strip なら外側の一組を外す）。
 */
export const SPEECH_BRACKETS = ["「", "『", "（", "("] as const;
/** 英語の台詞の引用符。一重の引用符（' ‘）は、語の中のアポストロフィと見分けられないので台詞にしない。 */
export const SPEECH_QUOTES = ['"', "“"] as const;
/** 台詞の始まりの印すべて。 */
export const SPEECH_OPENERS: readonly string[] = [...SPEECH_BRACKETS, ...SPEECH_QUOTES];
/** 始まりの印 → 対になる閉じの印。 */
export const SPEECH_CLOSE: Readonly<Record<string, string>> = { "「": "」", "『": "』", "（": "）", "(": ")", '"': '"', "“": "”" };

/** 台詞の始まりの印か。 */
export function isSpeechOpener(c: string): boolean {
  return SPEECH_OPENERS.includes(c);
}

/** 英語の台詞の引用符か。 */
export function isSpeechQuote(c: string): boolean {
  return (SPEECH_QUOTES as readonly string[]).includes(c);
}

/**
 * 話者名（と {name …}）の終わりの位置 at から台詞の本文が始まるなら、本文の始まりの位置を返す（引用符の前の半角の空白一つは飛ばす）。
 * 始まらなければ -1。
 */
export function speechOpenAt(line: string, at: number): number {
  const c = line.charAt(at);
  if (isSpeechOpener(c)) return at;
  if (c === " " && isSpeechQuote(line.charAt(at + 1))) return at + 1;
  return -1;
}

/** 話者名と台詞の本文を一行の文字にする（括弧はそのまま続け、引用符の前には半角の空白を挟む。`ユイ「…」`、`Yui "…"`）。 */
export function speechLine(speaker: string, body: string): string {
  return `${speaker}${isSpeechQuote(body.charAt(0)) ? " " : ""}${body}`;
}

/**
 * 台詞の本文の外側の印（「」『』“”""）の閉じの位置。本文の始まりの印に対になる閉じが本文の最後の文字なら、その位置を返す
 * （`「あ」「い」` や `"a" and "b"` のように、始まりの印が途中で閉じるものは -1）。（）と () は心の声として外さないので -1。
 */
function outerClose(text: string): number {
  const open = text.charAt(0);
  if (open !== "「" && open !== "『" && open !== "“" && open !== '"') return -1;
  const close = SPEECH_CLOSE[open]!;
  if (text.length < 2 || !text.endsWith(close)) return -1;
  if (open === close) return text.indexOf(close, 1) === text.length - 1 ? text.length - 1 : -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i === text.length - 1 ? i : -1;
  }
  return -1;
}

/** 台詞の本文の文字列から外側の一組の印（「」『』“”""）を外す（外せないものはそのまま）。（）は外さない。 */
export function unquoteSpeech(text: string): string {
  return outerClose(text) > 0 ? text.slice(1, -1) : text;
}

/**
 * 台詞の本文（構文木）から外側の一組の印（「」『』“”""）を外す（ui.text.quotes が strip のとき）。
 * 始まりの印が本文の最初の文字で、対になる閉じが最後の文字のときだけ外す（ルビ・式の値・絵が端にあれば外さない）。
 * 本文の中のコマンドと {click}・{noclick}・{br} は文字に数えない。外せなければ content をそのまま返す。
 */
export function stripSpeechQuotes(content: readonly Inline[]): Inline[] {
  // 文字の並び（ルビの親文字・式の値・絵は端に来たら外さないよう、印にならない字で数える）
  const leaves: { node: Inline; text: string }[] = [];
  const walk = (nodes: readonly Inline[]) => {
    for (const n of nodes) {
      if (n.kind === "text") leaves.push({ node: n, text: n.text });
      else if (n.kind === "ruby" || n.kind === "value" || n.kind === "image") leaves.push({ node: n, text: "￼" });
      else if ("children" in n) walk(n.children);
    }
  };
  walk(content);
  const nonEmpty = leaves.filter((l) => l.text !== "");
  const first = nonEmpty[0];
  const last = nonEmpty.at(-1);
  if (!first || !last || first.node.kind !== "text" || last.node.kind !== "text") return [...content];
  if (outerClose(nonEmpty.map((l) => l.text).join("")) <= 0) return [...content];
  const map = (nodes: readonly Inline[]): Inline[] =>
    nodes.flatMap((n): Inline[] => {
      if (n === first.node || n === last.node) {
        let text = (n as Extract<Inline, { kind: "text" }>).text;
        if (n === first.node) text = text.slice(1);
        if (n === last.node) text = text.slice(0, -1);
        return text === "" ? [] : [{ ...n, text } as Inline];
      }
      return "children" in n ? [{ ...n, children: map(n.children) } as Inline] : [n];
    });
  return map(content);
}
