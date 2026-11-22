import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { collectTranslatable, targetCandidates, voiceLines, type Script, type TranslationEntry, type TranslationFile, type VoiceLock, type VoiceLockEntry } from "@liminalia/lang";
import { leftInConfig, remainingRefs, rewriteConfig, rewriteMapPositions, targetVariables, uniqueLabel, type LabelTarget, type LeftRef } from "@liminalia/editor/label-rename";
import { moveBookmarks } from "../model/bookmarks.ts";
import { planSceneMove, SceneMoveError, type Origin, type PlannedFile } from "../model/scene-move.ts";
import type { SceneMoveResult } from "../protocol.ts";
import { pluginRefs, renameBaselines, rollback, scriptsOf, specLookup } from "./labels.ts";
import { refuseNotUtf8, updateConfig } from "./manage-shared.ts";
import { relocateReviewLines } from "./reviews.ts";
import { readStudioState, writeStudioState } from "./studio-state.ts";
import { renameInTests } from "./test-rename.ts";
import { StudioError, writeAtomic, type StudioWorkspace } from "./workspace.ts";

/**
 * シーンを別のファイルへ移す・ファイルを分ける（POST /scenes/move）。字面の組み立ては model/scene-move.ts。
 * 書き込みはシーンの名前の変更（labels.ts）と同じく、シナリオは書き込み口を通し（変更履歴に残る）、ラベルを持つほかの場所も追従させる:
 * liminalia.json（entry・afterLoad・おまけ・フローチャートの題・変数の初期値）、.liminalia/studio.json の mapPositions と sceneMarks、lim regress の基準の画像、
 * reviews/（移した行のスレッドは移した先の行へ）と .liminalia/studio.json の bookmarks（移した行の印は移した先の行へ）、訳と voice-lock.json の鍵（鍵はファイルと原文から作るので、移した行の鍵は移した先のファイルのものになる）。
 * 途中で書けなくなったら、書き終えたものを元へ戻してから失敗を返す。
 */
