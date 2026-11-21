import type { AutoLayoutRules, Cast, CommandSpec, DataDeclaration, Diagnostic, HeadMark, PunctuationConfig, TextStats, TranslationFile, UiConfig, VariantGroup, VoiceScriptRow } from "@liminalia/lang";
import type { ProjectConfig } from "@liminalia/project";
import type { SaveData, StageState, Value } from "@liminalia/runtime";
import type { Origin, RouteStep } from "./protocol/sweep.ts";

/**
 * 制作画面（ブラウザ）と開発サーバー（Node）のあいだの受け渡し。
 * 正本は .lim のファイルで、画面はそれを読んで描くだけ。書き込みはすべて PUT /file（書き込み口）を通る。
 *
 * ファイルは「シナリオの名前」（paths.scenario からの相対パスで、拡張子 .lim を除いたもの。例: "start"、"part1/chapter2"）で指す。
 * 行は 1 始まり。HTTP の口はすべて STUDIO_API の下にある。
 */

export const STUDIO_API = "/__liminalia/studio/api";
/** 制作画面のページ。 */
export const STUDIO_PAGE = "/__liminalia/studio";
/** 開発サーバーから画面への知らせ（Vite の WebSocket のカスタムイベント名）。 */
export const STUDIO_EVENT = "liminalia:studio";
/** 制作画面から開くプレビューのウィンドウ名。 */
export const STUDIO_STAGE_WINDOW = "liminalia-stage";

// ---- 作品のプラグインの開発サーバー側の口（STUDIO_API/plugin/<name>/…。../server-plugin.ts） ----

/** プラグインの口の場所。STUDIO_API/plugin/<name>/<path>。 */
export const STUDIO_PLUGIN_API = `${STUDIO_API}/plugin`;
/**
 * プラグインの口を呼ぶときに付ける見出し（値は "1"）。付いていない要求は 403。
 * ほかのページの <img> やフォームからの要求（Origin を付けないもの）で、子プロセスを起こす口などが動かないようにする。
 */
export const STUDIO_PLUGIN_HEADER = "x-liminalia-studio";
// ---- デスクトップ版の制作画面だけにある口（window[STUDIO_DESKTOP_GLOBAL]。packages/studio-desktop の preload-studio が置く） ----

/** デスクトップ版の制作画面のウィンドウに置く口の名前。ブラウザで開いた制作画面（lim studio）には無い。 */
export const STUDIO_DESKTOP_GLOBAL = "liminaliaDesktop";
/** 口の呼び名（invoke のチャンネルは studio:<名前>）。 */
export const STUDIO_DESKTOP_CHANNELS = ["pickPluginFolder", "pickAssetFiles", "showFile", "focusStagePopup", "tourSeen", "markTourSeen", "setTheme"] as const;

/**
 * 素材のファイルを選ぶ画面（pickAssetFiles）に渡すもの。kind は素材の種類（fgimage など）、folder はその中のフォルダ（キャラクターの画像の
 * フォルダなど。無ければ種類のフォルダ）。extensions は選べる拡張子（. を除く。空ならすべて）。
 */
export interface AssetFilePick {
  kind: string;
  folder?: string;
  extensions: string[];
  multiple: boolean;
}

/** 選んだファイル（名前と中身）。 */
export interface PickedFile {
  name: string;
  data: Uint8Array;
}

/** デスクトップ版の制作画面だけにある口。OS の画面を出すものとアプリの記録に置くものだけを、用途ごとに一つずつ置く（ipcRenderer そのものは渡さない）。 */
export interface StudioDesktopApi {
  /** プラグインのフォルダを OS のフォルダを選ぶ画面で選んでもらい、そのパスを返す（やめたら null）。 */
  pickPluginFolder(): Promise<string | null>;
  /**
   * 素材にするファイルを OS のファイルを選ぶ画面で選んでもらい、中身を返す（やめたら空）。画面は、このプロジェクトでその種類の素材を
   * 前に選んだ場所で開き、初めてなら素材の当てはまるフォルダ（assets/<kind>/<folder>）で開く（OS が覚えている前の場所で開かない）。
   */
  pickAssetFiles(pick: AssetFilePick): Promise<PickedFile[]>;
  /** 作品の中のファイル（作品のフォルダからの相対パス）を、OS のファイルの画面（Finder・エクスプローラー）で選んだ状態で開く。 */
  showFile(path: string): Promise<void>;
  /** この作品の別ウィンドウのプレビューを前に出す。無い場合は false。 */
  focusStagePopup(): Promise<boolean>;
  /** はじめての案内をもう出したか。デスクトップ版はオリジン（番号）が作品ごとに違い localStorage では作品をまたげないので、アプリの記録に置く。 */
  tourSeen(): Promise<boolean>;
  /** はじめての案内を出したことを、アプリの記録に覚える。 */
  markTourSeen(): Promise<void>;
  /** 制作画面の配色の選び（自動・ライト・ダーク）をアプリに知らせる。アプリは書き出しのウィンドウの配色をこれに合わせる。 */
  setTheme(theme: "auto" | "light" | "dark"): Promise<void>;
  /** テストプレイのウィンドウからの知らせ（このページをシナリオで開く・実行時の警告）を受ける。アプリは制作画面のウィンドウを前に出してから渡す。 */
  onTestPlay?(listener: (message: TestPlayMessage) => void): void;
}

// ---- テストプレイから制作画面へ（開発サーバーのときだけ。packages/web の play-dev.ts が送る） ----

/**
 * ブラウザで開いたテストプレイと制作画面のあいだの BroadcastChannel の名前（同じオリジン）。
 * 制作アプリのテストプレイのウィンドウは、代わりに preload の口（window[TEST_PLAY_GLOBAL]）からアプリを通して送る。
 * 遊ぶ側は制作画面のモジュールを読まない（書き出すゲームに入れない）ので、play-dev.ts にも同じ名前を書く。
 */
export const TEST_PLAY_CHANNEL = "liminalia:test-play";
/** 制作アプリのテストプレイのウィンドウに preload が置く口の名前（書き出したデスクトップ版の liminaliaDesktop とは別）。 */
export const TEST_PLAY_GLOBAL = "liminaliaTestPlay";

/** テストプレイで出た実行時の問題（無い素材、式の誤りなど）。 */
export interface TestPlayDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  file: string;
  line: number;
}

/**
 * テストプレイから制作画面への知らせ。
 * - test-play-start: テストプレイを開いた（session ごとに一つ。前のテストプレイで出た問題を片づける）
 * - test-play-diagnostic: 実行時の問題（制作画面のチェックの「テストプレイ」の分類に並べる）
 * - test-play-open: このページをシナリオで開く（⇧E とメニュー）。id は受けたことの返事（test-play-ack）に使う
 * - test-play-ack: 制作画面が test-play-open を受けた（ブラウザだけ。アプリは呼び出しの戻り値で分かる）
 */
export type TestPlayMessage =
  | { type: "test-play-start"; session: string }
  | { type: "test-play-diagnostic"; session: string; diagnostic: TestPlayDiagnostic }
  | { type: "test-play-open"; id: string; file: string; line: number }
  | { type: "test-play-ack"; id: string };

/** 制作アプリのテストプレイのウィンドウの口（preload が window[TEST_PLAY_GLOBAL] に置く）。 */
export interface TestPlayDesktopApi {
  /** 制作画面へ送る。制作画面のウィンドウが開いていれば true。 */
  send(message: TestPlayMessage): Promise<boolean>;
  /** アプリのメニュー（この場所から読み直す・このページをシナリオで開く）を受ける。 */
  onCommand(listener: (command: "reload" | "open") => void): void;
}

/** 流す口の応答（application/x-ndjson）の一行。口が出したものは event、途中で失敗したら error で終わる。 */
export type StreamLine = { event: unknown } | { error: string; status: number };
/** 作品のプラグインの流す口の一行（StreamLine と同じ形）。 */
export type PluginStreamLine = StreamLine;
/**
 * デスクトップ版で、開発サーバーを起動し直してから制作画面を開き直す頼み。画面がこのパスへ移ろうとすると、アプリが受けて移るのを止める
 * （?file=&line= を付けると、開き直したあとそのファイルのその行を開く）。デスクトップ版の画面（?desktop=1 で開いたもの）だけが使う。
 */
export const STUDIO_RESTART = `${STUDIO_PAGE}/restart`;

/**
 * デスクトップ版で、アプリの言語を変える頼み（?lang=ja|en）。画面がこのパスへ移ろうとすると、アプリが受けて言語を変え、
 * メニューと画面を作り直す（制作画面は ?lang= を付けて開き直す）。画面は保存を済ませてから移る。
 */
export const STUDIO_LANGUAGE = `${STUDIO_PAGE}/language`;
/** 画面が英語の表示のとき、開発サーバーへの要求に付ける見出し（値は "en"）。断りの文（{ error }）を英語で返す（server/errors-en.ts）。 */
export const STUDIO_LANGUAGE_HEADER = "x-liminalia-lang";

/** Liminalia のサイト（使い方、コマンドリファレンス）。制作画面と制作アプリのリンクはここから作る。 */
export const SITE_URL = "https://liminalia.skyta.dev";

/** サイトのページ（path は "/guide/" のように / で始めて / で終える）。英語の表示なら /en の下。 */
export function siteUrl(path: string, language = "ja"): string {
  return `${SITE_URL}${language === "en" ? "/en" : ""}${path}`;
}

/** コマンドリファレンスのそのコマンドのページ（組み込みと標準のコマンドだけがある）。 */
export function referenceUrl(name: string, language = "ja"): string {
  return siteUrl(`/reference/${name}/`, language);
}
/**
 * 画面（ブラウザのタブ、アプリの窓）ごとの id を開発サーバーへの要求に付ける見出し。開発サーバーは、その画面が書いた台本の変わりを
 * file-changed などの by に添えてすべての画面へ送る（同じ作品を二つの画面で開いたとき、書いた画面は読み飛ばし、ほかの画面が読み直す）。
 */
