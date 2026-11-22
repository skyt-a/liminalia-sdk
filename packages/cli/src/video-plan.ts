import { existsSync, readFileSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chapterOf, textStats, type ChapterInfo, type StoryMap } from "@liminalia/lang";
import { projectScripts, type Project } from "@liminalia/project";
import type { ChooserState } from "./video-timeline.ts";

/**
 * lim shot --video の段取り: 区切り（--split）の名前、どこまで録ったかの記録（続きから録る --resume）、止める所（--until）、
 * 始める前の見込みの大きさと空き。
 */

/** 区切り方。none は一つの mp4。 */
export type VideoSplit = "none" | "file" | "chapter";

/** どこまで録ったかを書くファイル（出力フォルダの中）。 */
export const PROGRESS_FILE = "liminalia-video.json";

/** 区切りの mp4 の名前（3 桁の番号と名前。名前のファイルに使えない文字は _ に）。 */
export function segmentFileName(n: number, name: string): string {
  const safe =
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "part";
  return `${String(n).padStart(3, "0")}_${safe}.mp4`;
}

/** 区切りの鍵と名前（ファイルごとならファイル、章ごとなら章の id。章に入らないファイルはファイルの名前）。 */
export function segmentKey(split: VideoSplit, file: string, chapters: readonly ChapterInfo[] | undefined): { key: string; name: string } {
  if (split === "none") return { key: "", name: "" };
  if (split === "chapter") {
    const c = chapterOf(chapters, file);
    if (c) return { key: `chapter:${c.id}`, name: c.id };
  }
  return { key: `file:${file}`, name: file };
}

/** 止める所（--until ファイル[#ラベル]）。line は、ラベルなら その行（ファイルのその行より後に着いたら止める）。 */
export interface UntilPoint {
  file: string;
  line: number | null;
  /** 書き方（"ファイル" か "ファイル#ラベル"）。 */
  target: string;
}

/** --until の書き方（resolveShotTarget で直したもの）から、止める所を作る。 */
export function untilPoint(project: Project, target: string): UntilPoint {
  const hash = target.indexOf("#");
  const file = hash < 0 ? target : target.slice(0, hash);
  if (hash < 0) return { file, line: null, target };
  const label = target.slice(hash + 1);
  const body = projectScripts(project).get(file)?.script.body ?? [];
  const hit = body.find((s) => s.kind === "label" && s.name === label);
  return { file, line: hit?.line ?? null, target };
}

/** 止める所に着いたか（呼び出しやマクロの中ではない、ファイルの本体の位置で見る）。 */
export function reachedUntil(until: UntilPoint | null, at: { file: string; line: number } | null, depth: number): boolean {
  if (!until || !at || depth > 0 || at.file !== until.file) return false;
  return until.line === null || at.line >= until.line;
}

/** 区切りの記録。 */
export interface SegmentRecord {
  /** 番号（1 から）。 */
  n: number;
  /** 名前（ファイルか章の id）。 */
  name: string;
  key: string;
  /** mp4 のファイルの名前（出力フォルダの中）。 */
  file: string;
  /** recording は録っている途中（止まったら、続きから録るときに録り直す）。 */
  status: "recording" | "done";
  seconds?: number;
  pages?: number;
  /** この区切りの最初のページのセーブと、そこまでの選び方とページの数（続きから録るときに、ここから録り直す）。 */
  resume?: ResumePoint;
}

/** 続きから録る所（セーブと、セーブに入らない temp の変数と、そこまでの選び方）。 */
export interface ResumeSnapshot {
  save: unknown;
  /** その時の temp の変数（セーブに入らないので別に持ち、読んだあとに戻す）。 */
  temp?: Record<string, unknown>;
  chooser: ChooserState;
}

export interface ResumePoint extends ResumeSnapshot {
  pages: number;
  /**
   * 区切りに入る前の最後の待ち（クリック待ちか選ぶ画面）。あれば、続きから録るときはここから録らずに進め、区切りに入ったところから録る
   * （区切りの頭の場面転換などの演出も、続けて録ったときと同じに録る）。録り始めの区切りと、前の版の記録には無い。
   */
  lead?: ResumeSnapshot;
}

/** どこまで録ったか（出力フォルダの liminalia-video.json）。 */
export interface VideoProgress {
  version: 1;
  project: string;
  split: Exclude<VideoSplit, "none">;
  /** 初めに録り始めた位置。 */
  start: string;
  segments: SegmentRecord[];
  /**
   * 録り終えた（プレイが終わった）。続きは無い。--until と --pages で止めたときは録り終えていない（stopped に理由を残し、
   * 続きから録る所のセーブを次の区切りの記録に持つ）。
   */
  finished: boolean;
  /** 最後に止まった理由。 */
  stopped?: string;
  updated: string;
}

/** 頼まれた所（--until、--pages）で止めた理由。続きを --resume で録れる。 */
export const RESUMABLE_STOPS: ReadonlySet<string> = new Set(["until", "pages"]);

/**
 * もう最後まで録ってあるか（続きが無いか）。前の版（0.1.20 まで）は --until と --pages で止めたときも finished にしていたので、
 * その記録は録り終えていないものとして扱う。
 */
export function recordedToEnd(progress: VideoProgress): boolean {
  return progress.finished && !RESUMABLE_STOPS.has(progress.stopped ?? "");
}