export function moveScenes(ws: StudioWorkspace, file: string, labels: readonly string[], to: string): SceneMoveResult {
  ws.path(to); // 名前を確かめる
  if (!ws.files().includes(file)) throw new StudioError(404, `${file}.lim がありません`);
  refuseNotUtf8(ws);
  const names = ws.files();
  const created = !names.includes(to);
  const before = scriptsOf(ws);
  const texts = new Map(names.map((f) => [f, ws.script(f).text] as const));
  const hashes = new Map(names.map((f) => [f, ws.script(f).hash] as const));
  const specOf = specLookup(ws, before.values());
  const variables = targetVariables(before.values());
  const map = ws.storyMap();
  const nexts = new Set(map.edges.filter((e) => e.kind === "next").map((e) => e.from));
  const ends = new Set(map.nodes.filter((n) => n.ends === "end").map((n) => n.id));
  let plan;
  try {
    plan = planSceneMove({
      file,
      labels,
      to,
      texts,
      parse: (text, name) => ws.parseText(name, text),
      specOf,
      variables,
      unique: (label) => uniqueLabel(before.values(), label),
      falls: (f, label) => {
        const id = label === null ? f : `${f}#${label}`;
        return nexts.has(id) ? "next" : ends.has(id) ? "end" : null;
      },
    });
  } catch (e) {
    if (e instanceof SceneMoveError) throw new StudioError(e.status, e.message);
    throw e;
  }
  const moved = [...plan.files.get(to)!.origin.flatMap((o) => (o?.file === file ? [o] : []))];
  const movedLabels = before.get(file)!.body.flatMap((s) => (s.kind === "label" && moved.some((o) => o.line === s.line) ? [s.name] : []));
  const targets: LabelTarget[] = movedLabels.map((name) => ({ file, from: name, to: name, toFile: to }));
  const result: SceneMoveResult = { files: [], lines: plan.lines, config: [], entry: false, translations: [], left: [], created, joins: plan.joins };

  // 移した先から書き、次に元のファイル、ほかのファイルの順に。移した先と元のファイルが書けなければ何も変えない
  const order = [to, file, ...[...plan.files.keys()].filter((f) => f !== to && f !== file)];
  const undo: { name: string; run: () => void }[] = [];
  const remember = (name: string, run: () => void) => void undo.push({ name, run });
  const left: LeftRef[] = [];
  let after: Map<string, Script>;
  try {
    for (const name of order) {
      const p = plan.files.get(name)!;
      const isNew = name === to && created;
      const w = ws.write(name, p.text, isNew ? null : hashes.get(name)!, false);
      if (!w.ok) {
        if (name === to || name === file) throw new StudioError(409, `${name}.lim がほかで変更されたため、保存できませんでした`);
        left.push(...changedLines(texts.get(name)!, p).map((line) => ({ file: name, line, reason: "conflict" as const })));
        plan.files.delete(name);
        continue;
      }
      if (isNew) remember(`${name}.lim`, () => rmSync(ws.path(name), { force: true }));
      else {
        const original = texts.get(name)!;
        remember(`${name}.lim`, () => {
          const back = ws.write(name, original, w.result.hash, false);
          if (!back.ok) throw new StudioError(409, `${name}.lim がほかで変更されました`);
        });
      }
      result.files.push(name);
    }

    after = scriptsOf(ws);
    const origins = new Map([...plan.files].map(([name, p]) => [name, p.origin] as const));
    result.translations = moveTranslationKeys(ws, before, after, origins, remember);
    moveVoiceLockKeys(ws, before, after, origins, remember);
    relocateReviewLines(ws.project, reviewMoves(texts, plan.files), remember);
    for (const t of targets) renameBaselines(ws, t, remember);
    // 台本のテストの `ファイル#ラベル`（from、expect reach、式の飛び先）
    for (const t of targets) {
      const tests = renameInTests(ws, { kind: "label", file: t.file, from: t.from, to: t.to, ...(t.toFile ? { toFile: t.toFile } : {}) }, remember);
      if (tests) result.tests = { files: [...new Set([...(result.tests?.files ?? []), ...tests.files])], left: [...(result.tests?.left ?? []), ...tests.left] };
    }

    const configPath = join(ws.project.root, "liminalia.json");
    const configBefore = readFileSync(configPath, "utf8");
    const config: string[] = [];
    updateConfig(ws, (raw) => {
      for (const t of targets) {
        const unique = uniqueLabel(before.values(), t.from);
        left.push(...leftInConfig(raw, t, variables, unique));
        config.push(...rewriteConfig(raw, t, variables, unique));
      }
      if (config.length === 0) return false;
    });
    if (config.length > 0) {
      remember("liminalia.json", () => {
        writeAtomic(configPath, configBefore);
        ws.variablesChanged();
        ws.targetsChanged();
      });
    }
    result.config = config;
    result.entry = config.includes("entry") || config.includes("afterLoad");
    if (result.entry) ws.targetsChanged();
    const state = readStudioState(ws.project);
    let positions = state.mapPositions;
    let marks = state.sceneMarks;
    for (const t of targets) {
      positions = rewriteMapPositions(positions, t);
      marks = rewriteMapPositions(marks, t);
    }
    // 移した行に付いたブックマークは、移した先の行へ
    const bookmarks = state.bookmarks ? moveBookmarks(state.bookmarks, texts, plan.files) : null;
    if (positions !== state.mapPositions || marks !== state.sceneMarks || bookmarks) {
      writeStudioState(ws.project, { ...state, ...(positions ? { mapPositions: positions } : {}), ...(marks ? { sceneMarks: marks } : {}), ...(bookmarks ? { bookmarks } : {}) });
      remember(".liminalia/studio.json", () => writeStudioState(ws.project, state));
    }
  } catch (e) {
    if (undo.length === 0 && e instanceof StudioError) throw e;
    console.error(e);
    throw new StudioError(409, rollback(undo, "シーンを移せませんでした。.liminalia やシナリオのフォルダに書き込めるか確認してください。"));
  }

  const candidates = targetCandidates(after, { registry: ws.commands, variables: ws.readVariables() });
  const seen = new Set<string>();
  for (const t of targets) {
    for (const l of [...left, ...remainingRefs(after, t, specOf, candidates, variables, uniqueLabel(before.values(), t.from)), ...pluginRefs(ws, t)]) {
      const key = `${l.file}:${l.line}:${l.reason}:${l.config ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.left.push(l);
    }
  }
  return result;
}

/** 行の数が同じファイルで、中身の変わった行。 */
function changedLines(before: string, p: PlannedFile): number[] {
  const old = before.split("\n");
  return p.text.split("\n").flatMap((t, i) => (p.origin[i] && old[p.origin[i]!.line - 1] !== t ? [i + 1] : []));
}

/** 移った行・書き換えた行（コメントのスレッドの付け替えに使う）。 */
function reviewMoves(texts: ReadonlyMap<string, string>, files: ReadonlyMap<string, PlannedFile>): { from: Origin; file: string; line: number; before: string; after: string }[] {
  const lines = new Map([...texts].map(([f, t]) => [f, t.split("\n")] as const));
  const out: { from: Origin; file: string; line: number; before: string; after: string }[] = [];
  for (const [file, p] of files) {
    p.text.split("\n").forEach((after, i) => {
      const o = p.origin[i];
      if (!o) return;
      const before = lines.get(o.file)?.[o.line - 1];
      if (before === undefined) return;
      if (o.file !== file || o.line !== i + 1 || before !== after) out.push({ from: o, file, line: i + 1, before, after });
    });
  }
  return out;
}

/** 行の出どころをたどって、古い鍵 → 新しい鍵（と原文）を作る。 */
function originKeyMoves<T extends { key: string; line: number; source: string }>(before: ReadonlyMap<string, Script>, after: ReadonlyMap<string, Script>, origins: ReadonlyMap<string, readonly (Origin | null)[]>, collect: (s: Script) => readonly T[]): { moves: Map<string, { key: string; source: string }>; live: Set<string> } {
  const old = new Map<string, Map<number, T>>();
  const moves = new Map<string, { key: string; source: string }>();
  const live = new Set<string>();
  for (const script of after.values()) for (const x of collect(script)) live.add(x.key);
  for (const [file, origin] of origins) {
    const next = after.get(file);
    if (!next) continue;
    for (const x of collect(next)) {
      const o = origin[x.line - 1];
      if (!o) continue;
      let table = old.get(o.file);
      if (!table) {
        const script = before.get(o.file);
        table = new Map((script ? collect(script) : []).map((y) => [y.line, y] as const));
        old.set(o.file, table);
      }
      const prev = table.get(o.line);
      if (prev && prev.key !== x.key && !moves.has(prev.key)) moves.set(prev.key, { key: x.key, source: x.source });
    }
  }
  return { moves, live };
}

/** 鍵を付け替えた表（新しい鍵に訳が無ければ写し、古い鍵がもう使われていなければ外す）。 */
function moveTable<E>(table: Record<string, E> | undefined, moves: ReadonlyMap<string, { key: string; source: string }>, live: ReadonlySet<string>, withSource: (e: E, source: string) => E): Record<string, E> | undefined {
  if (!table) return table;
  const out: Record<string, E> = { ...table };
  for (const [k, m] of moves) {
    const e = table[k];
    if (e === undefined) continue;
    if (!(m.key in out)) out[m.key] = withSource(e, m.source);
    if (!live.has(k)) delete out[k];
  }
  return out;
}

function moveTranslationKeys(ws: StudioWorkspace, before: ReadonlyMap<string, Script>, after: ReadonlyMap<string, Script>, origins: ReadonlyMap<string, readonly (Origin | null)[]>, remember: (name: string, undo: () => void) => void): string[] {
  const dir = ws.project.paths.lang;
  if (!existsSync(dir)) return [];
  const { moves, live } = originKeyMoves(before, after, origins, collectTranslatable);
  if (moves.size === 0) return [];
  const changed: string[] = [];
  const withSource = (e: TranslationEntry, source: string): TranslationEntry => ({ ...e, source });
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const path = join(dir, name);
    let file: TranslationFile;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
      file = JSON.parse(raw) as TranslationFile;
    } catch {
      continue;
    }
    const next = { ...file, ...(file.lines ? { lines: moveTable(file.lines, moves, live, withSource) } : {}) };
    if (JSON.stringify(next) === JSON.stringify(file)) continue;
    writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
    remember(`lang/${name}`, () => writeAtomic(path, raw));
    changed.push(name.replace(/\.json$/, ""));
  }
  return changed;
}

function moveVoiceLockKeys(ws: StudioWorkspace, before: ReadonlyMap<string, Script>, after: ReadonlyMap<string, Script>, origins: ReadonlyMap<string, readonly (Origin | null)[]>, remember: (name: string, undo: () => void) => void): void {
  const path = ws.project.paths.voiceLock;
  if (!existsSync(path)) return;
  const { moves, live } = originKeyMoves(before, after, origins, voiceLines);
  if (moves.size === 0) return;
  let lock: VoiceLock;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
    lock = JSON.parse(raw) as VoiceLock;
  } catch {
    return;
  }
  const withSource = (e: VoiceLockEntry, source: string): VoiceLockEntry => ({ ...e, source });
  const next: VoiceLock = { ...lock, lines: moveTable(lock.lines, moves, live, withSource)! };
  if (JSON.stringify(next) !== JSON.stringify(lock)) {
    writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
    remember("voice-lock.json", () => writeAtomic(path, raw));
  }
}
