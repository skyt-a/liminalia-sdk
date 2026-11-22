import {
  type AutoLayoutRules,
  applyCommandDefaults,
  booleanShorthandConflicts,
  normalizeBooleanArgs,
  chapterOf,
  check,
  contextAt,
  countEndings,
  endingKinds,
  endingRecordKey,
  endingRef,
  ENDINGS_KEY,
  translatableSetValue,
  type EndingKinds,
  CHOICE_BLOCK,
  CHOICE_OPTION,
  CORE_COMMANDS,
  castForSpeaker,
  createRegistry,
  paramLocalName,
  FORBIDDEN_PROPERTIES,
  parse,
  parseInline,
  parseLiteral,
  parseTargetText,
  paramTypeFromName,
  printInline,
  printLiteral,
  plainText,
  runtimeDiagnostic,
  stripSpeechQuotes,
  textHash,
  translationKey,
  READ_KEY,
  type Argument,
  type CastEntry,
  type ChapterInfo,
  type ChoiceOption,
  type CommandDefaults,
  type CommandSpec,
  type Diagnostic,
  type Expr,
  type Inline,
  type Literal,
  type ParamType,
  type Registry,
  type Script,
  type Target,
  type VoiceLock,
} from "@liminalia/lang";
import { chatDialogueActive, chatPartsText, pushChatMessage, type ChatDialogue } from "./chat.ts";
import { CORE_IMPLEMENTATIONS } from "./commands.ts";
import type { ChoiceLook, CoSpeaker, Host, PresentEvent, TextStyle } from "./host.ts";
import { buildProgram, type Instruction, type Program, type Unit, type UserFunction } from "./program.ts";
import { collectPrefetch } from "./prefetch.ts";
import { argOrigin, noteArgOrigin, textOrigins, withOrigins, type TextOrigin } from "./retranslate.ts";
import { migrateSave } from "./save.ts";
import { clonePlain, createState, toSaveData, voiceFile, voiceFilterFor, type NvlPage, type NvlPart, type GameState, type Position, type SaveData, type Snapshot, type VoiceCue } from "./state.ts";
import { checkedDivision, display, evaluate, EvalError, nextRandom, truthy, type EvalEnv, type Scope, type Value } from "./value.ts";

export type Args = Record<string, Value>;

export interface CommandContext {
  runtime: Runtime;
  state: GameState;
  /** 状態を更新したあとに呼び、描画側に反映させる。 */
  present(args: Args, wait: boolean): Promise<Value | void>;
  signal: AbortSignal;
  /** @end までの行をそのまま持つ命令（@html）の中身（字下げをそろえたもの）。ほかの命令では無い。 */
  body?: string;
  /**
   * 式（`(…)`）で書いた引数の、式の元の文字（括弧の中。引数の名前 → 文字）。値は args に評価済みで入る。変数が変わるたびに
   * 評価し直したい命令（常駐の表示の if= など）が、式を状態に残すのに使う。
   */
  sources?: Readonly<Record<string, string>>;
  /**
   * この命令の実行中にセーブされたら、この命令からやり直すようにする（UI を出して結果を待つ命令用）。
   * 命令が終われば元に戻る。
   */
  resumeHere(): void;
  /**
   * 選択肢を出して選ばせる（選んだ番号。null なら実行を終える）。プラグインの命令が自分の画面で行き先を選ばせるとき、
   * 描画側が答えを返さない（画面なしで流す: 道筋の探索・網羅・lim trace）場合はこれで選ぶ。そうすると、探索や網羅が
   * ふつうの選択肢と同じく選び方を変えて流せる。targets は選択肢ごとの飛び先（"ファイル" か "ファイル#ラベル"。分かれば）。
   */
  choose(options: string[], targets?: (string | null)[]): Promise<number | null>;
  /**
   * 行き先を選ばせる命令の結果を決める。outcomes は起こりうる結果の一覧（見出し・飛び先・値）で、行き先はここに一度だけ書く。
   * answer は描画側が返した答えを命令が読み替えたもの。あればそれを返し、無ければ（画面なしで流すとき）一覧をそのまま
   * choose に渡して選んだものの値を返す（先頭が既定の選び方）。こうすると、探索や網羅が一覧のどの行き先も試せる。
   * null なら実行を終える（一覧が空のときも null）。
   */
  pick<T>(outcomes: readonly PickOutcome<T>[], answer?: T | null): Promise<T | null>;
  /**
   * おまけの CG の画像を解放する（@cg-unlock と同じ。全セーブ共通の system.cg_unlocked に入れる）。image は extra.cg の images に書いたパス。
   * 調べる場所の一時の絵など、命令が自分で出した絵を CG にするときに、system 変数を直に触らずに使う。画面なしで流すときも同じに効く。
   */
  unlockCg(image: string): void;
  /**
   * 作品のデータ（paths.data の .json。`items` と `items.json` は同じ）を読む。無い・読めないなら undefined。
   * 同じ実行器の中では一度だけ読む（読み直すには作り直す）。返す値は書き換えない。
   */
  data(name: string): Promise<unknown>;
  /**
   * この命令を描画側へ渡すのを、次の場面の切れ目まで待たせる（@notify when=scene-break）。present の代わりに呼ぶ。
   * 場面の切れ目は @scene-change、背景の切り替え（@bg で別の絵）、暗転（@mask）、@jump と選択肢でほかのファイル（章）へ移ったとき。
   * 切れ目を過ぎたら、次の本文か選択肢を出す前に、引数をそのまま描画側へ渡す（待たない）。待っているものはセーブに入り、
   * 渡したものはその後のセーブから外れるので、待っている間にセーブとロードをしても消えず、二度も出ない。
   */
  atSceneBreak(args: Args): void;
}

/** ctx.pick の結果の一つ。target はその結果で飛ぶ先（"ファイル" か "ファイル#ラベル"。分からなければ null）。 */
export interface PickOutcome<T> {
  label: string;
  target: string | null;
  value: T;
}

/** 命令の実装。仕様（spec）はレジストリと共有する。 */
export interface CommandImpl {
  spec: CommandSpec;
  run(args: Args, ctx: CommandContext): void | Promise<void>;
  /**
   * 自動確認（Host.automated。lim playtest・lim shot・全ルートテスト）での進め方。あれば、ctx.present は描画側へ描かせずに
   * これを呼び、返した値を描画側の答えの代わりにする（args は ctx.present に渡したもの）。何も返さなければ答えなしで、
   * ctx.pick・ctx.choose で行き先を選ぶ命令は、ふつうの選択肢と同じく自動確認が選ぶ。遊ぶ人の操作を待つ画面や、飛ばしたい動画の命令に書く。
   */
  autoplay?(args: Args, ctx: CommandContext): Value | void | Promise<Value | void>;
}

/**
 * 実行器をまたいで使う、読んだ台本の控え（ファイル → 本文と、それを読み解いたもの）。巻き戻しやロードで実行器を作り直しても、
 * 本文が同じなら読み解き直さない。本文が変われば（開発中の書き換え）読み直す。中身は読むだけで書き換えない。
 */
export type ProgramCache = Map<string, { source: string; speakers: string; program: Program; script: Script }>;

export interface RuntimeOptions {
  /** 実行器をまたいで使う読んだ台本の控え（遊ぶ側が一回のプレイを作り直すたびに渡す）。 */
  programCache?: ProgramCache;
  /** 話者として認める名前（project.lim.json の speakers）。 */
  speakers?: Iterable<string>;
  /** 作品固有の命令。組み込みの命令と同名なら上書きする。 */
  commands?: CommandImpl[];
  /**
   * 作品ごとのコマンドの既定値（liminalia.json の commandDefaults。@liminalia/lang の CommandDefaults）。シナリオで省いたパラメータに使う。
   * 組み込みの命令にもプラグインの命令にも効く（使えない値は使わない。検査が知らせる）。
   */
  commandDefaults?: CommandDefaults;
  /** 乱数のシード。 */
  seed?: number;
  /** 無限ループ対策。既定 1,000,000 命令。 */
  maxSteps?: number;
  /**
   * 作品のデータを読む（命令の ctx.data。ホストが loadData を持たないとき、画面なしで流す網羅や探索に渡す）。
   * name は paths.data からのパス（`.json` 付き）。無ければ undefined を返す。
   */
  loadData?(name: string): unknown;
  /** 実行時エラーで止めるか（既定）、報告して続けるか。 */
  onError?: "stop" | "continue";
  /**
   * @call で呼ばれていない所の @return を、誤りにせずに次の行へ進むか（lim coverage と全ルートテストのファイルごとの流し。
   * @call で呼ぶだけのファイルも先頭から流すので、ラベルごとの @return は呼ばれずに通る）。既定は誤り。
   */
  returnWithoutCall?: "error" | "continue";
  /**
   * 変数に値を入れたときに呼ぶ（@set・@let・命令の結果を受け取る setVariable）。制作画面が「その値を決めた行」を示すのに使う。
   * path は game.x・system.x・temp.x（入れ子は game.a.b）か、局所変数の名前。value は入れたあとの値。at はその命令の行。
   */
  onAssign?(path: string, value: Value, at: { file: string; line: number }): void;
  /**
   * 一つの命令（本文・選択肢・ラベル・@if なども含む）を実行する直前に呼ぶ。at はその命令の行。
   * このときの save() は、その命令から再開するセーブ（＝前の命令を実行した直後の状態）になる。
   * 制作画面が、命令の行を実行した直後の状態を控えるのに使う。
   */
  onStep?(at: { file: string; line: number }): void;
  /**
   * 一つの命令を実行する直前に呼び、Promise を返したら解決するまでその命令を実行しない（制作画面のブレークポイント）。
   * 待っているあいだに捨てられた（dispose した）実行器は、そこで止まる。
   */
  beforeStep?(at: { file: string; line: number }): Promise<void> | void;
  /** 変数の初期値（liminalia.json の variables。"game.x"・"system.x" → 値）。 */
  variables?: Readonly<Record<string, Value>>;
  /** 式の lang() が返す言語（省くと ""。描画側は遊んでいる言語、画面なしで流すものは原文の言語を入れる）。runtime.language で替えられる。 */
  language?: string;
  /** 訳（多言語）。runtime.translator で替えられる。省けば訳さない。 */
  translator?: Translator | null;
  /** 式の platform()・app() が返す機種（省くとパソコンのブラウザ）。 */
  platform?: Platform;
  /** 章の情報（liminalia.json の chapters）。式の chapter() と runtime.chapter が読む。 */
  chapters?: readonly ChapterInfo[];
  /** 数を数える実績の目標（liminalia.json の extra.achievements の id → goal）。@achieve-progress が届いたら解除する。 */
  achievementGoals?: Readonly<Record<string, number>>;
  /**
   * 見たエンディングの数で進める実績（extra.achievements の endings。id → 種類（"*" はどれも）と goal。@liminalia/lang の endingAchievements）。
   * プレイを終える命令を動かすたびに、その種類のエンディングを見た数を今の数にし、goal に届いたら解除する。
   */
  endingAchievements?: Readonly<Record<string, { endings: string; goal: number }>>;
  /** 作品が足したエンディングの種類（liminalia.json の endingKinds）。ending= を種類として読み、前の書き方の文言と見分けるのに使う。 */
  endingKinds?: unknown;
  /**
   * キャストの定義（cast.json の cast）。あれば @chara のたびに、無い立ち絵セット・差分・立ち位置を実行時の診断で知らせる
   * （検査で拾えない、書かなかった値を保った結果の組み合わせも）。
   */
  cast?: Readonly<Record<string, CastEntry>>;
  /** 立ち絵の登場順の自動配置の並べ方（liminalia.json の autoLayout を autoLayoutRules で読み解いたもの）。省けば前からの並べ方。 */
  autoLayout?: AutoLayoutRules;
  /**
   * 連番のボイスの番号の固定（voice-lock.json）。あれば @voice-auto は台詞ごとに固定した番号を鳴らし、
   * 固定に無い台詞は鳴らさない（数え方の番号は、行を足すとずれるため）。
   */
  voiceLock?: VoiceLock | null;
  /**
   * ロードの直後に呼び出す位置（`ファイル#ラベル`。liminalia.json の afterLoad）。セーブに入らない temp を計算し直すなど。
   * @return でロードしたページへ戻る。
   */
  afterLoad?: string;
  /**
   * CG として解放する画像か（@liminalia/lang の cgMatcher(extra)。liminalia.json の extra.cg と extra.cgAuto）。あれば、CG として解放する印の
   * あるパラメータ（@bg の image など）で出した画像を system.cg_unlocked に入れる。描画しない実行（道筋の探索・網羅）やスキップ中でも同じに効く。
   */
  cg?: (folder: string, image: string) => boolean;
  /**
   * 読み終えたページと選んだ選択肢をチャットの列に積む（ui.chat.dialogue のとき。stage.extra の "std.chat"）。
   * セーブから組み立て直すので、画面なしで流して状態を作るもの（道筋の探索など）にも同じ値を渡す。
   */
  chatDialogue?: ChatDialogue;
  /**
   * 選択肢を本文の流れに出す（ui.choice.position が inline のとき）。@nvl の間、選んだ選択肢を本文の一部として stage.nvlPages に残し、
   * ロードで描画側が出し直せるようにする。描画の出し方は描画側（dom-host）が決める。
   */
  inlineChoices?: boolean;
  /**
   * 台詞の外側の括弧と引用符を外すか（ui.text.quotes が strip。遊んでいる言語の ui.languages を重ねたもの）。台詞のページを出すたびに呼ぶ。
   * true なら本文（訳があれば訳）の外側の一組の「…」『…』“…”"…" を外してから描画側へ送る（メッセージ枠・NVL・履歴・吹き出しに同じく効く）。
   */
  stripQuotes?: () => boolean;
  /**
   * 作品の版（liminalia.json の version）。セーブに入れ、式の save.version で読める（ロードの後の処理 afterLoad で、
   * 前の版のセーブの変数を付け替えるため）。
   */
  gameVersion?: string;
}

