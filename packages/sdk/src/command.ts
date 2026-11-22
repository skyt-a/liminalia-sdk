import type { Diagnostic, ParamType } from "@liminalia/lang";
import { SKIP_PARAM } from "./lang.ts";
import type { Args, CommandContext, Value } from "@liminalia/runtime";

/**
 * プラグインの命令の定義。この一つの表から
 * - 命令の仕様（検査・補完・リファレンス）
 * - 実行時の処理（状態の更新と描画側への通知）
 * を作る。見た目はプラグインの描画側（WebPlugin の renderers）が担う。
 * TyranoScript の .ks のタグからの変換は書き出すゲームに入れないので、ここには書かず、
 * プラグインの "./import"（@liminalia/ks-import の TyranoImportProfile の mappings）に書く。
 */

export interface ParamDefinition {
  type: ParamType;
  /**
   * 既定値（.lim の書き方）。取り込み元の .ks のタグがあるなら、そのタグで省略したときの値と同じにしておく
   * （取り込みは「.ks に書かれていた値のうち、既定値と違うもの」を書き出す）。
   */
  default?: string;
  required?: boolean;
  doc: string;
  /** 英語の説明（任意。無ければ英語の表示でも doc を出す）。 */
  docEn?: string;
}

export interface CommandDefinition {
  /** .lim の命令名。 */
  name: string;
  summary: string;
  /** 英語の要約（任意。無ければ英語の表示でも summary を出す）。Studio と VS Code の英語表示、lim reference --lang en が読む。 */
  summaryEn?: string;
  positional?: string[];
  /** 位置引数を埋めたあとの名前なしの値一つを受ける引数（名前を付けても書ける。対象を取らない命令の時間など）。 */
  bare?: string;
  params: Record<string, ParamDefinition>;
  example: string;
  /**
   * 英語の例（任意。無ければ英語の表示でも example を出す）。例に人物の名前や見せる文字があるときに、それを英語にして書く。
   * Studio と VS Code の英語表示、lim reference --lang en が読む。
   */
  exampleEn?: string;
  /**
   * 引数に wait がないときに、演出の終わりを待つか。引数 wait を持つ命令は、省略するとその既定値になる。
   * run で処理を差し替える命令も、ctx.present に渡す待ちと合わせて書く（制作画面の演出の流れとリファレンスが読む）。
   */
  waits?: boolean;
  /**
   * この命令でプレイが終わる（タイトルへ戻る・ゲームを終えるなど。あとの行へは進まない）。制作画面の地図は、
   * この命令で終わる場面を「終わり」にして、次の場面へ矢印を引かない（バッドエンドの場面などが別の枝として出る）。
   */
  ends?: boolean;
  /**
   * 組み込みの命令か、先に読んだプラグイン（標準の命令 @liminalia/std など）の同じ名前の命令を、わざと置き換えるときに true。
   * 書かずに同じ名前の命令を作ると、lim check と制作画面のチェックが警告する（plugin-replaces-command。標準の命令が増えて名前がぶつかったときに気づくため）。
   */
  replaces?: boolean;
  /** 制作画面のパーツの欄の区切り（screen・sprite・sound・motion・flow・system）。省くと「カスタムコマンド」に並ぶ。 */
  category?: string;
  /** やりたいことの言葉（「揺らす」「暗転」など）。パーツの欄で探すときと、AI が命令を選ぶときに使う。 */
  keywords?: string[];
  /** やりたいことの言葉の英語（任意。Studio の英語表示でパーツを探すとき）。 */
  keywordsEn?: string[];
  /**
   * セーブに残す状態の更新（stage.extra を書き換える）。
   * ロードしたとき描画側は stage.extra から画面を組み立て直す。
   */
  apply?(args: Args, extra: Record<string, Value>): void;
  /** 実行時の処理を丸ごと差し替える（結果を変数に入れる・飛ぶなど）。 */
  run?(args: Args, ctx: CommandContext): Promise<void>;
  /**
   * 自動確認（lim playtest・lim shot・全ルートテスト）での進め方。人が操作せずに流すとき、ctx.present は描画側（renderers）に描かせずに
   * これを呼び、返した値を描画側の答えの代わりにする（args は ctx.present に渡したもの）。遊ぶ人の操作を待つ画面（行き先を選ぶ地図、
   * 調べる画面、ミニゲーム）や、飛ばしたい長い演出の命令に書く。
   * 何も返さなければ答えなし。ctx.pick・ctx.choose で行き先を選ぶ命令は、ふつうの選択肢と同じく自動確認が選ぶ（lim playtest は
   * 実行ごとに選び方を変え、--choose でも選べる）ので、`autoplay: () => undefined` だけでよい。ミニゲームの結果のように答えが要るなら、それを返す。
   */
  autoplay?(args: Args, ctx: CommandContext): Value | void | Promise<Value | void>;
  /**
   * この命令が飛ぶかもしれない先（`#ラベル`・`ファイル`・`ファイル#ラベル`）。台本だけではわからない飛び先（作品のデータで
   * 決まる選択など）を、制作画面の地図が矢印にするのに使う（実行には使わない）。args は台本に書いた値（書いたままの文字列。
   * 位置引数も名前で引ける）、data は作品のデータ（paths.data の .json。無ければ undefined）を読む。
   * leaves を true にすると、この命令のあとの行へは進まない（かならずどれかへ飛ぶ）とみなす。
   */
  targets?(args: Readonly<Record<string, string>>, data: (name: string) => unknown): { targets: string[]; leaves?: boolean };
  /**
   * この命令の一行ごとの検査（lim check・lim build・制作画面のチェックが、台本のこの命令の行ごとに呼ぶ）。引数の型・必須・素材の実在など、
   * 仕様（params）で決まることはエンジンが確かめるので、ここには引数どうしの組み合わせや作品のデータとの突き合わせを書く。
   * args は台本に書いた値（書いたままの文字列。位置引数も名前で引ける。式で書いた引数は入らない）。返した診断の file・line を省くと、この行になる。
   * 同期の関数で書く。投げてもチェックは止まらず、そのプラグインの診断になる。
   */
  validate?(args: Readonly<Record<string, string>>, ctx: CommandValidateContext): readonly CommandDiagnostic[] | void;
}