export const STUDIO_WINDOW_HEADER = "x-liminalia-window";

/**
 * デスクトップ版で、上の帯の「テストプレイ」「書き出す」をアプリに頼む（遊ぶウィンドウ・書き出しのウィンドウを開く）。
 * 画面がこのパスへ移ろうとすると、アプリが受けて移るのを止める。ブラウザ（lim studio）では使わない。
 * 「ここから遊ぶ」は STUDIO_PLAY に遊ぶウィンドウへ渡す問い（?from=&start=）を付ける（アプリはそのまま `/?play=1&…` に付ける）。
 */
export const STUDIO_PLAY = `${STUDIO_PAGE}/play`;
export const STUDIO_EXPORT = `${STUDIO_PAGE}/export`;

/**
 * 「ここから遊ぶ」: 制作画面がその行から始めるセーブを localStorage のこの鍵に置き（PlayFrom）、プレイヤーを `/?play=1&from=<id>` で開く。
 * プレイヤーは id の合うものだけを読む（開発サーバーのときだけ。packages/web の studio-play-from.ts は同じ鍵を使う）。
 * 読めなければ（ほかのブラウザで開いたなど）、一緒に付けた ?start=（そのシーン）から変数を初期値にして始める。
 */
export const PLAY_FROM_KEY = "liminalia.studio.playFrom";

export interface PlayFrom {
  id: string;
  /** その行から始めるセーブ（その行を実行する直前の背景・立ち絵・BGM・変数）。 */
  save: SaveData;
  file: string;
  line: number;
}

/**
 * 開発サーバーの外（VS Code の拡張機能）で組み立てたセーブを、ブラウザのプレイヤーへ渡す口。
 * POST STUDIO_API + PLAY_FROM_ROUTE に PlayFromOffer を送ると id を返し（{ id }）、ブラウザで
 * GET STUDIO_API + PLAY_FROM_ROUTE?id=<id>&start=<シーン> を開くと、そのページが localStorage の PLAY_FROM_KEY に置いて
 * `/?play=1&from=<id>&start=<シーン>` へ移る（制作画面の「ここから遊ぶ」と同じ形で始まる）。
 * id が無い（開発サーバーを起動し直したなど）ときは `/?start=<シーン>&skip=<skip>` へ移る。
 */
export const PLAY_FROM_ROUTE = "/play-from";

export type PlayFromOffer = Omit<PlayFrom, "id">;

// ---- GET /project ----

export interface ProjectInfo {
  id: string;
  title: string;
  /** 「はじめから」の開始位置（ファイル または ファイル#ラベル）。 */
  entry: string;
  screen: { width: number; height: number };
  files: FileInfo[];
  speakers: string[];
  /**
   * 原文の言語（liminalia.json の languages の先頭。書いていなければ省く＝日本語）。ブロックで台詞を足すときの形に使う
   * （英語なら `話者 ""`、ほかは `話者「」`）。
   */
  language?: string;
  cast: Cast;
  /** 組み込み・標準・プラグインの命令の仕様（補完・検査・札の表示に使う）。 */
  commands: CommandSpec[];
  /** 命令の出どころ（命令名 → "core"（組み込み）か、プラグインの名前。標準の命令は "std"）。ブロックの部品の分け方に使う。 */
  commandSources: Record<string, string>;
  /** シナリオの @define のマクロの仕様（コマンドの既定値の欄で選べるように）。古いサーバーは送らない。 */
  macros?: CommandSpec[];
  /** 素材の一覧（補完・札のフォームの候補と、打鍵中の素材の欠けの検査に使う）。 */
  assets: AssetIndex;
  /**
   * .lim が取り込み（lim import）で作られる作品か。true なら編集しても次の取り込みで上書きされるので、
   * 画面は読むための道具として振る舞い、書き込む前にそのことを知らせる。
   */
  importManaged: boolean;
  /** @script を使ってよいか（liminalia.json の allowScript）。 */
  allowScript?: boolean;
  /** 立ち絵の登場順の自動配置の規則（liminalia.json の autoLayout。読み解いたもの。書いていなければ省く）。場面の情報の立ち位置に使う。 */
  autoLayout?: AutoLayoutRules;
  /** 約物の検査（liminalia.json の check.punctuation。省略はすべて行う）。 */
  punctuation?: PunctuationConfig;
  /** 診断の code ごとの重さ（liminalia.json の check.severity。"off" は出さない）。書いていなければ送らない。 */
  severity?: Record<string, "error" | "warning" | "info" | "off">;
  /** 整えるときの字下げ（liminalia.json の fmt.indent。「整える」が使う）。書いていなければ送らない（字下げは変えない）。 */
  formatIndent?: number | "tab";
  /** false なら「整える」で式の空白を整えない（liminalia.json の fmt.expressions）。書いていなければ送らない。 */
  formatExpressions?: false;
  /** liminalia.json の languages（先頭が原文の言語）。書いていなければ送らない（原文は日本語）。 */
  languages?: string[];
  /** プラグイン（標準の命令を含む）が形を宣言した作品のデータ（「プラグイン」のタブの自動のフォーム）。古いサーバーは送らない。 */
  data?: { plugin: string; decl: DataDeclaration }[];
  /** 読み込めずに抜いたプラグイン（上の帯に出す。作品の外のフォルダが無いだけのものは入れない）。無ければ送らない。 */
  pluginErrors?: { spec: string; message: string }[];
  /** 制限付きで開いたので、プラグインを読まずに開いた（@liminalia/project の trust.ts）。無ければ送らない。 */
  restricted?: true;
}

/**
 * 素材のフォルダ → その中のファイル（フォルダからの相対パス。"/" 区切り、名前順）。
 * 決まったフォルダ（ASSET_FOLDERS）と、命令の仕様が素材の探し先に挙げるフォルダを持つ。無いフォルダは空。
 * . で始まるファイル・フォルダは入れない。
 */
export type AssetIndex = Record<string, string[]>;

export const ASSET_FOLDERS = ["bgimage", "fgimage", "image", "bgm", "sound", "video"] as const;

export interface FileInfo {
  file: string;
  lines: number;
  hash: string;
  /** ファイルの中のラベル（目次に使う）。 */
  labels: { name: string; line: number }[];
  /** 台本内の、ゲームには影響しない場面マーカー。 */
  markers?: import("./scene-markers.ts").SceneMarker[];
  /** この台本に書かれた話者ごとの台詞数（話者補完の並びに使う）。 */
  speakerCounts?: Record<string, number>;
  /** ファイルの一番外側の @define（マクロの名前と行。定義へ移動と、@use したファイルのマクロの補完に使う）。古いサーバーは送らない。 */
  defines?: { name: string; line: number }[];
  /** 下書き（先頭のコメントに // lim: draft）。書き出し、全ルートテスト、網羅率から外す。下書きでなければ送らない。 */
  draft?: true;
}

// ---- GET /file?file=… ----

export interface FileText {
  file: string;
  text: string;
  /** 内容の SHA-256（16 進の先頭 16 文字）。書き込みのときに baseHash として返す。 */
  hash: string;
}

// ---- PUT /file ----

export interface WriteRequest {
  file: string;
  text: string;
  /** 画面が編集を始めたときの内容の hash。ディスクがこれと違えば書かずに 409 を返す。新しいファイルは null。 */
  baseHash: string | null;
  /** false なら書いたあとの検査をしない（置換などで続けて書き、終わってから一度 POST /check するとき）。既定は true。 */
  check?: boolean;
}

/** 200 */
export interface WriteResult {
  file: string;
  hash: string;
  /** 書いたあとのプロジェクト全体の検査のうち、このファイルのもの。 */
  diagnostics: Diagnostic[];
  /** 前の版を残した履歴の id（GET /history で引ける）。内容が変わらなければ null。 */
  history: string | null;
  /** 書いたあとのプロジェクト全体の検査（POST /check と同じもの。画面は保存のあとにこれを使い、検査をし直さない）。check: false で書いたときは無い。 */
  check?: CheckResult;
}

/** 409。画面はこれと自分の base・編集中の内容から三方向に合わせ直し、新しい hash を base にして書き直す。 */
export interface WriteConflict {
  file: string;
  current: FileText;
}

// ---- POST /search（全体の検索。探し方は ./search.ts） ----

export interface SearchOptions {
  query: string;
  /** 正規表現（JavaScript の書き方）。 */
  regex?: boolean;
  /** 本文だけ（台詞と地の文。コマンド・コメント・ラベルなどの行と、本文の中の書き方を除く）。 */
  body?: boolean;
  /** ひらがなとカタカナを同じに扱う。 */
  kana?: boolean;
  /** 大文字と小文字を区別する（既定は区別しない）。 */
  caseSensitive?: boolean;
  /** 探すファイル（ファイル名か、"/" で終わるフォルダ。そのフォルダの下のファイルすべて）。省けばすべてのファイル。 */
  scope?: string;
  /** この話者の台詞の行だけ（台詞の名前。@if・@define の中も）。省けばすべての行。 */
  speaker?: string;
  /**
   * パック（packs/<フォルダ>/scenario）の台本も探す（全体の検索と置換）。当たったファイルは packs/<フォルダ>/scenario/<台本> の名前で、pack にパックのフォルダ。
   * 制作画面はパックの台本を開いて書く口を持たないので、画面は開かず、置換では読み取り専用として飛ばす。
   */
  packs?: boolean;
}

export interface SearchRequest extends SearchOptions {
  /** 開いているファイルのまだ保存していない内容（あれば、そのファイルはディスクの代わりにこれを探す）。 */
  open?: { file: string; text: string };
}

