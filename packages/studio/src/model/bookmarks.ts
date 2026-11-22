import type { StudioBookmark } from "../protocol.ts";
import { locateReview, reviewLineHash } from "./reviews.ts";

/**
 * ブックマークの覚え方（画面なし）。行番号のほかに、一覧に出す行の中身（前後の空白を除き 80 字まで）と、行の中身全体のハッシュを持つ。
 * 開いていないファイルがほかで書き換えられたときは、ブレークポイントと同じく（model/breakpoints.ts）同じ中身の行（いくつもあれば元の行に近いもの）、
 * 無ければ似ている行を探して付け直す。見つからなければ元の行番号のまま（ファイルの行の数までに縮める）。
 * 覚える先は作品の .liminalia/studio.json の bookmarks（ファイル → 印の並び）。
 */

/** 一覧に出す行の中身の長さ。 */
const TEXT_MAX = 80;

/** 今の行の中身から、覚える形にする。 */
export function storeBookmark(line: number, text: string): StudioBookmark {
  const t = text.trim();
  return { line, text: t.slice(0, TEXT_MAX), hash: reviewLineHash(t) };
}

/** その印が今もその行に付いているか（ハッシュを持たない前の版の印は、一覧の字で始まるか）。 */
function stays(mark: StudioBookmark, lines: readonly string[]): boolean {
  const at = lines[mark.line - 1];
  if (at === undefined) return false;
  const t = at.trim();
  return mark.hash ? reviewLineHash(t) === mark.hash : t.startsWith(mark.text) && (mark.text !== "" || t === "");
}

/**
 * そのファイルのブックマークを今の中身に付け直す（行の順。同じ行に重なったものは一つにする）。changed は行か中身が変わった印があったか。
 */
export function placeBookmarks(marks: readonly StudioBookmark[], lines: readonly string[]): { marks: StudioBookmark[]; changed: boolean } {
  const count = Math.max(1, lines.length);
  const used = new Set<number>();
  const out: StudioBookmark[] = [];
  let changed = false;
  for (const m of marks) {
    let line = m.line;
    if (!stays(m, lines)) {
      const found = locateReview({ line: m.line, text: m.text, hash: m.hash ?? reviewLineHash(m.text) }, lines);
      line = found ? found.line : Math.min(Math.max(1, m.line), count);
    }
    if (used.has(line)) {
      changed = true;
      continue;
    }
    used.add(line);
    const next = storeBookmark(line, lines[line - 1] ?? "");
    if (next.line !== m.line || next.text !== m.text || next.hash !== m.hash) changed = true;
    out.push(next);
  }
  out.sort((a, b) => a.line - b.line);
  return { marks: out, changed };
}

/**
 * 行を別のファイルへ移したあと（シーンの移動・ファイルを分ける。server/scene-move.ts）の、ファイルごとのブックマーク。
 * before はファイルごとの移す前の中身、origin は書いたファイルの行ごとの出どころ（移す前のファイルと行）。
 * 移した行に付いていた印は移した先の行へ、出どころの無い行（消えた行）に付いていた印は元のファイルに残す。
 */
export function moveBookmarks(
  bookmarks: Readonly<Record<string, readonly StudioBookmark[]>>,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, { text: string; origin: readonly ({ file: string; line: number } | null)[] }>,
): Record<string, StudioBookmark[]> | null {
  // 書いたファイルの、出どころ → 今の場所
  const moved = new Map<string, { file: string; line: number }>();
  for (const [file, p] of after) p.origin.forEach((o, i) => o && moved.set(`${o.file}:${o.line}`, { file, line: i + 1 }));
  const out: Record<string, StudioBookmark[]> = {};
  let changed = false;
  const add = (file: string, mark: StudioBookmark) => (out[file] ??= []).push(mark);
  for (const [file, marks] of Object.entries(bookmarks)) {
    const text = before.get(file);
    if (text === undefined || ![...after.values()].some((p) => p.origin.some((o) => o?.file === file))) {
      for (const m of marks) add(file, m);
      continue;
    }
    // 移す前の中身で付け直してから、行の出どころで移す
    for (const m of placeBookmarks(marks, text.split("\n")).marks) {
      const to = moved.get(`${file}:${m.line}`);
      if (!to) {
        add(file, m);
        continue;
      }
      if (to.file !== file || to.line !== m.line) changed = true;
      add(to.file, storeBookmark(to.line, after.get(to.file)!.text.split("\n")[to.line - 1] ?? ""));
    }
  }
  if (!changed) return null;
  for (const [file, marks] of Object.entries(out)) out[file] = placeBookmarks(marks, (after.get(file)?.text ?? before.get(file) ?? "").split("\n")).marks;
  return out;
}
