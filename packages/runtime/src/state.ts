import type { TextStyle } from "./host.ts";
import type { TextOrigin } from "./retranslate.ts";
import type { Scope, Value } from "./value.ts";
import { SAVE_VERSION } from "./save.ts";
export { voiceFile } from "@liminalia/lang";

export interface Position {
  /** Unit の id（"chapter1" や "chapter1::title-card"）。 */
  unit: string;
  /** 次に実行する命令の位置。 */
  index: number;
  /**
   * セーブした場所の目印（本文・選択肢の行と、その文から作る鍵）。作品を更新して台本の行がずれても、
   * ロードで同じページを探して再開する（Runtime.load）。セーブのときだけ付ける。
   */
  anchor?: {
    line: number;
    key: string;
    /** 呼び出しの戻り先の目印のとき、目印は戻り先の一つ前の命令（呼んだ命令。鍵は命令の名前と引数）。 */
    after?: boolean;
  };
}

/** 吹き出しの置き方（@balloon on）。 */
export interface Balloon {
  width?: number;
  /** 話者の立ち絵が出ていないときに置く左上（px）。書かなければ、立ち絵の無い台詞はメッセージ枠で出す。 */
  x?: number;
  y?: number;
  /** 尾の向き（立ち絵の無い吹き出しのもの。auto は下。立ち絵があれば立ち絵へ向ける）・尾を出さない（none）。 */
  tail?: "auto" | "down" | "up" | "none";
  /** 尾の位置（吹き出しの左端からの px）。書かなければ立ち絵の真ん中（立ち絵が無ければ吹き出しの真ん中）。 */
  tailX?: number;
}

export interface Sprite {
  /** 差分（表情・ポーズ）。 */
  variant: string;
  /** 立ち絵セット。空文字はキャストの既定（描画側が defaultAppearance → default → 最初のもの、の順に選ぶ）。 */
  appearance: string;
  /** 立ち位置。差分の枠の positions の名前か "auto"（auto の立ち絵どうしで横に並べる。並べ方は描画側が状態だけから決める）。 */
  at: string;
  /** 位置未指定で新しい自動配置に入った人物。明示位置の人物と区別し、セーブにも残す。 */
  autoLayout?: boolean;
  /**
   * 自動配置の枠（何人の並びの左から何番目か）。新しく来た人物を入れる場所、退場しても動かさない並べ方、人物ごとの定位置を
   * 使う作品だけが残す（@liminalia/lang の assignAutoSlots）。
   */
  autoSlot?: { index: number; count: number };
  flip: boolean;
  /** 左端・上端の位置（px）。あれば at より優先する。 */
  x?: number;
  y?: number;
  /** 大きさ（px）。あれば差分の大きさより優先する。 */
  width?: number;
  height?: number;
  /** 重なり順（@chara の z）。大きいほど手前。同じなら出した順（挿入順）。省略は 0。 */
  z?: number;
  /**
   * 立ち絵に付いた、プラグインの状態（std の @emote の漫符など）。@chara で差し替えても残り、立ち絵を消すと一緒に消える。
   * 鍵はプラグインの名前を頭に付ける（"std.emote"）。
   */
  extra?: Record<string, Value>;
}

/** 音の鳴らし方（@bgm・@se のパラメータ）。ループの位置はミリ秒、pan は -100（左）〜100（右）、rate は再生速度（1 で等速）。 */
export interface SoundOptions {
  loopStart?: number;
  loopEnd?: number;
  pan?: number;
  rate?: number;
  /** 音のフィルター（@bgm・@se の filter。こもり・電話・無線・広間）。 */
  filter?: SoundFilterState;
}

/** 音のフィルター（type は muffled・phone・radio・hall、strength は 0〜100）。 */
export interface SoundFilterState {
  type: string;
  strength: number;
}

/** その話者のボイスに掛け続けているフィルター（@voice-filter。話者のものが無ければすべての話者のもの）。 */
export function voiceFilterFor(stage: Pick<StageState, "voiceFilter">, who: string | null): SoundFilterState | null {
  const filters = stage.voiceFilter;
  if (!filters) return null;
  return (who !== null ? filters[who] : undefined) ?? filters[""] ?? null;
}

/** 命令の filter・filter-strength を状態の形にする（none・書いていない・強さ 0 は null）。 */
export function filterArg(a: Readonly<Record<string, unknown>>): SoundFilterState | null {
  if (typeof a.filter !== "string" || a.filter === "none") return null;
  const strength = typeof a["filter-strength"] === "number" ? Math.max(0, Math.min(100, a["filter-strength"])) : 100;
  return strength === 0 ? null : { type: a.filter, strength };
}

