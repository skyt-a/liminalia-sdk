import { readFileSync } from "node:fs";
import { buildStoryMap, type Registry, type Script, type VoiceLock } from "@liminalia/lang";
import { projectRuntimeOptions, type CommandImpl, type ProjectRuntimeOptions } from "@liminalia/runtime";
import { findPlayStart, type PlaySweeps, type PlayStart } from "@liminalia/editor/play-from";
import { STUDIO_API, type Sweep, type SweepReach } from "@liminalia/editor/protocol";
import { routeGuide, Sweeper } from "@liminalia/editor/sweep";

/**
 * 「ここからテストプレイ」で、カーソルの行を実行する直前の状態（前のシーンやほかのファイルで決めた背景・立ち絵・BGM・変数）から始める
 * セーブを組み立てる。制作画面の「ここからテストプレイ」と同じ組み立て（@liminalia/editor の findPlayStart）で、現在地は
 * 開いている制作画面の開発サーバー（GET /sweep・GET /sweep/reach）から引き、引けなければ言語サーバーの中で同じもの
 * （@liminalia/editor の Sweeper と routeGuide）を作る。
 */

/** 開発サーバーの口で現在地を引く。 */
export function remoteSweeps(url: string, fetchImpl: typeof fetch = fetch): PlaySweeps {
  const get = async <T>(path: string, query: Record<string, string | number>): Promise<T> => {
    const q = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    const res = await fetchImpl(`${url}${STUDIO_API}${path}?${q}`);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    sweep: (file, range) => get<Sweep>("/sweep", { file, from: range.from, to: range.to }),
    reach: (file, line, range) => get<SweepReach>("/sweep/reach", { file, line, from: range.from, to: range.to }),
  };
}

/** 言語サーバーの中で現在地を作るのに要るもの（開いているファイルは保存前の中身）。 */
export interface LocalProject {
  /** シナリオの名前 → 中身と構文木。 */
  scripts: ReadonlyMap<string, { script: Script; text: string }>;
  registry: Registry;
  speakers: readonly string[];
  cast: Readonly<Record<string, unknown>>;
  /** 画面なしで動かせる命令（組み込みの外。標準の命令と、このプロセスで読めたプラグインの命令）。 */
  implementations: readonly CommandImpl[];
  /** liminalia.json を読んだもの。 */
  config: { entry?: unknown; variables?: unknown; afterLoad?: unknown; ui?: unknown; extra?: unknown; commandDefaults?: unknown; endingKinds?: unknown; autoLayout?: unknown; version?: unknown; chapters?: unknown; languages?: unknown };
  /** 作品のデータ（paths.data の .json）を名前で読む。 */
  data(name: string): unknown;
  /** 連番のボイスの番号の固定（voice-lock.json。無い・読めなければ null）。 */
  voiceLock?: VoiceLock | null;
}

/** voice-lock.json を読む。無い・読めなければ null（遊ぶ側と同じ。読めないことは診断が知らせる）。 */
export function readVoiceLockFile(path: string): VoiceLock | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as VoiceLock;
  } catch {
    // 読めない固定は無いものとして流す（遊ぶ側の player-info.ts と同じ。JSON の誤りは検査が bad-voice-lock で知らせる）
    return null;
  }
}

/**
 * 画面なしで流すときの実行器の設定（開発サーバーの StudioWorkspace の現在地と同じく、遊ぶ側と同じ @liminalia/runtime の
 * projectRuntimeOptions で作る。言語は原文の言語、訳は無し）。
 */
export function runtimeOptions(p: LocalProject): ProjectRuntimeOptions {
  return projectRuntimeOptions({
    config: p.config,
    speakers: p.speakers,
    commands: p.implementations,
    cast: p.cast,
    voiceLock: p.voiceLock ?? null,
    // 作品のデータ（命令の ctx.data）。読めないと、データで行き先を決める命令の先へ進めない
    loadData: (name) => p.data(name),
  });
}

/** 言語サーバーの中で現在地を作る（制作画面の開発サーバーと同じ Sweeper。届かない行は同じ手がかりで道筋を探す）。 */
export function localSweeps(p: LocalProject): PlaySweeps {
  const entry = typeof p.config.entry === "string" && p.config.entry !== "" ? p.config.entry : "start";
  const sweeper = new Sweeper({
    loadSource: async (file) => {
      const s = p.scripts.get(file);
      if (!s) throw new Error(`${file}.lim がありません`);
      return s.text;
    },
    runtime: runtimeOptions(p),
    entry,
  });
  return {
    sweep: async (file) => ({ ...(await sweeper.sweep(file)), hash: "" }),
    reach: async (file, line) => {
      const map = buildStoryMap({ scripts: p.scripts, registry: p.registry, entry, hooks: new Map(), data: (name) => p.data(name), variables: runtimeOptions(p).variables ?? {}, endingKinds: p.config.endingKinds });
      const guide = routeGuide(map, new Map([...p.scripts].map(([f, s]) => [f, s.script] as const)), file, line);
      const found = await sweeper.entryReaching(file, line, guide);
      return { sweep: found.entry ? { ...(await sweeper.sweep(file, found.entry)), hash: "" } : null };
    },
  };
}

/** 組み立てたセーブ（言語サーバーの liminalia/playFrom の答え）。 */
export interface PlayFromResult {
  save: PlayStart["save"];
  /** 実際に始める行（1 から）。 */
  line: number;
  basis: PlayStart["basis"];
  /** その行に届くルートが見つからず、手前の行の状態から始める行（1 から）。 */
  noRoute?: number;
  /** 現在地をどこで作ったか。 */
  source: "studio" | "local";
}

/**
 * file の line 行目（1 から）から遊ぶセーブ。studio があればその開発サーバーの現在地を使い、引けなければ local で作る。
 * 始められない行（マクロの中・ファイルの終わりの空行）は null。
 */
export async function buildPlayFrom(o: { file: string; text: string; speakers: readonly string[]; line: number; studio?: PlaySweeps; local: () => PlaySweeps; log?: (message: string) => void }): Promise<PlayFromResult | null> {
  const run = async (sweeps: PlaySweeps, source: PlayFromResult["source"]): Promise<PlayFromResult | null> => {
    let noRoute: number | undefined;
    const start = await findPlayStart(sweeps, o.file, o.text, o.speakers, o.line, { noRoute: (l) => (noRoute = l) });
    return start ? { save: start.save, line: start.line, basis: start.basis, ...(noRoute !== undefined ? { noRoute } : {}), source } : null;
  };
  if (o.studio) {
    try {
      return await run(o.studio, "studio");
    } catch (e) {
      o.log?.(`Studio から現在地を取得できないため、言語サーバー側で計算します（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  return run(o.local(), "local");
}