/** 行の中の当たった範囲。groups は正規表現のグループの中身（置換の $1 など）。 */
export interface SearchSpan {
  at: number;
  length: number;
  groups?: string[];
}

export interface SearchLine {
  line: number;
  text: string;
  spans: SearchSpan[];
}

/** 当たったファイル（名前順）。hash は探した内容の hash（置換で書くときの baseHash）。 */
export interface SearchFile {
  file: string;
  hash: string;
  lines: SearchLine[];
  /** パックの台本なら、そのパックのフォルダ（packs/<フォルダ>。file は packs/<フォルダ>/scenario/<台本>）。 */
  pack?: string;
}

export interface SearchResult {
  files: SearchFile[];
  /** 当たった数。 */
  count: number;
  /** 当たった行が多すぎるか、時間がかかりすぎて途中でやめた。 */
  truncated: boolean;
}

// ---- GET /history?file=… / GET /history/item?file=…&id=… ----
// /history は HistoryEntry[]（新しい順。直近は細かく、古いほど粗く間引いて、ファイルごとに 50 件まで。server/versions.ts）、/history/item はその版の FileText。


export interface HistoryEntry {
  id: string;
  /** ISO 8601。 */
  time: string;
  bytes: number;
}

// ---- POST /check ----

/** 書いたものの検査（実行しない）。素材の欠けも含む。 */
export interface CheckResult {
  /** ISO 8601。 */
  at: string;
  diagnostics: CheckedDiagnostic[];
  /** 分類ごとの件数（画面の点検の表に使う）。 */
  counts: Record<CheckCategory, number>;
}

/**
 * 検査の分類。syntax: 書き方の誤り、command: 命令と引数、cast: キャスト・立ち絵セット・差分・立ち位置（cast.json の形も）、
 * target: 飛び先のファイルとラベル、asset: 素材の欠け、plugin: 作品の決まり（プラグインが足す検査）。
 */
export type CheckCategory = "syntax" | "command" | "cast" | "target" | "asset" | "plugin";

export const CHECK_CATEGORIES: readonly CheckCategory[] = ["syntax", "command", "cast", "target", "asset", "plugin"];

/** 分類つきの診断。 */
export interface CheckedDiagnostic extends Diagnostic {
  category: CheckCategory;
}

// ---- POST /coverage ----
// 本文は省略できる。{ runs: N } でファイルごとに流す回数を変える（既定 4）。

/** 画面なしで流して確かめた結果（実行した確認）。 */
export interface CoverageResult {
  at: string;
  files: { file: string; lines: number; reached: number; unreached: number[] }[];
  /** 実行時に出た診断（実行した確認として、検査とは分けて出す）。 */
  diagnostics: Diagnostic[];
  /** 実行したときのファイルの hash（実行後にシナリオが変わったかを画面が見る）。 */
  hashes?: Record<string, string>;
  /** 実行したエンジンの版（無ければ、版を覚える前の制作画面が実行したもの）。 */
  engine?: string;
  /** 実行したときの、シナリオのほかで流し方を変えるもの（liminalia.json、cast.json、作品のデータ、プラグインのコマンド）の hash。 */
  inputs?: string;
  /**
   * GET /coverage が付ける、今の結果として使えないわけ。"engine" はエンジンの版が違う（か分からない）、"settings" は実行後に
   * 設定（inputs のもの）が変わった。画面は古い結果として出す（全ルートテストは重いので、自動では流し直さない）。
   */
  outdated?: "engine" | "settings";
}

/**
 * POST /coverage/stream が一行ずつ流すもの（StreamLine の event）。一回流し終えるたびに progress、終わったら done。
 * 結果は .liminalia/coverage.json に覚え、GET /coverage で読める（無ければ null。エンジンの版か設定が変わっていれば outdated を付ける）。
 */
export type CoverageEvent = { kind: "progress"; done: number; total: number; file: string } | { kind: "done"; result: CoverageResult };

// ---- GET /map （地図） ----

/** 台本から作る分岐の俯瞰（@liminalia/lang の buildStoryMap）。 */
export type { MapEdge, MapNode, StoryMap } from "@liminalia/lang";

export { afterGame, lineAssigned, lineChoices, lineSave, type AfterState, type LineState, type Origin, type RouteStep, type StageMarks, type StageTrack, type Sweep, type SweepReach } from "./protocol/sweep.ts";

// ---- POST /import （取り込み直す） ----

/**
 * 取り込みで作る作品（ProjectInfo.importManaged）で、取り込み元（TyranoScript の .ks）からもう一度取り込む（lim import と同じ）。
 * 書き換わった .lim は、ファイルの見張りから file-changed などで届く。取り込みで作らない作品では 400。
 */
// ---- GET・PUT /data（作品のデータ。プラグインの画面が読み書きする） ----

/**
 * 作品のデータのファイル（paths.data からの相対パス。拡張子 .json まで書く。例: "items.json"、"maps/town.json"）。
 * text は JSON の文字列そのまま（画面が JSON.parse する）。hash は読んだときの中身のハッシュで、書くときに baseHash として返す。
 */
export interface DataText {
  name: string;
  text: string;
  hash: string;
}

/** PUT /data。baseHash は読んだときの hash（新しいファイルは null）。text は JSON として読めるものだけ受ける。 */
export interface DataWriteRequest {
  name: string;
  text: string;
  baseHash: string | null;
}

/** PUT /data の結果。409 なら current に今のディスクの中身（ほかで書き換えられた）。 */
export type DataWriteResult = { ok: true; name: string; hash: string } | { ok: false; current: DataText };

// ---- GET・PUT /studio-state（制作画面だけの覚え書き） ----

/**
 * 制作画面のデータのうち、プロジェクトと一緒に共有するもの（.liminalia/shared.json。Git に入れ、共同作者とスマホ版に届ける）。
 * ほかはその人の手元だけのもの（.liminalia/studio.json。Git に入れない）。
 */
export const STUDIO_SHARED_KEYS = ["sceneMarks", "castNotes", "faces", "heads", "mapPositions"] as const;

/**
 * 制作画面だけが使う、作品ごとのデータ（共有するもの STUDIO_SHARED_KEYS は .liminalia/shared.json、ほかは .liminalia/studio.json）。
 * ゲーム・.lim・cast.json・liminalia.json には書かない。PUT は全体を置き換える（読んでから直して送る）。
 */
export interface StudioState {
  /** キャスト名 → 立ち絵から顔を切り出す位置。無ければ FACE_CROP。 */
  faces?: Record<string, FaceCrop>;
  /** 立ち絵の画像のパス（fgimage から）→ 確認した頭の測定点（「頭の大きさを揃える」が使う）。 */
  heads?: Record<string, HeadMark>;
  /** 地図の場面の id（MapNode.id）→ 書き手が動かした位置（地図の座標。倍率 100% の px）。 */
  mapPositions?: Record<string, { x: number; y: number }>;
  /** レビューのコメントを書くときの名前（無ければ git の user.name）。 */
  reviewer?: string;
  /** 最後に開いていたシナリオのファイルと行（起動したときにここへ戻る）。 */
  lastOpen?: { file: string; line: number };
  /** パーツの欄の「お気に入り」（行の並びと、パーツに出す名前）。作品ごとに持つ。 */
  favorites?: StudioFavorite[];
  /** シナリオのファイル → ブックマークを付けた行（行番号と、その行の中身とハッシュ。中身は一覧に出し、ハッシュで行を探し直す）。 */
  bookmarks?: Record<string, StudioBookmark[]>;
  /** 文字数の目標（台詞・地の文・選択肢の字数の合計）。 */
  textGoal?: number;
  /** 日付（YYYY-MM-DD）→ [その日に最初に数えた字数, 最後に数えた字数]（日ごとの進み。client/model/text-progress.ts）。 */
  textDaily?: Record<string, [number, number]>;
  /** ブレークポイント（行番号と、行の中身で追う。client/model/breakpoints.ts）。 */
  breakpoints?: StoredBreakpoint[];
  /** キャラクター ID → 制作画面だけの覚え書き（設定・声優など。ゲームには入れない）。 */
  castNotes?: Record<string, string>;
  /** チェックの画面の「TODO コメント」の対象の言葉（無ければ TODO、FIXME、XXX。client/model/todos.ts）。 */
  todoWords?: string[];
  /**
   * シーンの id（フローチャートと同じ `ファイル#ラベル`。ファイルの頭のシーンは `ファイル`）→ タグ、色、状態（client/model/scene-marks.ts）。
   * フローチャートのカード、シーン一覧の点、絞り込み、⌘K に使う。ゲームには入れない。
   */
  sceneMarks?: Record<string, SceneMark>;
}

/** シーンの状態（下書き、要確認、確認済み）。 */
export const SCENE_STATUSES = ["draft", "review", "done"] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];
/** シーンの色（制作画面の色の名前。Radix の red、amber、grass、blue、violet、pink、mauve）。 */
export const SCENE_COLORS = ["red", "yellow", "green", "blue", "purple", "pink", "gray"] as const;
export type SceneColor = (typeof SCENE_COLORS)[number];

/** シーンの印（どれも省ける。何も無ければ覚えない）。 */
export interface SceneMark {
  status?: SceneStatus;
  color?: SceneColor;
  tags?: string[];
}

/** キャラクターの覚え書きの長さの上限（文字）。 */
export const CAST_NOTE_MAX = 20_000;

/** あふれを計る本文のページ（文字の出し方の部品。実行器の NvlPart と同じ形）。 */
export interface MeasurePage {
  speaker: string | null;
  label?: string;
  parts: ({ text: string; ruby: string | null; style: { bold: boolean; italic: boolean; color: string | null; perChar: number | null; size: number | null; mark: string | null; emphasis?: boolean } } | { br: true })[];
}