/** 画面と音の状態。描画側はこれだけを見れば今の画面を組み立て直せる。 */
/** NVL の読み終えた段落の一片。 */
export type NvlPart = { text: string; ruby: string | null; style: TextStyle } | { br: true };
export interface NvlPage {
  speaker: string | null;
  label?: string;
  parts: NvlPart[];
  /**
   * 本文の行の元（書いたファイル、原文、場面、{name …} の原文）。別の言語でロードしたときに、今の言語の本文と名前を作り直す
   * （Runtime.retranslate）。前の版のセーブには無く、そのページは書いたときの言語のまま出す。
   */
  origin?: { file: string; source: string; context?: string; name?: string; id?: string };
  /**
   * 本文の流れに出して選んだ選択肢（ui.choice.position が inline のとき。options は出した文、picked は選んだ番号）。
   * @nvl の間は段落と同じく本文の一部として積まれるので、ロードで出し直す。
   */
  choice?: { options: { text: string; origin?: TextOrigin }[]; picked: number };
}

export interface StageState {
  background: string | null;
  /** 単色の背景（@bg color=・@scene-change bg-color=。#rrggbb など）。background があればそちらが勝ち、背景の絵を出す命令で外れる。 */
  backgroundColor?: string;
  /**
   * 奥行きのある背景の絵（@plane）。名前 → 絵（bgimage）と奥行き（0 は立ち絵と同じに動き、1 に近いほどカメラが動いても動かない。
   * 負なら手前で、より大きく動く）。front は立ち絵より手前に置く。@bg で外れる。
   */
  planes?: Record<string, { image: string; depth: number; front?: boolean }>;
  /** 表示中の立ち絵。キーはキャスト名。重なり順は z、同じなら挿入順。 */
  sprites: Record<string, Sprite>;
  /** 立ち絵を表示していないキャラクターの、顔ウィンドウの表情（@face。立ち絵を消したときは消す前のもの）。キーはキャスト名。 */
  faces?: Record<string, { appearance: string; variant: string }>;
  /** @face で出した顔（ui.face の show が explicit のとき、これだけを出す）。@face-off で消える。 */
  faceShown?: { who: string; appearance: string; variant: string };
  /** メッセージウィンドウの背景の画像（@window-image）。省略は ui.message.image。 */
  windowImage?: string;
  /**
   * paused は @pause-bgm で一時停止しているとき true。pausedAt は止めた位置（秒。描画側が書く）で、ロードしたあとの @resume-bgm はそこから続ける。
   */
  bgm: ({ file: string; volume: number; loop: boolean; paused?: boolean; pausedAt?: number } & SoundOptions) | null;
  /** ループ再生中の効果音（チャンネルごと）。単発の効果音は状態に残らない。 */
  loopingSe: Record<string, { file: string; volume: number; paused?: boolean } & SoundOptions>;
  window: boolean;
  /** 暗転・場面転換などで、次の本文まで一時的に枠を隠している。@window hide とは別。 */
  windowSuppressed?: boolean;
  /** @window hide で消したまま（show するまで true）。消していなければ、本文の前にウィンドウを自動で出す。 */
  windowHidden?: boolean;
  /** 画面全体に文章を積んでいく表示（@nvl on）。省略は false。 */
  nvl?: boolean;
  /** NVL の見た目の名前（@nvl on style=。liminalia.json の ui.nvlStyles）。省略は ui.nvl の見た目。 */
  nvlStyle?: string;
  /** 今の NVL の画面に積んである、読み終えた段落（ロードで出し直す）。@clear や表示の切り替えで消える。 */
  nvlPages?: NvlPage[];
  /**
   * クリックを待たずに次へ進んだページ（行の最後の {noclick}）の本文。次のページを出すまでメッセージウィンドウに残るので、
   * その間のセーブ（選択肢など）をロードしたら出し直す。次のページ、@clear、@window hide、表示の切り替えで消える。
   */
  noclickPage?: NvlPage;
  /** 本文の縦書き（@vertical）。省略は作品の設定（ui.message.vertical）。 */
  vertical?: boolean;
  mask: string | null;
  camera: { zoom: number; x: number; y: number; rotate: number };
  /** 一文字あたりのミリ秒。null は設定画面の値。 */
  textSpeed: number | null;
  /** 作品固有の命令が持つ状態。 */
  extra: Record<string, Value>;
  /** システム画面への要求のうち、続いている状態（@menu-button・@shortcuts・@backlog）。省略は既定（すべて true）。 */
  ui?: { menuButton: boolean; shortcuts: boolean; backlog: boolean };
  /** ボイス。next は次の台詞で鳴らすもの（@voice）、auto は話者ごとの連番の自動再生（@voice-auto）。省略は何もない。 */
  voice?: { next?: VoiceCue | null; auto?: Record<string, VoiceAuto> };
  /** ボイスに掛け続ける音のフィルター（@voice-filter）。キーは話者名、"" はすべての話者。省略は掛けない。 */
  voiceFilter?: Record<string, SoundFilterState>;
  /** 立ち絵の振る舞い（@chara-config）。省略した項目は作品の設定（ui.chara）、それも無ければ既定（目立たせない、跳ねない）。 */
  spriteConfig?: SpriteConfig;
  /** 話者の名前欄に出す名前（@name）。キーは話者名。話者ごとの処理（口パク、ボイスなど）は話者名のまま。 */
  names?: Record<string, string>;
  /** 文字を出すときの音（@text-sound）。キーは話者名、"" はほかのすべて。 */
  textSound?: Record<string, { file: string; volume: number; every: number }>;
  /** 吹き出し（@balloon on）。省略・null はメッセージ枠。 */
  balloon?: Balloon | null;
  /** 立ち絵の色調（@tone）。キーはキャスト名、"" はすべての立ち絵。値は色調の名前。背景の色調より先に効く。 */
  tones?: Record<string, string>;
  /**
   * @bg（@scene-change）の tone= で決めた背景の色調（none なら掛けない）。image はその背景で、背景がほかの絵に替わったら効かない。
   * 省略は liminalia.json の ui.backgroundTones（描画側が背景の名前で引く）。
   */
  backgroundTone?: { image: string; tone: string };
  /**
   * 被写界深度（@dof）。on のところにピントを合わせ、ほかをぼかす（blur は px）。chara は who の立ち絵に合わせ、
   * 背景とほかの立ち絵をぼかす。省略・null はぼかさない。
   */
  dof?: { on: "background" | "sprites" | "chara"; who?: string; blur: number } | null;
  /**
   * 場面の切れ目まで待たせている命令（@notify when=scene-break。命令の ctx.atSceneBreak）。セーブに入るので、待っている間に
   * セーブとロードをしても消えない。due は場面の切れ目を過ぎた数（先頭から）で、次の本文か選択肢の前に描画側へ渡して外す
   * （外したあとのセーブには入らないので、ロードで二度出ない）。省略は待っているものが無い。
   */
  sceneWait?: SceneWait;
}

