import { textHash, textSimilarity } from "@liminalia/lang";
import type { ReviewThread } from "../protocol.ts";

/**
 * レビューのコメントが今のシナリオのどの行にあるか。コメントは付けたときの行番号と、行の中身（前後の空白を除いたもの）の
 * ハッシュを持つので、行が動いても同じ中身の行を探せる。中身が書き換えられていれば、似ている行を探す。
 */

/** 書き換えられた行を同じ行とみなす似かたの下限（文字の二つ組の重なり）。 */
export const REVIEW_SIMILARITY = 0.6;

export interface ReviewPlace {
  line: number;
  /** 範囲の最後の行（一行に付けたものは line と同じ）。 */
  to: number;
  /** 付けたときと同じ中身の行か（false は書き換えられた行を似かたで見つけたもの）。 */
  exact: boolean;
}

/** 行の中身のハッシュ（前後の空白を除く）。 */
export function reviewLineHash(text: string): string {
  return textHash(text.trim());
}

/**
 * スレッドの今の行。見つからなければ null。範囲に付けたもの（end）は、最後の行も同じ決まりで探す
 * （始めの行より後ろに見つからなければ、付けたときの行の数だけ後ろまで）。
 */
export function locateReview(thread: Pick<ReviewThread, "line" | "text" | "hash"> & { end?: ReviewThread["end"] }, lines: readonly string[]): ReviewPlace | null {
  const start = locateLine(thread, lines);
  if (!start) return null;
  if (!thread.end) return { ...start, to: start.line };
  const end = locateLine(thread.end, lines);
  const to = end && end.line > start.line ? end.line : Math.min(lines.length, start.line + (thread.end.line - thread.line));
  return { line: start.line, to, exact: start.exact && (end?.exact ?? false) && to === end?.line };
}

function locateLine(thread: Pick<ReviewThread, "line" | "text" | "hash">, lines: readonly string[]): { line: number; exact: boolean } | null {
  const at = thread.line;
  // 空の行に付けたものは行番号だけで追う
  if (thread.text === "") return at <= lines.length ? { line: at, exact: lines[at - 1]!.trim() === "" } : null;
  if (at <= lines.length && reviewLineHash(lines[at - 1]!) === thread.hash) return { line: at, exact: true };
  const nearest = (candidates: number[]) => candidates.reduce((a, b) => (Math.abs(b - at) < Math.abs(a - at) ? b : a));
  const same: number[] = [];
  lines.forEach((l, i) => {
    if (reviewLineHash(l) === thread.hash) same.push(i + 1);
  });
  if (same.length > 0) return { line: nearest(same), exact: true };
  let best = 0;
  let found: number[] = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t === "") return;
    const s = textSimilarity(t, thread.text);
    if (s < REVIEW_SIMILARITY || s < best) return;
    if (s > best) found = [];
    best = s;
    found.push(i + 1);
  });
  return found.length > 0 ? { line: nearest(found), exact: false } : null;
}

/** ファイルのスレッドを行ごとにまとめる（見つからないものは lost）。 */
export function placeReviews(threads: readonly ReviewThread[], file: string, lines: readonly string[]): { byLine: Map<number, ReviewThread[]>; places: Map<string, ReviewPlace>; lost: ReviewThread[] } {
  const byLine = new Map<number, ReviewThread[]>();
  const places = new Map<string, ReviewPlace>();
  const lost: ReviewThread[] = [];
  for (const t of threads) {
    if (t.file !== file) continue;
    const place = locateReview(t, lines);
    if (!place) {
      lost.push(t);
      continue;
    }
    places.set(t.id, place);
    const list = byLine.get(place.line) ?? [];
    list.push(t);
    byLine.set(place.line, list);
  }
  return { byLine, places, lost };
}

/** 未解決のスレッドの数。 */
export function openReviews(threads: readonly ReviewThread[]): number {
  return threads.filter((t) => !t.resolved).length;
}
