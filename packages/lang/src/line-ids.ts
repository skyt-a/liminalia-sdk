import type { Script, Statement } from "./ast.ts";
import { translatableOccurrences, type TranslationEntry, type TranslationFile } from "./i18n.ts";
import type { Registry } from "./registry.ts";
import { hash } from "./text-hash.ts";
import { voiceLines, type VoiceLock } from "./voice-lock.ts";

/**
 * 固定の行 ID（`ユイ「おはよう」 #line:a1b2c3d4`）。Yarn Spinner の `#line:`、Ren'Py の `id` に当たる。
 *
 * 台詞、地の文、選択肢の行の終わりに、半角の空白かタブを挟んで `#line:ID` と書く（ID に使えるのは英数字、`_`、`-`）。
 * 書いた行は、訳の鍵（`ファイル:l@ID`、選択肢は `ファイル:c@ID`）とボイスの番号の固定の鍵（`ファイル:v@ID`）が原文によらなくなり、
 * 原文を少し直しても訳と番号が外れない（訳は使われ続け、`translatedFrom` に訳したときの原文が残る。番号は「要再収録」になる）。
 * 書かない行は今までどおり原文から鍵を作る。`lim i18n --stamp-ids` が、ID の無い行に振る。
 */
export const LINE_ID_PATTERN = /[ \t]+#line:([A-Za-z0-9_-]+)$/;

/** 行の終わりの `#line:…`（使えない文字を含むものも。書き方の誤りを知らせるため）。 */
const LINE_ID_LIKE = /[ \t]+#line:(\S*)$/;

/**
 * 行の終わりの `#line:ID` を外す。id は ID（無ければ null）、body は ID の前まで、bad は `#line:` の後ろが ID の形でないとき（本文のまま残す）の桁。
 * column は `#` の位置（0 始まり）。
 */
export function splitLineId(line: string): { body: string; id: string | null; column: number; bad: boolean } {
  const m = LINE_ID_PATTERN.exec(line);
  if (m) return { body: line.slice(0, m.index), id: m[1]!, column: line.lastIndexOf("#line:"), bad: false };
  const like = LINE_ID_LIKE.exec(line);
  if (like) return { body: line, id: null, column: line.lastIndexOf("#line:"), bad: true };
  return { body: line, id: null, column: -1, bad: false };
}

/** 台本の中の行 ID（台詞、地の文、選択肢。@if・@define の中も）。 */
export function lineIdsOf(script: Script): { id: string; line: number }[] {
  const out: { id: string; line: number }[] = [];
  walkTextLines(script.body, (s) => {
    if (s.id) out.push({ id: s.id, line: s.line });
  });
  return out;
}

/** 本文の行（台詞と地の文）と選択肢の行を、書いた順に。 */
function walkTextLines(body: readonly Statement[], visit: (s: { id?: string | undefined; line: number }) => void): void {
  for (const s of body) {
    if (s.kind === "say" || s.kind === "prose") visit(s);
    else if (s.kind === "choice") for (const o of s.options) visit(o);
    else if (s.kind === "if") for (const b of s.branches) walkTextLines(b.body, visit);
    else if (s.kind === "define") walkTextLines(s.body, visit);
  }
}

/** ID を振る行（ID の無い台詞、地の文、選択肢）の行番号。 */
export function linesWithoutId(script: Script): number[] {
  const out: number[] = [];
  walkTextLines(script.body, (s) => {
    if (!s.id) out.push(s.line);
  });
  return out;
}

/**
 * ID の無い台詞、地の文、選択肢の行の終わりに ` #line:ID` を足す（lim i18n --stamp-ids）。行番号は変わらない。
 * ID は 8 桁の 16 進で、taken（作品のほかの ID。足したものも入れる）と重ならないものにする。
 * 構文の誤りがあって読めない行（台詞や地の文として読まれていない行）には足さない。
 */