/** 場面の切れ目まで待たせている命令（StageState.sceneWait）。 */
export interface SceneWait {
  commands: { name: string; args: Record<string, Value> }[];
  due?: number;
}

export interface SpriteConfig {
  /** 話していないキャラクターの見せ方（省略は作品の設定 ui.chara.focus。それも無ければ none）。 */
  focus?: "none" | "dim" | "blur" | "dim-blur" | "lower" | "dim-lower";
  dim?: number;
  /** 下げる量（px）。 */
  lower?: number;
  jump?: boolean;
  /** 自動配置で並べ直す時間（ミリ秒）。 */
  moveTime?: number;
  easing?: string;
}

/** 鳴らすボイス一つ。folder は素材のフォルダ（voice か sound）。 */
export interface VoiceCue {
  file: string;
  volume: number;
  folder: string;
  /** 連番のボイス（@voice-auto）なら番号。 */
  n?: number;
  /** 字幕（@voice の caption。本文に書いていない声）。 */
  caption?: string;
  /** ボイスのチャンネル（1 から。省略は 1）。同じチャンネルのボイスは置き換わり、違うチャンネルなら同時に鳴る。 */
  channel?: number;
  /** このボイスの話者（@voice の who。省略はそのページの話者）。口パクと名前欄に使う。 */
  who?: string;
  /** 音のフィルター（@voice の filter か、@voice-filter で掛け続けているもの）。null は掛けない（@voice filter=none）。 */
  filter?: SoundFilterState | null;
  /** 同じページで同時に鳴らすボイス（二人が同時に話す。二つ目の @voice か channel=2）。 */
  also?: VoiceCue[];
}

