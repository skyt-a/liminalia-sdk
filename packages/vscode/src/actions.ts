import { applyFix, applyLinesFix, defineSpec, formatLim, NAME_PATTERN, parse, parseTargetText, renameInData, resolveTargetText, targetSiteAt, type CommandSpec, type DataDeclaration, type DiagnosticFix, type Statement, type TranslationFile, type VoiceLock } from "@liminalia/lang";
import { baselineRenames, jsonIndent, moveReviewThreads, moveTranslationFile, moveVoiceLock, translationMoves, voiceLockMoves, type MovedLine } from "@liminalia/editor/label-follow";
import { rewriteConfig, rewriteMapPositions, rewriteScript, targetVariables, uniqueLabel, type LabelTarget } from "@liminalia/editor/label-rename";
import type { ReviewThread } from "@liminalia/editor/protocol";
import type { CodeAction, Diagnostic as LspDiagnostic, Position, Range, TextEdit, WorkspaceEdit } from "vscode-languageserver";
import { walk, type LimProject } from "./model.ts";

/**
 * 整形（lim fmt と同じ formatLim）・Quick Fix（診断の直し方 DiagnosticFix）・ラベルの名前の変更（制作画面のシーンの名前の変更と同じ
 * label-rename.ts）・ここからテストプレイの位置。LimProject（ファイルに触らないプロジェクト）から LSP の形で求める。
 */

const range = (line: number, start: number, end: number): Range => ({ start: { line, character: start }, end: { line, character: end } });

/** 画面の言葉（VS Code の表示の言語で選ぶ）。 */
export type Lang = "ja" | "en";
const T = {
  deleteLine: { ja: "この行を削除", en: "Delete this line" },
  replace: { ja: (a: string, b: string) => `「${a}」を「${b}」に修正`, en: (a: string, b: string) => `Change "${a}" to "${b}"` },
  remove: { ja: (a: string) => `「${a}」を削除`, en: (a: string) => `Remove "${a}"` },
  replaceLines: { ja: (n: number, b: string) => `${n} 行を「${b}」にまとめる`, en: (n: number, b: string) => `Merge ${n} lines into "${b}"` },
  badName: { ja: (n: string) => `シーン名「${n}」は使えません。文字、数字、_、- で入力してください`, en: (n: string) => `"${n}" can't be used as a scene name. Use letters, digits, _ and -` },
  taken: { ja: (n: string, f: string) => `シーン #${n} はすでに ${f}.lim にあります`, en: (n: string, f: string) => `Scene #${n} already exists in ${f}.lim` },
  twice: { ja: (n: string, f: string) => `シーン #${n} が ${f}.lim に二つ以上あります。先に一つにしてください`, en: (n: string, f: string) => `Scene #${n} appears more than once in ${f}.lim. Make it one first` },
  notLabel: { ja: "ここにはシーン（ラベル）がありません", en: "There is no scene (label) here" },
};

// ---- 整形 ----

/** 整形した全体（変わらなければ空）。構文エラーがあれば理由。 */
export function formatEdits(project: LimProject, file: string, text: string): { edits: TextEdit[] } | { error: string } {
  // 字下げは liminalia.json の format.indent（決めていなければ変えない）
  const indent = project.input.config?.indent;
  const r = formatLim(text, file, { registry: project.registry, speakers: project.input.speakers, ...(indent === "tab" || typeof indent === "number" ? { indent } : {}), ...(project.input.config?.formatExpressions === false ? { expressions: false } : {}) });
  if (!r.ok) return { error: r.reason };
  if (!r.changed) return { edits: [] };
  const lines = text.split("\n");
  return { edits: [{ range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } }, newText: r.text }] };
}

// ---- Quick Fix ----

/** 診断に添える直し方（toLspDiagnostic が data に入れる）。 */
export interface FixData {
  fix: DiagnosticFix;
  column?: number;
}