/** 命令の一行ごとの検査（CommandDefinition.validate）に渡すもの。 */
export interface CommandValidateContext {
  /** 台本のファイル（拡張子なし）と行。 */
  file: string;
  line: number;
  /** 作品のデータ（paths.data の .json。無ければ undefined）。 */
  data(name: string): unknown;
  /** 素材のフォルダ（image・bgimage など）の中にあるか。 */
  assetExists(folder: string, path: string): boolean;
  /** キャストにある名前か。 */
  isCast(name: string): boolean;
  /** 飛び先（`#ラベル`・`ファイル`・`ファイル#ラベル`）があるか（`#ラベル` はこの行のファイル）。 */
  targetExists(target: string): boolean;
}

/** 命令の一行ごとの検査が返す診断（file・line を省くとその行。code・message・severity は必ず書く）。 */
export type CommandDiagnostic = Pick<Diagnostic, "severity" | "code" | "message"> & Partial<Pick<Diagnostic, "messageEn" | "file" | "line" | "column" | "hint" | "hintEn" | "fix" | "fixes">>;

const withDefault = (p: ParamDefinition, def: string | undefined): ParamDefinition => (def === undefined ? p : { ...p, default: def });

// 定義を短く書くための部品
export const t = {
  /** suggest は入力の候補（制作画面で一覧から選べる。ほかの値も書ける）。 */
  string: (doc: string, def?: string, suggest?: readonly string[]): ParamDefinition => {
    const type = suggest ? { kind: "string" as const, suggest } : { kind: "string" as const };
    return def === undefined ? { type, doc } : { type, default: def, doc };
  },
  /**
   * プレイヤーに見せる文（章題・テロップ・ダイアログの文など）。多言語の作品では、台本に字面で書いた値が訳のファイル（lim i18n）に
   * 「コマンドの文字」として並び、実行するときに遊んでいる言語の訳に替わる（訳が空なら原文のまま）。
   */
  text: (doc: string, def?: string): ParamDefinition => {
    const type = { kind: "string" as const, translate: "text" as const };
    return def === undefined ? { type, doc } : { type, default: def, doc };
  },
  /** 人の名前（話者や相手の名前）。多言語の作品では、訳のファイルの speakers に並ぶ（訳して見せるのは命令の実装。ctx.runtime.translator?.speaker）。 */
  name: (doc: string, def?: string): ParamDefinition => {
    const type = { kind: "string" as const, translate: "name" as const };
    return def === undefined ? { type, doc } : { type, default: def, doc };
  },
  /** 数。range の min・max を書くと、その外の値を lim check が知らせ、制作画面の欄もその幅にする。 */
  number: (doc: string, def?: string, range: { min?: number; max?: number } = {}): ParamDefinition => withDefault({ type: { kind: "number", ...range }, doc }, def),
  /** 整数。range は number と同じ。 */
  int: (doc: string, def?: string, range: { min?: number; max?: number } = {}): ParamDefinition => withDefault({ type: { kind: "int", ...range }, doc }, def),
  bool: (doc: string, def: boolean): ParamDefinition => ({ type: { kind: "bool" }, default: String(def), doc }),
  duration: (doc: string, def?: string): ParamDefinition => (def === undefined ? { type: { kind: "duration" }, doc } : { type: { kind: "duration" }, default: def, doc }),
  color: (doc: string, def?: string): ParamDefinition => (def === undefined ? { type: { kind: "color" }, doc } : { type: { kind: "color" }, default: def, doc }),
  enum: (values: string[], doc: string, def?: string): ParamDefinition =>
    def === undefined ? { type: { kind: "enum", values }, doc } : { type: { kind: "enum", values }, default: def, doc },
  /**
   * 素材のパス。cg を付けると、この素材を出したときに CG として解放する（liminalia.json の extra.cg か extra.cgAuto のフォルダにある画像なら。
   * @bg と同じく、台本に @cg-unlock を書かなくてよい。章末の扉絵など、作品の命令で一枚絵を出すときに使う）。
   */
  asset: (folder: string, doc: string, o: { cg?: boolean } = {}): ParamDefinition => ({ type: o.cg ? { kind: "asset", folder, cg: true } : { kind: "asset", folder }, doc }),
  required: (p: ParamDefinition): ParamDefinition => ({ ...p, required: true }),
  /** 値を入れる変数（`game.x`・`system.x`・`temp.x`）。命令の結果を受け取るときに。lim check が書き方を確かめ、値を入れる変数として数える。 */
  variable: (doc: string, def?: string): ParamDefinition => withDefault({ type: { kind: "variable" }, doc }, def),
  /** 飛び先（`#ラベル`・`ファイル`・`ファイル#ラベル`）。lim check がラベルとファイルの実在を確かめ、制作画面が候補を出し、地図が矢印を引く。 */
  target: (doc: string, def?: string): ParamDefinition => withDefault({ type: { kind: "target" }, doc }, def),
  /**
   * キャストの名前。lim check がキャストにあるかを確かめ、制作画面が一覧から選ばせる。shown を付けると、表示中の立ち絵の人物に効く引数
   * （消す、動かす、揺らす、漫符を付けるなど）として、制作画面の補完がその行で表示中の人物を上に並べる（ほかの人物も候補に残す。検査と実行は変わらない）。
   */
  cast: (doc: string, def?: string, o: { shown?: boolean } = {}): ParamDefinition => withDefault({ type: o.shown ? { kind: "cast", shown: true } : { kind: "cast" }, doc }, def),
  /** 条件。必ず式（`(…)`）で書き、実行するときに評価した真偽が渡る（@if と同じ）。 */
  condition: (doc: string, def?: string): ParamDefinition => withDefault({ type: { kind: "condition" }, doc }, def),
  /**
   * 作品のデータの中の名前（file は paths.data の .json、path はその中の辞書か並びへの道。`places`・`maps/town/spots` のように / で区切る）。
   * 辞書なら鍵、並びなら項目の id を名前とみなし、lim check が実在を確かめ、制作画面が候補を出す。
   */
  dataKey: (file: string, path: string, doc: string, def?: string): ParamDefinition => withDefault({ type: { kind: "string", data: { file, path } }, doc }, def),
  /**
   * 演出をクリックで終わりまで飛ばせるか（skip。既定 true）。時間のかかる演出を出す命令に付ける。
   * 描画側は何もしなくてよい（Element.animate の動きと ctx.delay の待ちは早送りで終わる。自分で動かす演出は ctx.onFastForward）。
   */
  skip: (): ParamDefinition => ({ ...SKIP_PARAM }),
};
