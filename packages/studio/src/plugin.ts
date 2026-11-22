import type { Cast } from "@liminalia/lang";
import type { AssetIndex, AssetUploadResult, DataText, DataWriteResult, FileInfo } from "./protocol.ts";

/** 欄の境目をドラッグして幅を変えるつまみ（制作画面の目次・右の欄と同じもの）。画面の欄にも使える。 */
export { Splitter, type SplitterOptions } from "./plugin/splitter.ts";
/** 作品のデータを一つの文書として編集する部品（自動で保存・ほかの変更と重ねる・⌘Z）。 */
export { dataDocument, mergeJson, type DataChangeSource, type DataDocument, type DataDocumentOptions } from "./plugin/data.ts";
/** 素材を選ぶ欄（作品の素材の一覧から候補を出し、画像なら見本を添える）。 */
export { assetField, type AssetField, type AssetFieldOptions } from "./plugin/asset-field.ts";
/** 確かめの窓（はい・キャンセル）と、文字を尋ねる窓。制作画面のダイアログと同じ見た目で、画面の言語の文言を出す。 */
export { askConfirm, askText } from "./plugin/dialogs.ts";

/** プラグインの口の版（plugin-version.ts）。 */
export { STUDIO_PLUGIN_API_VERSION } from "./plugin-version.ts";

/**
 * 制作画面（Liminalia Studio）のプラグイン。作品のプラグインのパッケージが exports の "./studio" に default export で置くと、
 * 制作画面の「プラグイン」のタブにその画面が足される。制作画面（開発サーバー）だけが読み、書き出すゲームには入らない。
 *
 * 画面は自分の DOM を el の中に組み立てる。見た目は制作画面と同じ CSS の変数で揃える
 * （色: --sheet・--paper・--el・--el-hover・--rule・--rule-strong・--ink・--ink-soft・--cue・--cue-wash・--cue-selected・--cue-solid・--mark・--ok など、
 * 文字: --fs-s（12px）・--fs-m（14px）・--fs-l（20px、見出し）・--fs-xl（36px）、線: --line、角丸: --r-s・--r-m・--r-l、影: --shadow-pop（今は影を使わないので none）。
 * どれも Radix Colors の段を指す。デザインの段の名前 --bg0〜--bg3・--ln・--ln2・--ink2・--ac・--ac-soft・--ac-solid も使える）。
 * ボタン・入力欄・選択欄は、制作画面の既定の見た目がそのまま効く（button.primary・button.ghost も使える）。
 */
export interface StudioPlugin {
  name: string;
  views?: StudioView[];
  /** シナリオのタブの右の欄に足す欄（書きながら使うもの）。 */
  panes?: StudioPane[];
  /** 上の帯の「その他」のメニューとキーから呼ぶ操作。 */
  commands?: StudioCommand[];
  /**
   * 台本の補完に、書いている場面に合う素材を足す（口の版 4 から）。素材の型のパラメータ（@bg、@se、@bgm など）の値を書く所で呼ばれ、
   * 返した素材は、合う順に補完の候補のいちばん上に並ぶ（5 つまで。いつもの候補はその下にそのまま出る）。
   * 遅くてもよい（いつもの候補は待たずに出て、返ってきたら足す）。続きを打つと signal が止まる。合うものが無ければ空を返す。
   */
  suggestAssets?(request: AssetSuggestRequest, ctx: StudioContext): Promise<AssetSuggestion[]>;
}

/** 補完の場所と、その前後の本文。行は 1 から数える。 */
export interface AssetSuggestRequest {
  file: string;
  line: number;
  /** 命令の名前（"se"）と、値を書いているパラメータの名前。 */
  command: string;
  param: string;
  /** 素材のフォルダ（"sound"）と、その中の素材（フォルダからのパス）。返すのはこの中のもの。 */
  folder: string;
  candidates: readonly string[];
  /** その行より前の台詞と地の文（近い 3 行。上から順）と、後ろの 2 行。飾りの記法はそのまま。 */
  before: readonly string[];
  after: readonly string[];
  signal: AbortSignal;
}

export interface AssetSuggestion {
  /** 素材（フォルダからのパス）。 */
  path: string;
}

/**
 * シナリオのタブの右の欄に、事実の欄などと同じ形のたためる区切りとして並べる欄。はじめはたたんであり、
 * はじめて開いたときに一度だけ mount する。開く・たたむと show・hide を呼ぶ。返すものはプラグインのタブの画面と同じ
 * （navState・restoreNav は使わない）。右の欄は欄ごとにではなく全体で縦に流れるので、高い欄は自分で高さを決める。
 */
