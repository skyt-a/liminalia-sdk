import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HeadMark } from "@liminalia/lang";
import type { Project } from "@liminalia/project";
import { CAST_NOTE_MAX, FAVORITES_MAX, STUDIO_SHARED_KEYS, type FaceCrop, type StoredBreakpoint, type StudioBookmark, type StudioFavorite, type StudioState } from "../protocol.ts";
import { cleanMarks } from "../model/scene-marks.ts";
import { StudioError, writeAtomic } from "./workspace.ts";

/** 制作画面のデータのうち、その人の手元だけのもの（開いていた所、ブックマークなど）の置き場（作品のフォルダからの相対パス）。Git に入れない。 */
export const STUDIO_STATE_FILE = join(".liminalia", "studio.json");
/**
 * 制作画面のデータのうち、プロジェクトと一緒に共有するもの（STUDIO_SHARED_KEYS。シーンのタグと状態、キャラクターのメモ、顔の切り出し、
 * 頭の印、フローチャートの配置）の置き場。Git に入れ（ひな形の .gitignore は .liminalia/ のうちこれだけを外さない）、共同作者とスマホ版に届ける。
 * どちらも .liminalia/ の下なので、ゲームの書き出しには入らない。
 */
export const STUDIO_SHARED_FILE = join(".liminalia", "shared.json");

const SHARED: ReadonlySet<string> = new Set(STUDIO_SHARED_KEYS);

/** ファイルを JSON のオブジェクトとして読む（無い、読めないときは null）。 */
function readObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    // 制作画面のデータが読めなければ、無いものとして始める（壊れていても制作画面は止めない）
    return null;
  }
}

/** state を、共有するものと手元だけのものに分ける。 */
function split(state: StudioState): { shared: StudioState; personal: StudioState } {
  const shared: Record<string, unknown> = {};
  const personal: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) (SHARED.has(k) ? shared : personal)[k] = v;
  return { shared: shared as StudioState, personal: personal as StudioState };
}

/** 前の版の studio.json にあった共有するもの（old）に、shared.json の分（now）を重ねる。項目の中の鍵（シーン、キャラクターなど）ごとに now を先にする。 */
function mergeShared(old: StudioState, now: StudioState): StudioState {
  const out: Record<string, unknown> = { ...old };
  for (const [k, v] of Object.entries(now)) {
    const was = out[k];
    out[k] = was && typeof was === "object" && v && typeof v === "object" ? { ...(was as object), ...(v as object) } : v;
  }
  return out as StudioState;
}

/**
 * 制作画面のデータを読む（studio.json と shared.json を合わせたもの）。無い、読めないときは空（壊れていても制作画面は止めない）。
 * 前の版の studio.json に共有するものがあれば、shared.json へ移す（開いたときに一度。shared.json にある値を先にする）。
 */
export function readStudioState(project: Project): StudioState {
  const personalPath = join(project.root, STUDIO_STATE_FILE);
  const sharedPath = join(project.root, STUDIO_SHARED_FILE);
  const rawPersonal = readObject(personalPath);
  const personal = split(cleanState(rawPersonal ?? {}));
  const shared = split(cleanState(readObject(sharedPath) ?? {})).shared;
  if (!rawPersonal || !Object.keys(rawPersonal).some((k) => SHARED.has(k))) return { ...personal.personal, ...shared };
  const merged = mergeShared(personal.shared, shared);
  try {
    writeShared(sharedPath, merged);
    writeAtomic(personalPath, `${JSON.stringify(personal.personal, null, 2)}\n`);
  } catch {
    // 移せなければ（書き込めないフォルダなど）、合わせたものを返すだけにする。次に読んだときにまた移す
  }
  return { ...personal.personal, ...merged };
}

/**
 * 制作画面のデータを書く（形の誤りは 400）。共有するものは shared.json に（中身が変わったときだけ。何も無く、ファイルも無ければ作らない）、
 * 手元だけのものは studio.json に書く。開発サーバーの見張りは shared.json の変更だけを知らせる（共同作者の変更を Git で取り込んだときにも）。
 */