/** 覚えたブレークポイント。text は行の中身（前後の空白を除く）、hash はそのハッシュ、cond は止める条件の式（無ければいつも止める）。 */
export interface StoredBreakpoint {
  file: string;
  line: number;
  text: string;
  hash: string;
  cond?: string;
}

export interface StudioFavorite {
  label: string;
  lines: string[];
}

/** ブックマーク。text は一覧に出す行の中身（前後の空白を除き 80 字まで）、hash は行の中身全体のハッシュ（ほかで書き換えたファイルで行を探し直す。client/model/bookmarks.ts）。 */
export interface StudioBookmark {
  line: number;
  text: string;
  hash?: string;
}

/** お気に入りの数の上限（覚え書きが大きくなりすぎないように）。ブックマークもファイルごとにこの数まで。 */
export const FAVORITES_MAX = 200;

/** 顔の切り出し。x・y は立ち絵の画像の中の位置（CSS の background-position の %）、size は画像を顔の枠の何 % の幅で敷くか。 */
export interface FaceCrop {
  x: number;
  y: number;
  size: number;
}

/** 顔の位置を決めていない立ち絵の切り出し（上の真ん中を 2 倍で）。 */
export const FACE_CROP: FaceCrop = { x: 50, y: 6, size: 200 };

// ---- POST /asset（素材を足す） ----

/**
 * POST /asset?kind=fgimage&path=chara/a.png[&overwrite=1]。本文はファイルの中身そのもの。
 * kind は素材のフォルダ（bgimage・fgimage・image・bgm・sound・video・others など、paths.assets の下）。
 * 同じ名前のファイルがあれば、overwrite が無いと 409（exists: true）。
 */
export type AssetUploadResult = { ok: true; kind: string; path: string; undo?: string } | { ok: false; exists: true };

/**
 * 素材の依頼表の一行（POST /assets/requests、GET /assets/requests.csv）。kind は asset（無い素材）、variant（無い立ち絵の差分。name は
 * 差分の名前、既定でない立ち絵セットなら "セット/差分"）、voice（収録していないボイス）。file と line は初めて使う所（キャラクターの定義なら cast.json）。
 */
export interface AssetRequest {
  kind: "asset" | "variant" | "voice";
  folder: string;
  name: string;
  who?: string;
  file: string;
  line: number;
  /** その行の本文（cast.json なら空）。 */
  text: string;
  count: number;
}

/** POST /assets/requests の結果（書いたファイルの作品からのパスと、行の数）。 */
export interface AssetRequestsResult {
  path: string;
  count: number;
}

/** POST /assets/samples の結果（写した素材と、同じ名前があって写さなかった素材。どれも "種類/パス"）。 */
export interface SampleAssetsResult {
  added: string[];
  skipped: string[];
  /** サンプル素材の説明のファイルの名前（プロジェクトの直下。素材について.txt か、原文が英語の作品は SAMPLE-ASSETS.txt）。 */
  note?: string;
}

// ---- 素材の管理（GET /assets/list・GET /assets/usage・POST /assets/rename・/assets/trash・/assets/restore・/assets/folder） ----
// /assets/restore はごみ箱から戻す口で、シナリオのファイルも戻す。

/** 素材のフォルダの中身。files は相対パス（"/" 区切り、名前順）、dirs は中のフォルダ（空のものも）。 */
export interface AssetFolderListing {
  kind: string;
  /** width・height は画像の大きさ（ファイルの頭から読めたときだけ）。 */
  files: { path: string; bytes: number; width?: number; height?: number }[];
  dirs: string[];
}

/** 素材を使っている場所。台本の行・キャストの差分・作品の設定（liminalia.json の extra など）。 */
/** in: "text" は構文では分からず、素材の名前が文字として現れただけのもの（where はシナリオの名前か、作品のフォルダからのパス）。 */
export type AssetUse = { in: "script"; file: string; line: number } | { in: "cast"; who: string } | { in: "config"; where: string } | { in: "text"; where: string; line: number; scenario: boolean };

/** "種類/パス" → 使っている場所。 */
export type AssetUsage = Record<string, AssetUse[]>;

/** 名前を変える（フォルダも可）。参照している台本の行とキャストも書き換える。 */
export interface AssetRenameRequest {
  kind: string;
  from: string;
  to: string;
}

export interface AssetRenameResult {
  /** 動かしたファイル（新しいパス）。 */
  moved: string[];
  /** 参照を書き換えた作品のデータ（data/ の名前。プラグインが形を宣言したもの）。 */
  data?: string[];
  /** 書き換えた台本のファイル。 */
  files: string[];
  /** キャストを書き換えたか。 */
  cast: boolean;
  /** 書き換えられなかった参照（作品の設定・式で書いたものなど。直すのは書き手）。 */
  left: AssetUse[];
  /** 書き換えた liminalia.json の場所（ui・extra・items の素材の参照）。 */
  config?: string[];
  /** 書き換えた作品の CSS（作品のフォルダからのパス。url() と @import）。 */
  css?: string[];
  /** ⌘Z で戻すための控え（POST /undo/apply）。 */
  undo?: string;
}

/** ごみ箱へ（.liminalia/trash/<id>/ に動かす。restore で戻せる）。 */
export interface AssetTrashRequest {
  kind: string;
  path: string;
}

/** 今の見た目をテーマとして保存した結果（POST /ui/theme/save）。同じ名前の作品のテーマがあれば、上書きを頼むまで書かない（exists はその ID）。 */
export type ThemeSaveResult = { ok: true; id: string } | { ok: false; exists: string };

export interface AssetTrashResult {
  id: string;
  /** 動かしたファイル（元のパス）。 */
  moved: string[];
  /** ⌘Z で戻すための控え（POST /undo/apply。素材のごみ箱だけ）。 */
  undo?: string;
}

/**
 * ごみ箱に入れた一つのもの（GET /trash）。kind は素材の種類、シナリオのファイルは "@scenario"（path は "名前.lim"）、
 * テーマは "@themes"（path はテーマの ID、name はその名前）。folder はフォルダごと入れたもの。
 */
export interface TrashItem {
  kind: string;
  path: string;
  folder?: true;
  name?: string;
}

/** ごみ箱の一つの id（一度に入れたもの。POST /assets/restore で戻す）。items は先頭から 20 件まで、total は全部の数。 */
export interface TrashEntry {
  id: string;
  /** 入れた日時（ISO 8601）。 */
  time: string;
  items: TrashItem[];
  total: number;
}

/** まとめてごみ箱へ（POST /assets/trash-many。一つの id に入るので、件数によらずまとめて元に戻せる）。ファイルだけ。 */
export interface AssetTrashManyRequest {
  items: AssetTrashRequest[];
}

// ---- ボイスの割り当て（GET /voices） ----

/** 台詞の行（lim voice-script と同じ決まりでボイスを決めたもの）。exists はそのファイルが素材のフォルダにあるか。pendingAuto は @voice-auto の話者だが番号がまだ固定されていない。 */
export interface VoiceRow extends VoiceScriptRow {
  exists: boolean;
  pendingAuto: boolean;
  /** 読んだときの台詞の行の本文（書く前に、今の行と同じかを確かめる）。 */
  source: string;
  /** 読んだときの @voice の行の本文（無ければ null）。 */
  voiceSource: string | null;
}

/** hashes は行を作ったときの各ファイルの hash（書く前に変わっていないかを確かめる）。 */
export interface VoiceList {
  rows: VoiceRow[];
  hashes: Record<string, string>;
}

// ---- シナリオのファイル（POST /files/create・/files/duplicate・/files/rename・/files/trash） ----
// create は { file, text? }、duplicate と rename は { from, to }、trash は { file } → AssetTrashResult（戻すのは POST /assets/restore）。

export interface ScenarioRenameResult {
  /** 飛び先を書き換えたほかのファイル。 */
  files: string[];
  /** 参照を書き換えた作品のデータ（data/ の名前。プラグインが形を宣言したもの）。 */
  data?: string[];
  /** 「はじめから」のファイルだったので liminalia.json の entry を書き換えた（起動し直すと効く）。 */
  entry: boolean;
  /** 書き換えた liminalia.json の場所（"entry"、"chapters.ch1.files"、"extra.replay.<id>" など）。 */
  config?: string[];
  /** liminalia.json の、書き換えられなかった場所（新しい名前に当たらなくなる章のワイルドカード。直すのは書き手）。 */
  left?: string[];
  /** 書き換えた台本のテスト。 */
  tests?: TestRenameResult;
}

/** 名前の変更で書き換えた台本のテスト（tests/*.limtest）。 */
export interface TestRenameResult {
  /** 書き換えたテストのファイル（作品のフォルダからのパス。tests/start.limtest）。 */
  files: string[];
  /** 書き換えられなかった行（式の中の `#ラベル` だけの飛び先。直すのは書き手）。file は作品のフォルダからのパス。 */
  left: { file: string; line: number }[];
}

/** マクロ（@define）の名前の変更の結果（lim rename macro）。 */
export interface MacroRenameResult {
  /** @define と呼び出しを書き換えたファイル。 */
  files: string[];
  /** 書き換えた行の数。 */
  lines: number;
  /** liminalia.json の commandDefaults の鍵を書き換えた。 */
  config: boolean;
}

// ---- シーン（ラベル）の名前の変更（POST /labels/rename） ----

/** 書き換えられなかった参照のわけ（client/model/label-rename.ts の LeftReason）。 */
export interface LabelLeftRef {
  file: string;
  line: number;
  reason: "expr" | "script" | "plugin" | "conflict" | "ambiguous" | "macro" | "test" | "chapter";
  /** liminalia.json の中のとき、その場所（行は 0）。台本のテストの中のとき（reason が test）は行の番号。 */
  config?: string;
}

