import type { Diagnostic } from "@liminalia/lang";
import type { Position, StageState, VoiceCue } from "./state.ts";
import type { PrefetchItem } from "./prefetch.ts";
import type { Value } from "./value.ts";

export interface TextStyle {
  bold: boolean;
  italic: boolean;
  color: string | null;
  /** 一文字あたりのミリ秒。null はそのときの既定の速さ。 */
  perChar: number | null;
  /** 文字の大きさ（px）。null は既定の大きさ。 */
  size: number | null;
  /** 背景に引く色（蛍光ペン）。 */
  mark: string | null;
  /** 文字の動き（{fx …}。shake・wave・pop・fade・glow）。 */
  fx?: string | null;
  /** 文字の動きの大きさと速さの倍率（{fx … strength= speed=}。書かなければ無い）。 */
  fxStrength?: number;
  fxSpeed?: number;
  /** 傍点（{dot …}）。 */
  emphasis?: boolean;
  /** 本文の中の画像（{img …}。image フォルダからのパス）。このときの text は "\uFFFC"。imageHeight は高さ（px）。 */
  image?: string;
  imageHeight?: number;
}

/** 選択肢の見た目（@choice の選択肢の行の image= x= など）。書かなかったものは入らない。 */
export interface ChoiceLook {
  /** 押せない状態で見せる（locked= が真）。 */
  locked?: boolean;
  image?: string;
  hover?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** 上に乗せたときのカーソルの画像と、出す短い説明（調べる場所）。 */
  cursor?: string;
  tip?: string;
}

/** 同じページで同時に話すほかの話者（PresentEvent の page の with）。 */
export interface CoSpeaker {
  speaker: string;
  /** 名前欄に出す名前（@name、訳）。話者名と同じなら省く。 */
  label?: string;
}

/** 描画側へ渡す出来事。描画側は表示し終えたら（または待たない指定なら即座に）Promise を解決する。 */
export type PresentEvent =
  /**
   * 新しいページ。メッセージ枠を空にして話者名を出す（null は地の文）。voice はこのページで鳴らすボイス（@voice・@voice-auto）。
   * label は話者名の訳（多言語）。出すのは label、話者ごとの処理（ボイスの音量・口パク）は speaker で見る。
   * key はページの鍵（@liminalia/lang の pageKeys。行を足しても変わらない。既読を覚えるのに使う）。
   * with は同じページで同時に話すほかの話者（二つ目のボイスの who。話者と同じ人は入れない）。label はその人の名前欄の名前（話者名と違うときだけ）。
   */
  | { type: "page"; speaker: string | null; label?: string; at: { file: string; line: number }; key?: string; voice?: VoiceCue; with?: CoSpeaker[] }
  | { type: "text"; text: string; ruby: string | null; style: TextStyle }
  | { type: "br" }
  /**
   * 命令を実行した。stage は実行後の状態。wait が true なら演出が終わるまで解決しない。
   * skip は演出の命令に付く。true ならクリックで演出を終わりまで早送りでき、false なら早送りしない（命令の skip=false）。
   * 演出でない命令（音、入力を待つ画面など）には付かない。
   * autoplay は自動確認（Host.automated）で命令の autoplay が答えを出すときに付く。描画側は描かずにすぐ返す（画面なしの記録には残す）。
   * interactive は autoplay を持つ命令（遊ぶ人の操作を待つ画面や動画）を、自動確認でないので描かせるときに付く。描画側は描いている間、
   * 操作待ちの画面を出していると撮影（lim shot）に知らせる。
   * afterPage は、メッセージ枠のページをクリックで送ってから最初に渡す命令に付く（TyranoScript の [p] の改ページと同じく、
   * 描画側はここで前のページの名前と本文を消し、枠は残す。ui.message.keepText か、@bg の keep-text=true なら消さない）。
   */
  | { type: "command"; name: string; args: Record<string, Value>; wait: boolean; stage: StageState; skip?: boolean; autoplay?: boolean; interactive?: boolean; afterPage?: boolean };

export interface Host {
  /** ファイル名（拡張子なし）から .lim の中身を返す。 */
  loadSource(file: string): Promise<string>;
  /**
   * 作品のデータ（paths.data の .json。name はそこからのパスで `.json` を省ける）を JSON として読む。無ければ undefined。
   * 命令は ctx.data で読む（図鑑・調べる場所など、作品のデータで動く標準の命令が使う）。省略可。
   */
  loadData?(name: string): Promise<unknown>;
  /** 命令によっては結果（選ばれた行き先など）を返す。 */
  present(event: PresentEvent, signal: AbortSignal): Promise<Value | void>;
  /** クリック（本文の送り）を待つ。 */
  waitClick(signal: AbortSignal): Promise<void>;
  /**
   * 選択肢から一つ選ぶ。null なら実行を終える。
   * looks は選択肢ごとの見た目（文字のボタンなら null）。画像のボタンや押せる範囲のときだけ渡る。
   * targets は選択肢ごとの飛び先（"ファイル" か "ファイル#ラベル"。式の飛び先などで分からなければ null）。
   * 描画側は使わない。画面なしで流す道筋の探索が、目標に近い選択肢から試すのに使う。
   */
  choose(options: string[], signal: AbortSignal, looks?: (ChoiceLook | null)[], targets?: (string | null)[]): Promise<number | null>;
  /**
   * @choice の選択肢を選んだ（時間切れで default を選んだときも。call=true の選択肢は除く）。text は選んだ選択肢の文（訳したもの。
   * 画像のボタンなどで文が無ければ空）、index は出した選択肢の中の番号。履歴に残すのに使う。省略可。
   */
  chosen?(option: { text: string; index: number }): void;
  /**
   * 選択肢の制限時間（@choice timeout=）を計り、ms だけ経ったら解決する。描画側は、システム画面を開いている間などは
   * 時間を止めておける。signal で打ち切ったら解決しなくてよい。省略すると実時間で計る（画面なしで流すときなど）。
   */
  countdown?(ms: number, signal: AbortSignal): Promise<void>;
  /**
   * この先で使う素材を先に読んでおく（ページを出すたびに呼ぶ）。待たずに返す。省略可。
   * 同じものが何度も来るので、描画側で重複を除く。
   */
  prefetch?(items: PrefetchItem[]): void;
  /** @script を実行する。省略時は実行せず診断を出す。 */
  runScript?(code: string, at: Position): Promise<void>;
  onDiagnostic?(diagnostic: Diagnostic): void;
  /**
   * 自動確認（lim playtest・lim shot・全ルートテストなど、人が操作せずに流す）で動いているか。true なら、autoplay を持つ命令
   * （遊ぶ人の操作を待つ画面や動画）は描かずに、命令の autoplay の答えで進める。画面なしの Host（HeadlessHost）は常に true。
   * 実行器は命令ごとに読み直すので、途中で変えてよい（lim shot は撮る所に着いたら false にして、その画面を描かせる）。
   */
  readonly automated?: boolean;
}