export function writeStudioState(project: Project, value: unknown): StudioState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StudioError(400, "state をオブジェクトで送ってください");
  const state = cleanState(value);
  const { shared, personal } = split(state);
  writeShared(join(project.root, STUDIO_SHARED_FILE), shared);
  writeAtomic(join(project.root, STUDIO_STATE_FILE), `${JSON.stringify(personal, null, 2)}\n`);
  return state;
}

/** 開発サーバーが最後に書いた共有するデータ（パス → 中身）。見張りが、自分の書き込みを外の変更として知らせないように。 */
const ownWrites = new Map<string, string>();

/** 共有するものを書く。今のファイルと中身（形を整えたもの）が同じなら、手元の書き方のまま残す（Git に差分を出さない）。 */
function writeShared(path: string, shared: StudioState): void {
  const now = readObject(path);
  if (now === null && !existsSync(path) && Object.keys(shared).length === 0) return;
  if (now !== null && Object.keys(now).every((k) => SHARED.has(k)) && JSON.stringify(cleanState(now)) === JSON.stringify(cleanState(shared))) return;
  const text = `${JSON.stringify(shared, null, 2)}\n`;
  ownWrites.set(path, text);
  writeAtomic(path, text);
}

/** 共有するデータのファイル（path）の今の中身が、開発サーバー自身が最後に書いたものか（見張りの知らせを画面に送らない）。 */
export function isOwnSharedWrite(path: string): boolean {
  const own = ownWrites.get(path);
  if (own === undefined) return false;
  try {
    return readFileSync(path, "utf8") === own;
  } catch {
    // 消えていれば外の変更
    return false;
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** 日ごとの文字数を覚えておく日数（画面の model/text-progress.ts の DAILY_KEEP と同じ）。 */
const DAILY_DAYS = 400;

/** 知っている項目の、形の合うものだけを残す。 */
function cleanState(raw: unknown): StudioState {
  const out: StudioState = {};
  if (!raw || typeof raw !== "object") return out;
  const { faces, heads, mapPositions, reviewer, lastOpen, favorites, textGoal, textDaily, bookmarks, breakpoints, castNotes, todoWords, sceneMarks } = raw as Record<string, unknown>;
  const marks = cleanMarks(sceneMarks);
  if (Object.keys(marks).length > 0) out.sceneMarks = marks;
  if (bookmarks && typeof bookmarks === "object" && !Array.isArray(bookmarks)) {
    const kept: Record<string, StudioBookmark[]> = {};
    for (const [file, list] of Object.entries(bookmarks)) {
      if (file === "" || !Array.isArray(list)) continue;
      const marks = list
        .filter((b): b is StudioBookmark => finite(b?.line) && b.line >= 1 && typeof b.text === "string")
        .slice(0, FAVORITES_MAX)
        .map((b) => ({ line: Math.floor(b.line), text: b.text.slice(0, 200), ...(typeof b.hash === "string" && b.hash !== "" ? { hash: b.hash.slice(0, 64) } : {}) }));
      if (marks.length > 0) kept[file] = marks;
    }
    if (Object.keys(kept).length > 0) out.bookmarks = kept;
  }
  if (finite(textGoal) && textGoal > 0) out.textGoal = Math.floor(textGoal);
  if (textDaily && typeof textDaily === "object" && !Array.isArray(textDaily)) {
    const kept: Record<string, [number, number]> = {};
    for (const [date, v] of Object.entries(textDaily).sort(([a], [b]) => a.localeCompare(b)).slice(-DAILY_DAYS)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) && v[0] >= 0 && v[1] >= 0) kept[date] = [Math.floor(v[0]), Math.floor(v[1])];
    }
    if (Object.keys(kept).length > 0) out.textDaily = kept;
  }
  if (Array.isArray(favorites)) {
    const kept = favorites
      .filter((f): f is StudioFavorite => typeof f?.label === "string" && Array.isArray(f.lines) && f.lines.length > 0 && f.lines.every((l: unknown) => typeof l === "string"))
      .slice(0, FAVORITES_MAX)
      .map((f) => ({ label: f.label.slice(0, 100), lines: [...f.lines] }));
    if (kept.length > 0) out.favorites = kept;
  }
  if (faces && typeof faces === "object") {
    const kept: Record<string, FaceCrop> = {};
    for (const [who, f] of Object.entries(faces)) {
      const c = f as Partial<FaceCrop> | null;
      if (c && finite(c.x) && finite(c.y) && finite(c.size) && c.size > 0) kept[who] = { x: c.x, y: c.y, size: c.size };
    }
    if (Object.keys(kept).length > 0) out.faces = kept;
  }
  if (heads && typeof heads === "object") {
    const kept: Record<string, HeadMark> = {};
    for (const [image, m] of Object.entries(heads)) {
      const c = m as Partial<HeadMark> | null;
      // 絵の中身の印（imageHash。"sha256-" と 16 進 64 字）。印の無い前の形と、前の版の弱い印の測定点も読む（制作画面が確かめ直しにする）
      const hash = typeof c?.imageHash === "string" && c.imageHash !== "" && c.imageHash.length <= 128 ? { imageHash: c.imageHash } : {};
      if (c && finite(c.chinX) && finite(c.chinY) && finite(c.top) && finite(c.width) && finite(c.imageWidth) && finite(c.imageHeight)) kept[image] = { chinX: c.chinX, chinY: c.chinY, top: c.top, width: c.width, imageWidth: c.imageWidth, imageHeight: c.imageHeight, ...hash };
    }
    if (Object.keys(kept).length > 0) out.heads = kept;
  }
  if (mapPositions && typeof mapPositions === "object") {
    const kept: Record<string, { x: number; y: number }> = {};
    for (const [id, p] of Object.entries(mapPositions)) {
      const at = p as { x?: unknown; y?: unknown } | null;
      if (at && finite(at.x) && finite(at.y)) kept[id] = { x: at.x, y: at.y };
    }
    if (Object.keys(kept).length > 0) out.mapPositions = kept;
  }
  if (typeof reviewer === "string" && reviewer.trim() !== "") out.reviewer = reviewer.trim().slice(0, 100);
  if (lastOpen && typeof lastOpen === "object") {
    const { file, line } = lastOpen as { file?: unknown; line?: unknown };
    if (typeof file === "string" && file !== "" && finite(line) && line >= 1) out.lastOpen = { file, line: Math.floor(line) };
  }
  if (castNotes && typeof castNotes === "object" && !Array.isArray(castNotes)) {
    const kept: Record<string, string> = {};
    for (const [who, note] of Object.entries(castNotes)) if (who !== "" && typeof note === "string" && note.trim() !== "") kept[who] = note.slice(0, CAST_NOTE_MAX);
    if (Object.keys(kept).length > 0) out.castNotes = kept;
  }
  if (Array.isArray(todoWords)) {
    const kept = [...new Set(todoWords.filter((w): w is string => typeof w === "string").map((w) => w.trim().slice(0, 30)).filter((w) => w !== ""))].slice(0, 20);
    if (kept.length > 0) out.todoWords = kept;
  }
  if (Array.isArray(breakpoints)) {
    const kept: StoredBreakpoint[] = [];
    for (const b of breakpoints.slice(0, 1000)) {
      const { file, line, text, hash, cond } = (b ?? {}) as Record<string, unknown>;
      if (typeof file !== "string" || file === "" || !finite(line) || line < 1 || typeof text !== "string" || typeof hash !== "string") continue;
      kept.push({ file, line: Math.floor(line), text: text.slice(0, 2000), hash, ...(typeof cond === "string" && cond.trim() !== "" ? { cond: cond.trim().slice(0, 500) } : {}) });
    }
    if (kept.length > 0) out.breakpoints = kept;
  }
  return out;
}
