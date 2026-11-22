import { SCENE_COLORS, SCENE_STATUSES, type SceneColor, type SceneMark, type SceneStatus } from "../protocol.ts";

/**
 * シーンのタグ、色、状態（画面なし）。制作画面のデータ（.liminalia/studio.json の sceneMarks。鍵はフローチャートと同じシーンの id
 * `ファイル#ラベル`、ファイルの頭のシーンは `ファイル`）に持ち、ゲームには入れない。フローチャートのカード、シーン一覧の点、絞り込み、⌘K に使う。
 */

export type SceneMarks = Record<string, SceneMark>;

/** タグの数と長さの上限。 */
export const TAGS_MAX = 12;
export const TAG_LENGTH = 40;

/** 色を決めていないシーンの点の色（状態から）。 */
const STATUS_COLOR: Record<SceneStatus, SceneColor> = { draft: "gray", review: "yellow", done: "green" };

/** 打ったタグの並び（読点、カンマ、空白で区切る。先頭の # は外す）を、重ならないタグの並びにする。 */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const w of text.split(/[、,，\s]+/)) {
    const tag = w.trim().replace(/^[#＃]+/, "").slice(0, TAG_LENGTH);
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, TAGS_MAX);
}

/** 形の合うものだけを残した印（何も無ければ null）。開発サーバーが覚えるときと、画面が書くときに使う。 */
export function cleanMark(raw: unknown): SceneMark | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { status, color, tags } = raw as Record<string, unknown>;
  const out: SceneMark = {};
  if (typeof status === "string" && (SCENE_STATUSES as readonly string[]).includes(status)) out.status = status as SceneStatus;
  if (typeof color === "string" && (SCENE_COLORS as readonly string[]).includes(color)) out.color = color as SceneColor;
  if (Array.isArray(tags)) {
    const kept = parseTags(tags.filter((t): t is string => typeof t === "string").join(","));
    if (kept.length > 0) out.tags = kept;
  }
  return out.status || out.color || out.tags ? out : null;
}

/** 印のすべて（覚えているもののうち形の合うもの）。 */
export function cleanMarks(raw: unknown): SceneMarks {
  const out: SceneMarks = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, m] of Object.entries(raw)) {
    const mark = id === "" ? null : cleanMark(m);
    if (mark) out[id] = mark;
  }
  return out;
}

/** シーン一覧とカードの点の色（色を決めていれば色、無ければ状態の色。どちらも無ければ null）。 */
export function dotColor(mark: SceneMark | undefined): SceneColor | null {
  return mark?.color ?? (mark?.status ? STATUS_COLOR[mark.status] : null);
}

/** 使っているタグ（多い順、同じなら名前順）。 */
export function allTags(marks: SceneMarks): string[] {
  const count = new Map<string, number>();
  for (const m of Object.values(marks)) for (const t of m.tags ?? []) count.set(t, (count.get(t) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja")).map(([t]) => t);
}

/**
 * 印の絞り込み。"" はすべて、"marked" は印のあるもの、"status:…"・"color:…"・"tag:…" はそれを持つもの。
 */
export function matchesMark(mark: SceneMark | undefined, filter: string): boolean {
  if (filter === "") return true;
  if (filter === "marked") return mark !== undefined;
  const at = filter.indexOf(":");
  const kind = filter.slice(0, at);
  const value = filter.slice(at + 1);
  if (kind === "status") return mark?.status === value;
  if (kind === "color") return mark?.color === value;
  if (kind === "tag") return mark?.tags?.includes(value) === true;
  return true;
}

/** 絞り込みの選び（すべて、印のあるもの、状態、色、使っているタグ）。名前は画面の言葉で渡す。 */
export function markFilterChoices(marks: SceneMarks, names: { all: string; marked: string; status: Record<string, string>; color: Record<string, string>; tag: (tag: string) => string }): { value: string; label: string }[] {
  const used = Object.values(marks);
  return [
    { value: "", label: names.all },
    { value: "marked", label: names.marked },
    ...SCENE_STATUSES.filter((s) => used.some((m) => m.status === s)).map((s) => ({ value: `status:${s}`, label: names.status[s] ?? s })),
    ...SCENE_COLORS.filter((c) => used.some((m) => m.color === c)).map((c) => ({ value: `color:${c}`, label: names.color[c] ?? c })),
    ...allTags(marks).map((t) => ({ value: `tag:${t}`, label: names.tag(t) })),
  ];
}

/** ⌘K で探すときの言葉（状態の名前とタグ）。 */
export function markWords(mark: SceneMark | undefined, statusName: (s: SceneStatus) => string): string {
  if (!mark) return "";
  return [mark.status ? statusName(mark.status) : "", ...(mark.tags ?? []).map((t) => `#${t}`)].filter(Boolean).join(" ");
}

/** 印の説明（マウスオーバー。状態、色、タグ）。 */
export function markSummary(mark: SceneMark | undefined, names: { status: Record<string, string>; color: Record<string, string> }, sep: string): string {
  if (!mark) return "";
  return [mark.status ? names.status[mark.status] : "", mark.color ? names.color[mark.color] : "", ...(mark.tags ?? []).map((t) => `#${t}`)].filter(Boolean).join(sep);
}
