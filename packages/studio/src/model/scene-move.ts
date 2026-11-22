import type { Script, Statement } from "@liminalia/lang";
import { rewriteScript, type LabelTarget, type SpecOf } from "@liminalia/editor/label-rename";

/**
 * シーンを別のファイルへ移す・ファイルを分けるときの、.lim の字面の組み立て（画面なし・ファイルなし）。開発サーバーの server/scene-move.ts が使う。
 *
 * - 移すシーンは、ファイルの中で続いたもの（ファイルを分けるときは、選んだシーンから最後まで）。移した先のファイルの終わりに足す
 * - 移したシーンの中の `#ラベル` のうち、元のファイルに残るシーンを指すものは `元のファイル#ラベル` にする
 * - 作品の中の、移したシーンを指すジャンプ先（`@jump`・`@call`・選択肢・式の候補・ジャンプ先の型のパラメータ・ジャンプ先に使う変数へ入れる文字列）は
 *   シーンの名前の変更と同じ仕組み（label-rename.ts）で移した先を指すようにする
 * - 流れを変えない: 移したシーンへそのまま続いていたシーンには `@jump 移した先#シーン` を、移したシーンの最後が次のシーンへ続いていたなら
 *   `@jump 元のファイル#次のシーン` を、移した先のファイルの最後がファイルの終わりで止まっていたなら `@stop` を足す（足した行は joins で返す）
 * - 元のファイルの `@use` と、移したシーンが呼ぶ元のファイルのマクロ（`@use 元のファイル`）を、移した先の頭に足す
 */

/** シーン（一番外側のラベルから次のラベルの前まで）。ファイルの頭は label が null。行は 1 から数え、end を含む。 */
export interface SceneSection {
  label: string | null;
  start: number;
  end: number;
}

export function sceneSections(script: Script, lineCount: number): SceneSection[] {
  const labels = script.body.filter((s): s is Extract<Statement, { kind: "label" }> => s.kind === "label");
  const out: SceneSection[] = [{ label: null, start: 1, end: (labels[0]?.line ?? lineCount + 1) - 1 }];
  labels.forEach((l, i) => out.push({ label: l.name, start: l.line, end: (labels[i + 1]?.line ?? lineCount + 1) - 1 }));
  return out;
}

/** 行と、その行がどのファイルの何行目から来たか（足した行は null）。 */
export interface Origin {
  file: string;
  line: number;
}
export interface PlannedFile {
  text: string;
  /** 行ごとの出どころ（行の数は text と同じ）。 */
  origin: (Origin | null)[];
}

/** シーンの終わり方（フローチャートと同じ見方）。next は次のシーンへ続く、end はファイルの終わりで止まる、null はほかへ移るか止まる。 */
export type Falls = (file: string, label: string | null) => "next" | "end" | null;

export interface SceneMoveInput {
  file: string;
  labels: readonly string[];
  to: string;
  /** 全シナリオの今の字面（移した先が新しいファイルなら、そのファイルは無い）。 */
  texts: ReadonlyMap<string, string>;
  parse(text: string, file: string): Script;
  specOf: SpecOf;
  /** 式のジャンプ先に使う変数（targetVariables）。 */
  variables: ReadonlySet<string>;
  /** そのラベルと同じ名前のラベルが作品に一つだけか（uniqueLabel）。 */
  unique(label: string): boolean;
  falls: Falls;
}

export interface SceneMoveOutput {
  /** 書き換えるファイル（新しいファイルを含む）。 */
  files: Map<string, PlannedFile>;
  /** 流れを変えないために足した行（書いたあとの行番号）。 */
  joins: { file: string; line: number; text: string }[];
  /** ジャンプ先を書き換えた行の数。 */
  lines: number;
}

/** 断るとき（status は HTTP の番号）。 */
export class SceneMoveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Row = { text: string; origin: Origin | null };

/** 範囲の中の、最後の空でない行の位置（rows の添え字。無ければ from - 1）。 */
function lastFilled(rows: readonly Row[], from: number, to: number): number {
  for (let i = to; i >= from; i--) if (rows[i]!.text.trim() !== "") return i;
  return from - 1;
}

function walk(body: readonly Statement[], fn: (s: Statement) => void): void {
  for (const s of body) {
    fn(s);
    if (s.kind === "if") for (const b of s.branches) walk(b.body, fn);
    if (s.kind === "define") walk(s.body, fn);
  }
}

/** 字面を書き換える（行の数は変えない）。書き換えた行の数を返す。 */
function rewriteRows(rows: Row[], file: string, t: LabelTarget, input: SceneMoveInput): number {
  const text = rows.map((r) => r.text).join("\n");
  if (!text.includes(`#${t.from}`)) return 0;
  const r = rewriteScript(text, input.parse(text, file), t, input.specOf, input.variables, input.unique(t.from));
  if (r.changed.length === 0) return 0;
  const next = r.text.split("\n");
  rows.forEach((row, i) => (row.text = next[i]!));
  return r.changed.length;
}