export interface LabelRenameResult {
  /** 書き換えたシナリオのファイルと行の数（ラベルの行も数える）。 */
  files: string[];
  /** 参照を書き換えた作品のデータ（data/ の名前。プラグインが形を宣言したもの）。 */
  data?: string[];
  lines: number;
  /** 書き換えた liminalia.json の場所（"entry"・"extra.replay.<id>" など）。 */
  config: string[];
  /** 「はじめから」かロード直後の位置を書き換えた（ゲームには起動し直すと効く）。 */
  entry: boolean;
  /** 訳の鍵を付け替えた言語。 */
  translations: string[];
  /** 書き換えられなかった参照（直すのは書き手）。 */
  left: LabelLeftRef[];
  /** 書き換えた台本のテスト。 */
  tests?: TestRenameResult;
}

/** POST /scenes/move（シーンを別のファイルへ移す・ファイルを分ける）。 */
export interface SceneMoveRequest {
  file: string;
  /** 移すシーン（ファイルの中で続いて並んでいるもの）。 */
  labels: string[];
  /** 移した先のファイル（無ければ作る）。 */
  to: string;
}

export interface SceneMoveResult extends LabelRenameResult {
  /** 移した先のファイルを作った。 */
  created: boolean;
  /** 流れを変えないために足した行（`@jump`・`@stop`・`@use`）。 */
  joins: { file: string; line: number; text: string }[];
}

// ---- 変数（GET /variables・POST /variables/set・POST /variables/rename） ----

/** 変数一つ。台本で使っているものと、初期値を決めたもの。 */
export interface VariableInfo {
  /** "game.x" の形。 */
  path: string;
  scope: "game" | "system" | "temp";
  /** 初期値（liminalia.json の variables）。決めていなければ無い。 */
  initial?: Value;
  /** 値を入れる行・読む行。 */
  writes: { file: string; line: number }[];
  reads: { file: string; line: number }[];
}

/** set は { path, value }（value が null なら初期値を外す。null を初期値にするときは { path, value: null, keep: true }）。rename は { from, to } → { files }。 */

// ---- 作品の設定（GET /settings・POST /settings） ----

/** 制作画面の「作品」の基本と書き出しで直す、liminalia.json の項目。 */
export const SETTINGS_KEYS = ["id", "title", "version", "author", "screen", "entry", "titleScreen", "afterLoad", "allowScript", "saves", "paths", "import", "check", "fmt", "build"] as const;
export type ProjectSettings = Partial<Pick<ProjectConfig, (typeof SETTINGS_KEYS)[number]>>;

/** 書いた結果。restart は開発サーバーを起動し直さないと効かない項目が、起動したときと違うか（書き出しの設定は書き出すときに読むので含めない）。 */
export interface SettingsResult {
  restart: boolean;
}

/**
 * liminalia.json の一部（ゲームの設定 ui・おまけ extra・基本と書き出しの項目）や訳のファイルを読んだもの。hash は書くときに baseHash として返す。
 * 台本の書き込み口と同じく、読んだあとにその部分がほかで変わっていたら書かない（409 で今の中身を返し、画面が合わせ直して書き直す）。
 */
export interface PartRead<T> {
  value: T;
  /** その部分の hash（liminalia.json の一部は JSON にした字面、訳はファイルの字面の hash。訳のファイルが無ければ null）。 */
  hash: string | null;
}

/** 200 { ok: true, hash }（書いたあとの hash）・409 { ok: false, current }（今の中身）。 */
export type PartWrite<T> = { ok: true; hash: string | null } | { ok: false; current: PartRead<T> };

// ---- 設定のファイルそのもの（GET /part-file・PUT /part-file・GET /part-file/history・GET /part-file/history/item） ----

/**
 * 元に戻す（⌘Z とお知らせの「元に戻す」）と変更履歴の欄が扱う、設定のファイル。"@config" は liminalia.json、"@lang/<言語>" は訳のファイル。
 * 前の内容は変更履歴（.liminalia/history/@config/・@lang/<言語>/）に残る。
 */
export type PartFileName = "@config" | `@lang/${string}`;

/** PUT /part-file の本文。baseHash は読んだときの FileText.hash（無かった訳のファイルは空の文字の hash）。訳を空の文字にするとファイルを外す。 */
export interface PartFileWriteRequest {
  part: PartFileName;
  text: string;
  baseHash: string;
}

/**
 * 200 { ok: true, hash, restart }（restart は開発サーバーを起動し直さないと効かない項目が、起動したときと違うか）・
 * 409 { ok: false, current }（読んだあとにほかで変わった。今の中身）。
 */
export type PartFileWrite = { ok: true; hash: string; restart: boolean } | { ok: false; current: FileText };

// ---- おまけ（GET /extra・POST /extra）・翻訳（GET /i18n・GET /i18n/file・PUT /i18n/file・POST /i18n/languages）・プラグイン（GET /plugins・POST /plugins） ----

export interface TranslationStatus {
  /** liminalia.json の languages（先頭が原文の言語）。 */
  languages: string[];
  /**
   * 原文のほかの言語ごとの、訳すもの（シナリオの本文、選択肢、話者名、作品の設定の文字）の数と訳した数。exists は訳のファイルがあるか。
   * ui はシステム画面の文言（日本語と英語のほかの言語だけ）の数と訳した数。
   */
  status: Record<string, { total: number; translated: number; exists: boolean; ui?: { total: number; translated: number } }>;
  /** languages の hash（POST /i18n/languages の baseHash に返す）。 */
  hash: string;
}

export interface TranslationView {
  /** 今の台本に合わせた訳（新しい行は訳を空で足し、使われなくなった訳は引き継ぐか取っておいたもの。updateTranslation）。 */
  file: TranslationFile;
  /** 鍵 → 台本の場所。 */
  where: Record<string, { file: string; line: number }>;
  /** 書いてあるファイルと違う（台本に合わせた形。訳を編集して保存すると、この形で書く）。 */
  outdated: boolean;
  /** 書いてあるファイルの字面の hash（無ければ null）。PUT /i18n/file の baseHash に返す。 */
  hash: string | null;
}

export interface PluginInfo {
  /** liminalia.json の plugins に書いたもの。 */
  spec: string;
  name: string;
  version: string;
  description: string;
  /** 持っている入口（commands・web・import・studio・studio-server）。 */
  entries: string[];
  /** 足す命令（独自タグ）。 */
  commands: string[];
  /** 今の開発サーバーが読んでいるか（足したばかりなら false。起動し直すと読む）。 */
  loaded: boolean;
  /** 作品のフォルダの中に置いたものか（名前・説明を書き換えられ、フォルダを開ける。入れたパッケージは false）。 */
  local: boolean;
  error?: string;
}

/** GET /plugins。hash は liminalia.json の plugins の hash（POST /plugins の baseHash に返す）。 */
export interface PluginList {
  plugins: PluginInfo[];
  hash: string;
}

/** 新しく作るプラグインの入口（命令は必ず作る）。 */
export type PluginPart = "commands" | "web" | "studio";

// ---- 公式のプラグイン（GET /plugins/catalog・POST /plugins/install。アプリに同梱した一覧から入れる） ----

/**
 * 公式のプラグインの一覧の一つ（同梱の catalog.json と、作品に入れてあるかどうか）。
 * 入れると作品の plugins/<id> に写し、liminalia.json の plugins に ./plugins/<id> を足す（起動し直すと効く）。
 */
export interface CatalogPluginInfo {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  /** 同梱の版。 */
  version: string;
  /** 持っている入口（commands・web・import・studio・studio-server）。 */
  entries: string[];
  /** 作品の plugins/<id> に入れてある版（入れていなければ null）。 */
  installed: string | null;
  /** liminalia.json の plugins に ./plugins/<id> があるか。 */
  added: boolean;
  /** 入れてある版より同梱の版が新しい。 */
  update: boolean;
  /** 入れられないわけ（同梱のフォルダが無い、plugins/<id> に別のプラグインがある など）。 */
  error?: string;
  /** このアプリに同梱していない（開発用の取り出しなどで、同梱のフォルダが無い）。画面では誤りではなく「含まれていない」と出す。 */
  unavailable?: true;
}

/** 入れた結果。 */
export interface CatalogInstallResult {
  spec: string;
  version: string;
}

// ---- キャラクターの名前の変更（POST /cast/rename） ----

/**
 * キャスト名・話者名を変える。kind が cast ならキャスト名（cast.json のキー と 台本のキャスト型の引数）、
 * speaker なら本文の行の話者名（cast.json の speakers・キャストの speaker と、台本の話者の行の頭）。
 */
export interface CastRenameRequest {
  kind: "cast" | "speaker";
  from: string;
  to: string;
  /** キャラクター ID（kind が cast）を変えるとき、同じ名前の表示名も to に変える（一つの操作として ⌘Z で戻す）。 */
  speakerToo?: boolean;
}

/**
 * キャラクターを使っている場所。cast はキャスト名 → 台本の行、speakers は話者名 → 台詞の数、
 * variants はキャスト名 → 立ち絵セット → 差分 → 差分を書いた行の数（@chara などに差分を書いた回数。立ち絵セットを省いた行は、
 * 既定の立ち絵セットにその差分があればそこ、無ければその差分を持つ最初の立ち絵セットに数える）。
 */
export interface CastUsage {
  cast: Record<string, { file: string; line: number }[]>;
  speakers: Record<string, number>;
  variants?: Record<string, Record<string, Record<string, number>>>;
}

/**
 * マクロを使う行（GET /macro/uses?name=）。kind は呼び方（行の @名前、@with 名前、本文の中の {@名前}）、text は行の字面（前後の空白を除く）。
 * ファイルの名前順、行の順。
 */