export function stampLineIds(source: string, script: Script, taken: Set<string>): { text: string; stamped: number } {
  const targets = new Set(linesWithoutId(script));
  if (targets.size === 0) return { text: source, stamped: 0 };
  const rows = source.split("\n");
  let stamped = 0;
  for (const lineNo of targets) {
    const raw = rows[lineNo - 1];
    if (raw === undefined) continue;
    const cr = raw.endsWith("\r");
    const body = (cr ? raw.slice(0, -1) : raw).replace(/[ \t]+$/, "");
    let id = "";
    for (let salt = 0; id === "" || taken.has(id); salt++) id = hash(`${script.file}\u0000${lineNo}\u0000${body}\u0000${salt}`);
    taken.add(id);
    rows[lineNo - 1] = `${body} #line:${id}${cr ? "\r" : ""}`;
    stamped++;
  }
  return { text: rows.join("\n"), stamped };
}

/** 鍵の付け替え一つ（context はその行の場面。場面ごとの訳から、その行の訳を選ぶ）。 */
export interface KeyMove {
  from: string;
  to: string;
  context: string;
}

/**
 * 行 ID を振った前後の台本から、訳の鍵の付け替え（原文の鍵 → 行 ID の鍵）を作る。行番号と種類と原文が同じ所を組にする。
 * 同じ原文が二度出て一つの訳を使っていた行は、行ごとの鍵に分かれる（どれにも同じ訳を写す）。
 */
export function translationKeyMoves(before: Script, after: Script, registry?: Registry): KeyMove[] {
  const old = new Map(translatableOccurrences(before, registry).map((o) => [`${o.line}\u0000${o.kind}\u0000${o.source}`, o.key]));
  const out: KeyMove[] = [];
  for (const o of translatableOccurrences(after, registry)) {
    const from = old.get(`${o.line}\u0000${o.kind}\u0000${o.source}`);
    if (from !== undefined && from !== o.key) out.push({ from, to: o.key, context: o.context });
  }
  return out;
}

/**
 * 訳のファイルの鍵を付け替える（lim i18n --stamp-ids）。新しい鍵には、その行の場面の訳（無ければ場面に分けない訳）を写す。
 * 付け替えた元の鍵は外す。新しい鍵がもうあれば変えない。
 */
export function moveTranslationKeys(file: TranslationFile, moves: readonly KeyMove[]): TranslationFile {
  if (moves.length === 0 || !file.lines) return file;
  const lines: Record<string, TranslationEntry> = { ...file.lines };
  const moved = new Set<string>();
  for (const m of moves) {
    const e = file.lines[m.from];
    if (!e) continue;
    moved.add(m.from);
    if (lines[m.to]) continue;
    const text = (m.context ? e.contexts?.[m.context] : undefined) || e.text;
    const { contexts: _contexts, ...rest } = e;
    lines[m.to] = { ...rest, text };
  }
  for (const k of moved) if (!moves.some((m) => m.to === k)) delete lines[k];
  return { ...file, lines };
}

/** 行 ID を振った前後の台本から、ボイスの番号の固定の鍵の付け替え（原文の鍵 → 行 ID の鍵）を作る。 */
export function voiceKeyMoves(before: Script, after: Script): KeyMove[] {
  const old = new Map(voiceLines(before).map((l) => [l.line, l.key]));
  const out: KeyMove[] = [];
  for (const l of voiceLines(after)) {
    const from = old.get(l.line);
    if (from !== undefined && from !== l.key) out.push({ from, to: l.key, context: "" });
  }
  return out;
}

/** ボイスの番号の固定（voice-lock.json）の鍵を付け替える。番号と「要再収録」の印はそのまま。 */
export function moveVoiceLockKeys(lock: VoiceLock, moves: readonly KeyMove[]): VoiceLock {
  if (moves.length === 0) return lock;
  const lines = { ...lock.lines };
  for (const m of moves) {
    const e = lock.lines[m.from];
    if (!e || lines[m.to]) continue;
    lines[m.to] = e;
    delete lines[m.from];
  }
  return { ...lock, lines };
}