/** start の指定。 */
export interface StartOptions {
  /** おまけの回想として再生するなら、その id（式の replaying() が true になる）。 */
  replay?: string;
  /** 始める前に入れる変数（"game.x"・"temp.x" → 値。回想の variables）。初期値より優先する。 */
  variables?: Readonly<Record<string, Value>>;
}

/**
 * 訳（多言語）。本文の行・選択肢の文は、ファイル名と原文（printInline で書き直したもの）から訳を引く。
 * 訳が無ければ null を返し、原文を出す。話者名は出すときだけ訳す。
 * arg はコマンドの文字（仕様で translate: "text" の引数。引数を読むときに訳す）、text は作品の設定の文字（liminalia.json の章の題など）。
 * context は実行している場面（直前のラベルの名前。無ければ ""）。訳のファイルに場面ごとの訳（contexts）があればそちらを使う。
 * id は行末に書いた固定の行 ID（#line:ID）。あれば原文ではなく ID で訳を引く（原文を書き換えても訳が外れない）。
 */
export interface Translator {
  line(file: string, source: string, context?: string, id?: string): Inline[] | null;
  option(file: string, source: string, context?: string, id?: string): Inline[] | null;
  speaker(name: string): string | null;
  arg?(file: string, source: string, context?: string): string | null;
  text?(source: string): string | null;
}

export type RunResult =
  | { reason: "end"; at: Position }
  | { reason: "stopped"; at: Position }
  | { reason: "max-steps"; at: Position }
  | { reason: "error"; at: Position; message: string };

/** .lim を実行する。描画・音・入力は Host が担う。 */

/**
 * 書き出したゲーム（lim build が Vite の define で true にする。Node や開発サーバーでは無い）。台本の検査（check）は
 * lim build の前の検査で済んでいるので、書き出したゲームでは読み込みの誤りだけを知らせ、検査を束に入れない。
 */
declare const __LIMINALIA_EXPORT__: boolean | undefined;
export class Runtime {
  state: GameState;
  /** 全セーブ共通の変数。保存は Host 側で行う。 */
  system: Scope = {};
  /** 訳（多言語）。null なら原文。遊んでいる途中で言語を替えたら、次のページから効く。 */
  translator: Translator | null = null;

  private readonly programs = new Map<string, Program>();
  private readonly implementations = new Map<string, CommandImpl>();
  readonly registry: Registry;
  private readonly speakers: string[];
  private readonly maxSteps: number;
  private readonly onError: "stop" | "continue";
  private readonly returnWithoutCall: "error" | "continue";
  private readonly onAssign: RuntimeOptions["onAssign"];
  private readonly onStep: RuntimeOptions["onStep"];
  private readonly beforeStep: RuntimeOptions["beforeStep"];
  /** ロードの直後に呼び出す位置（options.afterLoad）。 */
  private readonly afterLoad: string | undefined;
  /** 作品のコマンドの既定値（options.commandDefaults）。@define のマクロを呼ぶときに重ねる。 */
  private readonly commandDefaults: CommandDefaults | undefined;
  /** 変数の初期値（options.variables を置き場所ごとに分けたもの）。 */
  private readonly gameDefaults: Scope = {};
  private readonly systemDefaults: Scope = {};
  /** 実行中の命令（at が返す）。 */
  private currentUnit: Unit | null = null;
  private currentLine = 0;
  private halt: RunResult | null = null;
  /** 表示中のページや選択肢の位置。この間にセーブしたら、ここから再開する。 */
  private resumeAt: Position | null = null;
  /**
   * メッセージ枠のページをクリックで送ったあと、まだ命令を描画側に渡していない（TyranoScript の [p] の改ページと同じく、
   * 次に渡す命令に afterPage を付け、描画側がそこで前のページの本文を消す）。NVL、チャットの画面、{noclick} のページでは立てない。
   */
  private pageRead = false;
  /**
   * resumeAt に着いた時点の状態。ページの途中でセーブしたら、位置だけでなく状態もページの頭のものにする。
   * そうしないと、ロードしてページを頭から流し直したとき、本文中の命令（{@…}）が二度効く。
   */
  private resumeState: SaveData | null = null;
  private steps = 0;
  /** 本文のページを出している最中か（本文の中の命令を実行しているとき true）。 */
  private inPage = false;
  /** 出しているページの話者（地の文と、ページの外は null）。 */
  private pageSpeaker: string | null = null;
  private readonly abort = new AbortController();
  private readonly voiceLock: VoiceLock | null;
  /** CG として解放する画像か（options.cg）。 */
  private readonly isCg: ((folder: string, image: string) => boolean) | null;
  /** ふだんの台詞をチャットの列に積む設定（options.chatDialogue）。無ければ null。 */
  readonly chatDialogue: ChatDialogue | null;
  /** 台詞の外側の括弧と引用符を外すか（options.stripQuotes）。 */
  private readonly stripQuotes: () => boolean;
  /** 作品の版（options.gameVersion。無ければ空）。 */
  private readonly gameVersion: string;

  /**
   * 作ったときの設定（渡したものそのまま）。同じ作品を画面なしで先へ流す実行器（@liminalia/web の「次の選択肢へ」「次の未読へ」）を、
   * 遊んでいる実行器と同じ設定で作るのに使う。言語と訳は作ったあとにも替わるので、今の値は language と translator を読む。
   */
  readonly options: Readonly<RuntimeOptions>;

  constructor(
    private readonly host: Host,
    options: RuntimeOptions = {},
  ) {
    this.options = options;
    for (const impl of [...CORE_IMPLEMENTATIONS, ...(options.commands ?? [])]) {
      // 作品の既定値を重ねた仕様で引数を読む（実装はそのまま）
      const spec = applyCommandDefaults(impl.spec, options.commandDefaults);
      this.implementations.set(impl.spec.name, spec === impl.spec ? impl : { ...impl, spec });
    }
    this.registry = createRegistry([...this.implementations.values()].map((i) => i.spec));
    this.speakers = [...(options.speakers ?? [])];
    this.maxSteps = options.maxSteps ?? 1_000_000;
    this.onError = options.onError ?? "stop";
    this.returnWithoutCall = options.returnWithoutCall ?? "error";
    this.onAssign = options.onAssign;
    this.onStep = options.onStep;
    this.beforeStep = options.beforeStep;
    this.afterLoad = options.afterLoad;
    this.commandDefaults = options.commandDefaults;
    this.isCg = options.cg ?? null;
    this.cast = options.cast;
    this.autoLayout = options.autoLayout;
    this.voiceLock = options.voiceLock ?? null;
    this.chatDialogue = options.chatDialogue ?? null;
    this.stripQuotes = options.stripQuotes ?? (() => false);
    this.gameVersion = options.gameVersion ?? "";
    for (const [path, value] of Object.entries(options.variables ?? {})) {
      const [scope, name] = path.split(".");
      if (name && scope === "game") this.gameDefaults[name] = value;
      if (name && scope === "system") this.systemDefaults[name] = value;
    }
    this.state = createState("", options.seed ?? 1);
    this.language = options.language ?? "";
    this.translator = options.translator ?? null;
    this.platform = options.platform ?? { device: "pc", app: false };
    this.chapters = options.chapters ?? [];
    this.dataLoader = options.loadData;
    this.achievementGoals = options.achievementGoals ?? {};
    this.endingAchievements = options.endingAchievements ?? {};
    this.endingKinds = endingKinds(options.endingKinds);
  }

  // ---- 開始・再開 ----

  /**
   * target（`chapter1`・`chapter1#start`）から実行を始める。
   * temp（そのプレイ中だけの変数）は引き継ぐ。タイトル画面などが始める前に temp を入れておけるようにするため（load と同じ）。
   */
  async start(target: string, options: StartOptions = {}): Promise<RunResult> {
    const [file = "", label = null] = target.split("#");
    this.state = { ...createState(file, this.state.seed), temp: this.state.temp };
    if (this.gameVersion) this.state.gameVersion = this.gameVersion;
    this.state.game = structuredClone(this.gameDefaults);
    this.fillSystemDefaults();
    this.replay = options.replay ?? null;
    // 回想に渡す変数（liminalia.json の extra.replay の variables）。初期値の後ろに入れる
    for (const [path, value] of Object.entries(options.variables ?? {})) {
      const [scope] = path.split(".");
      if (scope === "game" || scope === "temp") this.setVariable(path, structuredClone(value));
    }
    await this.goto({ file, label }, file);
    return this.run();
  }

  /** system の変数のうち、まだ値の無いものを初期値にする。 */
  private fillSystemDefaults(): void {
    for (const [k, v] of Object.entries(this.systemDefaults)) if (!(k in this.system)) this.system[k] = structuredClone(v);
  }

  /** 現在の状態をセーブデータにする。ページや選択肢の途中なら、そのページ（選択肢）から再開する位置にする。 */
  save(): SaveData {
    const data = this.resumeAt && this.resumeState ? clonePlain(this.resumeState) : toSaveData(this.state);
    if (this.resumeAt) data.position = { ...this.resumeAt };
    // 今の作品の版を入れる（ロードした前の版のセーブも、セーブし直せば今の版のものになる）
    if (this.gameVersion) data.gameVersion = this.gameVersion;
    const anchor = this.anchorOf(data.position);
    if (anchor) data.position.anchor = anchor;
    // 呼び出しの戻り先にも目印を付ける（台本を直して呼んだ側の行がずれても、呼んだ命令の次へ戻るため）
    data.callStack = data.callStack.map((frame) => {
      const a = this.returnAnchor(frame.return);
      return a ? { ...frame, return: { ...frame.return, anchor: a } } : frame;
    });
    return data;
  }

  /** 読み込み済みの実行単位（無ければ undefined。save は同期なので読み込まない）。 */
  private loadedUnit(id: string): Unit | undefined {
    const program = this.programs.get(fileOf(id));
    if (!program) return undefined;
    return id === program.main.id ? program.main : program.defines.get(id.slice(id.indexOf("::") + 2));
  }

  /**
   * 呼び出しの戻り先の目印。戻り先の一つ前が呼んだ命令（@call・マクロ・@with の中身）ならその命令（after）、
   * そうでなく戻り先が選択肢（call=true の選択肢は、その選択肢へ戻る）ならその選択肢。
   */
  private returnAnchor(at: Position): Position["anchor"] | undefined {
    const unit = this.loadedUnit(at.unit);
    if (!unit) return undefined;
    const before = unit.instructions[at.index - 1];
    const beforeKey = before && callSite(before) ? siteKey(before) : undefined;
    if (before && beforeKey) return { line: before.line, key: beforeKey, after: true };
    const here = unit.instructions[at.index];
    const key = here ? instructionKey(here) : undefined;
    return here && key ? { line: here.line, key } : undefined;
  }

  /** その位置の命令の目印（本文・選択肢の行と文の鍵。ほかの命令は付けない）。読み込み済みの単位だけ（save は同期なので）。 */
  private anchorOf(at: Position): Position["anchor"] | undefined {
    const program = this.programs.get(fileOf(at.unit));
    if (!program) return undefined;
    const unit = at.unit === program.main.id ? program.main : program.defines.get(at.unit.slice(at.unit.indexOf("::") + 2));
    const ins = unit?.instructions[at.index];
    if (!ins) return undefined;
    const key = instructionKey(ins);
    return key ? { line: ins.line, key } : undefined;
  }

  /**
   * セーブした位置を、今の台本に合わせる。目印の鍵（本文・選択肢の文）が同じ命令があればそこ（いくつもあれば元の行に近いもの）、
   * 無ければ元の行にいちばん近い本文か選択肢。合わせ直したら知らせる（作品を更新して台本が変わったとき）。
   */
  private async relocate(at: Position): Promise<Position> {
    const anchor = at.anchor;
    if (!anchor?.key) return at;
    const unit = await this.unit(at.unit);
    const here = unit.instructions[at.index];
    if (here && instructionKey(here) === anchor.key) return at;
    const candidates = unit.instructions.map((ins, index) => ({ ins, index })).filter(({ ins }) => instructionKey(ins) === anchor.key);
    const pool = candidates.length > 0 ? candidates : unit.instructions.map((ins, index) => ({ ins, index })).filter(({ ins }) => ins.op === "say" || ins.op === "choice");
    if (pool.length === 0) return at;
    const best = pool.reduce((a, b) => (Math.abs(b.ins.line - anchor.line) < Math.abs(a.ins.line - anchor.line) ? b : a));
    this.diagnostic("warning", "save-relocated", `セーブした位置（${anchor.line} 行目）がシナリオの変更でずれたため、${best.ins.line} 行目から再開します`, unit, best.ins.line);
    return { unit: at.unit, index: best.index };
  }