export interface MacroUse {
  file: string;
  line: number;
  kind: "command" | "with" | "inline";
  text: string;
}

/** 話者の一つの台詞（GET /cast/lines。キャラクターの画面の「台詞」）。text はルビの親文字だけの字面。 */
export interface SpeakerLine {
  file: string;
  line: number;
  speaker: string;
  text: string;
}

export interface CastRenameResult {
  /** 書き換えた台本のファイル。 */
  files: string[];
  /** 参照を書き換えた作品のデータ（data/ の名前。プラグインが形を宣言したもの）。 */
  data?: string[];
  /** 書き換えた行の数。 */
  lines: number;
  /** 書き換えた台本のテスト（話者名の変更で、話者名と比べる expect text）。 */
  tests?: TestRenameResult;
  /** ⌘Z で戻すための控え（POST /undo/apply）。 */
  undo?: string;
}

// ---- 元に戻す（ファイルを動かす操作の控え。server/file-undo.ts） ----

/**
 * ファイルを動かす・書き換える操作（テーマの適用、素材の追加・名前の変更・ごみ箱、キャラクターの名前の変更）が返す控え（undo）の様子。
 * GET /undo/state?id=… の state。applied は操作のあとのまま、undone は戻したまま、changed はそのあとでほかに変わった、gone は覚えていない
 * （開発サーバーを起動し直した、古くなった）。
 */
export type UndoJournalState = "applied" | "undone" | "changed" | "gone";

/** POST /undo/apply（{ id, to }）。to が "undone" なら戻し、"applied" ならやり直す。今の様子が違えば ok: false と今の様子。 */
export type UndoJournalApply = { ok: true } | { ok: false; state: UndoJournalState };

/** 元に戻すの控えが使えるところ（制作画面が ⌘Z の並びに入れる。名前は edit-undo.ts の UndoStep の file）。 */
export const UNDO_JOURNAL_PREFIX = "@files/";

// ---- POST /reload ----

/**
 * 外で変わった作品を読み直した結果。シナリオ・キャスト・素材は開発サーバーのまま読み直せる。
 * 作品の設定（liminalia.json）か命令のプラグインのコードが変わっていたら、開発サーバーを起動し直さないと反映できない（restart）。
 */
export type ReloadResult = { ok: true; project: ProjectInfo } | { ok: false; restart: "config" | "plugins" };

export interface ImportResult {
  /** 未対応・手作業・構文や検査の誤りが無く、本文がすべて一致したか。 */
  ok: boolean;
  files: number;
  /** 本文が .ks と一字一句同じだったファイルの数。 */
  matched: number;
  /** 汎用の形で書き出した未対応のタグの数。 */
  unmapped: number;
  /** 手作業が要る箇所・読み直しの構文の誤り・命令の検査の誤り（先頭の 100 件）。 */
  problems: string[];
  /** 報告の全文を書いたファイル。 */
  reportPath: string;
}

// ---- レビューのコメント（GET /reviews・POST /reviews） ----

/**
 * シナリオの行に付けるコメントのまとまり（スレッド）。プロジェクトの reviews/<id>.json に一つずつ置く
 * （git で共有でき、別々の人が別のスレッドを足しても衝突しない）。書き出すゲームには入らない。
 * どの行かは、行番号と、行の中身（前後の空白を除いたもの）とそのハッシュで持つ。行が動いてもハッシュで同じ行を探し、
 * 書き換えられていれば似ている行を探す（画面の model/reviews.ts）。
 */
export interface ReviewThread {
  id: string;
  /** シナリオの名前（拡張子なし）。 */
  file: string;
  /** 付けたとき（か、行が書き換えられて付け直したとき）の行（1 始まり）。 */
  line: number;
  /** その行の中身（前後の空白を除いたもの）と、そのハッシュ（@liminalia/lang の textHash）。 */
  text: string;
  hash: string;
  /** 範囲（二行以上）に付けたときの最後の行。行と中身とハッシュは line・text・hash と同じ決まり。 */
  end?: { line: number; text: string; hash: string };
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  comments: ReviewComment[];
}

export interface ReviewComment {
  id: string;
  /** 書いた人の名前（制作画面の覚え書きの reviewer、無ければ git の user.name）。 */
  author: string;
  /** ISO 8601。 */
  time: string;
  body: string;
  /** 書き直した時刻（ISO 8601。書き直していなければ無い）。 */
  edited?: string;
  /** テスト版の指摘から取り込んだもの（build は指摘したテスト版のバージョンとエディション）。 */
  feedback?: { build?: string };
  /** 付いているスクリーンショット（reviews/ からの相対パス。GET /reviews/shot?path= で読む）。 */
  image?: string;
}

/** POST /reviews/import の結果。skipped は取り込まなかったもの（format 形が違う、project 別のプロジェクト、file 無いシナリオ、duplicate 取り込み済み）。 */
export interface FeedbackImportResult {
  imported: number;
  skipped: { name: string; reason: "format" | "project" | "file" | "duplicate" }[];
  list: ReviewList;
}

export interface ReviewList {
  /** 古いものから。 */
  threads: ReviewThread[];
  /** この制作画面で書くときの名前（空なら名前なし）。 */
  author: string;
}

/** POST /reviews の頼み。返すのは ReviewList。 */
export type ReviewAction =
  /** end は範囲（二行以上）に付けるときの最後の行と、その中身。 */
  | { kind: "create"; file: string; line: number; text: string; body: string; end?: { line: number; text: string } }
  | { kind: "reply"; id: string; body: string }
  | { kind: "resolve"; id: string; resolved: boolean }
  /** コメントを消す（スレッドのコメントが無くなればスレッドごと）。 */
  | { kind: "delete"; id: string; comment: string }
  /** 自分のコメントを書き直す。 */
  | { kind: "edit"; id: string; comment: string; body: string }
  /** 行が書き換えられたときに、今の行へ付け直す（範囲なら end も）。 */
  | { kind: "anchor"; id: string; line: number; text: string; end?: { line: number; text: string } };

// ---- 開発サーバーからの知らせ（STUDIO_EVENT） ----

export type StudioEvent =
  /**
   * ディスクのファイルが変わった（ほかのエディタ・AI・取り込み、制作画面の書き込み）。by は書いた画面の id（STUDIO_WINDOW_HEADER。
   * 制作画面が開発サーバーに書かせたとき）。書いた画面は自分の by を読み飛ばす。
   */
  | { type: "file-changed"; file: string; hash: string; by?: string }
  | { type: "file-added"; file: string; by?: string }
  | { type: "file-removed"; file: string; by?: string }
  /** cast.json が変わった。 */
  | { type: "cast-changed" }
  /** liminalia.json の変数の初期値が変わった。 */
  | { type: "variables-changed" }
  /** liminalia.json（変数の初期値のほか）、訳のファイル、ボイスの番号の固定が変わった。検査を取り直す。 */
  | { type: "config-changed" }
  /** 素材のフォルダにファイルが増えた・減った。 */
  | { type: "assets-changed" }
  /**
   * 検査が読む作品の画面のファイル（作品の CSS と @import の先、url() の指すもの、画面のテンプレートと画面の JS）が変わった
   * （外の書き込みも、制作画面の欄の保存も）。検査とゲームの画面のタブを取り直す。
   */
  | { type: "screens-changed" }
  /** 作品のデータ（paths.data の .json）が変わった。by は書いた画面の id（制作画面の書き込みのとき。書いた画面は読み飛ばす）。 */
  | { type: "data-changed"; name: string; by?: string }
  /** レビューのコメント（reviews/）が変わった（画面自身の書き込みも、git で取り込んだものも）。 */
  | { type: "reviews-changed" }
  /** 制作画面の共有するデータ（.liminalia/shared.json）が変わった（git で取り込んだ共同作者の変更も）。 */
  | { type: "studio-state-changed" };

// ---- プレイヤー（舞台の iframe）との受け渡し（postMessage） ----

/** 画面 → プレイヤー（`/?studio=1` で開いたもの）。 */
export type StageMessage =
  /** この状態から始めて、そのページを出して止まる（クリック待ち）。 */
  | { type: "liminalia:stage-show"; save: SaveData }
  /**
   * 本文を出さずに、この舞台の様子の画面だけを組み立てる（命令の行を実行した直後）。プレイヤーは実行器を進めず、
   * 今のプレイを止めてから、描画側の組み立て直し（ロードと同じ restore と、プラグインの restorers）だけで出す。メッセージ枠の本文は空。
   */
  | { type: "liminalia:stage-still"; stage: StageState; next?: SaveData }
  | { type: "liminalia:stage-cast"; cast: Cast }
  /**
   * 舞台を止める。今の画面のまま、音（BGM・効果音・動画）と動いている演出（アニメーション・文字送り・オート・待ち）を止め、
   * 舞台への入力も受けない。止めている間、画面は stage-show・stage-still を送らない。
   */
  | { type: "liminalia:stage-pause" }
  /** 止めた舞台を続きから動かす（画面はこのあと、そのときのカーソルの行を送り直す）。 */
  | { type: "liminalia:stage-resume" }
  /** 舞台の音を消す・戻す（止めずに聞こえなくするだけ）。舞台を作り直しても保つ。 */
  | { type: "liminalia:stage-mute"; muted: boolean }
  /**
   * ブレークポイント（すべてのファイルの分）。舞台が自分で進んでいるあいだに、この行の命令を実行する直前で舞台を止め、
   * stage-break を返す。stage-resume で、その命令から続ける。
   */
  | { type: "liminalia:stage-breakpoints"; points: { file: string; line: number; /** 止める条件の式（真のときだけ止める。読めない・評価できない式なら止める）。 */ cond?: string }[] }
  /** ブレークポイントで止めているとき、その命令を実行して次の命令の前でまた止める（一つずつ進める）。止めていなければ何もしない。 */
  | { type: "liminalia:stage-step" }
  /** 本文のページがメッセージウィンドウからあふれるかを計る（stage-measured で返す。今の端末・ゲームの設定・テーマで計る）。 */
  | { type: "liminalia:stage-measure"; id: number; pages: MeasurePage[] }
  /**
   * プレビューで動いている実行器の変数（game.・temp.・system.）の値を変える。ファイルや初期値には書かない。止めている間（ブレークポイント・一時停止）も効き、
   * 続けるとその値で進む。stage-show・stage-still で組み立て直すと元に戻る。stage-var-set を返す。
   */
  | { type: "liminalia:stage-set-var"; path: string; value: Value };

