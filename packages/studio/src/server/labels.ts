import { renameInDeclaredData } from "./data-rename.ts";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { defineSpec, NAME_PATTERN, targetCandidates, type CommandSpec, type Script, type Statement, type TranslationFile, type VoiceLock } from "@liminalia/lang";
import { baselineRenames, moveTranslationFile, moveVoiceLock, translationMoves, voiceLockMoves } from "@liminalia/editor/label-follow";
import { leftInConfig, remainingRefs, retarget, rewriteConfig, rewriteMapPositions, rewriteScript, targetVariables, uniqueLabel, type LabelTarget, type LeftRef, type SpecOf } from "@liminalia/editor/label-rename";
import type { LabelRenameResult } from "../protocol.ts";
import { refuseNotUtf8, updateConfig, writeConfigText } from "./manage-shared.ts";
import { moveReviewLines } from "./reviews.ts";
import { readStudioState, writeStudioState } from "./studio-state.ts";
import { renameInTests } from "./test-rename.ts";
import { rollback, type Remember } from "./undo.ts";
import { textStep } from "./file-undo.ts";
import { StudioError, writeAtomic, type StudioWorkspace } from "./workspace.ts";

export { rollback };

/**
 * シーン（ラベル）の名前を変える（POST /labels/rename）。ラベルの行と全シナリオの参照を書き込み口を通して書き換え（変更履歴に残る）、
 * ラベルを持つほかの場所も追従させる:
 * - liminalia.json の entry・afterLoad・extra.replay・extra.chapters・extra.flowchart.titles・飛び先に使う変数の初期値
 * - .liminalia/studio.json の mapPositions と sceneMarks（鍵が `ファイル#ラベル`）
 * - .liminalia/regress/baseline の基準の画像（名前が `ファイル_ラベル.png`）
 * - reviews/（書き換えた行に付いたスレッドの行の中身）
 * - 訳の鍵と voice-lock.json の鍵は ファイルと原文から作るのでラベルを持たないが、本文の中の `{@…}` の飛び先を書き換えると原文が変わるので、その行の分だけ付け替える
 * セーブ・変更履歴はファイルと命令の番号、既読はファイルとページの鍵（話者と本文から作る）で持つので、ラベルの名前には関わらない。
 * 途中で書けなくなったら、書き終えたものを元の内容へ書き戻してから失敗を返す（シナリオは書き込み口を通すので、書き戻しも変更履歴に残る）。
 */

function walk(body: readonly Statement[], fn: (s: Statement) => void): void {
  for (const s of body) {
    fn(s);
    if (s.kind === "if") for (const b of s.branches) walk(b.body, fn);
    if (s.kind === "define") walk(s.body, fn);
  }
}

/** 組み込み・プラグインの命令と、@define の仕様（@define の名前はプロジェクトで一つ）。 */
export function specLookup(ws: StudioWorkspace, scripts: Iterable<Script>): SpecOf {
  const defines = new Map<string, CommandSpec>();
  for (const script of scripts) {
    walk(script.body, (s) => {
      if (s.kind !== "define") return;
      const spec = defineSpec(s);
      if (spec) defines.set(s.name, spec);
    });
  }
  return (name) => ws.commands.get(name) ?? defines.get(name);
}

export const scriptsOf = (ws: StudioWorkspace) => new Map(ws.files().map((f) => [f, ws.script(f).script] as const));

