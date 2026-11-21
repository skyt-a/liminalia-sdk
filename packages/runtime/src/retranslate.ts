import type { Args } from "./runtime.ts";
import type { Value } from "./value.ts";

/**
 * 置いたままの文字（@layer-text の文字、チャットの吹き出しなど、状態の stage.extra に残る文字）を、言語を替えたときと
 * 別の言語でロードしたときに、今の言語で出し直すための元。
 *
 * 文字を持つものは、その横に `i18n: { 名前: TextOrigin }` を置く（名前はその文字を入れておく欄。text・title・label など）。
 * Runtime.retranslate が stage.extra をたどり、i18n を持つものの欄を今の言語の訳に書き換える。
 * - arg: コマンドの文字（仕様で translate: "text" の引数に字面で書いたもの）
 * - line: 本文の行（チャットの吹き出し。欄の文字と、ルビや装飾つきの一片 parts を作り直す）
 * - option: 選択肢の文
 * - speaker: 話者名と表示名（欄が label で、訳が話者と同じなら label を外す）
 */
export interface TextOrigin {
  kind: "arg" | "line" | "option" | "speaker";
  /** 書いたファイル（speaker は無い）。 */
  file?: string;
  /** 原文（本文の行と選択肢は printInline で書き直したもの）。 */
  source: string;
  /** 場面（直前のラベル。訳のファイルの contexts）。 */
  context?: string;
  /** 行末の固定の行 ID（#line:ID。本文の行と選択肢。あれば ID で訳を引く）。 */
  id?: string;
}

export const I18N_FIELD = "i18n";

/** 引数を読んだときの、訳す印のある文字の元（resolveArgs が付ける）。 */
const origins = new WeakMap<Args, Record<string, TextOrigin>>();

/** 引数の文字の元を控える（実行器の resolveArgs だけが使う）。 */
export function noteArgOrigin(args: Args, name: string, origin: TextOrigin): void {
  let o = origins.get(args);
  if (!o) origins.set(args, (o = {}));
  o[name] = origin;
}

/**
 * 命令の引数の、訳す印（translate: "text"）のある文字の元。字面で書いた文字だけにあり、式で書いた文字には無い。
 * 置いた文字を状態に残す命令は、これを i18n に入れておくと、言語を替えたときに出し直される。
 */
export function argOrigin(args: Args, name: string): TextOrigin | undefined {
  return origins.get(args)?.[name];
}

/** i18n を一つ作る（元の無い欄は入れない。どれも無ければ undefined）。 */
export function textOrigins(fields: Record<string, TextOrigin | undefined>): Record<string, TextOrigin> | undefined {
  const out: Record<string, TextOrigin> = {};
  for (const [k, v] of Object.entries(fields)) if (v) out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

const isRecord = (v: unknown): v is Record<string, Value> => !!v && typeof v === "object" && !Array.isArray(v);

/** stage.extra などの中で、i18n を持つものを順に渡す。 */
export function* withOrigins(value: unknown, depth = 0): Generator<{ target: Record<string, Value>; origins: Record<string, TextOrigin> }> {
  if (depth > 12) return;
  if (Array.isArray(value)) {
    for (const v of value) yield* withOrigins(v, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  const own = value[I18N_FIELD];
  if (isRecord(own)) yield { target: value, origins: own as unknown as Record<string, TextOrigin> };
  for (const [k, v] of Object.entries(value)) if (k !== I18N_FIELD && v && typeof v === "object") yield* withOrigins(v, depth + 1);
}