  /**
   * 呼び出しの戻り先を、今の台本に合わせる。目印があれば同じ命令（呼んだ命令の次か、call=true の選択肢）を探す（いくつもあれば元の行に近いもの）。
   * 目印の無い前の版のセーブは、戻り先の一つ前が呼んだ命令でも選択肢でもない（行がずれている）ときだけ、呼ばれた先を呼ぶ命令のうち
   * 元の位置にいちばん近いものの次へ直す。見つからなければそのまま。直したら知らせる（save-relocated）。
   */
  private async relocateReturns(): Promise<void> {
    const stack = this.state.callStack;
    for (let i = 0; i < stack.length; i++) {
      const frame = stack[i]!;
      const at = frame.return;
      const anchor = at.anchor;
      delete at.anchor;
      let unit: Unit;
      try {
        unit = await this.unit(at.unit);
      } catch {
        continue;
      }
      const ins = unit.instructions.map((x, index) => ({ x, index }));
      let to: { index: number; line: number } | null = null;
      if (anchor) {
        const offset = anchor.after ? 1 : 0;
        const key = (x: Instruction) => (anchor.after ? (callSite(x) ? siteKey(x) : undefined) : instructionKey(x));
        const here = unit.instructions[at.index - offset];
        if (here && key(here) === anchor.key) continue;
        const pool = ins.filter(({ x }) => key(x) === anchor.key);
        if (pool.length === 0) continue;
        const best = pool.reduce((a, b) => (Math.abs(b.x.line - anchor.line) < Math.abs(a.x.line - anchor.line) ? b : a));
        to = { index: best.index + offset, line: best.x.line };
      } else {
        const before = unit.instructions[at.index - 1];
        const here = unit.instructions[at.index];
        if ((before && callSite(before)) || here?.op === "choice") continue;
        const callee = i + 1 < stack.length ? stack[i + 1]!.return.unit : this.state.position.unit;
        const pool = ins.filter(({ x }) => calls(x, unit.file, callee));
        if (pool.length === 0) continue;
        const best = pool.reduce((a, b) => (Math.abs(b.index - at.index) < Math.abs(a.index - at.index) ? b : a));
        to = { index: best.index + (best.x.op === "choice" ? 0 : 1), line: best.x.line };
      }
      const from = anchor?.line ?? unit.instructions[at.index]?.line ?? 0;
      this.diagnostic("warning", "save-relocated", `呼び出しの戻り先（${from} 行目）がシナリオの変更でずれたため、${to.line} 行目の次へ戻ります`, unit, to.line);
      frame.return = { unit: at.unit, index: to.index };
    }
  }

  /**
   * セーブデータから再開する。描画側には現在の状態をそのまま渡し直す。
   * options.call は、再開したページから場面（`#ラベル`・`ファイル#ラベル`）を呼ぶ（常駐のボタンの call=）。呼んだ場面は @return か、
   * 次のラベルかファイルの終わりで戻り、そのページを出し直す。options.afterLoad を false にすると、作品の afterLoad を呼ばない
   * （同じプレイの続きを組み立て直すとき）。
   */
  async load(raw: SaveData, options: { call?: string; afterLoad?: boolean } = {}): Promise<RunResult> {
    // 古い版のセーブは今の版にする。新しい版・壊れたセーブは読まない
    let save: SaveData;
    try {
      save = migrateSave(raw);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.host.onDiagnostic?.({ severity: "error", code: "save-version", message, file: "", line: 0 });
      return { reason: "error", at: { unit: "", index: 0 }, message };
    }
    await this.program(fileOf(save.position.unit));
    // 捨てた実行器は組み立て直さない（読み込みの途中で捨てられたとき、ほかの画面を上書きしないため）
    if (this.abort.signal.aborted) return { reason: "stopped", at: { ...save.position } };
    this.state = { ...save, temp: this.state.temp };
    this.state.position = await this.relocate(this.state.position);
    delete this.state.position.anchor;
    await this.relocateReturns();
    // 初期値を足したあとのセーブにない変数は、初期値で補う
    for (const [k, v] of Object.entries(this.gameDefaults)) if (!(k in this.state.game)) this.state.game[k] = structuredClone(v);
    this.fillSystemDefaults();
    // セーブしたときと違う言語で遊んでいれば、置いたままの文字を今の言語にする
    this.retranslate();
    this.pageRead = false;
    await this.host.present({ type: "command", name: "restore", args: {}, wait: false, stage: this.state.stage }, this.abort.signal);
    // 再開したページから場面を呼ぶ（戻ったらそのページを出し直す）
    if (options.call) await this.callScene(options.call, false, "here");
    if (this.afterLoad && options.afterLoad !== false) {
      // ロードしたページへ @return で戻るように呼び出す
      this.state.callStack.push({ return: { ...this.state.position }, locals: this.state.locals });
      this.state.locals = {};
      await this.jump(this.afterLoad);
    }
    return this.run();
  }

  stop(): void {
    this.halt ??= { reason: "stopped", at: { ...this.state.position } };
  }

  /**
   * 命令から場面（`#ラベル`・`ファイル#ラベル`）を呼び出す。呼んだ場面が次のラベルかファイルの終わりに着いたら、@return を書かなくても戻る。
   * again なら、戻ったときにこの命令をもう一度実行する（調べる場所の画面を出し直すなど）。そうでなければ次の行へ進む。
   * 場面の中で @jump したり選択肢でほかへ飛んだりしたら戻らない（@return を書けば、そこで戻る）。
   */
  async callScene(target: string, again = false, from: "command" | "here" = "command"): Promise<void> {
    const at = this.state.position;
    // here は、今の位置（まだ実行していない命令）へ戻る（ロードしたページを出し直す）
    const back = from === "here" ? { ...at } : again ? { unit: at.unit, index: Math.max(0, at.index - 1) } : { ...at };
    this.state.callStack.push({ return: back, locals: this.state.locals, scene: true });
    this.state.locals = {};
    await this.jump(target);
    // 呼んだ場面のラベルそのものでは戻らないよう、ラベルを踏んでから始める（入った回数は数える）
    const unit = await this.unit(this.state.position.unit);
    const ins = unit.instructions[this.state.position.index];
    if (ins?.op === "label") {
      if (unit.id === unit.file) this.visited(`${unit.file}#${ins.name}`);
      this.state.position.index++;
    }
  }

  /** 場面の呼び出しの枠から戻る（次のラベルかファイルの終わりに着いた）。 */
  private returnFromScene(): void {
    const frame = this.state.callStack.pop()!;
    this.state.position = { ...frame.return };
    this.state.locals = frame.locals;
  }

  /** 場面の呼び出しの中で、ほかへ飛んだ（戻らない）。 */
  private leaveScene(): void {
    if (this.state.callStack.at(-1)?.scene) this.state.callStack.pop();
  }

  /** 読んだ作品のデータ（名前 → 値）。 */
  private readonly dataCache = new Map<string, Promise<unknown>>();
  private readonly dataLoader: ((name: string) => unknown) | undefined;

  /** 作品のデータを読む（ctx.data）。ホストが読めなければ undefined。 */
  loadData(name: string): Promise<unknown> {
    const key = name.endsWith(".json") ? name : `${name}.json`;
    let p = this.dataCache.get(key);
    if (!p) {
      const loader = this.dataLoader;
      const host = this.host;
      p = (async () => {
        const v = host.loadData ? await host.loadData(key) : undefined;
        return v !== undefined ? v : loader ? await loader(key) : undefined;
      })().catch(() => undefined);
      this.dataCache.set(key, p);
    }
    return p;
  }

  /** 命令から飛ぶ（`ファイル`・`#ラベル`・`ファイル#ラベル`）。 */
  async jump(target: string): Promise<void> {
    const [file = "", label] = target.split("#");
    await this.goto({ file: file === "" ? null : file, label: label ?? null }, fileOf(this.state.position.unit));
  }

  /** `game.x` のような変数に値を入れる（命令の結果を受け取るとき）。 */
  setVariable(path: string, value: Value): void {
    const parts = path.split(".");
    const root = parts.shift();
    if (root !== "game" && root !== "system" && root !== "temp") throw new EvalError(`変数 ${path} には代入できません`);
    checkKeys(parts);
    let o = this.env.lookup(root) as Record<string, Value>;
    for (const p of parts.slice(0, -1)) o = (o[p] && typeof o[p] === "object" ? o[p] : (o[p] = {})) as Record<string, Value>;
    o[parts.at(-1)!] = value;
    this.assigned(path, value);
  }

  /** キャストの定義（options.cast）。開発中に cast.json を書き換えたときは、プレイヤーが差し替える。 */
  cast: Readonly<Record<string, CastEntry>> | undefined;
  /** 立ち絵の登場順の自動配置の並べ方（options.autoLayout）。開発中に liminalia.json を書き換えたときは、プレイヤーが差し替える。 */
  autoLayout: AutoLayoutRules | undefined;

  /** 実行中の命令の行に診断を出す（命令の実装が、止めずに知らせたいとき）。 */
  report(severity: Diagnostic["severity"], code: string, message: string): void {
    if (this.currentUnit) this.diagnostic(severity, code, message, this.currentUnit, this.currentLine);
  }

  /** 実行中の命令の位置（ファイルと行）。始める前は null。 */
  get at(): { file: string; line: number } | null {
    return this.currentUnit ? { file: this.currentUnit.file, line: this.currentLine } : null;
  }

  /**
   * 今いるファイルとラベル（その位置より前で最後のラベル。ラベルより前なら label は null）。@define の中なら、呼び出したところ。
   * セーブの一覧に章の名前を出すのに使う。読み込む前は null。
   */
  get label(): { file: string; label: string | null } | null {
    const unit = this.currentUnit;
    const program = unit ? this.programs.get(unit.file) : undefined;
    if (!unit || !program) return null;
    let line = this.currentLine;
    if (unit !== program.main) {
      // @define の中なら、本体のどこから呼んだか（戻る位置の一つ前の命令）
      const back = [...this.state.callStack].reverse().find((f) => f.return.unit === program.main.id);
      const call = back ? program.main.instructions[back.return.index - 1] : undefined;
      if (!call) return { file: unit.file, label: null };
      line = call.line;
    }
    // ラベルの位置は、ラベルの次の命令。その命令の行が今の行より後なら、まだそのラベルには入っていない
    let label: string | null = null;
    let best = -1;
    for (const [name, index] of Object.entries(program.main.labels)) {
      const first = program.main.instructions[index];
      if (first && first.line <= line && index > best) {
        label = name;
        best = index;
      }
    }
    return { file: unit.file, label };
  }

  waitClick(): Promise<void> {
    return this.host.waitClick(this.abort.signal);
  }

  /** 読み込んだファイルの、本文の行 → ページの鍵（既読を覚えるのに使う）。まだ読み込んでいなければ undefined。 */
  pageKeysOf(file: string): ReadonlyMap<number, string> | undefined {
    return this.programs.get(file)?.pageKeys;
  }

  /** 本文のページを出している最中か（@voice が「その場で鳴らす」か「次の台詞で鳴らす」かを決める）。 */
  get speaking(): boolean {
    return this.inPage;
  }

  /** 出しているページの話者（地の文と、ページの外は null）。本文の中の @voice のフィルターに使う。 */
  get speakerNow(): string | null {
    return this.inPage ? this.pageSpeaker : null;
  }

  dispose(): void {
    this.abort.abort();
    this.stop();
  }

  // ---- 取っておいた状態（@sleep-game・@checkpoint） ----

  /** 今の状態を取っておく。位置は実行中の命令の次。 */
  snapshot(): Snapshot {
    const { position, locals, callStack, game, stage, seed, visits, chosen, variants } = this.state;
    return structuredClone({ position, locals, callStack, game, stage, seed, ...(visits ? { visits } : {}), ...(chosen ? { chosen } : {}), ...(variants ? { variants } : {}) });
  }

  /**
   * 取っておいた状態に戻り、描画側に画面を組み立て直させる。
   * keepVariables なら game. は今の値を、keepBgm なら BGM は今鳴っているものを残す。
   */
  async restoreSnapshot(snapshot: Snapshot, o: { keepVariables: boolean; keepBgm: boolean }): Promise<void> {
    const s = structuredClone(snapshot);
    // 進み具合（visits・chosen）はゲームの変数と同じに扱う
    if (o.keepVariables) Object.assign(s, { game: this.state.game, visits: this.state.visits, chosen: this.state.chosen, variants: this.state.variants });
    else Object.assign(s, { visits: s.visits, chosen: s.chosen, variants: s.variants });
    if (o.keepBgm) s.stage.bgm = this.state.stage.bgm;
    Object.assign(this.state, s);
    this.resumeAt = null;
    this.retranslate();
    this.pageRead = false;
    await this.host.present({ type: "command", name: "restore", args: {}, wait: false, stage: this.state.stage }, this.abort.signal);
  }

  // ---- 実行 ----

  async run(): Promise<RunResult> {
    // 捨てた（dispose した）実行器は動かさない
    if (this.abort.signal.aborted) return { reason: "stopped", at: { ...this.state.position } };
    this.halt = null;
    while (this.halt === null) {
      if (++this.steps > this.maxSteps) return { reason: "max-steps", at: { ...this.state.position } };
      const unit = await this.unit(this.state.position.unit);
      const instruction = unit.instructions[this.state.position.index];
      if (!instruction) {
        // 場面の呼び出し（callScene）はファイルの終わりで戻る
        if (this.state.callStack.at(-1)?.scene && unit.id === unit.file) {
          this.returnFromScene();
          continue;
        }
        return { reason: "end", at: { ...this.state.position } };
      }
      this.onStep?.({ file: unit.file, line: instruction.line });
      const hold = this.beforeStep?.({ file: unit.file, line: instruction.line });
      if (hold) {
        await hold;
        if (this.abort.signal.aborted) return { reason: "stopped", at: { ...this.state.position } };
        if (this.halt !== null) break;
      }
      this.state.position.index++;
      this.currentUnit = unit;
      this.currentLine = instruction.line;
      try {
        await this.execute(instruction, unit);
      } catch (e) {
        if (e instanceof EvalError) this.fail(e.message, unit, instruction.line);
        else throw e;
      }
    }
    return this.halt;
  }