/**
 * プレイヤー → 画面。stage-shown の at は出し始めたページ（選択肢ならその選択肢）の位置。
 * 着く前にプレイが終わったときは null（システム画面が位置を出さないまま待ちの上限を過ぎたときは実行器の今の位置）。
 * プレイヤーは `?studio=1` のとき、書き手が舞台を押すまで入力（focus）を取らない。
 */
export type StageReply =
  | { type: "liminalia:stage-ready" }
  | { type: "liminalia:stage-shown"; at: { file: string; line: number } | null; system?: Record<string, Value> }
  /** stage-still の画面を組み立て終えた。 */
  | { type: "liminalia:stage-still-shown" }
  /** stage-measure の答え（pages と同じ順）。 */
  | { type: "liminalia:stage-measured"; id: number; results: { overflow: boolean; lines: number; fits: number }[] }
  /** stage-pause・stage-resume・stage-mute を受けて、今そうなっている。 */
  | { type: "liminalia:stage-controlled"; paused: boolean; muted: boolean }
  /**
   * 舞台が自分で進んで、次のページ（か選択肢）を出し始めた（書き手が舞台を押した・オート・スキップ・選んだ）。
   * stage-show で頼んだページ自体（stage-shown で返すもの）と、stage-still の画面では送らない。画面の追従（台本のカーソルを合わせる）に使う。
   * played はそのページの時点の、舞台で遊んだ状態（追従で合わせた行の事実の欄・道筋に使う）。実行器が無いときは null。
   */
  | { type: "liminalia:stage-progress"; at: { file: string; line: number }; played: StagePlayed | null }
  /** ブレークポイントの行の命令の前で止めた（舞台は止まっている。stage-resume で続ける）。played はその時点の状態。 */
  | { type: "liminalia:stage-break"; at: { file: string; line: number }; played: StagePlayed | null }
  /** stage-set-var の返事。at はプレビューが今出している行、played はその時点の状態。入れられなかったら error（実行器が無い・パスが誤り）。 */
  | { type: "liminalia:stage-var-set"; path: string; value: Value; at: { file: string; line: number } | null; played: StagePlayed | null; error?: string };

/**
 * 舞台で遊んで着いたページ（か選択肢）の時点の状態。変数の出どころと選んだ選択肢は、頼まれたページ（最後の stage-show）から先の分だけを持つ
 * （画面はそのページの現在地の状態に足して使う）。
 */
export interface StagePlayed {
  /** そのページ（選択肢）から再開するセーブ（現在地の LineState.save と同じ時点。舞台の様子は save.stage、ゲーム変数は save.game）。 */
  save: SaveData;
  temp: Record<string, Value>;
  /**
   * 頼まれたページから先で値を入れた変数のパス（"game.trust"）→ その行。後に入れたものほど後ろ。
   * システム画面が実行器に onAssign を渡さない（SystemEnv.onAssign を使わない）ときは空。
   */
  assigned: Record<string, Origin>;
  /** 頼まれたページから先で選んだ選択肢（選んだ順。option は出した選択肢の中の番号）。 */
  choices: RouteStep[];
  /** 実行器が持っている system の変数。 */
  system?: Record<string, Value>;
}

/**
 * ゲームの設定の見本（プレイヤーの ?ui-preview=）が制作画面へ知らせる、設定が効いているか（@liminalia/web の ui-probe.ts）。
 * 差し替えを知らせる画面（WebPlugin の title、splash と、screens の口。glyph はクリック待ちの印（本文の見た目の glyph））。
 */
export type Replaceable =
  | "title"
  | "splash"
  | "config"
  | "saveload"
  | "backlog"
  | "menuBar"
  | "menu"
  | "confirm"
  | "ending"
  | "extra"
  | "flowchart"
  | "indicator"
  | "codex"
  | "toast"
  | "choice"
  | "name"
  | "dialog"
  | "help"
  | "items"
  | "glyph";

export interface UiReport {
  type: "liminalia:ui-report";
  /** 差し替えた画面 → プラグインの名前。 */
  replaced: Partial<Record<Replaceable, string>>;
  /** 確かめた項目（ui の "text.size" の形）。見本に要素が無いものは入らない。 */
  probed: string[];
  /** 確かめた項目のうち、変えても見た目が変わらないもの。 */
  ignored: string[];
}

// ---- ゲームの画面（標準の画面を作り物の中身で開く見本。プレイヤーの ?ui-preview=screen。@liminalia/web の screen-preview/） ----

/** 見本の中身の状態（filled は入った状態、empty は空、long は長い本文と長い名前）。 */
export type ScreenSampleState = "filled" | "empty" | "long";

/**
 * 標準の画面の一つ（GET STUDIO_API/screens。@liminalia/web の system/screen-catalog.ts の一覧と、screen-preview/samples.ts の開き方）。
 * 制作画面は描画側を読まないので、開発サーバーが setScreenTable で渡す。texts から replace は画面の四つの段の口（docs/screens.md の表）。
 */
export interface ScreenInfo {
  id: string;
  name: { ja: string; en: string };
  /** 作るパッケージ（web は標準のシステム画面、std は標準の命令）。 */
  owner: "web" | "std";
  /** 見本で開けるか。開けなければ why に理由。 */
  opens: boolean;
  /** 入った状態のほかに用意した状態。 */
  states: Exclude<ScreenSampleState, "filled">[];
  why?: { ja: string; en: string };
  texts: readonly string[];
  theme: readonly string[];
  classes: readonly string[];
  vars: readonly string[];
  systemVars?: boolean;
  /** システム画面の共通の変数の名前（systemVars の画面だけ。CSS の欄の補完に使う）。 */
  systemVarNames?: readonly string[];
  replace: readonly string[];
  /** 画面の部品（見本の上で押して選ぶもの）。具体的なものから並ぶ（押した要素から closest で探し、先に当たったもの）。 */
  parts: readonly ScreenPartInfo[];
}

/** 画面の部品の一つ（@liminalia/web の system/screen-catalog.ts の ScreenPart）。 */
export interface ScreenPartInfo {
  name: { ja: string; en: string };
  /** 部品の CSS のセレクタ。 */
  selector: string;
  /** 見た目を決めるテーマの値（ui の中の道筋と、値を入れる CSS の変数）。空ならテーマの値では変えられない。 */
  values: readonly { path: string; var?: string }[];
}

/**
 * ゲームの画面の見本（プレイヤーの ?ui-preview=screen）が制作画面へ知らせる、開いた様子。開き直すたびに loading から送り直す。
 * 撮影の道具は、同じものを window.__liminaliaScreenPreview と html の data-lm-screen-preview（ready か failed）で読める。
 */
export interface ScreenPreviewReport {
  type: "liminalia:screen-preview";
  /** 画面の id（ScreenInfo の id）。 */
  screen: string;
  state: ScreenSampleState;
  /** loading は開いている途中、ready は開き終えた、failed は開けなかった（problems に理由）。 */
  status: "loading" | "ready" | "failed";
  /** プラグインが差し替えた画面の id → プラグインの名前（どの画面の分も）。 */
  replaced: Record<string, string>;
  /** 開けなかった理由と、ページで出た例外。 */
  problems: string[];
}

/**
 * 制作画面からゲームの画面の見本への頼み。screen-draft は欄を引いている間の見た目で、ui をその設定で当てる（保存はしない。
 * 保存すれば開発サーバーの知らせで当て直し、同じ画面を開き直す）。見本で当てているテーマは、その上に重ねる。
 * css は、部品の欄で保存する前の作品の CSS の行（「セレクタ { 性質: 値; }」を並べたもの）。作品の CSS のさらにあとに当てる（空なら外す。省けばそのまま）。
 * cssFile は、CSS の欄で保存する前の作品の CSS のファイルの中身（file は ui.css に書くパス。url() は見本で読める URL に直したもの）。
 * そのファイルの中身の代わりに当てる（ui.css にまだ無いファイルなら、作品の CSS の終わりに足す）。null なら外す。省けばそのまま。
 * template は、テンプレートの欄で保存する前の画面のテンプレート（screen は ui.templates の鍵、html はファイルの中身）。その画面の作品のテンプレートの
 * 代わりに使い、同じ画面を開き直す。null なら外す。省けばそのまま。
 */
export type ScreenPreviewMessage = { type: "liminalia:screen-draft"; ui: UiConfig; css?: string; cssFile?: { file: string; css: string } | null; template?: { screen: string; html: string } | null };

// ---- 作品の画面のテンプレート（ゲームの画面のタブのテンプレートの欄。docs/design/screen-templates.md の「写し出し」） ----

/** その画面を先に差し替えるプラグイン（後のプラグインが勝つ。theme はテーマの中の口のとき）。 */
export interface ScreenOverride {
  plugin: string;
  /** 差し替える口（"screens.confirm"、"system" など）。 */
  hook: string;
  theme?: string;
}

