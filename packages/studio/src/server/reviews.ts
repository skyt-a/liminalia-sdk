import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { pageKeys, parse, textHash } from "@liminalia/lang";
import type { Project } from "@liminalia/project";
import { moveReviewThreads } from "@liminalia/editor/label-follow";
import type { ReviewAction, ReviewComment, ReviewList, ReviewThread } from "../protocol.ts";
import { readStudioState } from "./studio-state.ts";
import { StudioError, writeAtomic } from "./workspace.ts";

/**
 * レビューのコメント（シナリオの行に付けるコメントと返信・解決）。プロジェクトの reviews/ にスレッドごとの .json を置く。
 * git で共有するためのテキストのファイルで、別々の人が別のスレッドを足しても衝突しない。書き出し（lim build）は
 * シナリオ・データ・素材のフォルダしか読まないので、ゲームには入らない。
 */

/** 置き場（作品のフォルダからの相対パス）。 */
export const REVIEWS_DIR = "reviews";
/** コメントの長さの上限（文字）。 */
const BODY_LIMIT = 10_000;

const ID = /^[a-z0-9-]{1,64}$/;

function dir(project: Project): string {
  return join(project.root, REVIEWS_DIR);
}

/** 新しい id（時刻と乱数。並べると作った順）。 */
function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 形の合うスレッドだけを読む（壊れたファイルは飛ばす。制作画面は止めない）。古いものから。 */
export function readReviews(project: Project): ReviewThread[] {
  const folder = dir(project);
  if (!existsSync(folder)) return [];
  const out: ReviewThread[] = [];
  for (const name of readdirSync(folder)) {
    if (!name.endsWith(".json")) continue;
    try {
      const t = clean(JSON.parse(readFileSync(join(folder, name), "utf8")));
      if (t && `${t.id}.json` === name) out.push(t);
    } catch {
      // 読めないファイルは飛ばす
    }
  }
  return out.sort((a, b) => (a.comments[0]?.time ?? "").localeCompare(b.comments[0]?.time ?? "") || a.id.localeCompare(b.id));
}

function clean(raw: unknown): ReviewThread | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Partial<ReviewThread>;
  if (typeof t.id !== "string" || !ID.test(t.id) || typeof t.file !== "string" || typeof t.line !== "number" || !Array.isArray(t.comments)) return null;
  const comments = t.comments
    .filter((c): c is ReviewComment => !!c && typeof c.id === "string" && typeof c.author === "string" && typeof c.time === "string" && typeof c.body === "string")
    .map((c) => ({
      id: c.id,
      author: c.author,
      time: c.time,
      body: c.body,
      ...(typeof c.edited === "string" ? { edited: c.edited } : {}),
      ...(c.feedback && typeof c.feedback === "object" ? { feedback: typeof c.feedback.build === "string" ? { build: c.feedback.build } : {} } : {}),
      ...(typeof c.image === "string" && /^shots\/[a-z0-9-]{1,64}\.(jpg|png)$/.test(c.image) ? { image: c.image } : {}),
    }));
  const text = typeof t.text === "string" ? t.text : "";
  const line = Math.max(1, Math.floor(t.line));
  const end = t.end && typeof t.end === "object" && typeof t.end.line === "number" && t.end.line > line && typeof t.end.text === "string" ? t.end : null;
  return {
    id: t.id,
    file: t.file,
    line,
    text,
    hash: typeof t.hash === "string" && t.hash !== "" ? t.hash : textHash(text),
    ...(end ? { end: { line: Math.floor(end.line), text: end.text, hash: typeof end.hash === "string" && end.hash !== "" ? end.hash : textHash(end.text) } } : {}),
    resolved: t.resolved === true,
    ...(typeof t.resolvedBy === "string" ? { resolvedBy: t.resolvedBy } : {}),
    ...(typeof t.resolvedAt === "string" ? { resolvedAt: t.resolvedAt } : {}),
    comments,
  };
}