  private async execute(ins: Instruction, unit: Unit): Promise<void> {
    const signal = this.abort.signal;
    switch (ins.op) {
      case "label":
        // 場面の呼び出し（callScene）は次のラベルに着いたら戻る
        if (unit.id === unit.file && this.state.callStack.at(-1)?.scene) return this.returnFromScene();
        // ファイル本体のラベルに入った回数と既読（式の visits・read）
        if (unit.id === unit.file) this.visited(`${unit.file}#${ins.name}`);
        return;
      case "say":
        await this.flushSceneWait();
        this.holdResume({ unit: unit.id, index: this.state.position.index - 1 });
        await this.say(ins.speaker, ins.content, unit, ins.line, ins.name, ins.id);
        this.holdResume(null);
        return;
      case "command":
        return this.command(ins.name, ins.args, unit, ins.line, ins.body, ins.content);
      case "content": {
        // マクロに @with で渡された中身を、呼んだ側の局所変数で実行する（渡されていなければ何もしない）
        const frame = this.state.callStack.at(-1);
        if (!frame?.content) return;
        this.state.callStack.push({ return: { ...this.state.position }, locals: this.state.locals });
        this.state.locals = frame.locals;
        this.state.position = { unit: frame.content, index: 0 };
        return;
      }
      case "branch":
        if (!this.condition(ins.condition, unit, ins.line)) this.state.position.index = ins.otherwise;
        return;
      case "goto":
        this.state.position.index = ins.to;
        return;
      case "set": {
        // `@set 変数 = "文字"` の文字は、訳があれば訳を入れる（鍵はコマンドの文字と同じ。lim i18n が集める）
        const source = this.translator?.arg ? translatableSetValue(ins.operator, ins.value) : null;
        const translated = source !== null ? this.translator?.arg?.(unit.file, source, contextAt(unit.labels, this.state.position.index - 1)) : null;
        return this.assign(ins.target, ins.operator, translated || this.eval(ins.value));
      }
      case "let":
        checkKeys([ins.name]);
        this.state.locals[ins.name] = this.eval(ins.value);
        this.assigned(ins.name, this.state.locals[ins.name]!);
        return;
      case "choice": {
        await this.flushSceneWait();
        // 条件（if=）が偽の選択肢は出さない。描画側・道筋の探索には出すものだけを渡し、選ばれた番号もその中の番号。
        const shown = ins.options.filter((o) => this.optionFlag(o.args, "if", true, unit, o.line));
        if (shown.length === 0) {
          // TyranoScript で cond がすべて偽の [glink] のあとの [s] と同じく、選べるものが無いまま止まる（@stop と同じ）。
          this.diagnostic("warning", "no-choice-shown", "選択肢の条件（if=）がすべて偽で、表示する選択肢がないため止まりました", unit, ins.line);
          this.stop();
          return;
        }
        const context = contextAt(unit.labels, this.state.position.index - 1);
        // 再開の状態は、選択肢の文の出し分け（{seq …}）を進める前に控える（ロードで同じ文を出す）
        this.holdResume({ unit: unit.id, index: this.state.position.index - 1 });
        const texts = shown.map((o) => this.withVariants(unit.file, printInline(o.content), true, () => this.plain(this.translator?.option(unit.file, printInline(o.content), context, o.id) ?? o.content)));
        const looks = shown.map((o) => (o.args.some((a) => !NOT_LOOK.has(a.key) || a.key === "locked") ? this.look(o.args, unit, o.line, context) : null));
        // 飛び先（道筋の探索が目標に近い選択肢から試すのに使う）。式の飛び先は分からないので null
        const targets = shown.map((o) => (o.target.expr ? null : `${o.target.file ?? unit.file}${o.target.label ? `#${o.target.label}` : ""}`));
        // 制限時間（@choice timeout=）。描画側に残り時間を見せさせ、過ぎたら選ぶのをやめさせる
        const block = ins.args ? this.resolveArgs(CHOICE_BLOCK, ins.args) : {};
        const timeout = typeof block.timeout === "number" && block.timeout > 0 ? block.timeout : 0;
        let timedOut = false;
        const counting = new AbortController();
        let chooseSignal = signal;
        // 選び終えたら外す（実行器の signal は一回の遊びのあいだ同じなので、残すと選択肢の数だけたまる）
        let stopLimit = (): void => undefined;
        if (timeout > 0) {
          const limit = new AbortController();
          stopLimit = () => limit.abort();
          signal.addEventListener("abort", stopLimit, { once: true });
          chooseSignal = limit.signal;
          await this.host.present({ type: "command", name: "choice-timer", args: { time: timeout }, wait: false, stage: this.state.stage }, signal);
          // 時間は描画側に計らせる（システム画面を開いている間は止める）。描画側が計らなければ実時間で
          const elapsed = this.host.countdown ? this.host.countdown(timeout, counting.signal) : realCountdown(timeout, counting.signal);
          void elapsed.then(() => {
            if (counting.signal.aborted) return;
            timedOut = true;
            limit.abort();
          });
        }
        let selected = await this.host.choose(texts, chooseSignal, looks.some((l) => l !== null) ? looks : undefined, targets);
        counting.abort();
        signal.removeEventListener("abort", stopLimit);
        this.holdResume(null);
        if (selected === null && timedOut && !signal.aborted) {
          // 時間切れ: default（上から何番目か）が表示されていて押せるならそれ、そうでなければ選ばずに @end の後へ
          const fallback = typeof block.default === "number" ? ins.options[block.default - 1] : undefined;
          if (fallback && shown.includes(fallback) && !this.optionFlag(fallback.args, "locked", false, unit, fallback.line)) {
            selected = shown.indexOf(fallback);
          } else {
            return;
          }
        }
        if (selected === null) {
          this.stop();
          return;
        }
        const option = shown[selected];
        if (!option) return this.fail(`選択肢 ${selected} はありません`, unit, ins.line);
        // 本文の流れに出す選択肢（ui.choice.position: inline）は、@nvl の間、選んだものを本文の一部として残す（ロードで出し直す）
        if (this.options.inlineChoices === true && this.state.stage.nvl === true) {
          (this.state.stage.nvlPages ??= []).push({
            speaker: null,
            parts: [],
            choice: {
              options: shown.map((o, i) => ({
                text: texts[i] ?? "",
                origin: { kind: "option", file: unit.file, source: printInline(o.content), ...(context ? { context } : {}), ...(o.id ? { id: o.id } : {}) },
              })),
              picked: selected,
            },
          });
        }
        const calls = this.optionFlag(option.args, "call", false, unit, option.line);
        this.noteChosen(option);
        if (!calls) this.host.chosen?.({ text: texts[selected] ?? "", index: selected });
        await this.chatChosen(texts[selected] ?? "", looks[selected] ?? null, { kind: "option", file: unit.file, source: printInline(option.content), ...(context ? { context } : {}), ...(option.id ? { id: option.id } : {}) });
        if (!calls) this.leaveScene();
        if (calls) {
          // call=true: 呼び出して、@return でこの選択肢へ戻る（もう一度出す。切り替えのボタンなど）
          this.state.callStack.push({ return: { unit: unit.id, index: this.state.position.index - 1 }, locals: this.state.locals });
          this.state.locals = {};
          return this.goto(option.target, unit.file, option.line);
        }
        return this.moveTo(option.target, unit.file, option.line);
      }
      case "jump":
        this.leaveScene();
        return this.moveTo(ins.target, unit.file, ins.line);
      case "call":
        this.state.callStack.push({ return: { ...this.state.position }, locals: this.state.locals });
        this.state.locals = {};
        return this.goto(ins.target, unit.file, ins.line);
      case "return": {
        // マクロの戻り値は、局所変数を戻す前に計算する
        const value = ins.value ? this.eval(ins.value) : undefined;
        const frame = this.state.callStack.pop();
        if (!frame) return this.returnWithoutCall === "continue" ? undefined : this.fail("@call されていない場所で @return が実行されました", unit, ins.line);
        this.state.position = { ...frame.return };
        this.state.locals = frame.locals;
        if (value !== undefined && frame.result) this.setVariable(frame.result, value);
        return;
      }
      case "script":
        if (this.host.runScript) return this.host.runScript(ins.code, { ...this.state.position });
        this.diagnostic("warning", "script-skipped", "@script の中身は実行しません", unit, ins.line);
        return;
    }
  }

  // ---- 本文 ----

  private async say(speaker: string | null, content: Inline[], unit: Unit, line: number, name?: Inline[], id?: string): Promise<void> {
    this.inPage = true;
    this.pageSpeaker = speaker;
    try {
      await this.sayPage(speaker, content, unit, line, name, id);
    } finally {
      this.pageSpeaker = null;
      this.inPage = false;
    }
  }

  private async sayPage(speaker: string | null, content: Inline[], unit: Unit, line: number, name?: Inline[], id?: string): Promise<void> {
    const signal = this.abort.signal;
    const index = this.state.position.index - 1;
    this.host.prefetch?.([...collectPrefetch(unit, index, this.registry), ...this.voicePrefetch(unit, index)]);
    this.prefetchTargets(unit, index);
    const voice = this.takeVoice(speaker, unit.file, line);
    // 行の最後の {noclick}: クリックを待たずに次へ進む（訳の書き方によらず、原文で決める）
    const noclick = content.at(-1)?.kind === "noclick";
    // 前のページが残した本文（{noclick}）は、このページで消える
    delete this.state.stage.noclickPage;
    this.pageRead = false;
    const source = printInline(content);
    const context = contextAt(unit.labels, index);
    const translated = this.translator?.line(unit.file, source, context, id);
    if (translated) content = translated;
    // 台詞の外側の括弧と引用符を外す（ui.text.quotes: strip）
    if (speaker !== null && this.stripQuotes()) content = stripSpeechQuotes(content);
    const label = speaker === null ? null : this.speakerLabel(speaker, name);
    delete this.state.stage.windowSuppressed;
    // @window で消していなければ、本文の前にメッセージウィンドウを出す（@window show を書かなくても文字が見える）
    if (!this.state.stage.window && !this.state.stage.windowHidden) {
      this.state.stage.window = true;
      await this.host.present({ type: "command", name: "window", args: { mode: "show" }, wait: false, stage: this.state.stage }, signal);
    }
    const key = this.programs.get(unit.file)?.pageKeys.get(line);
    // 同時に話すほかの話者（二つ目のボイスの who）。名前欄、履歴、聞いた話者に使う
    const together = [...new Set((voice?.also ?? []).flatMap((c) => (c.who && c.who !== speaker ? [c.who] : [])))].map((who): CoSpeaker => {
      const shown = this.speakerLabel(who);
      return shown ? { speaker: who, label: shown } : { speaker: who };
    });
    await this.host.present(
      { type: "page", speaker, at: { file: unit.file, line }, ...(key ? { key } : {}), ...(label ? { label } : {}), ...(voice ? { voice } : {}), ...(together.length > 0 ? { with: together } : {}) },
      signal,
    );
    const base: TextStyle = { bold: false, italic: false, color: null, perChar: null, size: null, mark: null };
    const parts: NvlPart[] = [];
    // 本文の出し分け（{seq …}）の鍵の頭と、このページの中で何番目か
    const variantBase = `${unit.file}#${textHash(source)}`;
    let variantIndex = 0;
    const walk = async (nodes: Inline[], style: TextStyle): Promise<void> => {
      for (const n of nodes) {
        // 捨てた（dispose した）実行器は、ページの残りを描画側へ送らない（制作画面の舞台が、同じ画面を組み立て直している最中など）。
        if (signal.aborted) return;
        switch (n.kind) {
          case "text":
            parts.push({ text: n.text, ruby: null, style });
            await this.host.present({ type: "text", text: n.text, ruby: null, style }, signal);
            break;
          case "ruby":
            parts.push({ text: n.base, ruby: n.reading, style });
            await this.host.present({ type: "text", text: n.base, ruby: n.reading, style }, signal);
            break;
          case "value":
            {
              const text = display(this.eval(n.expr));
              parts.push({ text, ruby: null, style });
              await this.host.present({ type: "text", text, ruby: null, style }, signal);
            }
            break;
          case "br":
            parts.push({ br: true });
            await this.host.present({ type: "br" }, signal);
            break;
          case "click":
            await this.host.waitClick(signal);
            break;
          case "noclick":
            break;
          case "command":
            await this.command(n.name, n.args, unit, line);
            break;
          case "style":
            await walk(n.children, { ...style, [n.style]: true });
            break;
          case "color":
            await walk(n.children, { ...style, color: n.color });
            break;
          case "speed":
            await walk(n.children, { ...style, perChar: n.perChar });
            break;
          case "size":
            await walk(n.children, { ...style, size: n.size });
            break;
          case "mark":
            await walk(n.children, { ...style, mark: n.color });
            break;
          case "fx": {
            // 内側の {fx} は外側の大きさと速さを引き継がない
            const { fxStrength: _s, fxSpeed: _v, ...rest } = style;
            await walk(n.children, { ...rest, fx: n.effect, ...(n.strength !== undefined ? { fxStrength: n.strength } : {}), ...(n.speed !== undefined ? { fxSpeed: n.speed } : {}) });
            break;
          }
          case "emphasis":
            await walk(n.children, { ...style, emphasis: true });
            break;
          case "variants":
            await walk(this.variantItem(n, `${variantBase}:${variantIndex++}`, true), style);
            break;
          case "image":
            parts.push({ text: "\uFFFC", ruby: null, style: { ...style, image: n.path, ...(n.height !== undefined ? { imageHeight: n.height } : {}) } });
            await this.host.present({ type: "text", text: "\uFFFC", ruby: null, style: { ...style, image: n.path, ...(n.height !== undefined ? { imageHeight: n.height } : {}) } }, signal);
            break;
        }
      }
    };
    await walk(content, base);
    if (signal.aborted) return;
    if (!noclick) await this.host.waitClick(signal);
    if (!noclick && !signal.aborted && this.state.stage.nvl !== true && !(this.chatDialogue && chatDialogueActive(this.state.stage))) this.pageRead = true;
    // 別の言語でロードしたときに作り直す元（原文と場面）
    const origin = { file: unit.file, source, ...(context ? { context } : {}), ...(name ? { name: printInline(name) } : {}), ...(id ? { id } : {}) };
    // 読み終えてから積む（クリックを待っている間のセーブでは、このページはロードでもう一度出す）
    if (this.state.stage.nvl === true && !signal.aborted) (this.state.stage.nvlPages ??= []).push({ speaker, ...(label ? { label } : {}), parts, origin });
    else if (noclick && !signal.aborted && !(this.chatDialogue && chatDialogueActive(this.state.stage))) {
      // クリックを待たずに残した本文（次の選択肢などの間も出しておく）。ロードで組み立て直すときに出し直す
      this.state.stage.noclickPage = { speaker, ...(label ? { label } : {}), parts, origin };
    }
    else if (this.chatDialogue && !signal.aborted && chatDialogueActive(this.state.stage)) {
      const stage = this.state.stage;
      const who = speaker !== null && this.cast ? castForSpeaker(this.cast, speaker) : null;
      const pose = who ? (stage.sprites[who] ?? stage.faces?.[who]) : undefined;
      pushChatMessage(stage.extra, this.chatDialogue, (chat) => ({
        speaker: speaker ?? "",
        text: chatPartsText(parts),
        image: "",
        me: speaker !== null && speaker === (chat.me || this.chatDialogue?.me),
        ...(speaker === null ? { note: true } : {}),
        ...(label ? { label } : {}),
        parts,
        ...(who && pose ? { face: { who, appearance: pose.appearance, variant: pose.variant } } : {}),
        // 言語を替えたときに出し直す元（本文の行と、名前欄の名前）
        i18n: textOrigins({
          text: { kind: "line", file: unit.file, source, ...(context ? { context } : {}), ...(id ? { id } : {}) },
          label: speaker === null ? undefined : { kind: "speaker", source: this.shownName(speaker, name) },
        })!,
      }));
    }
  }

  /**
   * 名前欄に出す名前（話者と違うときだけ。同じなら null）。この行の {name …}、無ければ @name で替えた名前、どちらも無ければ話者名。
   * 訳があれば訳す（表示名の訳は、話者名と同じく訳のファイルの speakers に書く）。
   */
  private speakerLabel(speaker: string, name?: Inline[]): string | null {
    const shown = this.shownName(speaker, name);
    const label = this.translator?.speaker(shown) ?? shown;
    return label === speaker ? null : label;
  }

  /** 名前欄に出す名前の原文（この行の {name …}、無ければ @name で替えた名前、どちらも無ければ話者名）。 */
  private shownName(speaker: string, name?: Inline[]): string {
    return name ? this.plain(name) : (this.state.stage.names?.[speaker] ?? speaker);
  }

  /**
   * 置いたままの文字（stage.extra の中の、i18n を持つもの。retranslate.ts）を、今の言語（translator）で書き換える。
   * ロードしたときと巻き戻したときに呼び、言語を替えたときはシステム画面が呼んで描画側に出し直させる。書き換えたものがあれば true。
   */
  retranslate(): boolean {
    let changed = false;
    for (const { target, origins } of withOrigins(this.state.stage.extra)) {
      for (const [field, origin] of Object.entries(origins)) {
        try {
          if (this.retranslateField(target, field, origin)) changed = true;
        } catch {
          // 式の値が読めないなど。その欄は今のまま
        }
      }
    }
    // NVL の読み終えた段落と、クリックを待たずに残した本文（{noclick}）
    const stage = this.state.stage;
    for (const page of [...(stage.nvlPages ?? []), ...(stage.noclickPage ? [stage.noclickPage] : [])]) {
      try {
        if (this.retranslatePage(page)) changed = true;
      } catch {
        // 式の値が読めないなど。その段落は今のまま
      }
    }
    return changed;
  }

  /** 読み終えた本文の一ページを、元（origin）から今の言語で作り直す。変わったら true。 */
  private retranslatePage(page: NvlPage): boolean {
    // 本文の流れに出した選択肢（ui.choice.position: inline）は、一つずつの文を訳し直す
    if (page.choice) {
      let changed = false;
      for (const option of page.choice.options) {
        const o = option.origin;
        if (!o) continue;
        const target: Record<string, Value> = { text: option.text };
        if (this.retranslateField(target, "text", o) && typeof target.text === "string") {
          option.text = target.text;
          changed = true;
        }
      }
      return changed;
    }
    const o = page.origin;
    if (!o || typeof o.source !== "string" || typeof o.file !== "string") return false;
    const before = JSON.stringify([page.parts, page.label ?? null]);
    let content = this.translator?.line(o.file, o.source, o.context, o.id) ?? parseInline(o.source).content;
    if (page.speaker !== null && this.stripQuotes()) content = stripSpeechQuotes(content);
    page.parts = this.withVariants(o.file, o.source, false, () => this.partsOf(content));
    if (page.speaker !== null) {
      const label = this.speakerLabel(page.speaker, typeof o.name === "string" ? parseInline(o.name).content : undefined);
      if (label) page.label = label;
      else delete page.label;
    }
    return JSON.stringify([page.parts, page.label ?? null]) !== before;
  }

  private retranslateField(target: Record<string, Value>, field: string, o: TextOrigin): boolean {
    if (!o || typeof o.source !== "string") return false;
    const tr = this.translator;
    const before = JSON.stringify([target[field] ?? null, target.parts ?? null]);
    switch (o.kind) {
      case "arg":
        target[field] = (o.file !== undefined ? tr?.arg?.(o.file, o.source, o.context) : null) || o.source;
        break;
      case "option":
        target[field] = this.withVariants(o.file ?? "", o.source, false, () => this.plain((o.file !== undefined ? tr?.option(o.file, o.source, o.context, o.id) : null) ?? parseInline(o.source).content));
        break;
      case "speaker": {
        const label = tr?.speaker(o.source) ?? o.source;
        if (field === "label" && label === target.speaker) delete target[field];
        else target[field] = label;
        break;
      }
      case "line": {
        const content = (o.file !== undefined ? tr?.line(o.file, o.source, o.context, o.id) : null) ?? parseInline(o.source).content;
        // 台詞の吹き出し（地の文の一行でないもの）は、出したときと同じく外側の括弧と引用符を外す（ui.text.quotes: strip）
        const parts = this.withVariants(o.file ?? "", o.source, false, () => this.partsOf(target.note !== true && typeof target.speaker === "string" && target.speaker !== "" && this.stripQuotes() ? stripSpeechQuotes(content) : content));
        target.parts = parts as unknown as Value;
        target[field] = chatPartsText(parts);
        break;
      }
      default:
        return false;
    }
    return JSON.stringify([target[field] ?? null, target.parts ?? null]) !== before;
  }

  /** 本文を、描画側に送るのと同じ一片の並びにする（本文中の命令とクリック待ちは除く。式はいまの値）。 */
  private partsOf(nodes: Inline[], style: TextStyle = { bold: false, italic: false, color: null, perChar: null, size: null, mark: null }, out: NvlPart[] = []): NvlPart[] {
    for (const n of nodes) {
      switch (n.kind) {
        case "text":
          out.push({ text: n.text, ruby: null, style });
          break;
        case "ruby":
          out.push({ text: n.base, ruby: n.reading, style });
          break;
        case "value":
          out.push({ text: display(this.eval(n.expr)), ruby: null, style });
          break;
        case "br":
          out.push({ br: true });
          break;
        case "style":
          this.partsOf(n.children, { ...style, [n.style]: true }, out);
          break;
        case "color":
          this.partsOf(n.children, { ...style, color: n.color }, out);
          break;
        case "speed":
          this.partsOf(n.children, { ...style, perChar: n.perChar }, out);
          break;
        case "size":
          this.partsOf(n.children, { ...style, size: n.size }, out);
          break;
        case "mark":
          this.partsOf(n.children, { ...style, mark: n.color }, out);
          break;
        case "fx": {
          const { fxStrength: _s, fxSpeed: _v, ...rest } = style;
          this.partsOf(n.children, { ...rest, fx: n.effect, ...(n.strength !== undefined ? { fxStrength: n.strength } : {}), ...(n.speed !== undefined ? { fxSpeed: n.speed } : {}) }, out);
          break;
        }
        case "emphasis":
          this.partsOf(n.children, { ...style, emphasis: true }, out);
          break;
        case "variants":
          this.partsOf(this.scopedVariant(n), style, out);
          break;
        case "image":
          out.push({ text: "\uFFFC", ruby: null, style: { ...style, image: n.path, ...(n.height !== undefined ? { imageHeight: n.height } : {}) } });
          break;
        default:
          break;
      }
    }
    return out;
  }

  /** 選んだ選択肢を自分の吹き出しとして積み、描画側へ知らせる（ui.chat.dialogue のとき。絵のボタン・押せる範囲は積まない）。 */
  private async chatChosen(text: string, look: ChoiceLook | null, origin?: TextOrigin): Promise<void> {
    const stage = this.state.stage;
    if (!this.chatDialogue || text === "" || !chatDialogueActive(stage) || look?.image || (look?.width !== undefined && look.height !== undefined)) return;
    pushChatMessage(stage.extra, this.chatDialogue, (chat) => ({ speaker: chat.me || (this.chatDialogue?.me ?? ""), text, image: "", me: true, ...(origin ? { i18n: { text: origin } } : {}) }));
    await this.host.present({ type: "command", name: "chat-chosen", args: {}, wait: false, stage }, this.abort.signal);
  }

  /**
   * このページで鳴らすボイス。@voice で決めたものがあればそれ、なければ話者の連番（番号を一つ進める）。
   * 番号の固定があれば、その台詞に固定した番号（固定に無い台詞は鳴らさない）。
   */
  private takeVoice(speaker: string | null, file: string, line: number): VoiceCue | null {
    const cue = this.nextVoice(speaker, file, line);
    if (!cue || !this.state.stage.voiceFilter) return cue;
    // @voice-filter で掛け続けているフィルター（@voice に filter を書いたボイスはそちら）
    const withFilter = (c: VoiceCue, who: string | null): VoiceCue => {
      if (c.filter !== undefined) return c;
      const filter = voiceFilterFor(this.state.stage, who);
      return filter ? { ...c, filter } : c;
    };
    const main = withFilter(cue, cue.who ?? speaker);
    // who を省いたボイスはその台詞の話者のもの（話者ごとのフィルターは台詞の話者のを掛ける）
    return cue.also ? { ...main, also: cue.also.map((c) => withFilter(c, c.who ?? speaker)) } : main;
  }

  private nextVoice(speaker: string | null, file: string, line: number): VoiceCue | null {
    const v = this.state.stage.voice;
    if (!v) return null;
    if (v.next) {
      const cue = v.next;
      v.next = null;
      if (!cue.also) return cue;
      // 同じ channel のボイスが重なったら、空いている channel へ回す（同時に鳴らすため）
      const used = new Set<number>();
      const [first, ...rest] = [cue, ...cue.also].map((c) => {
        let channel = c.channel ?? 1;
        while (used.has(channel)) channel++;
        used.add(channel);
        return channel === (c.channel ?? 1) ? c : { ...c, channel };
      });
      return { ...first!, also: rest };
    }
    const auto = speaker === null ? undefined : v.auto?.[speaker];
    if (!auto || auto.off) return null;
    const n = this.lockedVoice(file, line) ?? (this.voiceLock ? null : auto.next);
    if (n === null) return null;
    auto.next = n + 1;
    return { file: voiceFile(auto.pattern, n), volume: auto.volume, folder: auto.folder, n };
  }

  /** その台詞に固定したボイスの番号（固定が無い・その台詞が無ければ null）。 */
  private lockedVoice(file: string, line: number): number | null {
    const lock = this.voiceLock;
    if (!lock) return null;
    const key = this.programs.get(file)?.voiceKeys.get(line);
    return (key !== undefined ? lock.lines[key]?.n : undefined) ?? null;
  }

  /** この先の台詞で鳴る連番のボイス（先読み用。分岐は両方とも数えるので、番号は目安）。 */
  private voicePrefetch(unit: Unit, index: number, limit = 8): { kind: "asset"; folder: string; path: string }[] {
    const auto = this.state.stage.voice?.auto;
    if (!auto || Object.keys(auto).length === 0) return [];
    const next = Object.fromEntries(Object.entries(auto).map(([who, a]) => [who, a.next]));
    const out: { kind: "asset"; folder: string; path: string }[] = [];
    for (let i = index; i < unit.instructions.length && out.length < limit; i++) {
      const ins = unit.instructions[i]!;
      if (ins.op !== "say" || ins.speaker === null) continue;
      const a = auto[ins.speaker];
      if (!a || a.off) continue;
      const n = this.lockedVoice(unit.file, ins.line) ?? (this.voiceLock ? null : next[ins.speaker]!++);
      if (n !== null) out.push({ kind: "asset", folder: a.folder, path: voiceFile(a.pattern, n) });
    }
    return out;
  }

  private plain(content: Inline[]): string {
    let out = "";
    for (const n of content) {
      if (n.kind === "text") out += n.text;
      else if (n.kind === "ruby") out += n.base;
      else if (n.kind === "value") out += display(this.eval(n.expr));
      else if (n.kind === "style" || n.kind === "color" || n.kind === "speed" || n.kind === "size" || n.kind === "mark" || n.kind === "fx" || n.kind === "emphasis") out += this.plain(n.children);
      else if (n.kind === "variants") out += this.plain(this.scopedVariant(n));
    }
    return out;
  }

  // ---- 本文の出し分け（{seq a|b|c} など） ----

  /** plain と partsOf が出し分けを読むときの鍵の頭（ファイルと原文）と、何番目か。advance でなければ前に出したものを読む。 */
  private variantScope: { base: string; n: number; advance: boolean } | null = null;

  private withVariants<T>(file: string, source: string, advance: boolean, run: () => T): T {
    const previous = this.variantScope;
    this.variantScope = { base: `${file}#${textHash(source)}`, n: 0, advance };
    try {
      return run();
    } finally {
      this.variantScope = previous;
    }
  }

  /** withVariants の中なら、その鍵で出し分けを選ぶ。外なら頭のもの（表示名の {name …} の中など）。 */
  private scopedVariant(node: Extract<Inline, { kind: "variants" }>): Inline[] {
    const scope = this.variantScope;
    if (!scope) return node.items[0] ?? [];
    return this.variantItem(node, `${scope.base}:${scope.n++}`, scope.advance);
  }

  /**
   * 出し分けで今回出すもの。advance なら通った回数を一つ進めて選び（seq は最後で止まる、cycle は頭に戻る、once は出し終えたら何も出さない、
   * shuffle は乱数で、前と同じものを続けない）、advance でなければ前に出したものを返す（言語を替えて出し直すとき）。
   */
  private variantItem(node: Extract<Inline, { kind: "variants" }>, key: string, advance: boolean): Inline[] {
    const n = node.items.length;
    if (n === 0) return [];
    const seen = this.state.variants?.[key];
    const count = seen?.[0] ?? 0;
    const last = seen?.[1] ?? -1;
    if (!advance) return last >= 0 ? (node.items[last] ?? []) : [];
    let i: number;
    switch (node.mode) {
      case "seq":
        i = Math.min(count, n - 1);
        break;
      case "cycle":
        i = count % n;
        break;
      case "once":
        i = count < n ? count : -1;
        break;
      case "shuffle":
        if (n === 1) i = 0;
        else if (last < 0 || last >= n) i = Math.floor(this.env.random() * n);
        else {
          const r = Math.floor(this.env.random() * (n - 1));
          i = r >= last ? r + 1 : r;
        }
        break;
    }
    (this.state.variants ??= {})[key] = [count + 1, i];
    return i < 0 ? [] : (node.items[i] ?? []);
  }

  /**
   * 条件（@if、@elif、@while、@for、行の if=、選択肢の if= locked= call=）の式を真偽にする。式が誤りなら、誤りを知らせて偽として扱う
   * （真の枝へ黙って入らない。初期値の無い変数を数と比べたときなど）。
   */
  private condition(expr: Expr, unit: Unit, line: number): boolean {
    try {
      return truthy(this.eval(expr));
    } catch (e) {
      if (!(e instanceof EvalError)) throw e;
      this.fail(`条件の式を計算できないため、偽として扱いました（${e.message}）`, unit, line);
      return false;
    }
  }

  /**
   * 選択肢の条件のパラメータ。if= は出すか、locked= は押せない状態で見せるか、call= は選んだら呼び出すか。
   * 書いていなければ absent。式が誤りなら偽（condition）。
   */
  private optionFlag(args: Argument[], key: "if" | "locked" | "call", absent: boolean, unit: Unit, line: number): boolean {
    const cond = normalizeBooleanArgs(CHOICE_OPTION, args).find((a) => a.key === key);
    if (!cond) return absent;
    return cond.value.kind === "expr" ? this.condition(cond.value.expr, unit, line) : truthy(literalValue(cond.value, { kind: "bool" }));
  }

  /** 選択肢の見た目の引数を値にする。 */
  private look(args: Argument[], unit: Unit, line: number, context: string): ChoiceLook {
    const values = this.resolveArgs(CHOICE_OPTION, args.filter((a) => !NOT_LOOK.has(a.key)), { file: unit.file, context });
    const look: ChoiceLook = {};
    if (this.optionFlag(args, "locked", false, unit, line)) look.locked = true;
    for (const key of ["image", "hover", "cursor", "tip"] as const) if (typeof values[key] === "string") look[key] = values[key];
    for (const key of ["x", "y", "width", "height"] as const) if (typeof values[key] === "number") look[key] = values[key];
    return look;
  }

  // ---- 命令 ----

  private async command(name: string, args: Argument[], unit: Unit, line: number, body?: string, content?: string): Promise<void> {
    const define = this.findDefine(name, unit.file);
    if (define) {
      // 作品の既定値（commandDefaults）はマクロにも効く
      const values = this.resolveArgs(applyCommandDefaults(defineSpec(name, define), this.commandDefaults), args);
      // 戻り値（@return (式)）を入れる変数（型 variable のパラメータ）と、@with で渡した中身
      const resultParam = define.params?.find((p) => p.type === "variable")?.name;
      const result = resultParam !== undefined && typeof values[resultParam] === "string" ? (values[resultParam] as string) : undefined;
      this.state.callStack.push({ return: { ...this.state.position }, locals: this.state.locals, ...(result ? { result } : {}), ...(content ? { content } : {}) });
      // 引数名の - は、中の式では _ で参照する（face-name → face_name）。
      this.state.locals = Object.fromEntries(Object.entries(values).map(([k, v]) => [paramLocalName(k), v]));
      this.state.position = { unit: define.id, index: 0 };
      return;
    }
    const impl = this.implementations.get(name);
    if (content !== undefined) {
      this.diagnostic("warning", "unsupported-command", `@with で呼べるのは @define のマクロだけです（@${name} はマクロではないため、中身ごとスキップしました）`, unit, line);
      return;
    }
    if (!impl) {
      this.diagnostic("warning", "unsupported-command", `@${name} はこの環境では実装されていないため、スキップしました`, unit, line);
      return;
    }
    const context = contextAt(unit.labels, this.state.position.index - 1);
    const values = this.resolveArgs(impl.spec, args, { file: unit.file, context });
    const sources = exprSources(impl.spec, args);
    // プレイを終える命令のエンディングを、見た結末として全セーブ共通に残す（式の endings() と、見た数で進める実績）
    const achieved = impl.spec.ends ? this.noteEnding(values, unit.file, context) : [];
    this.unlockCg(impl.spec, values);
    const skip = effectSkip(impl.spec, values);
    const at = { unit: unit.id, index: this.state.position.index - 1 };
    const previous = this.resumeAt;
    const previousState = this.resumeState;
    const ctx: CommandContext = {
      runtime: this,
      state: this.state,
      ...(body !== undefined ? { body } : {}),
      sources,
      signal: this.abort.signal,
      // 演出の命令は、描画側にクリックで早送りできるか（skip=false なら早送りしない）を添える。
      // 自動確認では、autoplay を持つ命令は描かせずに（画面なしの記録には残す）、その答えで進める
      present: async (presented, wait) => {
        // 送ったページのあとの最初の命令に印を付ける（描画側がそこで前のページの本文を消す）
        const afterPage = this.pageRead;
        this.pageRead = false;
        const event = { type: "command" as const, name, args: presented, wait, stage: this.state.stage, ...(skip !== undefined ? { skip } : {}), ...(afterPage ? { afterPage } : {}) };
        if (!impl.autoplay) return this.host.present(event, this.abort.signal);
        // 自動確認でなければ、操作待ちの画面（か動画）として描かせる（lim shot が撮る所の目印にする）
        if (this.host.automated !== true) return this.host.present({ ...event, interactive: true }, this.abort.signal);
        await this.host.present({ ...event, autoplay: true }, this.abort.signal);
        return impl.autoplay(presented, ctx);
      },
      // 本文中の命令なら、すでにそのページから再開する位置になっている。
      // UI を出して待つ命令は、待つ間に描画側が書いた進み具合（stage.extra）をセーブに残したいので、
      // 状態は控えず、セーブの時点のものを使う（ページの途中なら、ページの頭の状態から流し直す）。
      resumeHere: () => {
        if (!previous) this.resumeAt = at;
      },
      choose: (options, targets) => this.host.choose(options, this.abort.signal, undefined, targets),
      unlockCg: (image) => {
        if (typeof image === "string" && image !== "") ((this.system.cg_unlocked ??= {}) as Record<string, Value>)[image] = true;
      },
      pick: async (outcomes, answer) => {
        if (answer !== undefined && answer !== null) return answer;
        if (outcomes.length === 0) return null;
        const picked = await ctx.choose(
          outcomes.map((o) => o.label),
          outcomes.map((o) => o.target),
        );
        return picked === null ? null : (outcomes[picked] ?? outcomes[0]!).value;
      },
      data: (name) => this.loadData(name),
      atSceneBreak: (presented) => {
        const wait = (this.state.stage.sceneWait ??= { commands: [] });
        wait.commands.push({ name, args: structuredClone(presented) });
      },
    };
    // 場面の切れ目（待たせている通知を出す時機）。場面転換、暗転、別の絵への @bg は始める前に印を付け（演出の途中のセーブにも入る）、
    // ほかの命令（プラグインの命令など）が背景を替えたときは終わってから付ける（取っておいた状態へ戻す命令は、戻した状態のまま）
    const stage = this.state.stage;
    const background = stage.background;
    if (name === "scene-change" || name === "mask" || (name === "bg" && typeof values.image === "string" && values.image !== background)) this.sceneBreak();
    // 見た数で進めた実績は、命令の前に描画側へ知らせる（@achieve-progress と同じ形。タイトルへ戻る前に通知を出す）
    for (const a of achieved) await this.host.present({ type: "command", name: "achieve-progress", args: a, wait: false, stage: this.state.stage }, this.abort.signal);
    try {
      await impl.run(values, ctx);
    } finally {
      this.resumeAt = previous;
      this.resumeState = previousState;
      if (this.state.stage === stage && stage.background !== background) this.sceneBreak();
    }
  }

  /** 場面の切れ目を過ぎた。それまでに待たせていた命令を、次の本文か選択肢の前に出すようにする。 */
  private sceneBreak(): void {
    const wait = this.state.stage.sceneWait;
    if (wait && wait.commands.length > 0) wait.due = wait.commands.length;
  }

  /** 場面の切れ目を過ぎた待たせている命令を、描画側へ渡して外す（本文と選択肢の前。その位置のセーブには入れない）。 */
  private async flushSceneWait(): Promise<void> {
    const wait = this.state.stage.sceneWait;
    if (!wait?.due) return;
    const due = wait.commands.splice(0, wait.due);
    if (wait.commands.length > 0) delete wait.due;
    else delete this.state.stage.sceneWait;
    for (const c of due) await this.host.present({ type: "command", name: c.name, args: c.args, wait: false, stage: this.state.stage }, this.abort.signal);
  }

  /** CG として解放する印のあるパラメータで出した画像が CG なら解放する（folder= があればそのフォルダで見る）。 */
  private unlockCg(spec: CommandSpec, values: Args): void {
    if (!this.isCg) return;
    for (const [name, p] of Object.entries(spec.params)) {
      if (p.type.kind !== "asset" || !p.type.cg) continue;
      const image = values[name];
      const folder = typeof values.folder === "string" ? values.folder : p.type.folder;
      if (typeof image !== "string" || image === "" || !this.isCg(folder, image)) continue;
      ((this.system.cg_unlocked ??= {}) as Record<string, Value>)[image] = true;
    }
  }

  /**
   * 命令が作品のデータから出した画像を CG として解放する（liminalia.json の extra.cg か extra.cgAuto の画像なら。@bg で出したときと同じ）。
   * 解放したら true。データの形の宣言でその欄に CG の印（d.asset(…, { cg: true })）を付けておくと、どこからも出ない CG の検査が数える。
   */
  unlockCgImage(folder: string, image: string): boolean {
    if (!this.isCg || image === "" || !this.isCg(folder, image)) return false;
    ((this.system.cg_unlocked ??= {}) as Record<string, Value>)[image] = true;
    return true;
  }

  /** 再開する位置と、その時点の状態を控える（null で外す）。 */
  private holdResume(at: Position | null): void {
    this.resumeAt = at;
    this.resumeState = at ? toSaveData(this.state) : null;
  }

  /**
   * 引数を仕様の型に合わせた値にし、既定値を補う。at（書いたファイルと場面）を渡せば、訳す印（translate: "text"）のある文字の引数を
   * 遊んでいる言語の訳に替える（訳が無ければそのまま）。
   */
  private resolveArgs(spec: CommandSpec, args: Argument[], at?: { file: string; context: string }): Args {
    const conflict = booleanShorthandConflicts(spec, args, this.cast)[0];
    if (conflict) throw new EvalError(`${conflict.name} は真偽値と ${conflict.positional} の両方に読めます。真偽値には ${conflict.name}=true と書いてください`);
    const out: Args = {};
    let position = 0;
    for (const a of normalizeBooleanArgs(spec, args)) {
      const name = a.key ?? spec.positional[position++];
      if (name === undefined) continue;
      const type = spec.params[name]?.type ?? { kind: "string" };
      out[name] = a.value.kind === "expr" ? this.eval(a.value.expr) : literalValue(a.value, type);
      if (spec.ends && name === "ending") {
        // ending=true は真偽の字面でなく、エンディングの種類の true
        if (out[name] === true) out[name] = "true";
        // 前の書き方の文言（BAD END、通り雨など。種類でないもの）は、移すまでコマンドの文字として訳す
        const value = out[name];
        if (at && a.value.kind === "string" && typeof value === "string" && value.trim() !== "" && !this.endingKinds.names.has(value.trim())) {
          noteArgOrigin(out, name, { kind: "arg", file: at.file, source: value, ...(at.context ? { context: at.context } : {}) });
          const translated = this.translator?.arg?.(at.file, value, at.context);
          if (translated) out[name] = translated;
        }
        continue;
      }
      if (at && type.kind === "string" && type.translate === "text" && typeof out[name] === "string" && out[name] !== "") {
        // 字面で書いた文字は、置いたままの文字を言語を替えたときに出し直せるよう、元を控える（argOrigin）
        if (a.value.kind === "string") noteArgOrigin(out, name, { kind: "arg", file: at.file, source: out[name] as string, ...(at.context ? { context: at.context } : {}) });
        const translated = this.translator?.arg?.(at.file, out[name] as string, at.context);
        if (translated) out[name] = translated;
      }
    }
    for (const [name, p] of Object.entries(spec.params)) {
      // 旧名の作品既定値より、この行に明示した新しい名前を優先する。
      if (spec.name === "scene-change" && name === "hide-at" && args.some((a) => a.key === "hide-chara-at") && !args.some((a) => a.key === "hide-at")) continue;
      if (!(name in out) && p.default !== undefined) out[name] = literalValue(parseLiteral(p.default), p.type);
    }
    return out;
  }

  /** そのファイルと、そのファイルが @use したファイルの @define を探す。 */
  private findDefine(name: string, file: string): Unit | undefined {
    const program = this.programs.get(file);
    const own = program?.defines.get(name);
    if (own) return own;
    for (const used of program?.uses ?? []) {
      const d = this.programs.get(used)?.defines.get(name);
      if (d) return d;
    }
    return undefined;
  }

  // ---- 移動 ----

  /** @jump と選択肢の移動。ほかのファイル（章）へ移ったら場面の切れ目にする（@call と @return は切れ目にしない）。 */
  private async moveTo(target: Target, currentFile: string, line: number): Promise<void> {
    await this.goto(target, currentFile, line);
    if (fileOf(this.state.position.unit) !== currentFile) this.sceneBreak();
  }

  private async goto(target: Target, currentFile: string, line = 0): Promise<void> {
    if (target.expr) {
      // 飛び先を実行時に決める式。値は `#ラベル`・`ファイル`・`ファイル#ラベル` の文字列
      const value = this.eval(target.expr);
      const resolved = typeof value === "string" ? parseTargetText(value.trim()) : null;
      if (!resolved) {
        const unit = await this.unit(this.state.position.unit);
        this.fail(`ジャンプ先の式の値 ${JSON.stringify(value)} は \`#ラベル\`、\`ファイル\`、\`ファイル#ラベル\` のどの形でもありません`, unit, line);
        return;
      }
      // to= の候補を書いたなら、その中のどれかでなければならない（検査と分岐の地図は候補だけを見ている）
      if (target.candidates && !target.candidates.includes(String(value).trim())) {
        const unit = await this.unit(this.state.position.unit);
        this.fail(`ジャンプ先の式の値 ${JSON.stringify(value)} は候補（to=${target.candidates.join(",")}）にありません`, unit, line);
        return;
      }
      return this.goto(resolved, currentFile, line);
    }
    const file = target.file ?? currentFile;
    const program = await this.program(file);
    if (file !== fileOf(this.state.position.unit)) this.state.locals = {};
    if (target.label === null) {
      this.state.position = { unit: program.main.id, index: 0 };
      this.visited(file);
      return;
    }
    const index = program.main.labels[target.label];
    if (program.main.nestedLabels?.has(target.label)) {
      this.fail(`ラベル #${target.label} は @if の中にあるため、ジャンプできません`, program.main, line);
      return;
    }
    if (index === undefined) {
      // @define・@with の中のラベルは別の実行単位にある（場面の名前に使う）ので、そこへは飛べない
      const inner = [...program.defines.entries()].find(([, u]) => target.label! in u.labels);
      // 知らせる場所は、ジャンプした行（ジャンプ先のファイルの頭ではなく）
      this.fail(
        inner
          ? `ラベル #${target.label} は ${inner[0].startsWith("@with:") ? "@with" : `@define ${inner[0]}`} の中にあるため、ジャンプできません`
          : `ラベル #${target.label} が ${file} にありません`,
        await this.unit(this.state.position.unit),
        line,
      );
      return;
    }
    this.state.position = { unit: program.main.id, index };
  }

  /**
   * ファイルを読んで実行できる形にする（一度読んだものは持っておく）。quiet（先読み）なら、見つけた誤りはまだ知らせず、
   * そのファイルを本当に使うときに知らせる（通らない分岐の先の誤りを、遊んでいる途中に出さないため）。
   */
  async program(file: string, quiet = false): Promise<Program> {
    let program = this.programs.get(file);
    if (!program) {
      // 先読みと本当の読み込みが重なっても、読むのは一度
      let loading = this.loadingPrograms.get(file);
      if (!loading) {
        loading = this.readProgram(file).finally(() => this.loadingPrograms.delete(file));
        this.loadingPrograms.set(file, loading);
      }
      program = await loading;
    }
    if (!quiet) this.flushDiagnostics(file);
    return program;
  }

  /** 読み込み中のファイル（先読みと重なったとき、同じ読み込みを待つ）。 */
  private readonly loadingPrograms = new Map<string, Promise<Program>>();
  /** 読んだが、まだ知らせていない誤り（ファイル → 診断）。使ったときに知らせる。 */
  private readonly pendingDiagnostics = new Map<string, Diagnostic[]>();

  private async readProgram(file: string): Promise<Program> {
    const source = await this.host.loadSource(file);
    const speakersKey = this.speakers.join("\n");
    const cached = this.options.programCache?.get(file);
    const hit = cached && cached.source === source && cached.speakers === speakersKey ? cached : null;
    const script = hit ? hit.script : parse(source, file, { speakers: this.speakers });
    // 約物の検査、書き方の提案（立ち絵のちらつき、既定値と同じパラメータなど）、前の名前の fade= は、実行の結果を変えない書き方の点検
    // （lim check と制作画面が作品の設定と原文の言語で見る）なので、動かすときには知らせない（runtimeDiagnostic。@liminalia/lang の RUNTIME_QUIET の表）
    // @use したファイルのマクロ（unknown-command）と関数（unknown-function）は、このファイルだけでは分からないので知らせない（呼んだときに分かる）
    // @script（作品の allowScript を知らない。中身を実行しないことは、通ったときに script-skipped で知らせる）も知らせない
    // 書き出したゲームでは検査しない（__LIMINALIA_EXPORT__）
    const found = [
      ...script.diagnostics.filter(runtimeDiagnostic),
      ...(typeof __LIMINALIA_EXPORT__ !== "undefined" && __LIMINALIA_EXPORT__ ? [] : check(script, { registry: this.registry, punctuation: false }).filter((d) => !RUN_TIME_KNOWN.has(d.code) && runtimeDiagnostic(d))),
    ];
    const program = hit ? hit.program : buildProgram(script);
    if (!hit) this.options.programCache?.set(file, { source, speakers: speakersKey, program, script });
    this.programs.set(file, program);
    if (found.length > 0) this.pendingDiagnostics.set(file, found);
    // @use したファイルも読んでおく（そこにある @define を呼ぶため）。互いに @use していても一度だけ読む。
    for (const used of program.uses) await this.program(used, true);
    return program;
  }

  /** まだ知らせていない、そのファイルと @use したファイルの誤りを知らせる。 */
  private flushDiagnostics(file: string, seen = new Set<string>()): void {
    if (seen.has(file)) return;
    seen.add(file);
    const found = this.pendingDiagnostics.get(file);
    if (found) {
      this.pendingDiagnostics.delete(file);
      for (const d of found) this.host.onDiagnostic?.(d);
    }
    for (const used of this.programs.get(file)?.uses ?? []) this.flushDiagnostics(used, seen);
  }

  /** 先読みした飛び先（`ファイル#ラベル`）。同じところは二度読まない。 */
  private readonly prefetched = new Set<string>();

  /**
   * この先（collectPrefetch と同じ範囲）の @jump・@call・選択肢の飛び先を先読みする。別のファイルならそのファイルを読んでおき、
   * 飛び先の頭から使う素材を描画側に渡す（同じファイルでも、見ている範囲の外のラベルなら素材を渡す）。式の飛び先は読まない。
   * 一ページに読むのは新しい飛び先 MAX_TARGET_PREFETCH 個まで。読めなくても黙る（本当に飛んだときに知らせる）。
   */
  private prefetchTargets(unit: Unit, index: number, limit = 40): void {
    if (!this.host.prefetch) return;
    const targets: Target[] = [];
    const end = Math.min(unit.instructions.length, index + limit);
    for (let i = index; i < end; i++) {
      const ins = unit.instructions[i]!;
      if (ins.op === "jump" || ins.op === "call") targets.push(ins.target);
      else if (ins.op === "choice") for (const o of ins.options) targets.push(o.target);
    }
    let started = 0;
    for (const t of targets) {
      if (t.expr || started >= MAX_TARGET_PREFETCH) continue;
      const file = t.file ?? unit.file;
      const key = `${file}#${t.label ?? ""}`;
      if (this.prefetched.has(key)) continue;
      if (file === unit.file) {
        // 同じファイルのラベルは、見ている範囲の中なら collectPrefetch が拾っている
        const at = t.label === null ? 0 : unit.labels[t.label];
        if (unit.id !== fileOf(unit.id) || at === undefined || (at >= index && at < end)) continue;
      }
      this.prefetched.add(key);
      started++;
      const signal = this.abort.signal;
      void this.program(file, true).then(
        (program) => {
          if (signal.aborted) return;
          const at = t.label === null ? 0 : program.main.labels[t.label];
          if (at !== undefined) this.host.prefetch?.(collectPrefetch(program.main, at, this.registry, TARGET_PREFETCH_LIMIT));
        },
        () => undefined,
      );
    }
  }

  private async unit(id: string): Promise<Unit> {
    const program = await this.program(fileOf(id));
    if (id === program.main.id) return program.main;
    const unit = program.defines.get(id.slice(id.indexOf("::") + 2));
    if (!unit) throw new Error(`実行単位 ${id} がありません`);
    return unit;
  }

  // ---- 変数 ----

  private readonly env: EvalEnv = {
    lookup: (name) => {
      if (name === "game") return this.state.game;
      if (name === "system") return this.system;
      if (name === "temp") return this.state.temp;
      if (Object.hasOwn(this.state.locals, name)) return this.state.locals[name] ?? null;
      // セーブの様子（読むだけ）。version はロードしたセーブを作った作品の版（新しく始めたプレイは今の版、版を入れる前のセーブは空）
      if (name === "save") return { version: this.state.gameVersion ?? "" };
      return null;
    },
    random: () => {
      const { value, seed } = nextRandom(this.state.seed);
      this.state.seed = seed;
      return value;
    },
    story: (name, args) => this.story(name, args),
    fn: (name, file) => this.findFunction(name, file ?? this.currentUnit?.file ?? fileOf(this.state.position.unit)),
  };

  /** そのファイルと、そのファイルが @use したファイルの @function を探す。 */
  private findFunction(name: string, file: string): UserFunction | undefined {
    const program = this.programs.get(file);
    const own = program?.functions.get(name);
    if (own) return own;
    for (const used of program?.uses ?? []) {
      const f = this.programs.get(used)?.functions.get(name);
      if (f) return f;
    }
    return undefined;
  }

  // ---- 進み具合と遊んでいる環境（式の visits・read・chosen・lang・platform・app・replaying） ----

  /** 式の lang() が返す、遊んでいる言語。描画側が入れる（言語を替えたら入れ直す）。 */
  language: string;
  /** 式の platform()・app() が返す、遊んでいる機種。描画側が入れる。 */
  platform: Platform;
  /** 再生しているおまけの回想の id（start の replay）。回想でなければ null。 */
  replay: string | null = null;
  /** 章の情報（options.chapters）。 */
  readonly chapters: readonly ChapterInfo[];
  /** 数を数える実績の目標（options.achievementGoals）。 */
  readonly achievementGoals: Readonly<Record<string, number>>;

  /**
   * 今のシナリオファイル（実行中の命令のファイル。始める前は再開する位置のファイル）の章（liminalia.json の chapters）。無ければ null。
   * 章の扉や章の終わりのプラグインのコマンドは、ここから番号と題を読む。
   */
  get chapter(): ChapterInfo | null {
    return chapterOf(this.chapters, this.currentUnit?.file ?? fileOf(this.state.position.unit));
  }

  private story(name: string, args: Value[]): Value {
    switch (name) {
      case "visits":
        return this.state.visits?.[this.progressKey(args[0] ?? null)] ?? 0;
      case "read":
        return countOf(this.system[READ_KEY], this.progressKey(args[0] ?? null)) > 0;
      case "chosen":
        return (this.state.chosen?.[String(args[0])] ?? 0) > 0;
      case "lang":
        return this.language;
      case "platform":
        return this.platform.device;
      case "app":
        return this.platform.app;
      case "replaying":
        return this.replay !== null;
      case "chapter":
        return this.chapter?.id ?? "";
      case "endings": {
        const kind = args[0];
        if (kind !== undefined && kind !== null && typeof kind !== "string") throw new EvalError(`endings() にはエンディングの種類（bad など）を渡します（${JSON.stringify(kind)}）`);
        return countEndings(this.system[ENDINGS_KEY], typeof kind === "string" && kind !== "" ? kind : undefined);
      }
      default:
        throw new EvalError(`関数 ${name}() はありません`);
    }
  }

  /** visits・read の鍵（`ファイル#ラベル` か `ファイル`）。`#ラベル` は式を書いたファイルのラベル。 */
  private progressKey(value: Value): string {
    const target = typeof value === "string" ? parseTargetText(value.trim()) : null;
    if (!target || target.expr) throw new EvalError(`ジャンプ先（#ラベル、ファイル、ファイル#ラベル）を渡します（${JSON.stringify(value)}）`);
    const file = target.file ?? this.currentUnit?.file ?? fileOf(this.state.position.unit);
    return target.label === null ? file : `${file}#${target.label}`;
  }

  /** 見たエンディングで進める実績（options.endingAchievements）。 */
  readonly endingAchievements: Readonly<Record<string, { endings: string; goal: number }>>;
  /** 使えるエンディングの種類（組み込みと options.endingKinds）。 */
  readonly endingKinds: EndingKinds;

  /**
   * プレイを終える命令の ending= と title=（原文。訳す前）を、見た結末として全セーブ共通の ENDINGS_KEY に残す（鍵はシーンと種類と名前）。
   * 見た数で進める実績の数を合わせ、変わったものを @achieve-progress の形で返す（描画側に知らせる）。回想の間は残さない。
   */
  private noteEnding(values: Args, file: string, context: string): Args[] {
    if (this.replay !== null) return [];
    const source = (name: string) => argOrigin(values, name)?.source ?? values[name];
    const ref = endingRef(source("ending"), source("title"), this.endingKinds);
    if (!ref) return [];
    const record = scopeOf(this.system, ENDINGS_KEY);
    const key = endingRecordKey(context ? `${file}#${context}` : file, ref);
    if (record[key] === ref.kind) return [];
    record[key] = ref.kind;
    this.variablesChanged("system");
    const out: Args[] = [];
    const progress = (this.system.achievement_progress ??= {}) as Record<string, number>;
    const unlocked = (this.system.achievements ??= {}) as Record<string, string>;
    for (const [id, a] of Object.entries(this.endingAchievements)) {
      const value = countEndings(record, a.endings);
      const now = typeof progress[id] === "number" ? progress[id] : 0;
      if (value <= now) continue;
      progress[id] = value;
      let reached = false;
      if (value >= a.goal && !unlocked[id]) {
        unlocked[id] = new Date().toISOString();
        reached = true;
      }
      out.push({ id, value, goal: a.goal, unlocked: reached });
    }
    return out;
  }

  /** ラベル（かファイルの頭）に入ったことを数える（このプレイの回数と、全セーブ共通の既読）。 */
  private visited(key: string): void {
    const visits = (this.state.visits ??= {});
    visits[key] = (visits[key] ?? 0) + 1;
    scopeOf(this.system, READ_KEY)[key] = true;
    this.variablesChanged("visits");
  }

  /** 選んだ選択肢の文（原文の飾りを外したもの）を覚える。 */
  private noteChosen(option: ChoiceOption): void {
    const chosen = (this.state.chosen ??= {});
    const text = plainText(option.content);
    chosen[text] = (chosen[text] ?? 0) + 1;
    this.variablesChanged("chosen");
  }

  eval(expr: Expr): Value {
    return evaluate(expr, this.env);
  }

  private assign(target: Expr, operator: "=" | "+=" | "-=" | "*=" | "/=", value: Value): void {
    // 左辺を「入れ物」と「キー」に分ける。途中の入れ物がなければ作る。
    const path: (string | number)[] = [];
    let e = target;
    while (e.kind === "member" || e.kind === "index") {
      if (e.kind === "member") path.unshift(e.property);
      else {
        const k = this.eval(e.index);
        if (typeof k !== "string" && typeof k !== "number") throw new EvalError("添字には文字列か数値が必要です");
        path.unshift(k);
      }
      e = e.object;
    }
    if (e.kind !== "name") throw new EvalError("@set の左辺が変数ではありません");
    checkKeys([e.name, ...path]);
    let container: Record<string | number, Value>;
    let key: string | number;
    if (e.name === "game" || e.name === "system" || e.name === "temp") {
      if (path.length === 0) throw new EvalError(`${e.name} そのものには代入できません（${e.name}.名前 に代入します）`);
      container = this.env.lookup(e.name) as Record<string, Value>;
      key = path.pop()!;
    } else {
      container = this.state.locals;
      key = e.name;
      if (path.length > 0) {
        path.unshift(key);
        key = path.pop()!;
      }
    }
    const name = [e.name === "game" || e.name === "system" || e.name === "temp" ? e.name : null, ...path, key].filter((p) => p !== null).join(".");
    for (const p of path) {
      const next = container[p];
      if (next === null || next === undefined || typeof next !== "object") container[p] = {};
      container = container[p] as Record<string | number, Value>;
    }
    if (operator === "=") {
      container[key] = value;
    } else {
      const current = container[key] ?? null;
      if (operator === "+=" && (typeof current === "string" || typeof value === "string")) {
        container[key] = display(current) + display(value);
      } else {
        const a = current === null ? 0 : current;
        if (typeof a !== "number" || typeof value !== "number") throw new EvalError(`${operator} は数値にだけ使えます`);
        container[key] = operator === "+=" ? a + value : operator === "-=" ? a - value : operator === "*=" ? a * value : checkedDivision(a, value, "/");
      }
    }
    this.assigned(name, container[key]!);
  }

  private assigned(path: string, value: Value): void {
    if (this.onAssign && this.currentUnit) this.onAssign(path, value, { file: this.currentUnit.file, line: this.currentLine });
    this.variablesChanged(path);
  }

  private readonly changeListeners = new Set<(path: string) => void>();

  /**
   * 変数が変わったときに呼ぶ（@set・@let・命令の結果の setVariable・持ち物・選んだ選択肢と入った場面の数、variablesChanged で知らせたもの）。
   * path は game.x・system.x・temp.x（入れ子は game.a.b）か局所変数の名前、持ち物は game.@items、選んだ選択肢は chosen、入った場面は visits、
   * まとめて消したら game・system・temp。図鑑の見回しのように、変数で決まるものを変わった時点で見直すのに使う。返す関数で外す。
   */
  onVariableChange(listener: (path: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** 変数を変えたことを知らせる（state.game などを直に書き換えたプラグインが呼ぶ。setVariable は自分で知らせる）。 */
  variablesChanged(...paths: string[]): void {
    for (const path of paths) for (const listener of [...this.changeListeners]) listener(path);
  }

  // ---- 診断 ----

  private fail(message: string, unit: Unit, line: number): void {
    this.diagnostic("error", "runtime", message, unit, line);
    if (this.onError === "stop") this.halt ??= { reason: "error", at: { ...this.state.position }, message };
  }

  private diagnostic(severity: Diagnostic["severity"], code: string, message: string, unit: Unit, line: number): void {
    this.host.onDiagnostic?.({ severity, code, message, file: unit.file, line });
  }
}

/** 命令の目印の鍵（本文はその文、選択肢は選択肢の文を並べたもの）。ほかの命令は無い。 */
/** 一ページに先読みする新しい飛び先の数。 */
const MAX_TARGET_PREFETCH = 4;
/** 読み込んだファイルの検査のうち、実行器には分からない、または実行したときに知らせるもの（readProgram）。 */
const RUN_TIME_KNOWN: ReadonlySet<string> = new Set(["unknown-command", "unknown-function", "script-not-allowed", "script-skipped"]);
/** 飛び先の頭から、素材を集める命令の数。 */
const TARGET_PREFETCH_LIMIT = 24;

/** 呼び出す命令か（@call・命令の名前のマクロ・@with の中身）。マクロかどうかは見ない（どの命令も、呼べば戻り先はその次）。 */
function callSite(ins: Instruction): boolean {
  return ins.op === "call" || ins.op === "command" || ins.op === "content";
}

/** 呼び出す命令の鍵（命令の名前と引数、@call の飛び先から作る。行は入れない）。 */
function siteKey(ins: Instruction): string | undefined {
  if (ins.op === "call") return translationKey("", "line", `@call ${ins.target.file ?? ""}#${ins.target.label ?? ""}${ins.target.expr ? " (expr)" : ""}`);
  if (ins.op === "command") return translationKey("", "line", `@${ins.name} ${ins.args.map((a) => `${a.key ?? ""}=${printLiteral(a.value)}`).join(" ")}`);
  if (ins.op === "content") return translationKey("", "line", "@content");
  return undefined;
}

/** その命令が callee（実行単位の id）を呼ぶか（前の版のセーブの戻り先を探すとき）。式の飛び先は呼ぶものとみなす。 */
function calls(ins: Instruction, file: string, callee: string): boolean {
  const calleeFile = fileOf(callee);
  const define = callee.includes("::") ? callee.slice(callee.indexOf("::") + 2) : null;
  if (ins.op === "call") return !!ins.target.expr || (define === null && (ins.target.file ?? file) === calleeFile);
  if (ins.op === "command") return define !== null && ins.name === define;
  if (ins.op === "choice") return define === null && ins.options.some((o) => (o.target.file ?? file) === calleeFile && o.args.some((a) => a.key === "call"));
  return false;
}

function instructionKey(ins: Instruction): string | undefined {
  if (ins.op === "say") return translationKey("", "line", `${ins.speaker ?? ""}${printInline(ins.content)}`);
  if (ins.op === "choice") return translationKey("", "option", ins.options.map((o) => printInline(o.content)).join("\n"));
  return undefined;
}

/**
 * 命令の演出をクリックで早送りできるか。skip の引数を持つ命令はその値（@movie は既定で false）。持たなくても、時間の引数があって
 * 終わりを待つ（waits か wait の引数を持つ）命令は、早送りできる演出とみなす（作品の命令の演出）。どちらでもない命令（音、入力を待つ画面など）は undefined。
 */
function effectSkip(spec: CommandSpec, values: Args): boolean | undefined {
  if (typeof values.skip === "boolean") return values.skip;
  const timed = Object.values(spec.params).some((p) => p.type.kind === "duration");
  return timed && (spec.waits === true || "wait" in spec.params) ? true : undefined;
}

/** ms だけ実時間で待つ（signal で打ち切ったら解決しない）。 */
function realCountdown(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  });
}

/** 遊んでいる機種（式の platform()・app()）。device は pc か mobile、app はアプリ（デスクトップ版、スマホ版）なら true。 */
export interface Platform {
  device: "pc" | "mobile";
  app: boolean;
}

/** 名前 → 数 の入れ物（無い・形の違う値なら作り直す）。 */
function scopeOf(root: Scope, key: string): Scope {
  const v = root[key];
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Scope;
  return (root[key] = {});
}

/** 入れ物の数（真なら 1、無ければ 0）。 */
function countOf(scope: Value | undefined, key: string): number {
  if (!scope || typeof scope !== "object" || Array.isArray(scope) || !Object.hasOwn(scope, key)) return 0;
  const v = (scope as Scope)[key];
  return typeof v === "number" ? v : v === true ? 1 : 0;
}

/** 選択肢の行の引数のうち、見た目でないもの（出す条件と、呼び出すか）。 */
const NOT_LOOK = new Set<string | null>(["if", "call", "locked"]);

function fileOf(unitId: string): string {
  const i = unitId.indexOf("::");
  return i < 0 ? unitId : unitId.slice(0, i);
}

function literalValue(v: Literal, type: ParamType): Value {
  switch (v.kind) {
    case "string":
      return v.value;
    case "number":
      return v.value;
    case "duration":
      return v.ms;
    case "bool":
      return v.value;
    case "color":
      return v.value;
    case "expr":
      throw new Error("式は literalValue に渡さない");
  }
  void type;
}

function defineSpec(name: string, unit: Unit): CommandSpec {
  // 型は作品の既定値（commandDefaults）の値を確かめるのに使う（値の読み方は書いた字面で決まる）
  const params: CommandSpec["params"] = Object.fromEntries(
    (unit.params ?? []).map((p) => {
      const type = paramTypeFromName(p.type) ?? { kind: "string" as const };
      return [p.name, p.defaultValue ? { type, default: printDefault(p.defaultValue), doc: "" } : { type, doc: "" }];
    }),
  );
  return { name, summary: "", positional: [], params, example: "" };
}

function printDefault(v: Literal): string {
  switch (v.kind) {
    case "string":
      return JSON.stringify(v.value);
    case "duration":
      return v.source;
    case "expr":
      return v.source;
    default:
      return String(v.value);
  }
}

export type { PresentEvent };
export { CORE_COMMANDS };

/** 変数の名前とキーの並びに __proto__、constructor、prototype があれば実行時エラーにする（オブジェクトのプロトタイプを書き換えさせない）。 */
function checkKeys(keys: readonly (string | number)[]): void {
  for (const k of keys) {
    if (typeof k === "string" && FORBIDDEN_PROPERTIES.has(k)) throw new EvalError(`${k} は変数の名前やキーに使えません（代入しません）`);
  }
}

/** 式で書いた引数の、式の元の文字（引数の名前 → 括弧の中）。 */
function exprSources(spec: CommandSpec, args: readonly Argument[]): Record<string, string> {
  const out: Record<string, string> = {};
  let position = 0;
  for (const a of normalizeBooleanArgs(spec, args)) {
    const name = a.key ?? spec.positional[position++];
    if (name !== undefined && a.value.kind === "expr") out[name] = a.value.source;
  }
  return out;
}