/** 画面のテンプレートと画面の JS（GET /screens/files）。 */
export interface ScreenFiles {
  screen: string;
  /** ui.templates に登録しているか（使われる場所を指す値だけ）。 */
  registered: boolean;
  /** ui.templates に書いてあるが、使われない値（.html でないもの、作品の外を指すもの）。無ければ null。 */
  misregistered: string | null;
  template: { file: string; text: string | null };
  script: { file: string; text: string | null };
  /** テンプレートのファイルの絶対パス（デスクトップ版がフォルダを開くのに使う）。 */
  path: string;
  overriddenBy: ScreenOverride | null;
}

/** 写した結果（POST /screens/copy）。 */
export interface ScreenCopyResult {
  file: string;
  parts: string[];
  registered: boolean;
  undo?: string;
}

/** 標準に戻した結果（POST /screens/reset）。moved は名前を変えて残したファイル。 */
export interface ScreenResetResult {
  unregistered: boolean;
  moved: { from: string; to: string }[];
  undo?: string;
}

/** 写した元の版から今の標準で変わったところ（@liminalia/project/screen-copy の StandardChange と同じ形）。 */
export type ScreenStandardChange = { from: number | undefined; now: number; diff: string } | { from: number | undefined; now: number; missingOriginal: true };

/** 標準との違い（GET /screens/diff。lim screens diff と同じ中身）。 */
export interface ScreenDiffInfo {
  screen: string;
  file: string;
  parts: { part: string; version: number | undefined; standardVersion: number | undefined; authorDiff: string; standardChange: ScreenStandardChange | null }[];
}

// ---- 配置の編集（ゲームの設定のプレビュー ?ui-preview=page・choice に layout=1 を付けたもの。@liminalia/web の layout-probe.ts） ----

/** 矩形（px）。 */
export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** プレビューの上で動かせるもの。hudButton と hudText は常駐の表示（@hud-button・@hud-text。シナリオのその行のパラメータを書き換える）。 */
export type LayoutKind = "message" | "name" | "face" | "choices" | "menuBar" | "sprite" | "hudButton" | "hudText";

/** 立ち絵の配置の手がかり（cast.json の、その差分の枠の立ち位置を書き換える）。 */
export interface LayoutSprite {
  who: string;
  appearance: string;
  variant: string;
  /** 立ち位置の名前。 */
  at: string;
  /** 差分に枠（frame）があるか。無ければ画像の実寸で画面下の中央に出ている。 */
  framed: boolean;
  /** 画像の実寸（枠を作るときに使う）。 */
  natural: { width: number; height: number };
  /** 立ち位置で置いているか（auto や @chara の x・y で置いた立ち絵は、枠を直しても動かない）。 */
  movable: boolean;
}

/**
 * プレビューの上の一つのもの。rect はプレビューのページの中の矩形（その iframe のビューポートの px）。
 * values は今の値: ui の項目は文字と枠の座標の px（message は x・y・width・height、name は x・y、face は x・y・width・height、
 * choices は y・width、menuBar は x・y）、立ち絵と常駐の表示は舞台の座標の px（立ち絵の x・y は枠の左上。常駐のボタンは x・y・width・height、文字は x・y）。
 */
export interface LayoutItem {
  id: string;
  kind: LayoutKind;
  rect: LayoutRect;
  values: Record<string, number>;
  sprite?: LayoutSprite;
  /** 常駐の表示の名前（@hud-button・@hud-text の name）。 */
  hud?: string;
}

/** プレビューが知らせる、今の配置。stage は舞台の矩形（ページの中の px）、screen は作品の画面の大きさ、uiScale は文字と枠の拡大率。 */
export interface LayoutReport {
  type: "liminalia:layout-report";
  stage: LayoutRect;
  screen: { width: number; height: number };
  uiScale: number;
  items: LayoutItem[];
}

/**
 * 制作画面からプレビューへの頼み。layout-probe は今の配置を知らせてもらう。layout-draft は引いている間の見た目
 * （ui はその設定を当てる。sprites は立ち絵を舞台の px でずらして見せる。保存はしない。空の sprites でずらしを外す。
 * hud は常駐の表示（"button:<名前>"・"text:<名前>"）をその位置と大きさ（舞台の px）に置く）。
 */
export type LayoutMessage =
  | { type: "liminalia:layout-probe" }
  | { type: "liminalia:layout-draft"; ui?: UiConfig; sprites?: Record<string, { dx: number; dy: number }>; hud?: Record<string, Partial<LayoutRect>> };

/** 文字数と表記ゆれの候補（GET /stats。lim stats と同じ集計）。 */
export interface TextReport {
  stats: TextStats;
  variants: VariantGroup[];
  /** 除外した組（liminalia.json の stats.variants.ignore。POST /stats/unignore で戻せる）。 */
  ignored: string[];
  /** パック（packs/<フォルダ>/scenario）の台本の名前（packs/<フォルダ>/scenario/<台本>）。制作画面では開けないので、画面は位置だけを出す。 */
  packFiles?: string[];
}

// ---- 画面写真（POST /shot）と重さの計測（POST /profile） ----

/**
 * 画面なしのブラウザ（Chromium）が見つからないときの応答の番号（POST /shot・POST /profile）。
 * 画面はこの番号を見て、入れ方を添えた言葉を出す（デスクトップ版はアプリの Electron で開くので、この応答は出ない）。
 */
export const CHROMIUM_MISSING_STATUS = 424;

/**
 * POST /shot の頼み。舞台に最後に頼んだ画面（stage-show のセーブか stage-still の様子）を、作品の画面の大きさ（liminalia.json の screen）で
 * 開いたプレイヤーに同じく頼んで撮り、exports/shots/<ファイル>-<行>.png に書く（同じ名前があれば -2・-3… を付ける）。
 */
export interface ShotRequest {
  /** 名前に使う、台本のファイルと行。 */
  file: string;
  line: number;
  /** 舞台に頼んだもの（stage-show か stage-still）。 */
  show: Extract<StageMessage, { type: "liminalia:stage-show" | "liminalia:stage-still" }>;
  /** 舞台に渡しているキャスト（キャラクターの画面で保存前に変えたもの）。省けば作品の cast.json。 */
  cast?: Cast;
}

export interface ShotResult {
  /** 書いたファイル（作品のフォルダからの相対パス。区切りは /）。 */
  path: string;
  width: number;
  height: number;
}

/** POST /profile の頼み（lim profile と同じ計測）。 */
export interface ProfileRequest {
  /** 始める位置（ファイル[#ラベル]）。省けば liminalia.json の entry。 */
  target?: string;
  /** 進めるページの数（1〜200。既定 30）。 */
  pages?: number;
}

/** 一ページごとの計測。 */
export interface ProfileSample {
  page: number;
  /** その時点の位置（"ファイル:行"）。 */
  at: string;
  fps: number | null;
  memory: number | null;
  dom: number;
  /** そのページまでに読み込んだ素材の数（画像・音・動画・フォント・そのほかの合計）。 */
  resources: number;
  longFrames: number;
}

export type ProfileResourceKind = "image" | "audio" | "video" | "font" | "other";

/** 重さの計測の結果（lim profile の 計測.json、--lang en では profile.json と同じ形）。 */
export interface ProfileReport {
  target: string;
  pages: number;
  samples: ProfileSample[];
  summary: {
    fps: { average: number | null; min: number | null };
    frames: { count: number; long: number; longest: number };
    longTasks: { count: number; total: number } | null;
    memory: { start: number | null; end: number | null; max: number | null; limit: number | null };
    dom: { max: number };
    resources: Record<ProfileResourceKind, { count: number; bytes: number }>;
    slowest: { name: string; kind: ProfileResourceKind; ms: number; bytes: number }[];
  };
}

/**
 * POST /profile が一行ずつ流すもの（StreamLine の event）。進むたびに progress、終わったら done（計測.md・計測.json を書いたフォルダと、
 * 書いた .md のパスつき。英語の表示から計ったときは profile.md・profile.json）。
 * 画面が要求を切ると（やめる）、計測を止めてブラウザを閉じる（何も書かない）。
 */
/** 見た目の確かめ（POST /regress。lim regress と同じ置き場 .liminalia/regress）の結果。ratio は違う画素の割合（0〜1）。 */
export interface RegressResult {
  /** 撮ったシーンの数。 */
  scenes: number;
  /** 基準と比べて変わったシーン（違いの大きい順。file は diff・current・baseline の画像の名前）。 */
  changed: { scene: string; file: string; ratio: number }[];
  /** 基準が無かったので基準にしたシーン。 */
  added: string[];
  failed: { scene: string; error: string }[];
  /** 今の見た目を基準にした（比べていない）。 */
  updated: boolean;
}

/** POST /regress が一行ずつ流すもの。 */
export type RegressEvent = { type: "progress"; done: number; total: number; scene: string } | { type: "done"; result: RegressResult };

/** POST /voice-lock の結果（lim voice-lock と同じ）。speakers が空なら固定するボイスが無い。 */
export interface VoiceLockResult {
  /** 書いたファイル（作品のフォルダからのパス）。 */
  path: string;
  speakers: string[];
  total: number;
  kept: number;
  captured: number;
  carried: number;
  added: number;
  /** ルートによって番号が変わった台詞と、ほかの台詞と同じ番号が鳴った台詞（収録したファイルと合っているか確かめる）。pack はパックの台詞のパックのフォルダ（packs/<フォルダ>。file はパックの scenario からの台本の名前）。 */
  varied: { file: string; line: number; speaker: string; n: number; pack?: string }[];
  /** 読まなかったパックの組み合わせの数（台本のあるパックが多いとき。@liminalia/lang の skippedPlaySets）。 */
  skippedSets: number;
}

export type ProfileEvent =
  | { type: "progress"; page: number; pages: number; at: string }
  | { type: "done"; report: ProfileReport; folder: string; file?: string };
