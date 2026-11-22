import type { Cast, CommandSpec, Diagnostic, Script } from "@liminalia/lang";
import type { Project } from "@liminalia/project";
import type { AssetIndex, DataText, DataWriteResult, FileText } from "./protocol.ts";

/**
 * 制作画面のプラグインの、開発サーバー側（Node）。作品のプラグインのパッケージが exports の "./studio-server" に default export で置くと、
 * 開発サーバー（lim studio・lim dev・デスクトップ版）がその口を STUDIO_API/plugin/<name>/… に載せる。書き出すゲームには入らない。
 * 子プロセスを起こす（AI の CLI など）・作品の外のファイルを読むなど、ブラウザの画面だけではできないことに使う。
 *
 * 画面（"./studio"）からは ctx.server・ctx.stream で呼ぶ。name は同じプラグインの "./studio" の name と同じにする。
 * 口は起動したときに一度だけ読む（書き換えたら起動し直す）。
 */
export interface StudioServerPlugin {
  /** プラグインの名前（英小文字・数字・-）。口の場所 STUDIO_API/plugin/<name>/ になる。 */
  name: string;
  /**
   * 口の表。キーは "GET /status" のように、メソッドと、name より後ろのパス。
   * - 値を返すと JSON にして返す（undefined なら中身なしの 204）。Response を返せばそのまま返す（画像・音など）
   * - 非同期イテレーター（async function*）を返すと、出したものを一行ずつ流す（画面の ctx.stream が一つずつ受け取る）
   * - StudioServerError（か、status に 400〜599 の数を持つ Error）を投げると、その状態の番号とメッセージで返す。ほかの例外は 500
   */
  routes: Record<string, StudioRoute>;
  /** 開発サーバーを閉じるとき（起こした子プロセスを止めるなど）。 */
  dispose?(): void | Promise<void>;
}

export type StudioRoute = (req: StudioRequest, ctx: StudioServerContext) => unknown;

export interface StudioRequest {
  method: string;
  /** name より後ろのパス（"/status"）。 */
  path: string;
  query: URLSearchParams;
  /** 本文を JSON として読む。本文が無ければ null。 */
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  /** 画面が接続を切った・取り消した（ctx.stream のループを抜けた・signal を止めた）。子プロセスを止めるのに使う。 */
  signal: AbortSignal;
}

/** 口に渡す、開発サーバーの側の制作画面の口。 */
export interface StudioServerContext {
  /** 作品のフォルダ。 */
  readonly root: string;
  /** 作品のフォルダの場所（シナリオ・素材・データなど）。 */
  readonly paths: Project["paths"];
  /** このプラグインが自由に使ってよいフォルダ（.liminalia/plugins/<name>）。会話の履歴や設定など、制作画面だけの覚え書きに使う。無ければ作る。 */
  stateDir(): string;
  /** 台本（シナリオのフォルダの中の名前。拡張子なし）を読む。無ければ null。 */
  readScript(file: string): FileText | null;
  /**
   * 台本を書く。baseHash は読んだときの hash（新しいファイルは null）。ほかで書き換えられていたら書かずに今の中身を返す。
   * 書いたら、制作画面の画面に外の変更として知らせる（開いていれば、編集中の内容と合わせ直す）。
   */
  writeScript(file: string, text: string, baseHash: string | null): { ok: true; hash: string } | { ok: false; current: FileText };
  /** 作品のデータ（paths.data の .json）を読む。無ければ null。 */
  readData(name: string): DataText | null;
  /** 作品のデータを書く（画面の ctx.writeData と同じ）。書いたら画面の onDataChanged に知らせる。 */
  writeData(name: string, text: string, baseHash: string | null): DataWriteResult;
  /**
   * 作品で使える命令の仕様（組み込み・標準・プラグイン）。組み込みの命令の keywords（やりたいことの言葉）は
   * command-meta.ts のものを入れてある。AI に命令を選ばせるときの手引きに使う。
   */
  commands(): CommandSpec[];
  /**
   * 台本の中身を、書かずに検査する（ほかのファイル・キャスト・素材と合わせて。lim check と同じ規則）。
   * file はシナリオのフォルダの中の名前（拡張子なし）。返すのはそのファイルの診断だけ。
   */
  check(file: string, text: string): Diagnostic[];
  /** 開発サーバーの記録に出す。 */
  log(message: string): void;
  /** プラグインの口の版（STUDIO_PLUGIN_API_VERSION。これより古い制作画面では undefined）。 */
  readonly apiVersion?: number;
  /** キャスト（cast.json の cast。人物 → 立ち絵セット・差分）。 */
  cast?(): Cast;
  /** 話者の名前（cast.json の speakers と、キャストの speaker）。台本の台詞の行を見分けるのに使う。 */
  speakers?(): string[];
  /** 素材の一覧（フォルダ → その中のパス）。 */
  assets?(): AssetIndex;
  /** 台本のファイル（シナリオのフォルダの中の名前。拡張子なし。名前順）。 */
  scripts?(): string[];
  /**
   * 台本を解析した構文木（@liminalia/lang の Script。行の種類・話者・命令と引数）。text を渡すとディスクのものの代わりにそれを解析する
   * （書く前の案を読む）。無いファイルは null。自前で台本を読み分けなくてよい。
   */
  parse?(file: string, text?: string): Script | null;
}

/** 口から投げると、status とメッセージで画面に返す（画面の ctx.server・ctx.stream は status を持つ Error を投げる）。 */
export class StudioServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 型を付けるだけ（そのまま返す）。 */
export function defineStudioServerPlugin(plugin: StudioServerPlugin): StudioServerPlugin {
  return plugin;
}

// プラグインの約束（@liminalia/sdk/studio-server）が呼ぶ実装を登録する
import { provide as provideToSdk } from "@liminalia/sdk/host";
import { findRunningStudio as findRunningStudioForSdk } from "@liminalia/editor/running";
provideToSdk("studio-server", { StudioServerError, findRunningStudio: findRunningStudioForSdk });
