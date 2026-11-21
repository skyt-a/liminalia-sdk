import { parse } from "@liminalia/lang";
import { buildProgram, createState, initialStage, type SaveData, type StageState, type Value } from "@liminalia/runtime";
import { afterGame, lineSave, type Sweep } from "./protocol.ts";
import { classifyLines } from "./lines.ts";

/**
 * 「ここから遊ぶ」で、行から始めるセーブを組み立てる（画面なし・ファイルなし）。
 *
 * プレイヤーの ?start=ファイル#ラベル&skip=N は、そのシーンの頭から空の状態（変数は初期値・背景も立ち絵も BGM も無し）で始めて
 * N ページを早送りするだけなので、前のシーンやほかのファイルで決めた背景・立ち絵・BGM・変数が無い。そこで、現在地（Sweep。
 * はじめからルートどおりに流した各行の状態）から、その行を実行する直前の状態を取り、その行の命令から始めるセーブを作る
 * （タイムラインの「再生」と同じ組み立て方）。
 *
 * - 本文と選択肢の行は、その行の状態のセーブ（そのページから再開するもの）がそのまま使える
 * - ほかの行は、そのファイルのページのセーブを骨組み（呼び出しの戻り先・ローカル変数）にし、位置をその行の命令に、
 *   舞台の様子と変数を、その行より前で状態を持つ一番近い行のもの（無ければファイルに入った時点のもの）にする
 * - 選択肢の行と @script・@html の中は、その @choice・@script の行から。空行と注釈は、次の命令から
 * - マクロ（@define）の中からは始められない（null）
 */

export interface PlayStart {
  save: SaveData;
  /** 実際に始める行（空行・注釈なら次の命令の行、選択肢の行なら @choice の行）。 */
  line: number;
  /**
   * 状態をどこから取ったか。line はその行の状態（その行を通っている）、before はその行より前の状態を持つ行、
   * entry はファイルに入った時点（その行より前に状態を持つ行が無い。取った範囲の外にあるかもしれない）。
   */
  basis: "line" | "before" | "entry";
}

/** 行の中の、始める命令の行（選択肢・@script の中なら、そのまとまりの頭）。始められなければ null。 */
export function startLine(lines: readonly string[], speakers: readonly string[], line: number): number | null {
  const table = classifyLines(lines, speakers);
  let at = Math.min(Math.max(line, 1), lines.length);
  if (table[at - 1]?.inDefine) return null;
  while (at > 1 && (table[at - 1]?.kind === "option" || table[at - 1]?.kind === "script" || (table[at - 1]?.kind === "comment" && table[at - 2]?.kind === "option"))) at--;
  return at;
}

/** その行より前で状態を持つ一番近い行の、舞台の様子とゲーム変数（全体）。無ければ null。 */
function stateBefore(sweep: Pick<Sweep, "base" | "lines" | "after" | "stages">, line: number): { stage: StageState; game: Record<string, Value> } | null {
  let best = -1;
  for (const l of Object.keys(sweep.lines)) if (Number(l) < line && Number(l) > best) best = Number(l);
  for (const l of Object.keys(sweep.after)) if (Number(l) < line && Number(l) > best) best = Number(l);
  if (best < 0) return null;
  const page = sweep.lines[best];
  if (page) {
    const save = lineSave(sweep, page);
    return { stage: save.stage, game: save.game };
  }
  const after = sweep.after[best]!;
  const stage = sweep.stages[after.stage];
  return stage ? { stage, game: afterGame(sweep, after) } : null;
}

/**
 * text（保存した内容）の line 行目から遊ぶセーブ。sweep はそのファイルの現在地（行の範囲を絞ったものでよいが、line より前の
 * 状態を持つ行を含むこと）。始める命令が無い（ファイルの終わりの空行など）・マクロの中なら null。
 */