export function renameLabel(ws: StudioWorkspace, file: string, from: string, to: string): LabelRenameResult {
  if (!ws.files().includes(file)) throw new StudioError(404, `${file}.lim がありません`);
  if (!NAME_PATTERN.test(to)) throw new StudioError(400, `シーン名「${to}」は使えません。文字、数字、_、- で入力してください`);
  const own = ws.script(file).script;
  const labels: string[] = [];
  walk(own.body, (s) => {
    if (s.kind === "label") labels.push(s.name);
  });
  const found = labels.filter((l) => l === from).length;
  if (found === 0) throw new StudioError(404, `${file}.lim にシーン #${from} がありません`);
  if (found > 1) throw new StudioError(409, `シーン #${from} が ${file}.lim に ${found} か所あります。先に一つにしてください`);
  const empty: LabelRenameResult = { files: [], lines: 0, config: [], entry: false, translations: [], left: [] };
  if (from === to) return empty;
  if (labels.includes(to)) throw new StudioError(409, `シーン #${to} はすでに ${file}.lim にあります`);
  refuseNotUtf8(ws);

  const t: LabelTarget = { file, from, to };
  const before = scriptsOf(ws);
  const specOf = specLookup(ws, before.values());
  const variables = targetVariables(before.values());
  const unique = uniqueLabel(before.values(), from);
  const result: LabelRenameResult = { ...empty, files: [], config: [], translations: [], left: [] };

  // 先に全部作ってから書く。名前を変えるファイルから書き、書けなければ何も変えない
  const planned = ws.files().flatMap((name) => {
    const { text, hash } = ws.script(name);
    const r = rewriteScript(text, before.get(name)!, t, specOf, variables, unique);
    return r.text === text ? [] : [{ name, hash, original: text, ...r }];
  });
  planned.sort((a, b) => Number(b.name === file) - Number(a.name === file));
  const moved: { file: string; line: number; before: string; after: string }[] = [];
  const left: LeftRef[] = [];
  /** 書き終えたものを元へ戻す手順（新しい順に行う）。 */
  const undo: { name: string; run: () => void }[] = [];
  const remember = (name: string, run: () => void) => void undo.push({ name, run });
  let after: Map<string, Script>;
  try {
    for (const p of planned) {
      const w = ws.write(p.name, p.text, p.hash, false);
      if (!w.ok) {
        if (p.name === file) throw new StudioError(409, `${file}.lim がほかで変更されたため、保存できませんでした`);
        left.push(...p.changed.map((c) => ({ file: p.name, line: c.line, reason: "conflict" as const })));
        continue;
      }
      remember(`${p.name}.lim`, () => {
        const back = ws.write(p.name, p.original, w.result.hash, false);
        if (!back.ok) throw new StudioError(409, `${p.name}.lim がほかで変更されました`);
      });
      result.files.push(p.name);
      result.lines += p.changed.length;
      moved.push(...p.changed.map((c) => ({ file: p.name, ...c })));
    }

    // 本文の中の {@…} を書き換えた行は、原文から作る鍵が変わる
    after = scriptsOf(ws);
    result.translations = moveTranslationKeys(ws, before, after, t, specOf, remember);
    moveVoiceLockKeys(ws, before, after, remember);
    moveReviewLines(ws.project, moved, remember);
    renameBaselines(ws, t, remember);
    // プラグインが形を宣言した作品のデータの中の飛び先
    const data = renameInDeclaredData(ws, { kind: "label", file, from, to }, remember);
    if (data.length > 0) result.data = data;
    // 台本のテスト（from と expect reach の `ファイル#ラベル`、式の飛び先）
    const tests = renameInTests(ws, { kind: "label", file, from, to }, remember);
    if (tests) result.tests = tests;

    // 設定と覚え書き（中身が変わるときだけ書く）
    const configPath = join(ws.project.root, "liminalia.json");
    const configBefore = readFileSync(configPath, "utf8");
    let config: string[] = [];
    updateConfig(ws, (raw) => {
      left.push(...leftInConfig(raw, t, variables, unique));
      config = rewriteConfig(raw, t, variables, unique);
      if (config.length === 0) return false;
    });
    if (config.length > 0) {
      const configAfter = readFileSync(configPath, "utf8");
      // 書き戻しも変更履歴を通す（書き換えた中身を履歴に残す）。書いたあとにほかで変わっていれば戻さない
      remember("liminalia.json", () => {
        if (readFileSync(configPath, "utf8") !== configAfter) throw new StudioError(409, "liminalia.json がほかで変更されました");
        writeConfigText(ws, configBefore);
        ws.variablesChanged();
        ws.targetsChanged();
      });
    }
    result.config = config;
    result.entry = config.includes("entry") || config.includes("afterLoad");
    if (result.entry) ws.targetsChanged();
    const state = readStudioState(ws.project);
    const positions = rewriteMapPositions(state.mapPositions, t);
    const marks = rewriteMapPositions(state.sceneMarks, t);
    if (positions !== state.mapPositions || marks !== state.sceneMarks) {
      writeStudioState(ws.project, { ...state, ...(positions ? { mapPositions: positions } : {}), ...(marks ? { sceneMarks: marks } : {}) });
      remember(".liminalia/studio.json", () => writeStudioState(ws.project, state));
    }
  } catch (e) {
    // 何も書く前なら理由をそのまま返す（名前を変えるファイルがほかで変わっていたときなど）
    if (undo.length === 0 && e instanceof StudioError) throw e;
    console.error(e);
    throw new StudioError(409, rollback(undo));
  }

  // 残った参照（書き換えられなかったもの）
  const candidates = targetCandidates(after, { registry: ws.commands, variables: ws.readVariables() });
  const seen = new Set<string>();
  for (const l of [...left, ...remainingRefs(after, t, specOf, candidates, variables, unique), ...pluginRefs(ws, t)]) {
    const key = `${l.file}:${l.line}:${l.reason}:${l.config ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.left.push(l);
  }
  return result;
}

/** プラグインの命令が教える行き先（作品のデータから決まるものは書き換えられない）。 */
export function pluginRefs(ws: StudioWorkspace, t: LabelTarget): LeftRef[] {
  const out: LeftRef[] = [];
  for (const [at, targets] of ws.promised()) {
    const colon = at.lastIndexOf(":");
    const file = at.slice(0, colon);
    if (targets.some((x) => retarget(x, file, t) !== null)) out.push({ file, line: Number(at.slice(colon + 1)), reason: "plugin" });
  }
  return out;
}

/** 訳の鍵を付け替える（訳文の中の {@…} の飛び先も書き換え、名前を変えたラベルの場面ごとの訳の名前も替える）。書き換えた言語を返す。 */
function moveTranslationKeys(ws: StudioWorkspace, before: ReadonlyMap<string, Script>, after: ReadonlyMap<string, Script>, t: LabelTarget, specOf: SpecOf, remember: (name: string, undo: () => void) => void): string[] {
  const dir = ws.project.paths.lang;
  if (!existsSync(dir)) return [];
  const moves = translationMoves(before, after);
  const changed: string[] = [];
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
    const next = moveTranslationFile(file, moves, t, specOf);
    if (!next) continue;
    writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
    remember(`lang/${name}`, () => writeAtomic(path, raw));
    changed.push(name.replace(/\.json$/, ""));
  }
  return changed;
}

/** 番号の固定（voice-lock.json）の鍵を、同じ行の新しい鍵へ付け替える（行の数を変えない書き換えのあと。話者の名前の変更にも使う）。 */
export function moveVoiceLockKeys(ws: StudioWorkspace, before: ReadonlyMap<string, Script>, after: ReadonlyMap<string, Script>, remember: Remember): void {
  const path = ws.project.paths.voiceLock;
  if (!existsSync(path)) return;
  const moves = voiceLockMoves(before, after);
  if (moves.size === 0) return;
  let lock: VoiceLock;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
    lock = JSON.parse(raw) as VoiceLock;
  } catch (e) {
    // 飛ばすとボイスの番号が古い行の鍵のまま残り、黙って使われなくなる。止めて、呼ぶ側の withRollback に書いたものを戻させる
    throw new StudioError(400, `voice-lock.json を読めないので、変更に合わせてボイスの番号を付け替えられません。voice-lock.json を直してから、もう一度変更してください（${e instanceof Error ? e.message : String(e)}）`);
  }
  const next = moveVoiceLock(lock, moves);
  if (next) {
    const text = `${JSON.stringify(next, null, 2)}\n`;
    writeAtomic(path, text);
    const step = textStep("voice-lock.json", path, raw, text);
    remember("voice-lock.json", () => writeAtomic(path, raw), step);
  }
}

/** lim regress の基準の画像の名前を付け替える（名前の付け方は cli の regress.ts の fileOf と同じ）。 */
export function renameBaselines(ws: StudioWorkspace, t: LabelTarget, remember: (name: string, undo: () => void) => void): void {
  const dir = join(ws.project.root, ".liminalia", "regress", "baseline");
  if (!existsSync(dir)) return;
  for (const [f, to] of baselineRenames(readdirSync(dir), t)) {
    const dest = join(dir, to);
    if (existsSync(dest)) continue;
    renameSync(join(dir, f), dest);
    remember(`.liminalia/regress/baseline/${f}`, () => renameSync(dest, join(dir, f)));
  }
}
