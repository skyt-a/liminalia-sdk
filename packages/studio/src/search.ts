import { TEXT_VARIANTS } from "@liminalia/lang";
import type { SearchOptions, SearchSpan } from "./protocol.ts";

/**
 * 全体の検索と全ファイルの置換の探し方（開発サーバーの POST /search と、画面の置換の見本で使う。DOM も node: も使わない）。
 * - 行をまたいでは探さない。一行の中で重ならないように左から順に当てる（空の一致は数えない）
 * - kana: ひらがなとカタカナを同じに扱う（カタカナをひらがなにしてから比べる。字の数は変わらない）
 * - caseSensitive でなければ大文字と小文字を区別しない（小文字にすると字の数が変わる字はそのまま比べる）
 * - regex: 正規表現（JavaScript の書き方）。置換の文字では $& と $1〜$99 と $$ が使える
 * - 本文だけ（body）は、どの行が本文か（台詞と地の文）を知っている呼ぶ側が、行の中の本文の範囲（bodyRanges）を渡す
 */

/** 読めない正規表現。 */
export class SearchPatternError extends Error {}

/** カタカナをひらがなに（ァ〜ヶ、ヽヾ。字の数は変わらない）。 */
export function foldKana(text: string): string {
  return text.replace(/[ァ-ヶヽヾ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 小文字に（字の数が変わる字はそのまま）。 */
function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = "";
  for (const ch of text) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

/** 一行の中の当たった範囲を返す関数。ranges を渡すと、その範囲（[始め, 終わり)）の中に収まるものだけ。 */
export type LineMatcher = (line: string, ranges?: readonly (readonly [number, number])[]) => SearchSpan[];

/** 探し方から、一行を探す関数を作る。探す文字が空なら null。読めない正規表現は SearchPatternError を投げる。 */
export function lineMatcher(opts: SearchOptions): LineMatcher | null {
  if (opts.query === "") return null;
  const fold = (s: string) => {
    const k = opts.kana ? foldKana(s) : s;
    return opts.caseSensitive || opts.regex ? k : foldCase(k);
  };
  const inside = (ranges: readonly (readonly [number, number])[] | undefined, at: number, end: number) => !ranges || ranges.some(([a, b]) => a <= at && end <= b);
  if (!opts.regex) {
    const needle = fold(opts.query);
    return (line, ranges) => {
      const hay = fold(line);
      const out: SearchSpan[] = [];
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
        if (inside(ranges, at, at + needle.length)) out.push({ at, length: needle.length });
      }
      return out;
    };
  }
  let re: RegExp;
  try {
    re = new RegExp(opts.kana ? foldKana(opts.query) : opts.query, `gd${opts.caseSensitive ? "" : "i"}`);
  } catch (e) {
    throw new SearchPatternError(e instanceof Error ? e.message : String(e));
  }
  return (line, ranges) => {
    const hay = opts.kana ? foldKana(line) : line;
    const out: SearchSpan[] = [];
    re.lastIndex = 0;
    for (let m = re.exec(hay); m; m = re.exec(hay)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const at = m.index;
      const end = at + m[0].length;
      if (!inside(ranges, at, end)) continue;
      // グループは元の行から切り出す（カタカナをひらがなにして探したときも、書いてあるとおりの字を使う）
      const groups = (m.indices ?? []).slice(1).map((g) => (g ? line.slice(g[0], g[1]) : ""));
      out.push({ at, length: end - at, ...(groups.length > 0 ? { groups } : {}) });
    }
    return out;
  };
}

/** 当たった所を置き換える文字（正規表現なら $& と $1〜$99 と $$ を、当たった中身にする）。 */
export function replacementText(replacement: string, matched: string, span: SearchSpan, regex: boolean): string {
  if (!regex) return replacement;
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (all, key: string) => {
    if (key === "$") return "$";
    if (key === "&") return matched;
    const groups = span.groups ?? [];
    // 二桁の番号がグループの数を超えるなら一桁として読む（JavaScript の replace と同じ）
    const n = Number(key);
    if (n >= 1 && n <= groups.length) return groups[n - 1]!;
    if (key.length === 2 && Number(key[0]) >= 1 && Number(key[0]) <= groups.length) return groups[Number(key[0]) - 1]! + key[1];
    return all;
  });
}

/** 当たった範囲を置き換えた行。 */
export function replaceSpans(line: string, spans: readonly SearchSpan[], replacement: string, regex = false): string {
  let out = "";
  let from = 0;
  for (const s of spans) {
    out += line.slice(from, s.at) + replacementText(replacement, line.slice(s.at, s.at + s.length), s, regex);
    from = s.at + s.length;
  }
  return out + line.slice(from);
}

/**
 * 本文の行（台詞と地の文）の中の、本文の字の範囲（[始め, 終わり)。行の中の位置）。from は本文の始まり（台詞なら話者の名前の後ろ）。
 * 本文の中の書き方（`{@…}` のコマンド・`{= 式}`・`{click}` などの印・飾りの頭と閉じの `}`・出し分けの項目の区切り `|`・`\` のエスケープ）は除き、
 * ルビの親文字と読み、飾りと出し分けの中の字は本文に数える。
 */
export function bodyRanges(line: string, from: number): [number, number][] {
  const end = line.replace(/[ \t\r]+$/, "").length;
  const out: [number, number][] = [];
  let run = -1;
  let i = from;
  const close = () => {
    if (run >= 0 && i > run) out.push([run, i]);
    run = -1;
  };
  const text = () => {
    if (run < 0) run = i;
    i++;
  };
  /** `{=` `{@` から対応する `}` の後ろまで（"…" と (…) の中の } では閉じない）。 */
  const skipCode = () => {
    let quoted = false;
    let depth = 0;
    i += 2;
    while (i < end && (quoted || depth > 0 || line[i] !== "}")) {
      if (quoted && line[i] === "\\") i++;
      else if (line[i] === '"') quoted = !quoted;
      else if (!quoted && line[i] === "(") depth++;
      else if (!quoted && line[i] === ")") depth--;
      i++;
    }
    i++;
  };
  /** 入れ子の無い部分（ルビ）を stop まで本文として読む。 */
  const plain = (stop: string) => {
    while (i < end && line[i] !== stop) {
      if (line[i] === "\\" && i + 1 < end) {
        close();
        i++;
      }
      text();
    }
    close();
    i++;
  };
  // 入れ子の { … } の種類（variant は出し分けの中。中の | は項目の区切りで本文ではない）
  const frames: ("variant" | "other")[] = [];
  while (i < end) {
    const c = line[i]!;
    if (c === "\\") {
      // \ は除き、逃がした字は本文（続く字と一つの範囲にする）
      close();
      i++;
      if (i < end) text();
      continue;
    }
    if (c === "}") {
      close();
      frames.pop();
      i++;
      continue;
    }
    if (c === "|" && frames.at(-1) === "variant") {
      // 出し分けの項目の区切りは本文ではない（ルビの {r 親|読み} は plain が読み切る）
      close();
      i++;
      continue;
    }
    if (c !== "{") {
      text();
      continue;
    }
    close();
    const next = line[i + 1];
    if (next === "=" || next === "@") {
      skipCode();
      continue;
    }
    const rest = line.slice(i + 1, end);
    const word = /^[a-z]+/.exec(rest)?.[0] ?? "";
    const after = rest[word.length];
    if ((word === "click" || word === "br" || word === "noclick") && after === "}") {
      i += word.length + 2;
      continue;
    }
    if (word === "img" && after === " ") {
      const stop = line.indexOf("}", i);
      i = stop < 0 ? end : stop + 1;
      continue;
    }
    if (word === "r" && after === " ") {
      i += 3;
      plain("|");
      plain("}");
      continue;
    }
    // 本文の出し分け（{seq {cycle {once {shuffle）。| で区切った一つずつが本文
    if ((TEXT_VARIANTS as readonly string[]).includes(word) && after === " ") {
      frames.push("variant");
      i += word.length + 2;
      continue;
    }
    // 飾りの頭（{b {i {dot と、値を一つ持つ {c #色 {mark #色 {size 32 {speed 600ms {fx wave [strength=N] [speed=N]）。
    // 値は } を含まない（{c #fff}X の X は本文）。{fx の調整は値の後に空白が必要で、無ければ値ごと中身の本文（{fx wave speed=2} は中身が speed=2 の {fx wave}）
    const head = /^(?:(?:b|i|dot) |(?:c|mark|size|speed) [^\s}]+ ?|fx [^\s}]+ ?(?:strength=[^\s}]* )?(?:speed=[^\s}]* )?)/.exec(rest)?.[0];
    frames.push("other");
    i += 1 + (head?.length ?? 0);
  }
  close();
  return out;
}