export interface StudioPane {
  /** 欄の名前（英小文字・数字・-）。 */
  id: string;
  /** 区切りの見出し。 */
  title: string;
  /** 英語の表示のときの見出し（無ければ title）。 */
  titleEn?: string;
  mount(el: HTMLElement, ctx: StudioContext): StudioViewInstance | void;
}

/** 操作。key を書くとシナリオのタブでそのキーで呼べる（CodeMirror の書き方: "Mod-Shift-j"）。 */
export interface StudioCommand {
  /** 操作の名前（英小文字・数字・-）。 */
  id: string;
  /** メニューに出す名前。 */
  title: string;
  /** 英語の表示のときの名前（無ければ title）。 */
  titleEn?: string;
  key?: string;
  run(ctx: StudioContext): void | Promise<void>;
}

export interface StudioView {
  /** 画面の名前（英小文字・数字・-）。 */
  id: string;
  /** 「プラグイン」のタブの左の欄に出す名前。 */
  title: string;
  /** 英語の表示のときの名前（無ければ title）。 */
  titleEn?: string;
  /** はじめてタブを開いたときに一度だけ呼ぶ。 */
  mount(el: HTMLElement, ctx: StudioContext): StudioViewInstance | void;
}

export interface StudioViewInstance {
  /** タブが前に出た・後ろに下がった。 */
  show?(): void;
  hide?(): void;
  /** 保存待ちの変更をすぐ書く（ウィンドウを閉じる前・「更新」の前）。書けなければ理由の文字列で拒否する。 */
  flush?(): Promise<void>;
  /** 作品が外で変わった（「更新」を押した）。データを読み直す。 */
  refresh?(): void | Promise<void>;
  /**
   * 戻る・進むで戻れる、画面の中の今の場所（開いているフォルダや選んでいる項目など。JSON にできる値）。
   * 画面の中で移る前に ctx.remember() を呼ぶと、制作画面がこれを戻る履歴に残す。
   */
  navState?(): unknown;
  /** 戻る・進むで、navState が返した場所へ戻す（画面はもう前に出ている）。 */
  restoreNav?(state: unknown): void;
}

/** 画面に渡す、制作画面の口。 */
export interface StudioContext {
  /** 作品の情報（「更新」のあとは新しいもの）。 */
  readonly project: StudioProject;
  /** 作品のデータ（paths.data の .json）を読む。無ければ null。 */
  readData(name: string): Promise<DataText | null>;
  /** 作品のデータを書く。baseHash は読んだときの hash（新しいファイルは null）。ほかで書き換えられていたら書かずに今の中身を返す。 */
  writeData(name: string, text: string, baseHash: string | null): Promise<DataWriteResult>;
  /** 素材の URL（画像・音を出すとき）。 */
  assetUrl(kind: string, path: string): string;
  /** 素材を足す（kind は素材のフォルダ、path はその中の相対パス）。同じ名前があれば overwrite のときだけ上書き。 */
  uploadAsset(kind: string, path: string, file: Blob, overwrite?: boolean): Promise<AssetUploadResult>;
  /** 台本のそのファイルのその行を開く（シナリオのタブへ移る）。 */
  openScript(file: string, line?: number): void;
  /** 下の帯にお知らせを出す。 */
  notify(text: string): void;
  /** 画面の中で移る前に呼ぶ。今の場所（navState）を戻る履歴に残す（戻る・進むで動かしている間は何もしない）。 */
  remember(): void;
  /** 作品のデータがほかで変わったとき（ほかのエディタ・AI・git）。止めるときは返り値を呼ぶ。 */
  onDataChanged(listener: (name: string) => void): () => void;
  /** 作品の情報（ファイルの一覧・キャスト・素材の一覧）が変わったとき。止めるときは返り値を呼ぶ。 */
  onProjectChanged(listener: () => void): () => void;
  /**
   * 同じプラグインの開発サーバー側の口（"./studio-server"。../server-plugin.ts）を呼び、JSON の答えを返す（中身が無ければ undefined）。
   * path は "/status" のように name より後ろ。body を渡すと既定のメソッドは POST（JSON にして送る）、無ければ GET。
   * 口が失敗したら、status を持つ Error を投げる。
   */
  server<T = unknown>(path: string, init?: StudioServerInit): Promise<T>;
  /**
   * 開発サーバー側の、流す口（非同期イテレーターを返す口）を呼び、出したものを一つずつ受け取る。
   * ループを抜ける（break）か signal を止めると、口の側の req.signal も止まる。口が途中で失敗したら、status を持つ Error を投げる。
   * ```ts
   * for await (const ev of ctx.stream<AiEvent>("/run", { body: { prompt } })) show(ev);
   * ```
   */
  stream<T = unknown>(path: string, init?: StudioServerInit): AsyncIterable<T>;
  /** シナリオのタブで書いているもの（開いている台本・カーソル・選んでいる範囲）と、その本文の読み書き。 */
  readonly script: StudioScript;
  /** プラグインの口の版（STUDIO_PLUGIN_API_VERSION。これより古い制作画面では undefined）。 */
  readonly apiVersion?: number;
  /** 制作画面の表示の言語（画面の文言をこれに合わせる。口の版 3 から。それより古い制作画面では undefined）。 */
  readonly language?: "ja" | "en";
}