/** カーソルの範囲の診断のうち、直し方のあるものを Quick Fix にする。当てられない（そのあとで行が変わった）ものは出さない。 */
export function quickFixes(project: LimProject, file: string, uri: string, diagnostics: readonly LspDiagnostic[], lang: Lang): CodeAction[] {
  const lines = project.lines(file);
  const out: CodeAction[] = [];
  for (const d of diagnostics) {
    const data = d.data as FixData | undefined;
    if (!data?.fix || d.source !== "lim") continue;
    const line = d.range.start.line;
    if (data.fix.kind === "replace-lines") {
      // 何行かを一行にまとめる（@mask の塊を @scene-change に）
      const m = applyLinesFix(lines, line, data.fix);
      if (!m) continue;
      const last = line + m.count - 1;
      out.push({ title: T.replaceLines[lang](m.count, data.fix.with), kind: "quickfix", diagnostics: [d], isPreferred: true, edit: { changes: { [uri]: [{ range: { start: { line, character: 0 }, end: { line: last, character: (lines[last] ?? "").length } }, newText: m.text }] } } });
      continue;
    }
    const r = applyFix(lines[line] ?? "", data.fix, data.column);
    if (!r) continue;
    const edit: TextEdit = r.remove ? { range: { start: { line, character: 0 }, end: { line: line + 1, character: 0 } }, newText: "" } : { range: range(line, r.at, r.at + r.length), newText: data.fix.kind === "replace" ? data.fix.with : "" };
    out.push({
      title: data.fix.kind === "delete-line" ? T.deleteLine[lang] : data.fix.with.trim() === "" ? T.remove[lang](data.fix.find.trim()) : T.replace[lang](data.fix.find, data.fix.with),
      kind: "quickfix",
      diagnostics: [d],
      isPreferred: true,
      edit: { changes: { [uri]: [edit] } },
    });
  }
  return out;
}

// ---- ラベルの名前の変更 ----

/** カーソルのあるラベル: ラベルの行の名前か、ラベルを指すジャンプ先。名前の範囲と、どのファイルのラベルか。 */
export function labelAt(project: LimProject, file: string, pos: Position): { range: Range; file: string; label: string } | null {
  const lines = project.lines(file);
  const text = lines[pos.line] ?? "";
  const own = project.labels(file).find((l) => l.line - 1 === pos.line);
  if (own) {
    const at = text.indexOf(own.name, text.indexOf("#"));
    if (at >= 0 && pos.character >= at && pos.character <= at + own.name.length) return { range: range(pos.line, at, at + own.name.length), file, label: own.name };
  }
  const site = targetSiteAt(lines, pos.line, pos.character, (name) => specOf(project, file, name));
  if (!site) return null;
  const t = parseTargetText(site.text);
  const place = resolveTargetText(site.text, file, { has: (f) => project.input.files.has(f), labels: (f) => project.labels(f) });
  if (!t?.label || !place?.label) return null;
  const at = site.start + site.text.lastIndexOf(t.label);
  return { range: range(pos.line, at, at + t.label.length), file: place.file, label: place.label };
}

/** 命令の仕様（組み込み・プラグイン、そのファイルで呼べる @define、作品のどこかの @define）。 */
export function specOf(project: LimProject, file: string, name: string): CommandSpec | undefined {
  return project.registry.get(name) ?? project.visibleDefines(file).get(name)?.spec ?? project.findDefine(name)?.spec;
}

/** 名前の変更で書き換えるかもしれないファイル（URI と今の中身）。 */
export interface TextFile {
  uri: string;
  text: string;
}

/**
 * 名前の変更で、台本のほかに付け替えるもの（言語サーバーがディスクか開いている中身から読んで渡す）。制作画面のシーンの名前の変更
 * （packages/studio の server/labels.ts）が付け替えるものと同じ。
 */