export function readProgress(dir: string): VideoProgress | null {
  const path = join(dir, PROGRESS_FILE);
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf8")) as VideoProgress;
  if (data?.version !== 1 || !Array.isArray(data.segments)) throw new Error(`${path} の形が読めません（消してから録り直してください）`);
  return data;
}

/** 書き換える（書き終えてから置き換えるので、途中で止まっても前のものが残る）。 */
export function writeProgress(dir: string, progress: VideoProgress): void {
  const path = join(dir, PROGRESS_FILE);
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ ...progress, updated: new Date().toISOString() }, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** 続きから録る所（セーブを持つ最後の区切り。そこから録り直す）。無ければ null。 */
export function resumePoint(progress: VideoProgress): SegmentRecord | null {
  for (let i = progress.segments.length - 1; i >= 0; i--) if (progress.segments[i]!.resume) return progress.segments[i]!;
  return null;
}

/**
 * 録り直す区切り（--redo 番号）。その区切りの最初のページの記録（resume）から録り直す。番号の区切りが無いか、録り直す所の記録が無ければ例外
 * （録り始めの前に止まった区切りと、前の版で続きを書かなかった区切り）。
 */
export function redoSegment(progress: VideoProgress, n: number): SegmentRecord {
  const s = progress.segments.find((x) => x.n === n);
  if (!s) throw new Error(`${n} 番の区切りはありません（あるもの: ${progress.segments.map((x) => String(x.n).padStart(3, "0")).join("、") || "なし"}）`);
  if (!s.resume) throw new Error(`${n} 番の区切りには、録り直す所の記録がありません（--resume で続きを録るか、はじめから録り直します）`);
  return s;
}

/** そのフォルダ（無ければ、ある親）のある所の空き（バイト）。測れなければ Infinity。 */
export function freeBytes(path: string): number {
  let dir = resolve(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    // 空きを測れない所は、足りないとはみなさない（止めずに録る）
    return Infinity;
  }
}

/** 1 秒あたりの大きさ（バイト）の見込み。動画は 1280×720 で約 1.6Mbps（静かな場面が多い。動きが多ければ増える）、音は 160kbps。 */
export function bytesPerSecond(screen: { width: number; height: number }, audio: boolean): number {
  const video = (1_600_000 / 8) * ((screen.width * screen.height) / (1280 * 720));
  return Math.round(video + (audio ? 160_000 / 8 : 0));
}

/** 録る長さの見込み。 */
export interface VideoEstimate {
  /** 録るページの数の見込み（分かれ道はどれも通るものとして数えるので、多めになる）。 */
  pages: number;
  seconds: number;
  bytes: number;
}

/**
 * 録る長さと大きさの見込み。台本の地図（buildStoryMap）で開始位置から行ける場面のページと文字を数え（止める所の先は数えない）、
 * 1 ページを「読む時間 + 演出の間（0.4 秒）+ 文字を出す時間（一文字 30 ミリ秒）+ ボイスの付いた台詞なら声の長さ（一文字 150 ミリ秒の見当）」とする。
 */
export function estimateVideo(project: Project, map: StoryMap, o: { start: string; until: UntilPoint | null; pages: number; readMs: number; audio: boolean }): VideoEstimate {
  const startFile = o.start.split("#")[0]!;
  const ids = new Set(map.nodes.map((n) => n.id));
  const first = ids.has(o.start) ? o.start : map.nodes.filter((n) => n.file === startFile).sort((a, b) => a.line - b.line)[0]?.id;
  const stop = (id: string) => {
    if (!o.until) return false;
    const n = map.nodes.find((x) => x.id === id);
    return !!n && n.file === o.until.file && (o.until.line === null || n.line >= o.until.line);
  };
  const next = new Map<string, string[]>();
  for (const e of map.edges) if (!e.missing) (next.get(e.from) ?? next.set(e.from, []).get(e.from)!).push(e.to);
  const seen = new Set<string>();
  const queue = first ? [first] : [];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id) || stop(id)) continue;
    seen.add(id);
    for (const to of next.get(id) ?? []) if (!seen.has(to)) queue.push(to);
  }
  const scenes = new Map(textStats(new Map([...projectScripts(project)].map(([name, s]) => [name, s.script] as const))).scenes.map((s) => [`${s.file}#${s.label ?? ""}`, s] as const));
  let pages = 0;
  let chars = 0;
  let voicedChars = 0;
  for (const n of map.nodes) {
    if (!seen.has(n.id)) continue;
    pages += n.pages;
    const s = scenes.get(`${n.file}#${n.label ?? ""}`);
    if (!s) continue;
    const c = s.say.chars + s.prose.chars;
    const lines = s.say.lines + s.prose.lines;
    chars += c;
    if (lines > 0) voicedChars += (c * s.voiced) / lines;
  }
  const scale = Number.isFinite(o.pages) && pages > o.pages ? o.pages / pages : 1;
  const seconds = (pages * (o.readMs / 1000 + 0.4) + chars * 0.03 + voicedChars * 0.15) * scale;
  return { pages: Math.round(pages * scale), seconds: Math.round(seconds), bytes: Math.round(seconds * bytesPerSecond(project.screen, o.audio)) };
}

/** 大きさの表記（GB か MB）。英語の出力は lim の文言の表で読み替える。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "不明";
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;
}

/** 長さの表記（何時間何分、短ければ何分何秒）。英語の出力は lim の文言の表で読み替える。 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 時間 ${m} 分`;
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}
