import { collectTranslatable, textHash, voiceLines, type Script, type TranslationEntry, type TranslationFile, type VoiceLock, type VoiceLockEntry } from "@liminalia/lang";
import type { ReviewThread } from "./protocol.ts";
import { rewriteInlineTargets, type LabelTarget, type SpecOf } from "./label-rename.ts";

/**
 * シーン（ラベル）の名前の変更で、台本のほかに付け替えるものの中身（画面なし・ファイルなし）。開発サーバーの server/labels.ts と
 * VS Code の拡張機能（packages/vscode の actions.ts）が使う。ファイルの読み書きは使う側がする。
 *
 * - 訳の鍵と voice-lock.json の鍵は、ファイルと原文から作るのでラベルを持たない。ただ本文の中の `{@…}` の飛び先を書き換えると
 *   原文が変わるので、その行の分だけ付け替える（行の数を変えない書き換えのあと。書き換える前と後の台本の同じ行を比べる）
 * - 訳の場面ごとの訳（contexts）は、名前を変えたラベルの名前に替える
 * - レビューのコメントは、書き換えた行に付いたスレッドの行の中身を付け替える
 */

/** 同じ行の鍵の付け替え（古い鍵 → 新しい鍵と原文）。 */
export function keyMoves<T extends { key: string; line: number; source: string }>(before: readonly T[], after: readonly T[]): Map<string, { key: string; source: string }> {
  const byLine = new Map(after.map((x) => [x.line, x] as const));
  const out = new Map<string, { key: string; source: string }>();
  for (const x of before) {
    const next = byLine.get(x.line);
    if (next && next.key !== x.key) out.set(x.key, { key: next.key, source: next.source });
  }
  return out;
}

/** 訳の鍵の付け替え（古い鍵 → 新しい鍵・原文・その行のファイル）。 */
export type TranslationMoves = ReadonlyMap<string, { key: string; source: string; file: string }>;

export function translationMoves(before: ReadonlyMap<string, Script>, after: ReadonlyMap<string, Script>): TranslationMoves {
  const moves = new Map<string, { key: string; source: string; file: string }>();
  for (const [file, script] of before) {
    const next = after.get(file);
    if (!next) continue;
    for (const [k, v] of keyMoves(collectTranslatable(script), collectTranslatable(next))) moves.set(k, { ...v, file });
  }
  return moves;
}

/**
 * 一つの言語の訳のファイルを付け替えたもの（訳文の中の {@…} の飛び先も書き換え、名前を変えたラベルの場面ごとの訳の名前も替える）。
 * 変わらなければ null。
 */
export function moveTranslationFile(file: TranslationFile, moves: TranslationMoves, t: LabelTarget, specOf: SpecOf): TranslationFile | null {
  /** 場面ごとの訳（contexts）の名前を、名前を変えたラベルに合わせる（そのファイルの項目だけ）。 */
  const scene = (k: string, e: TranslationEntry): TranslationEntry => {
    if (k.slice(0, k.lastIndexOf(":")) !== t.file || !e.contexts || !(t.from in e.contexts)) return e;
    return { ...e, contexts: Object.fromEntries(Object.entries(e.contexts).map(([c, v]) => [c === t.from ? t.to : c, v])) };
  };
  const move = (table: Record<string, TranslationEntry>): Record<string, TranslationEntry> =>
    Object.fromEntries(
      Object.entries(table).map(([k, e]) => {
        const m = moves.get(k);
        return m ? [m.key, scene(m.key, { ...e, source: m.source, text: rewriteInlineTargets(e.text, m.file, t, specOf) })] : [k, scene(k, e)];
      }),
    );
  const next: TranslationFile = { ...file, ...(file.lines ? { lines: move(file.lines) } : {}), ...(file.stale ? { stale: move(file.stale) } : {}) };
  return JSON.stringify(next) === JSON.stringify(file) ? null : next;
}

/** 番号の固定（voice-lock.json）の鍵の付け替え（古い鍵 → 新しい鍵と原文）。 */
export function voiceLockMoves(before: ReadonlyMap<string, Script>, after: ReadonlyMap<string, Script>): Map<string, { key: string; source: string }> {
  const moves = new Map<string, { key: string; source: string }>();
  for (const [file, script] of before) {
    const next = after.get(file);
    if (next) for (const [k, v] of keyMoves(voiceLines(script), voiceLines(next))) moves.set(k, v);
  }
  return moves;
}

/** 番号の固定を付け替えたもの。変わらなければ null。 */
export function moveVoiceLock(lock: VoiceLock, moves: ReadonlyMap<string, { key: string; source: string }>): VoiceLock | null {
  if (moves.size === 0) return null;
  const move = (table: Record<string, VoiceLockEntry>) =>
    Object.fromEntries(
      Object.entries(table).map(([k, e]) => {
        const m = moves.get(k);
        return m ? [m.key, { ...e, source: m.source }] : [k, e];
      }),
    );
  const next: VoiceLock = { ...lock, lines: move(lock.lines), ...(lock.retired ? { retired: move(lock.retired) } : {}) };
  return JSON.stringify(next) === JSON.stringify(lock) ? null : next;
}

/** 書き換えた行（ファイル・行・前と後の中身）。 */
export interface MovedLine {
  file: string;
  line: number;
  before: string;
  after: string;
}

/**
 * 書き換えた行に付いたレビューのスレッドの行の中身を付け替えたもの（付け替えたスレッドだけ）。同じ中身の行がいくつもあれば、
 * 行番号の合うものを先に使う。
 */
export function moveReviewThreads(threads: readonly ReviewThread[], moved: readonly MovedLine[]): ReviewThread[] {
  if (moved.length === 0) return [];
  const out: ReviewThread[] = [];
  for (const t of threads) {
    const same = moved.filter((m) => m.file === t.file && m.before.trim() === t.text);
    const m = same.find((x) => x.line === t.line) ?? same[0];
    if (!m) continue;
    out.push({ ...t, line: m.line, text: m.after.trim(), hash: textHash(m.after.trim()) });
  }
  return out;
}

/** lim regress の基準の画像の名前（`ファイル_ラベル.png`、二ページ目からは `ファイル_ラベル~2.png`）を付け替える。古い名前 → 新しい名前。 */
export function baselineRenames(names: readonly string[], t: LabelTarget): Map<string, string> {
  const name = (file: string, label: string) => `${file}#${label}`.replace(/[#/\\:*?"<>|]/g, "_");
  const from = name(t.file, t.from);
  const to = name(t.toFile ?? t.file, t.to);
  const taken = new Set(names);
  const out = new Map<string, string>();
  for (const f of names) {
    const rest = f === `${from}.png` ? ".png" : f.startsWith(`${from}~`) && f.endsWith(".png") ? f.slice(from.length) : null;
    if (rest === null) continue;
    const dest = `${to}${rest}`;
    if (taken.has(dest)) continue;
    out.set(f, dest);
  }
  return out;
}

/** JSON の字下げ（二行目の頭の空白。タブか空白の数。分からなければ空白二つ）。作品のデータを書き直すとき、元のファイルに合わせる。 */
export function jsonIndent(text: string): string | number {
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return 2;
  return m[1]!.startsWith("\t") ? "\t" : m[1]!.length;
}