export function playStart(sweep: Pick<Sweep, "file" | "base" | "lines" | "after" | "stages">, text: string, speakers: readonly string[], line: number): PlayStart | null {
  const lines = text.split("\n");
  const from = startLine(lines, speakers, line);
  if (from === null) return null;
  const program = buildProgram(parse(text, sweep.file, { speakers }));
  const list = program.main.instructions;
  let index = list.findIndex((i) => i.line === from);
  if (index < 0) index = list.findIndex((i) => i.line >= from);
  if (index < 0) return null;
  const at = list[index]!.line;
  // 本文・選択肢の行は、その行の状態のセーブ（現在地のプレビューと同じ）
  const own = sweep.lines[at];
  if (own) return { save: lineSave(sweep, own), line: at, basis: "line" };
  // 骨組みにするページ（このファイルの外側の流れのもの）。その行より後の最初のもの、無ければ前の最後のもの
  const pages = Object.keys(sweep.lines)
    .map(Number)
    .filter((l) => sweep.lines[l]!.save.position.unit === sweep.file)
    .sort((a, b) => a - b);
  const frame = pages.find((l) => l > at) ?? pages.filter((l) => l < at).at(-1);
  const skeleton: SaveData = frame !== undefined ? lineSave(sweep, sweep.lines[frame]!) : createState(sweep.file);
  // ラベルは何もしない命令なので、それを通った直後の状態が、そのシーンに入った時点の状態（飛んで来た先の状態）
  const label = list[index]!.op === "label" ? sweep.after[at] : undefined;
  const labelStage = label ? sweep.stages[label.stage] : undefined;
  const before = label && labelStage ? { stage: labelStage, game: afterGame(sweep, label) } : stateBefore(sweep, at);
  const save: SaveData = {
    ...structuredClone(skeleton),
    position: { unit: sweep.file, index },
    stage: structuredClone(before?.stage ?? sweep.base.stage ?? initialStage()),
    game: structuredClone(before?.game ?? sweep.base.game),
  };
  // createState が持つ temp はセーブに入れない
  delete (save as Partial<{ temp: unknown }>).temp;
  return { save, line: at, basis: label || sweep.after[at] ? "line" : before ? "before" : "entry" };
}

/** 状態を取る行の幅（その行の前後）。前の状態を持つ行がこの中に無ければ、ファイルの頭から取り直す。 */
export const PLAY_MARGIN = 400;

/** 現在地を引く口（開発サーバーの GET /sweep と GET /sweep/reach。VS Code の拡張機能は、開発サーバーが無ければ自分で作る）。 */
export interface PlaySweeps {
  sweep(file: string, range: { from: number; to: number }): Promise<Pick<Sweep, "file" | "base" | "lines" | "after" | "stages">>;
  /** その行に届く現在地（今の道筋で届かなければ、届く道筋を探して作り直す）。見つからなければ sweep が null。 */
  reach(file: string, line: number, range: { from: number; to: number }): Promise<{ sweep: Pick<Sweep, "file" | "base" | "lines" | "after" | "stages"> | null }>;
}

/**
 * text（保存した内容）の line 行目から遊ぶセーブを、現在地を引いて組み立てる（制作画面の「ここから遊ぶ」と VS Code の「ここから遊ぶ」）。
 * 今のルートで通らない行は、通るルートを探してから（searching を呼ぶ）。見つからなければ手前の行の状態から（noRoute を呼ぶ）。
 * 始められない行（マクロの中）は null。
 */
export async function findPlayStart(sweeps: PlaySweeps, file: string, text: string, speakers: readonly string[], line: number, note: { searching?(line: number): void; noRoute?(line: number): void } = {}): Promise<PlayStart | null> {
  let range = { from: Math.max(1, line - PLAY_MARGIN), to: line + PLAY_MARGIN };
  let sweep = await sweeps.sweep(file, range);
  let start = playStart(sweep, text, speakers, line);
  if (start?.basis === "entry" && range.from > 1) {
    // 手前の状態を持つ行が、取った範囲の外にある
    range = { from: 1, to: range.to };
    sweep = await sweeps.sweep(file, range);
    start = playStart(sweep, text, speakers, line);
  }
  if (start && !(start.line in sweep.lines || start.line in sweep.after)) {
    // 今のルートでは通らない行（@if の枝・ほかのファイルで決めた変数で分かれる先）
    note.searching?.(start.line);
    const r = await sweeps.reach(file, start.line, range);
    if (r.sweep) start = playStart(r.sweep, text, speakers, line);
    else note.noRoute?.(start.line);
  }
  return start;
}