export interface RenameFiles {
  /** liminalia.json（entry・afterLoad・おまけの飛び先・飛び先に使う変数の初期値）。 */
  config?: TextFile;
  /** 訳のファイル（lang/<言語>.json）。 */
  translations?: readonly TextFile[];
  /** ボイスの番号の固定（voice-lock.json）。 */
  voiceLock?: TextFile;
  /** レビューのコメント（reviews/<id>.json）。 */
  reviews?: readonly TextFile[];
  /** 制作画面の覚え書き（.liminalia/studio.json。フローチャートのカードの位置）。 */
  studioState?: TextFile;
  /** lim regress の基準の画像のフォルダ（.liminalia/regress/baseline の URI。末尾の / なし）と、その中のファイルの名前。 */
  baselines?: { folder: string; names: readonly string[] };
  /** プラグインが形を宣言した作品のデータ（data/*.json）。 */
  data?: readonly { decl: DataDeclaration; file: TextFile }[];
}

/** 全体を置き換える編集。 */
function whole(text: string, newText: string): TextEdit {
  const lines = text.split("\n");
  return { range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } }, newText };
}

const json = (value: unknown, indent: string | number = 2) => `${JSON.stringify(value, null, indent)}\n`;

function readJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * ラベルの名前を変える編集（制作画面のシーンの名前の変更と同じ書き換え）。台本はどれも変えた行だけを置き換え、
 * liminalia.json の entry・afterLoad・おまけの飛び先、訳の鍵、ボイスの番号の固定、レビューのコメント、フローチャートのカードの位置、
 * 作品のデータの中の飛び先（files に今の中身を渡したもの）は全体を書き直し、lim regress の基準の画像は名前を変える。
 */