/** シナリオのタブの台本。行は 1 から、行の中の位置（ch）は 0 から数える。 */
export interface StudioScript {
  /** 開いている台本と、カーソルの行・選んでいる範囲。開いていなければ null。 */
  current(): ScriptPosition | null;
  /** 開いている台本の、編集中の本文（まだ保存していないものを含む）。開いていなければ null。 */
  text(): string | null;
  /** 台本を読む（拡張子なし）。開いている台本なら編集中の本文。無ければ null。 */
  read(file: string): Promise<{ file: string; text: string } | null>;
  /**
   * 開いている台本の行を書き換える（まとめて一回の変更として ⌘Z で戻せる。そのあとは自動で保存する）。
   * どれかの行が expect と違えば（書き手がその間に直した）、何も書かずに changed を返す。
   * 開いていない台本は、開発サーバー側の ctx.writeScript で書く。
   */
  apply(edits: ScriptEdit[]): ScriptApplyResult;
  /** 開いている台本を開き直した・カーソルが動いた・選んでいる範囲が変わった。打っている最中は呼ばない。止めるときは返り値を呼ぶ。 */
  onChange(listener: () => void): () => void;
}

export interface ScriptPosition {
  file: string;
  line: number;
  /** 選んでいる範囲（何も選んでいなければ null）。 */
  selection: { from: { line: number; ch: number }; to: { line: number; ch: number }; text: string } | null;
  /** 書き換えられない（取り込みで作った作品の、まだ編集を許していない台本）。 */
  readOnly: boolean;
}

/**
 * 行の書き換え。from〜to の行（両端を含む）を text にする。text は改行を含んでよく、null なら行ごと消す。
 * to を from - 1 にすると、from の行の前に text を足す（from が行数 + 1 なら末尾に足す）。
 * expect は書き換える前の from〜to の行（改行でつないだもの。足すときは ""）。
 */
export interface ScriptEdit {
  file: string;
  from: number;
  to: number;
  expect: string;
  text: string | null;
}

export type ScriptApplyResult =
  | { ok: true }
  /** not-open: 開いていない台本／readonly: 書き換えられない／changed: 行が expect と違う／invalid: 行の範囲がおかしい・重なっている。index はどの書き換えか。 */
  | { ok: false; reason: "not-open" | "readonly" | "changed" | "invalid"; index?: number };

export interface StudioServerInit {
  /** 省けば、body があれば POST、無ければ GET。 */
  method?: string;
  /** JSON にして送る。 */
  body?: unknown;
  signal?: AbortSignal;
}

export interface StudioProject {
  id: string;
  title: string;
  screen: { width: number; height: number };
  files: FileInfo[];
  cast: Cast;
  assets: AssetIndex;
}

/** 型を付けるだけ（そのまま返す）。 */
export function defineStudioPlugin(plugin: StudioPlugin): StudioPlugin {
  return plugin;
}

// プラグインの約束（@liminalia/sdk/studio）が呼ぶ画面の部品の実装を登録する
import { provide as provideToSdk } from "@liminalia/sdk/host";
import { assetField as assetFieldForSdk } from "./plugin/asset-field.ts";
import { dataDocument as dataDocumentForSdk, mergeJson as mergeJsonForSdk } from "./plugin/data.ts";
import { askConfirm as askConfirmForSdk, askText as askTextForSdk } from "./plugin/dialogs.ts";
import { Splitter as SplitterForSdk } from "./plugin/splitter.ts";
provideToSdk("studio", { Splitter: SplitterForSdk, dataDocument: dataDocumentForSdk, mergeJson: mergeJsonForSdk, assetField: assetFieldForSdk, askConfirm: askConfirmForSdk, askText: askTextForSdk });