export function planSceneMove(input: SceneMoveInput): SceneMoveOutput {
  const { file, to } = input;
  if (file === to) throw new SceneMoveError(400, "同じファイルへは移せません");
  const sourceText = input.texts.get(file);
  if (sourceText === undefined) throw new SceneMoveError(404, `${file}.lim がありません`);
  const sourceLines = sourceText.split("\n");
  const sourceScript = input.parse(sourceText, file);
  const sections = sceneSections(sourceScript, sourceLines.length);
  if (input.labels.length === 0) throw new SceneMoveError(400, "移すシーンを選んでください");
  const picked = new Set(input.labels);
  for (const name of picked) {
    const n = sections.filter((s) => s.label === name).length;
    if (n === 0) throw new SceneMoveError(404, `${file}.lim にシーン #${name} がありません`);
    if (n > 1) throw new SceneMoveError(409, `シーン #${name} が ${file}.lim に ${n} か所あります。先に一つにしてください`);
  }
  const at = sections.flatMap((s, i) => (s.label !== null && picked.has(s.label) ? [i] : []));
  const first = at[0]!;
  const last = at.at(-1)!;
  if (last - first + 1 !== at.length) throw new SceneMoveError(400, "連続したシーンを選んでください");
  const moved = sections.slice(first, last + 1).map((s) => s.label!);
  const destText = input.texts.get(to);
  if (destText !== undefined) {
    const destLabels = sceneSections(input.parse(destText, to), destText.split("\n").length).map((s) => s.label);
    const clash = moved.find((name) => destLabels.includes(name));
    if (clash) throw new SceneMoveError(409, `シーン #${clash} はすでに ${to}.lim にあります。先に名前を変更してください`);
  }

  let lines = 0;
  const joins: { file: string; text: string; row: Row }[] = [];
  const join = (where: string, text: string): Row => {
    const row = { text, origin: null };
    joins.push({ file: where, text, row });
    return row;
  };

  // 移すシーンの行。中の `#ラベル` のうち、元のファイルに残るシーンを指すものは `元のファイル#ラベル` に
  const rowsOf = (text: string, name: string): Row[] => text.split("\n").map((t, i) => ({ text: t, origin: { file: name, line: i + 1 } }));
  const all = rowsOf(sourceText, file);
  const block = all.slice(sections[first]!.start - 1, sections[last]!.end);
  for (const s of sections) {
    if (s.label === null) continue;
    lines += rewriteRows(block, file, { file, from: s.label, to: s.label, toFile: picked.has(s.label) ? to : file, outFile: to }, input);
  }
  // 最後のシーンが次のシーンへ続いていたなら、そこへ移る行を足す
  const after = sections[last + 1];
  if (after && input.falls(file, sections[last]!.label) === "next") block.splice(lastFilled(block, 0, block.length - 1) + 1, 0, join(to, `@jump ${file}#${after.label}`));

  // 元のファイルから抜く。前のシーンが移したシーンへ続いていたなら、移した先へ移る行を足す
  const source = [...all.slice(0, sections[first]!.start - 1), ...all.slice(sections[last]!.end)];
  const before = sections[first - 1]!;
  if (input.falls(file, before.label) === "next") source.splice(lastFilled(source, 0, before.end - 1) + 1, 0, join(file, `@jump ${to}#${moved[0]}`));

  // 移した先: 頭に @use を足し、最後がファイルの終わりで止まっていたなら @stop を足してから、終わりに足す
  const dest = destText === undefined ? [] : rowsOf(destText, to);
  const destScript = destText === undefined ? null : input.parse(destText, to);
  if (destScript && destText !== undefined) {
    const destSections = sceneSections(destScript, dest.length);
    const tail = destSections.at(-1)!;
    if (input.falls(to, tail.label) === "end") dest.splice(lastFilled(dest, 0, dest.length - 1) + 1, 0, join(to, "@stop"));
  }
  const has = new Set(destScript?.body.flatMap((s) => (s.kind === "use" ? [s.file] : [])) ?? []);
  const uses: string[] = [];
  for (const s of sourceScript.body) if (s.kind === "use" && s.file !== to && !has.has(s.file) && !uses.includes(s.file)) uses.push(s.file);
  const defines = new Set<string>();
  for (const s of sourceScript.body) if (s.kind === "define") defines.add(s.name);
  if (defines.size > 0 && !has.has(file)) {
    let calls = false;
    walk(input.parse(block.map((r) => r.text).join("\n"), file).body, (s) => {
      if (s.kind === "command" && defines.has(s.name)) calls = true;
    });
    if (calls) uses.push(file);
  }
  dest.unshift(...uses.map((u) => join(to, `@use ${u}`)));
  while (dest.length > 0 && dest.at(-1)!.text.trim() === "") dest.pop();
  if (dest.length > 0) dest.push({ text: "", origin: null });
  else if (uses.length > 0) dest.push({ text: "", origin: null });
  dest.push(...block);

  // 作品の中の、移したシーンを指すジャンプ先
  const files = new Map<string, Row[]>();
  for (const [name, text] of input.texts) files.set(name, name === file ? source : name === to ? dest : rowsOf(text, name));
  if (!files.has(to)) files.set(to, dest);
  const touched = new Set([file, to]);
  for (const name of moved) {
    const t: LabelTarget = { file, from: name, to: name, toFile: to };
    for (const [f, rows] of files) {
      const n = rewriteRows(rows, f, t, input);
      if (n > 0) touched.add(f);
      lines += n;
    }
  }

  const out = new Map<string, PlannedFile>();
  for (const f of touched) {
    const rows = files.get(f)!;
    out.set(f, { text: rows.map((r) => r.text).join("\n"), origin: rows.map((r) => r.origin) });
  }
  const joinLines = joins.map((j) => ({ file: j.file, line: files.get(j.file)!.indexOf(j.row) + 1, text: j.text }));
  return { files: out, joins: joinLines, lines };
}

/** ファイルを分けるときに移すシーン（選んだシーンから最後まで）。 */
export function scenesFrom(script: Script, lineCount: number, label: string): string[] {
  const sections = sceneSections(script, lineCount).filter((s) => s.label !== null);
  const i = sections.findIndex((s) => s.label === label);
  return i < 0 ? [] : sections.slice(i).map((s) => s.label!);
}