export function renameLabelEdit(project: LimProject, file: string, pos: Position, to: string, lang: Lang, files: RenameFiles = {}): { edit: WorkspaceEdit } | { error: string } {
  const at = labelAt(project, file, pos);
  if (!at) return { error: T.notLabel[lang] };
  if (!NAME_PATTERN.test(to)) return { error: T.badName[lang](to) };
  const labels = project.labels(at.file).map((l) => l.name);
  if (labels.filter((l) => l === at.label).length > 1) return { error: T.twice[lang](at.label, at.file) };
  if (to !== at.label && labels.includes(to)) return { error: T.taken[lang](to, at.file) };
  const changes: Record<string, TextEdit[]> = {};
  if (to === at.label) return { edit: { changes } };
  const scripts = project.scripts();
  const defines = new Map<string, CommandSpec>();
  for (const s of scripts.values()) {
    walk(s.body, (st) => {
      if (st.kind !== "define") return;
      const spec = defineSpec(st);
      if (spec) defines.set(st.name, spec);
    });
  }
  const lookup = (name: string) => project.registry.get(name) ?? defines.get(name);
  const t: LabelTarget = { file: at.file, from: at.label, to };
  const variables = targetVariables(scripts.values());
  const unique = uniqueLabel(scripts.values(), at.label);
  const after = new Map(scripts);
  const moved: MovedLine[] = [];
  for (const [name, script] of scripts) {
    const source = project.input.files.get(name)!;
    const r = rewriteScript(source.text, script, t, lookup, variables, unique);
    if (r.changed.length === 0) continue;
    const lines = r.text.split("\n");
    changes[source.uri] = r.changed.map((c) => {
      const before = source.text.split("\n")[c.line - 1] ?? "";
      return { range: range(c.line - 1, 0, before.length), newText: lines[c.line - 1] ?? "" };
    });
    after.set(name, parse(r.text, name, { speakers: project.input.speakers }));
    moved.push(...r.changed.map((c) => ({ file: name, ...c })));
  }
  const put = (f: TextFile, next: string) => {
    if (next !== f.text) changes[f.uri] = [whole(f.text, next)];
  };
  const { config } = files;
  if (config) {
    // 読めない liminalia.json は書き換えない（検査が知らせる）
    const raw = readJson<Record<string, unknown>>(config.text);
    if (raw && rewriteConfig(raw, t, variables, unique).length > 0) put(config, json(raw));
  }
  // 本文の中の {@…} を書き換えた行は、原文から作る鍵が変わる
  const moves = translationMoves(scripts, after);
  for (const f of files.translations ?? []) {
    const raw = readJson<TranslationFile>(f.text);
    const next = raw && moveTranslationFile(raw, moves, t, lookup);
    if (next) put(f, json(next));
  }
  if (files.voiceLock) {
    const raw = readJson<VoiceLock>(files.voiceLock.text);
    const next = raw && moveVoiceLock(raw, voiceLockMoves(scripts, after));
    if (next) put(files.voiceLock, json(next));
  }
  const reviews = (files.reviews ?? []).flatMap((f) => {
    const raw = readJson<ReviewThread>(f.text);
    return raw && typeof raw.id === "string" && typeof raw.file === "string" && typeof raw.line === "number" && typeof raw.text === "string" ? [{ f, raw }] : [];
  });
  for (const next of moveReviewThreads(reviews.map((r) => r.raw), moved)) put(reviews.find((r) => r.raw.id === next.id)!.f, json(next));
  if (files.studioState) {
    const raw = readJson<{ mapPositions?: Record<string, unknown> }>(files.studioState.text);
    const positions = raw && rewriteMapPositions(raw.mapPositions, t);
    if (raw && positions !== raw.mapPositions) put(files.studioState, json({ ...raw, mapPositions: positions }));
  }
  for (const { decl, file: f } of files.data ?? []) {
    const raw = readJson<unknown>(f.text);
    if (raw === null) continue;
    const r = renameInData(decl, raw, { kind: "label", file: t.file, from: t.from, to: t.to });
    if (r.count > 0) put(f, `${JSON.stringify(r.value, null, jsonIndent(f.text))}${f.text.endsWith("\n") ? "\n" : ""}`);
  }
  const renames = files.baselines ? [...baselineRenames(files.baselines.names, t)] : [];
  if (renames.length === 0) return { edit: { changes } };
  // ファイルの名前の変更があるときは documentChanges で（編集と名前の変更を一つの編集にする）
  const folder = files.baselines!.folder;
  const documentChanges: WorkspaceEdit["documentChanges"] = [
    ...Object.entries(changes).map(([uri, edits]) => ({ textDocument: { uri, version: null }, edits })),
    ...renames.map(([from, name]) => ({ kind: "rename" as const, oldUri: `${folder}/${encodeURIComponent(from)}`, newUri: `${folder}/${encodeURIComponent(name)}`, options: { ignoreIfExists: true } })),
  ];
  return { edit: { documentChanges } };
}

// ---- ここからテストプレイ ----

/**
 * カーソルの行からテストプレイする位置: カーソルのあるシーン（ラベル。無ければファイルの頭）と、そこからカーソルの行までのページの数
 * （プレイヤーの ?start= と ?skip=。シーンの頭から空の状態で始めて、その数のページまで早送りする）。
 */
export function playTarget(project: LimProject, file: string, line: number): { start: string; skip: number } | null {
  const script = project.script(file);
  if (!script) return null;
  const cursor = line + 1;
  const label = project
    .labels(file)
    .filter((l) => l.line <= cursor)
    .at(-1);
  let skip = 0;
  // マクロ（@define）の中の本文は、書いた所では出ないので数えない
  const visit = (body: readonly Statement[]) => {
    for (const s of body) {
      if ((s.kind === "say" || s.kind === "prose") && s.line > (label?.line ?? 0) && s.line <= cursor) skip++;
      if (s.kind === "if") for (const b of s.branches) visit(b.body);
    }
  };
  visit(script.body);
  return { start: label ? `${file}#${label.name}` : file, skip };
}