/**
 * 話者の連番のボイス。pattern の {n}（{n:3} なら 3 桁）を next に置き換えたファイルを鳴らし、鳴らすたびに next を一つ進める。
 * off は止めている間 true（番号は保つ）。
 */
export interface VoiceAuto {
  pattern: string;
  next: number;
  volume: number;
  folder: string;
  off?: boolean;
}

/**
 * 呼び出しの記録（@call・マクロ・@with の中身）。return は戻る位置、locals は戻ったときの局所変数。
 * result はマクロの戻り値（@return (式)）を入れる変数、content は @with で渡された中身の実行単位の id（マクロの中の @content が入る）。
 */
export interface CallFrame {
  return: Position;
  locals: Scope;
  result?: string;
  content?: string;
  /**
   * 場面の呼び出し（Runtime.callScene）。呼んだ場面が次のラベルかファイルの終わりに着いたら、@return を書かなくても return へ戻る。
   * 場面の中で @jump したり、選択肢でほかへ飛んだりしたら、戻らずにこの枠を捨てる。
   */
  scene?: true;
}

/** @sleep-game・@checkpoint で取っておく、ある時点の状態。 */
export interface Snapshot {
  position: Position;
  locals: Scope;
  callStack: CallFrame[];
  game: Scope;
  stage: StageState;
  seed: number;
  visits?: Record<string, number>;
  chosen?: Record<string, number>;
  variants?: Record<string, number[]>;
}

/** セーブデータ。この値を JSON にして保存し、そのまま戻せば再開できる。 */
export interface SaveData {
  /** セーブの形の版（save.ts の SAVE_VERSION）。読み込むときに今の版へ変換する。 */
  version: number;
  position: Position;
  locals: Scope;
  callStack: CallFrame[];
  game: Scope;
  stage: StageState;
  seed: number;
  /** @sleep-game で取っておいた状態（@awake-game で戻る）。 */
  sleep?: Snapshot | null;
  /** @checkpoint で名前を付けて取っておいた状態。 */
  checkpoints?: Record<string, Snapshot>;
  /** このプレイでラベル（`ファイル#ラベル`）とファイルの頭（`ファイル`）に入った回数（式の visits()）。無ければ 0。 */
  visits?: Record<string, number>;
  /** このプレイで選んだ選択肢の文（飾りを外した原文）→ 回数（式の chosen()）。 */
  chosen?: Record<string, number>;
  /**
   * 本文の出し分け（{seq a|b} など）を通った回数と、前に出したものの番号（出していなければ -1）。鍵はファイルと原文のハッシュと、
   * その文の何番目の出し分けか（`ファイル#ハッシュ:番号`。同じファイルの同じ文の行は数を分け合う）。
   */
  variants?: Record<string, number[]>;
  /**
   * 作品の版（liminalia.json の version。Runtime の options.gameVersion）。セーブするときに今の版を入れる。
   * 式の save.version で読む（ロードしたプレイはそのセーブを作った版、新しく始めたプレイは今の版。版を入れる前のセーブには無く、空として読む）。
   */
  gameVersion?: string;
}

export interface GameState extends SaveData {
  /** そのプレイ中だけの変数。セーブには入らない。 */
  temp: Scope;
}

export function initialStage(): StageState {
  return {
    background: null,
    sprites: {},
    bgm: null,
    loopingSe: {},
    window: false,
    mask: null,
    camera: { zoom: 1, x: 0, y: 0, rotate: 0 },
    textSpeed: null,
    extra: {},
  };
}

export function createState(unit: string, seed = 1): GameState {
  return {
    version: SAVE_VERSION,
    position: { unit, index: 0 },
    locals: {},
    callStack: [],
    game: {},
    temp: {},
    stage: initialStage(),
    seed,
  };
}

export function toSaveData(state: GameState): SaveData {
  const { temp: _, ...save } = state;
  return clonePlain(save);
}

/**
 * 状態の深い写し。状態はセーブ（JSON）に書ける値だけなので、配列とふつうのオブジェクトを辿って写す。
 * structuredClone と同じ結果だが、台詞ごとに取る写し（再開の控え）では数倍速い。ふつうでないもの（Map、Date など）はそこだけ structuredClone にする。
 */
export function clonePlain<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clonePlain) as T;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return structuredClone(value);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) out[key] = clonePlain((value as Record<string, unknown>)[key]);
  return out as T;
}