/** 書く名前。制作画面の覚え書きの reviewer → OS のユーザー名（git は呼ばない。開発ツールの無い Mac では入れる画面が出るため）。 */
export function reviewAuthor(project: Project): string {
  const set = readStudioState(project).reviewer;
  if (set) return set;
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

export function listReviews(project: Project): ReviewList {
  return { threads: readReviews(project), author: reviewAuthor(project) };
}

function write(project: Project, t: ReviewThread): void {
  writeAtomic(join(dir(project), `${t.id}.json`), `${JSON.stringify(t, null, 2)}\n`);
}

/** 範囲の最後の行（line より後ろのときだけ）。 */
function rangeEnd(line: number, end: unknown): ReviewThread["end"] | null {
  if (!end || typeof end !== "object") return null;
  const e = end as { line?: unknown; text?: unknown };
  if (!Number.isInteger(e.line) || (e.line as number) <= line) return null;
  const text = typeof e.text === "string" ? e.text.trim() : "";
  return { line: e.line as number, text, hash: textHash(text) };
}

function body(text: unknown): string {
  if (typeof text !== "string" || text.trim() === "") throw new StudioError(400, "コメントが空です");
  if (text.length > BODY_LIMIT) throw new StudioError(400, "コメントが長すぎます");
  return text.trim();
}

/** 行の中身を書き換えた（シーンの名前の変更）。その行に付いたスレッドの行の中身を付け替える（名前を書かないので git は読まない）。 */
export function moveReviewLines(project: Project, moved: readonly { file: string; line: number; before: string; after: string }[], remember?: (name: string, undo: () => void) => void): void {
  if (moved.length === 0) return;
  const threads = readReviews(project);
  for (const next of moveReviewThreads(threads, moved)) {
    const t = threads.find((x) => x.id === next.id)!;
    write(project, next);
    remember?.(`reviews/${t.id}.json`, () => write(project, t));
  }
}

/** シナリオのファイルの名前を変えた。そのファイルの行に付いたスレッドを新しい名前へ付け替える（行と中身はそのまま）。 */
export function renameReviewFile(project: Project, from: string, to: string, remember?: (name: string, undo: () => void) => void): void {
  for (const t of readReviews(project)) {
    if (t.file !== from) continue;
    write(project, { ...t, file: to });
    remember?.(`reviews/${t.id}.json`, () => write(project, t));
  }
}

/**
 * 別のファイルへ移した行に付いたスレッドを、移した先の行へ付け替える（シーンを別のファイルへ移したとき）。
 * moved は行ごとの移った先と、移す前と後の中身。同じ中身の行がいくつもあれば、元の行番号の合うものを先に使う。
 */
export function relocateReviewLines(project: Project, moved: readonly { from: { file: string; line: number }; file: string; line: number; before: string; after: string }[], remember?: (name: string, undo: () => void) => void): void {
  if (moved.length === 0) return;
  for (const t of readReviews(project)) {
    const same = moved.filter((m) => m.from.file === t.file && m.before.trim() === t.text);
    const m = same.find((x) => x.from.line === t.line) ?? same[0];
    if (!m) continue;
    write(project, { ...t, file: m.file, line: m.line, text: m.after.trim(), hash: textHash(m.after.trim()) });
    remember?.(`reviews/${t.id}.json`, () => write(project, t));
  }
}

// ---- テスト版の指摘の取り込み ----

/** 指摘のスクリーンショットの置き場（reviews/ の下）。 */
export const FEEDBACK_SHOTS = "shots";
/** 一つのスクリーンショットの大きさの上限（base64 を戻したもの）。 */
const SHOT_LIMIT = 4 * 1024 * 1024;

/** 読み込んだ指摘の一つ（テスト版の packages/web/src/feedback.ts の FeedbackRecord）。 */
interface FeedbackRecordIn {
  kind?: unknown;
  project?: unknown;
  version?: unknown;
  variant?: unknown;
  at?: unknown;
  body?: unknown;
  author?: unknown;
  time?: unknown;
  shot?: unknown;
}

/** 取り込めなかった理由（画面が文言に直す）。name は送られたファイルの名前。 */
export type FeedbackSkip = { name: string; reason: "format" | "project" | "file" | "duplicate" };

/** 同じ指摘を二度取り込まないための id（作品・時刻・名前・本文から。並べると指摘した順）。 */
function feedbackId(r: { time: string; author: string; body: string }): string {
  const t = Date.parse(r.time);
  return `f${(Number.isFinite(t) ? t : 0).toString(36)}-${textHash(`${r.author}\n${r.body}`).replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 12)}`;
}

/** 台本のページの鍵で、今の行を探す（行を足しても同じページを指す）。見つからなければ書いたときの行。 */
function feedbackLine(source: string, file: string, at: { line: number; key?: string }): number {
  const total = source.split("\n").length;
  if (at.key) {
    try {
      for (const [line, key] of pageKeys(parse(source, file))) if (key === at.key) return line;
    } catch {
      // 読めない台本は書いたときの行
    }
  }
  return Math.min(Math.max(1, Math.floor(at.line)), total);
}

/**
 * テスト版の指摘（.liminalia-feedback.json の中身か、送り先で受けたものの並び）を、そのシナリオの行のコメントとして reviews/ に取り込む。
 * 行はページの鍵で探し直し、スクリーンショットは reviews/shots/ に置いてコメントに付ける。別のプロジェクトの指摘、無いシナリオ、
 * 取り込み済みの指摘は飛ばして理由を返す。
 */
export function importFeedback(project: Project, files: unknown): { imported: number; skipped: FeedbackSkip[]; list: ReviewList } {
  if (!Array.isArray(files)) throw new StudioError(400, "files（{ name, data } の並び）を送ってください");
  const known = new Set(readReviews(project).map((t) => t.id));
  const skipped: FeedbackSkip[] = [];
  let imported = 0;
  for (const raw of files as { name?: unknown; data?: unknown }[]) {
    const name = typeof raw?.name === "string" ? raw.name : "";
    const records = Array.isArray(raw?.data) ? (raw.data as FeedbackRecordIn[]) : [raw?.data as FeedbackRecordIn];
    for (const r of records) {
      // 場面の位置の分からない指摘（タイトル画面など）は、「はじめから」のファイルの頭に付ける
      const at = r && typeof r.at === "object" && r.at !== null ? (r.at as { file?: unknown; line?: unknown; key?: unknown }) : r?.at === null ? { file: project.config.entry, line: 1 } : null;
      if (!r || r.kind !== "liminalia-feedback" || typeof r.body !== "string" || r.body.trim() === "" || typeof r.time !== "string" || !at || typeof at.file !== "string" || typeof at.line !== "number") {
        skipped.push({ name, reason: "format" });
        continue;
      }
      if (typeof r.project === "string" && r.project !== project.config.id) {
        skipped.push({ name, reason: "project" });
        continue;
      }
      const author = typeof r.author === "string" ? r.author.trim().slice(0, 100) : "";
      const body = r.body.trim().slice(0, BODY_LIMIT);
      const id = feedbackId({ time: r.time, author, body });
      if (known.has(id)) {
        skipped.push({ name, reason: "duplicate" });
        continue;
      }
      const path = join(project.paths.scenario, ...`${at.file}.lim`.split("/"));
      if (at.file.split("/").some((p) => p === "" || p === "." || p === "..") || !existsSync(path)) {
        skipped.push({ name, reason: "file" });
        continue;
      }
      const source = readFileSync(path, "utf8");
      const line = feedbackLine(source, at.file, { line: at.line, ...(typeof at.key === "string" ? { key: at.key } : {}) });
      const text = (source.split("\n")[line - 1] ?? "").trim();
      let image: string | undefined;
      const shot = typeof r.shot === "string" ? /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(r.shot) : null;
      if (shot) {
        const data = Buffer.from(shot[2]!, "base64");
        if (data.length > 0 && data.length <= SHOT_LIMIT) {
          image = `${FEEDBACK_SHOTS}/${id}.${shot[1] === "png" ? "png" : "jpg"}`;
          writeAtomic(join(dir(project), ...image.split("/")), data);
        }
      }
      const via = [typeof r.version === "string" && r.version ? r.version : "", typeof r.variant === "string" ? r.variant : ""].filter(Boolean).join(" ");
      const time = Number.isFinite(Date.parse(r.time)) ? new Date(r.time).toISOString() : new Date().toISOString();
      write(project, { id, file: at.file, line, text, hash: textHash(text), resolved: false, comments: [{ id: newId("c"), author, time, body, feedback: { ...(via ? { build: via } : {}) }, ...(image ? { image } : {}) }] });
      known.add(id);
      imported++;
    }
  }
  return { imported, skipped, list: listReviews(project) };
}

/** 指摘のスクリーンショットを読む（reviews/shots/ の中のものだけ）。 */
export function feedbackShot(project: Project, path: unknown): { data: Buffer; type: string } {
  if (typeof path !== "string" || !new RegExp(`^${FEEDBACK_SHOTS}/[a-z0-9-]{1,64}\\.(jpg|png)$`).test(path)) throw new StudioError(400, "path を送ってください");
  const file = join(dir(project), ...path.split("/"));
  if (!existsSync(file)) throw new StudioError(404, "スクリーンショットがありません");
  return { data: readFileSync(file), type: path.endsWith(".png") ? "image/png" : "image/jpeg" };
}

/** 頼みを受けて reviews/ を書き換え、書いたあとの一覧を返す。 */
export function applyReview(project: Project, action: ReviewAction, now = new Date()): ReviewList {
  const author = reviewAuthor(project);
  const time = now.toISOString();
  const threads = readReviews(project);
  const find = (id: string) => {
    const t = threads.find((x) => x.id === id);
    if (!t) throw new StudioError(404, `コメント ${id} がありません（ほかで削除されたかもしれません）`);
    return t;
  };
  switch (action.kind) {
    case "create": {
      if (typeof action.file !== "string" || action.file === "" || !Number.isInteger(action.line) || action.line < 1) throw new StudioError(400, "file と line を送ってください");
      const text = typeof action.text === "string" ? action.text.trim() : "";
      const end = rangeEnd(action.line, action.end);
      write(project, { id: newId("r"), file: action.file, line: action.line, text, hash: textHash(text), ...(end ? { end } : {}), resolved: false, comments: [{ id: newId("c"), author, time, body: body(action.body) }] });
      break;
    }
    case "edit": {
      const t = find(action.id);
      const c = t.comments.find((x) => x.id === action.comment);
      if (!c) throw new StudioError(404, "コメントがありません（ほかで削除されたかもしれません）");
      if (c.author !== author) throw new StudioError(403, "ほかの人のコメントは編集できません");
      c.body = body(action.body);
      c.edited = time;
      write(project, t);
      break;
    }
    case "reply": {
      const t = find(action.id);
      t.comments.push({ id: newId("c"), author, time, body: body(action.body) });
      write(project, t);
      break;
    }
    case "resolve": {
      const t = find(action.id);
      t.resolved = action.resolved === true;
      if (t.resolved) {
        t.resolvedBy = author;
        t.resolvedAt = time;
      } else {
        delete t.resolvedBy;
        delete t.resolvedAt;
      }
      write(project, t);
      break;
    }
    case "delete": {
      const t = find(action.id);
      t.comments = t.comments.filter((c) => c.id !== action.comment);
      if (t.comments.length === 0) rmSync(join(dir(project), `${t.id}.json`), { force: true });
      else write(project, t);
      break;
    }
    case "anchor": {
      const t = find(action.id);
      if (!Number.isInteger(action.line) || action.line < 1) throw new StudioError(400, "line（1 から）を送ってください");
      t.line = action.line;
      t.text = typeof action.text === "string" ? action.text.trim() : "";
      t.hash = textHash(t.text);
      if (action.end !== undefined) {
        const end = rangeEnd(t.line, action.end);
        if (end) t.end = end;
        else delete t.end;
      }
      write(project, t);
      break;
    }
    default:
      throw new StudioError(400, "kind（create、reply、edit、resolve、delete、anchor）を送ってください");
  }
  return listReviews(project);
}
