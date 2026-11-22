import type { Cast, DataDeclaration, Diagnostic, Registry, Script } from "@liminalia/lang";
import type { Value } from "@liminalia/runtime";
import type { CommandDefinition } from "./command.ts";

/**
 * プラグインが足す式の関数（CommandPlugin.functions）。台本の式（@if・@set・{…}・条件の式）から `名前(引数…)` で呼べる。
 * 引数は評価した値の写し（書き換えても台本の変数は変わらない）、返すのは値（数・文字・真偽・null・配列・オブジェクト）。
 * 乱数は env.random()（作品の乱数のシードに従うので、ロードしても同じ値になる）。同期の関数で、状態を持たない（同じ引数なら同じ値）ように書く。
 */
export interface PluginFunction {
  /** 引数の数（数一つならちょうどその数、[最小, 最大]。最大は Infinity も書ける）。lim check と実行器が確かめる。 */
  args: number | readonly [min: number, max: number];
  /** 説明（lim reference の式の関数の表に出す）。 */
  doc: string;
  docEn?: string;
  /** 書き方の例（`rank(game.score)` など。無ければ `名前()`）。 */
  usage?: readonly string[];
  run(args: Value[], env: { random(): number }): Value;
}

/**
 * プラグインの命令側（Node でも読める部分）。プロジェクト設定の plugins に書いたパッケージの
 * "./commands" がこれを default export する。検査・画面なしの実行・書き出し・プレイヤーが読む。
 * 見た目（描画・システム画面）は同じパッケージの "./web" が担う（@liminalia/web の WebPlugin）。
 * TyranoScript の .ks からの取り込み（タグの変換表・[iscript] の置き換え・扱わないタグ）は "./import" が担う
 * （@liminalia/ks-import の TyranoImportProfile）。書き出すゲームには入らない。
 */
export interface CommandPlugin {
  name: string;
  commands: readonly CommandDefinition[];
  /**
   * 作品全体を読んで診断を返す（lim check・lim build・制作画面のチェックが呼ぶ。保存のたびにも呼ぶので重い処理は避ける。同期の関数で書く）。
   * 分類は「プラグイン」に入る。投げても全体のチェックは止まらず、そのプラグインの診断として出る。
   */
  check?(project: PluginCheckProject): readonly PluginDiagnostic[];
  /**
   * 作品のデータ（paths.data の .json）の形の宣言（@liminalia/sdk の d で書く）。この宣言から、lim check と制作画面のチェックが形・素材・
   * キャスト・飛び先・式を確かめ、データの中のフラグと台本の @set を突き合わせ、制作画面が自動のフォームを作り、シーン・ファイル・素材・
   * 変数・キャストの名前を変えたらデータも書き換える。CG の印（d.asset(…, { cg: true })）の素材は、どこからも出ない CG の検査が出ているものと数える。
   */
  data?: readonly DataDeclaration[];
  /**
   * このプラグインの命令が値を入れる変数（"game.x"。末尾を .* にすると、その下の名前すべて。"game.codex.*" など）。
   * lim check と制作画面のチェックは、どこでも値を入れずに読むだけの変数を綴り違いとして知らせるので、プラグインが ctx.runtime.setVariable などで
   * 値を入れる変数はここに書く。
   */
  variables?: readonly string[];
  /**
   * 式の関数（名前 → 定義）。台本の式から呼べる（lim check の unknown-function にならない）。組み込みの関数と同じ名前は使えない
   * （lim check が plugin-function-clash を出し、組み込みのほうを使う）。
   */
  functions?: Readonly<Record<string, PluginFunction>>;
  /**
   * このプラグインを書いたときのプラグインの口の版（PLUGIN_API_VERSION）。エンジンの版より新しければ、lim check と制作画面のチェックが
   * 「新しいエンジンが要る」と知らせる（plugin-api-version）。書かなければ確かめない。
   */
  apiVersion?: number;
}

/** プラグインの check が読む作品。 */
export interface PluginCheckProject {
  /** 作品のフォルダ。 */
  root: string;
  /** liminalia.json の中身。 */
  config: Readonly<Record<string, unknown>>;
  /** ファイル（拡張子なし）→ 構文木。 */
  scripts: ReadonlyMap<string, Script>;
  /** 台本の文字（拡張子なし）。 */
  text(file: string): string;
  cast: Readonly<Cast>;
  speakers: readonly string[];
  /** 命令の仕様（組み込み・標準・プラグイン）。 */
  registry: Registry;
  /** 作品のデータ（paths.data の .json。無ければ undefined）。 */
  data(name: string): unknown;
  /** 素材のフォルダ（image・bgimage など）の中にあるか。 */
  assetExists(folder: string, path: string): boolean;
  /** 作品のデータの文字（診断の行を求めるのに使う。無ければ 1 行目に出す）。 */
  dataText?(name: string): string | undefined;
  /** 診断に書くデータのフォルダの名前（作品のフォルダからのパス。既定 data）。 */
  dataFolder?: string;
}

/**
 * プラグインの check が返す診断。file を省くと liminalia.json、line を省くと 1。訳があれば messageEn・hintEn に書く（無ければ英語の表示でも原文のまま）。
 * fix・fixes に直し方（行の置き換え・行の削除・話者に足す・シーンを作る）を書くと、制作画面のチェックとエディタに「修正」が出る。
 */
export type PluginDiagnostic = Pick<Diagnostic, "severity" | "code" | "message"> & Partial<Pick<Diagnostic, "messageEn" | "file" | "line" | "column" | "hint" | "hintEn" | "fix" | "fixes">>;

export function defineCommandPlugin(plugin: CommandPlugin): CommandPlugin {
  return plugin;
}
