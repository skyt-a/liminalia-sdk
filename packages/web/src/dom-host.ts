import { chatDialogueActive, chatQuoteStripper, type ChoiceLook, type Host, type NvlPart, type PrefetchItem, type PresentEvent, type StageState, type TextStyle, type Value } from "@liminalia/runtime";
import { backgroundToneName, castSides, type AutoLayoutRules, baseVariant, flipAxisRatio, RENAMED_PARAMS, castForSpeaker, DEFAULT_SCREEN, findTone, isPortrait, spriteToneName, CAMERA_EASINGS, IDENTITY_MATRIX, mixMatrix, resolveVariant, screenAspect, toneMatrix, uiScale, uiSpace, variantFace, variantLayers, type Cast, type CastAppearance, type CastEntry, type CastVariant, type Diagnostic, type UiConfig, uiForLanguage } from "@liminalia/lang";
import { AudioPlayer, playOptions, soundFilter, stageSound } from "./audio.ts";
import type { VoiceCue } from "@liminalia/runtime";
import { cameraTransform, coverCamera } from "./camera.ts";
import { layoutSprites, type Box, type Size, type SpriteLayoutInput } from "./sprite-layout.ts";
import type { NameShown, RenderSystem, StandardScreens, SystemRequest } from "./plugin.ts";
import { renderPlay, restorePlay } from "./play.ts";
import { createFace, hasFace, type SpritePart, type SpritePartFactory, type SpritePartVariant } from "./sprite-face.ts";
import { BUILTIN_SPRITE_PARTS } from "./sprite-sway.ts";
import { ruleFromImage, ruleFromPattern, ruleTransition, transitionKeyframes, type RuleLevels, type RulePattern } from "./transitions.ts";
import { UiPointer } from "./ui-pointer.ts";
import { cssUrl, applyNvlStyle, applySpeakerText, applyUiStyle, uiGlyph } from "./ui-style.ts";
import { playSound, setUiSound, setUiSounds } from "./ui-parts.ts";
import { createHostFonts, type HostFonts } from "./host-fonts.ts";
import { RenderEvents, type RenderEvent, type RenderEventOf, type RenderEventType } from "./render-events.ts";
import { RenderScope, type EffectScope, type EffectScopeOptions } from "./render-scope.ts";
import { Notices, type NoticeOptions, type ToastApi } from "./notices.ts";
import { placeChoices, resetChoicePlace } from "./choice-place.ts";
import { toast } from "./system/ui.ts";
import { joinSpeakerNames } from "./system/backlog.ts";
import { OfferBoard, type InputOffer, type OfferedInput } from "./input-offer.ts";
import { loadScreenTemplates, screenTemplates } from "./system/standard-templates.ts";

export type { Cast, CastEntry, CastVariant };

export type AssetKind = "bgimage" | "fgimage" | "image" | "bgm" | "sound" | "voice" | "video" | "others";

/** 作品固有の演出が使える描画の部品。 */
export interface RenderContext {
  host: DomHost;
  /** 舞台全体（作品の screen の大きさ）。 */
  stage: HTMLDivElement;
  /** 作品の画面の大きさ（liminalia.json の screen）。舞台の座標はこの大きさで、縦長かどうかは height > width（舞台の class の lm-portrait でも分かる）。 */
  screen: { width: number; height: number };
  /** 文字と枠（メッセージ枠・選択肢・システム画面）の拡大率。基準の大きさ（横長 1280×720、縦長 720×1280）の作品は 1。 */
  uiScale: number;
  /** カメラの内側（背景・立ち絵・前景画像が載る）。 */
  camera: HTMLDivElement;
  layers: {
    background: HTMLDivElement;
    sprites: HTMLDivElement;
    /** 立ち絵より上、カメラの内側（[image layer=1] やカットイン）。 */
    images: HTMLDivElement;
    /** カメラの外側、メッセージ枠より下（画面効果）。 */
    fx: HTMLDivElement;
    /**
     * メッセージ枠より上、暗転（@mask・@scene-change）より下（常駐の表示・残すカットイン）。暗転しきっている間と、
     * 全画面の演出（coverUi。章の扉・動画）の間は出さない（押せもしない）。
     */
    hud: HTMLDivElement;
    /** メッセージ枠と暗転より上（通知・章タイトル・ミニゲームなどの UI）。 */
    overlay: HTMLDivElement;
  };
  message: { root: HTMLDivElement; name: HTMLDivElement; text: HTMLDivElement };
  asset(kind: AssetKind, path: string): string;
  /** 立ち絵の定義（cast.json の cast）。 */
  cast: Cast;
  image(url: string): Promise<HTMLImageElement>;
  /** その立ち絵（省くとすべて）を置き終えるまで待つ。@chara は待たずに次へ進むので、直後に立ち絵の要素を触るならこれを待つ。 */
  spriteReady(who?: string): Promise<void>;
  fade(el: HTMLElement, to: number, ms: number): Promise<void>;
  /** スキップ中は 0 にする。 */
  time(ms: number): number;
  /**
   * 演出の待ち（setTimeout の代わり）。スキップ中は待たず、クリックで演出を早送りしたときも終わる
   * （命令が skip=false なら早送りでは終わらない）。
   */
  delay(ms: number): Promise<void>;
  /**
   * クリックで演出を早送りしたときに呼ぶ関数を登録する（requestAnimationFrame などで自分で動かす演出を、終わりの姿にするため）。
   * Element.animate の動きは登録しなくても終わりの姿まで進む。返す関数で外す（演出が終わったら外す）。
   */
  onFastForward(finish: () => void): () => void;
  readonly skipping: boolean;
  waitClick(signal?: AbortSignal): Promise<void>;
  audio: AudioPlayer;
  /** プロジェクトの data/ にある JSON を読む（name は data/ からのパス。拡張子を省くと .json）。 */
  loadData(name: string): Promise<unknown>;
  /**
   * 制作画面の舞台（行を動かすたびにセーブから組み立て直す iframe）で動いているか。ロードの幕など、
   * 組み立て直すたびに出ると邪魔な演出は、true のときは出さない。
   */
  readonly studio: boolean;
  /** 画面の揺れを弱めるか（「画面の揺れ: 控えめ」。揺らさない）。 */
  readonly reduceShake: boolean;
  /** 光の点滅を弱めるか（「光の点滅: 控えめ」。点滅させずに薄い幕にする）。 */
  readonly reduceFlash: boolean;
  /** ゲームの見た目の設定（liminalia.json の ui）。 */
  readonly ui: UiConfig | undefined;
  /**
   * システム画面への口（画面を開く・様子・セーブやバックログなどの操作・system 変数）。システム画面を作ったあとに置かれ、
   * それまで（setup の間）は null。命令の描画・restorer・作品の画面から使う。
   */
  readonly system: RenderSystem | null;
  /**
   * カメラの外側の層（@quake が揺らす層。背景・立ち絵・前景画像を含み、メッセージ枠は含まない）。画面全体を傾ける・寄せる・色を変える演出は、
   * CSS の個別のプロパティ（translate・rotate・scale・filter）で載せると、@quake（transform の動き）と @camera（カメラの transform）とぶつからない。
   */
  readonly world: HTMLDivElement;
  /**
   * 暗転の層（@mask）を、動きなしで覆う・外す。見た目だけで状態（stage.mask）は変えないので、覆ったまま次へ進む命令は、
   * 命令の側で stage.mask も書く（書かないとロードで外れる）。color は省くと黒。
   */
  readonly mask: { cover(color?: string): void; uncover(): void };
  /**
   * メッセージ枠を、job が済むまで（hide なら返した関数を呼ぶまで）見せない。見た目だけで @window の状態は変えず、
   * 済んだら状態どおりに戻る（重ねて呼んでよい。ロードで外れる）。
   */
  readonly window: { hideWhile<T>(job: () => Promise<T> | T): Promise<T>; hide(): () => void };
  /** システム画面の層（標準のシステム画面の .lm-sys。舞台の最前面。システム画面を差し替えた作品では overlay）。 */
  readonly systemLayer: HTMLElement;
  /**
   * 背景を替える（@bg と同じ見せ方。fade はミリ秒で、スキップと早送りに従う）。見た目だけで状態（stage.background）は変えないので、
   * 調べる場所の一時の絵のように、ロードで元に戻ってよいものに使う。替え終わったら解決する。
   */
  setBackground(image: string, options?: { fade?: number; method?: string; folder?: "bgimage" | "image" | "fgimage" }): Promise<void>;
  /** 画面の座標（PointerEvent の clientX・clientY）を舞台の座標（screen の px。左上が 0）にする。舞台の拡大・縮小と位置を戻す。 */
  toStage(clientX: number, clientY: number): { x: number; y: number };
  /**
   * 演出の後始末を受け持つもの（タイマー・requestAnimationFrame・要素・受け口）。ロード（組み立て直し）とスキップの始まりに、
   * エンジンが片付ける（keepOnSkip ならスキップでは片付けない）。演出が終わったら dispose を呼ぶ。
   */
  scope(options?: EffectScopeOptions): EffectScope;
  /** 描画側の出来事（ページ・話者・立ち絵・組み立て直し・ロードの終わり・画面とメニューが閉じた）を受ける。返す関数で外す。 */
  on<T extends RenderEventType>(type: T, listener: (event: RenderEventOf<T>) => void): () => void;
  /**
   * 積み上げる通知を出す（@notify と同じ）。上限を超えたら古いものから下げ、同じ文（key）は一つにまとめ、
   * 全画面の演出（host.coverUi）の間は待たせる。見た目は CSS（.lm-notice）か WebPlugin.screens.toast で変える。
   */
  notify(text: string, options?: NoticeOptions): void;
  /** システム画面と同じ短い知らせ（「セーブしました」と同じもの）を出す。ms は出しておく時間（既定 1600）。 */
  toast(message: string, ms?: number): void;
  /**
   * 遊ぶ人の操作を待つ画面（行き先を選ぶ地図、調べる画面、ミニゲームなど）が、選べるものと選び方を知らせる（input-offer.ts）。
   * 録画（lim shot --video）は画面を出したまま、読む時間のあとに選択肢と同じ選び方で一つ選ぶ。返す関数で外す（画面を閉じたら外す）。
   * 前のエンジンには無い口なので、プラグインは `ctx.offer?.(…)` と書く。
   */
  offer?(offer: InputOffer): () => void;
}

/** 命令の描画。結果を返すと、命令の実装側が受け取る（選択の結果など）。 */
export type Renderer = (ctx: RenderContext, args: Record<string, Value>, wait: boolean, stage: StageState) => Promise<Value | void> | Value | void;
/** ロード時に stage から画面を組み立て直す。 */
export type Restorer = (ctx: RenderContext, stage: StageState) => Promise<void> | void;

/**
 * 本文とメッセージ枠の見た目を作品ごとに差し替える口（フォント・既読の表示・クリック待ち記号・文字の出し方）。
 * どれも省略でき、省略すればエンジン既定の見た目になる。
 */
export interface TextTheme {
  /** 描画側を組み立てた直後に一度だけ呼ぶ（フォントの登録・クラス付けなど）。 */
  install?(ctx: RenderContext): void;
  /** ページの始まり（本文を消した直後）。at は .lim のファイルと行。 */
  page?(ctx: RenderContext, at: { file: string; line: number }): void;
  /** クリック待ち記号の要素。 */
  glyph?(): HTMLElement;
  /** 本文の文字を枠に入れた直後。units は一文字ずつ（ルビは一塊）の要素、perChar は一文字あたりのミリ秒（0 は一度に出す）。 */
  reveal?(units: HTMLElement[], perChar: number): void;
  /**
   * 本文の一文字（.ch）を枠に入れた直後に、一文字ずつ呼ぶ（reveal の後）。index は文字の番号、delay はその文字を出し始める時刻（ミリ秒。
   * 要素の animation-delay と同じ）、perChar は一文字あたりのミリ秒（0 は一度に出す。スキップ中もここ）。
   * ここで el.animate(…) で付けた動き（Web Animations）は、クリックで出し切ったとき（.shown が付くとき）にエンジンが終わりの姿まで進める。
   * 出し方の CSS の動き（--lm-reveal-animation）を書き換えずに、一文字に動きを足すのに使う（三点リーダーを一点ずつ灯すなど）。
   */
  char?(el: HTMLElement, info: { index: number; delay: number; perChar: number }): void;
}

/**
 * 本文をメッセージ枠の代わりに別の画面へ積む口（ui.chat.dialogue の吹き出し。std の chat.ts）。枠の文字と同じ部品（ルビ・文字の動き・文字送り・クリック待ちの印）が
 * page の返す要素に入る。@nvl on・@vertical on・@balloon on の間は呼ばず、いつものメッセージ枠に戻す。
 */
export interface DialogueView {
  /**
   * ページの始まり。本文を入れる要素を返す。入力中の表示のように間を置くなら、host.pause で待ってから返す（押されたら飛ばせる）。
   * read は読んだことのあるページか、instant は文字を一度に出すか（巻き戻しで戻ったページ）。
   */
  page(ctx: RenderContext, page: { speaker: string | null; label?: string; read: boolean; instant: boolean }, stage: StageState): Promise<HTMLElement>;
  /** 出している文字が見える位置へ送る（本文を足した・クリック待ちの印を付けたとき）。 */
  follow(ctx: RenderContext): void;
  /** 選択肢を出した・消した。layer は選択肢の層。 */
  choosing(ctx: RenderContext, on: boolean, layer: HTMLElement): void;
  /** 積んだものを消す（@clear）。 */
  clear(ctx: RenderContext): void;
}

/** 立ち絵の切り替えの調子を作品ごとに変える口。どれも省略でき、省略すれば Tyrano Tatie と同じ。 */
export interface SpriteTheme {
  /**
   * 枠が同じで画像だけ替わる（表情だけ変える）重ねた切り替えにかける時間の倍率。
   * 透けない切り替え（plus-lighter）は同じ時間でも変化が強く見えるので、短くしたい作品が使う。既定は 1。
   */
  expressionDissolveScale?: number;
}

export interface Extensions {
  renderers: Record<string, Renderer>;
  restorers?: Restorer[];
  /**
   * 遊んでいる途中で言語を替えたとき、置いたままの文字（@layer-text・チャットの吹き出しなど）を今の言語で出し直す。
   * stage はもう今の言語に書き換えてある（Runtime.retranslate）。組み立て直さず、出している要素の文字だけを替える。
   */
  relocalizers?: Restorer[];
  text?: TextTheme;
  /** 本文をメッセージ枠の代わりに別の画面へ積む（ui.chat.dialogue のとき）。 */
  dialogue?: DialogueView;
  sprites?: SpriteTheme;
  /** 画像の代わりに描く立ち絵（Live2D・Spine など）。キーはキャストの差分の model.type。 */
  spriteParts?: Record<string, SpritePartFactory>;
}

export interface DomHostOptions {
  root: HTMLElement;
  loadSource(file: string): Promise<string>;
  asset(kind: AssetKind, path: string): string;
  /**
   * 音のループの位置（秒）。書き出しが元の音から読んだもの（スマホ版で縮めた音。project/audio-loops.json）で、
   * 音に埋め込まれた LOOPSTART・LOOPLENGTH より先に使う。無ければ undefined。
   */
  audioLoop?(kind: AssetKind, path: string): { start?: number; end?: number } | undefined;
  cast: Cast;
  /** 立ち絵の登場順の自動配置の並べ方（liminalia.json の autoLayout を autoLayoutRules で読み解いたもの）。省けば前からの並べ方。 */
  autoLayout?: AutoLayoutRules;
  /** 一文字あたりの既定のミリ秒。 */
  defaultPerChar?: number;
  onDiagnostic?(d: Diagnostic): void;
  /** key はページの鍵（@liminalia/lang の pageKeys。テスト版の指摘が、行を足しても同じページを指すのに使う）。 */
  onPage?(at: { file: string; line: number }, key?: string): void;
  extensions?: Extensions;
  /** プロジェクトの data/ にある JSON を読む（name は data/ からのパス。拡張子を省くと .json）。プラグインが一覧などに使う。 */
  loadData?(name: string): Promise<unknown>;
  /** 制作画面の舞台で動いているか（RenderContext.studio）。 */
  studio?: boolean;
  /** 作品の画面の大きさ（liminalia.json の screen。既定 1280×720）。舞台はこの大きさで描く。 */
  screen?: { width: number; height: number };
}

/** 素材の読み込みをこれより長く待つときは、待ちの印を出す（ミリ秒）。 */
const BUSY_AFTER = 500;

/** @camera などの ease（名前は @liminalia/lang の CAMERA_EASINGS。制作画面の候補と同じ）。 */
const EASINGS: Record<string, string> = ({
  ease: "ease",
  linear: "linear",
  easeInSine: "cubic-bezier(0.12, 0, 0.39, 0)",
  easeOutSine: "cubic-bezier(0.61, 1, 0.88, 1)",
  easeInOutSine: "cubic-bezier(0.37, 0, 0.63, 1)",
  easeInQuad: "cubic-bezier(0.11, 0, 0.5, 0)",
  easeOutQuad: "cubic-bezier(0.5, 1, 0.89, 1)",
  easeInOutQuad: "cubic-bezier(0.45, 0, 0.55, 1)",
  easeInCubic: "cubic-bezier(0.32, 0, 0.67, 0)",
  easeOutCubic: "cubic-bezier(0.33, 1, 0.68, 1)",
  easeInOutCubic: "cubic-bezier(0.65, 0, 0.35, 1)",
} satisfies Record<(typeof CAMERA_EASINGS)[number], string>);

const num = (v: Value | undefined, d = 0) => (typeof v === "number" ? v : d);
const str = (v: Value | undefined, d = "") => (typeof v === "string" ? v : d);

/**
 * ブラウザで描画する Host。見た目は状態（StageState）と命令の引数だけから決め、
 * 自分では進行を持たない。待ちが必要な演出は Promise で返す。
 */
/** ルールの切り替えの引数（rule・pattern・vague）。どちらも書いていなければ null。 */
interface RuleArgs {
  image?: string;
  pattern?: RulePattern;
  vague: number;
}

function ruleOf(a: Record<string, Value>): RuleArgs | null {
  const image = typeof a.rule === "string" && a.rule !== "" ? a.rule : undefined;
  const pattern = typeof a.pattern === "string" && a.pattern !== "" ? (a.pattern as RulePattern) : undefined;
  if (!image && !pattern) return null;
  return { ...(image ? { image } : {}), ...(pattern ? { pattern } : {}), vague: typeof a.vague === "number" ? a.vague : 64 };
}

export class DomHost implements Host {
  readonly audio: AudioPlayer;
  readonly stage: HTMLDivElement;
  /** 作品の画面の大きさ（liminalia.json の screen）。 */
  readonly screen: Size;
  private readonly quake: HTMLDivElement;
  private readonly camera: HTMLDivElement;
  private readonly background: HTMLDivElement;
  private readonly sprites: HTMLDivElement;
  private readonly images: HTMLDivElement;
  private readonly fx: HTMLDivElement;
  private readonly hud: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly mask: HTMLDivElement;
  private readonly message: HTMLDivElement;
  private readonly nameEl: HTMLDivElement;
  /** 顔ウィンドウ（ui.face）。 */
  private readonly faceEl: HTMLImageElement;
  private readonly textEl: HTMLDivElement;
  private readonly choices: HTMLDivElement;
  private readonly spriteEls = new Map<string, SpriteElement>();
  /** 先読みした画像（URL → 読み込み中または済みの要素）。 */
  private readonly warm = new Map<string, Promise<HTMLImageElement>>();
  /** 立ち絵ごとの切り替えの番号。新しい切り替えが始まったら、古い切り替えは続きを捨てる。 */
  private readonly spriteTokens = new Map<string, number>();
  /** 立ち絵の画像の実寸（URL ごと）。自動配置の計算に使う。 */
  private readonly naturalSizes = new Map<string, Size>();

  private textSpeed: number | null = null;
  /** 表示途中の文字を一度に出し切る関数。 */
  private readonly revealing = new Set<() => void>();
  /** 文字を出している途中で押された。次のクリック待ちまでの文字はすぐ出す（ルビ・装飾の切れ目で止めない）。 */
  private hurry = false;
  /** 次のページの文字を一度に出す（巻き戻しで戻ったページ）。ページを出したら戻る。 */
  instantPage = false;
  /** 素材の差し替え（"種類/パス" → 使うパス）。 */
  private assetRemap: Map<string, string> | null = null;

  /** 素材の差し替えを決める（"bgimage/a.png" → "a_safe.png" のように種類のフォルダからのパスへ）。null で外す。次に出す素材から効く。 */
  setAssetRemap(map: Readonly<Record<string, string>> | null): void {
    this.assetRemap = map && Object.keys(map).length > 0 ? new Map(Object.entries(map)) : null;
  }
  /** 用語集（本文に出た語に印を付け、出たことと押されたことを知らせる）。 */
  private glossary: { pattern: RegExp; ids: Map<string, string>; link: Set<string>; shown(id: string): void; open(id: string, el: HTMLElement): void } | null = null;

  /**
   * 用語集の語を決める（システム画面が liminalia.json の extra.glossary から渡す）。本文に出た語は shown で知らせ、
   * link の語には印（.lm-term）を付けて、押されたら open で知らせる。null で外す。
   */
  /** 効果音と BGM の字幕を出すか（コンフィグの「効果音の字幕」。システム画面が置く）。 */
  captions = false;
  /** 字幕の文字（システム画面が置く。ui.captions とおまけの音楽の題名から）。無ければ @se の caption= だけ。 */
  captionText?: (kind: "se" | "bgm" | "voice", file: string, caption: string | undefined) => string | null;
  private captionArea: HTMLDivElement | null = null;

  /** 字幕を画面の右上に少しのあいだ出す（スキップ中は出さない）。 */
  private caption(kind: "se" | "bgm" | "voice", file: string, caption: string | undefined): void {
    if (!this.captions || this.skipping) return;
    const text = this.captionText ? this.captionText(kind, file, caption) : (caption ?? null);
    if (!text) return;
    if (!this.captionArea?.isConnected) {
      this.captionArea = document.createElement("div");
      this.captionArea.className = "lm-captions";
      this.captionArea.setAttribute("aria-live", "polite");
      this.message.after(this.captionArea);
    }
    const line = Object.assign(document.createElement("div"), { className: "lm-caption", textContent: text });
    this.captionArea.append(line);
    while (this.captionArea.children.length > 3) this.captionArea.firstElementChild?.remove();
    setTimeout(() => line.remove(), CAPTION_MS);
  }

  /** 描画側からシステム画面への口（RenderContext.system。プレイヤーがシステム画面を作ったあとに置く）。 */
  system: RenderSystem | null = null;
  /** 持ち物を選ばせる（@item-select。システム画面が置く）。選んだ名前、やめたら null。無ければ選ばなかったことにする。 */
  pickItem?: (title?: string) => Promise<string | null>;
  /** 持ち物を手に入れた（@item-add の notify。システム画面が知らせを出す）。 */
  onItemAdded?: (key: string) => void;

  setGlossary(g: { words: { word: string; id: string; link: boolean }[]; shown(id: string): void; open(id: string, el: HTMLElement): void } | null): void {
    const words = (g?.words ?? []).filter((w) => w.word !== "").sort((a, b) => b.word.length - a.word.length);
    if (!g || words.length === 0) {
      this.glossary = null;
      return;
    }
    const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.glossary = {
      pattern: new RegExp(words.map((w) => escape(w.word)).join("|"), "gu"),
      ids: new Map(words.map((w) => [w.word, w.id])),
      link: new Set(words.filter((w) => w.link).map((w) => w.word)),
      shown: g.shown,
      open: g.open,
    };
  }
  /** 画面の揺れを弱める（設定画面の「画面の揺れ」）。 */
  shakeReduced = false;
  get reduceShake(): boolean {
    return this.shakeReduced;
  }
  /** 光の点滅を弱める（設定画面の「光の点滅」）。 */
  flashReduced = false;
  get reduceFlash(): boolean {
    return this.flashReduced;
  }
  /** スキップ中に一ページを出しておく時間（ミリ秒。設定画面の「スキップの速さ」）。 */
  skipPageMs = 16;
  private clickResolver: (() => void) | null = null;
  private skippingNow = false;
  /** true の間は演出と文字表示を飛ばし、クリック待ちもすぐ進める。スキップが始まると、演出の scope（keepOnSkip でないもの）を片付ける。 */
  get skipping(): boolean {
    return this.skippingNow;
  }
  set skipping(on: boolean) {
    const starting = on && !this.skippingNow;
    this.skippingNow = on;
    if (starting) this.disposeScopes(true);
    // 送りで終わらせる待ち（飛ばせる @movie）も、スキップが始まったら終える
    if (starting) for (const end of [...this.skipRequests].reverse()) end();
  }

  /**
   * 開発用の早送り（?start=…&skip=N で N ページ目まで）の間か。システム画面が入れる。スキップでは飛ばさない指定のもの
   * （skip=false の @movie）も、この間は飛ばす。
   */
  devSkipping = false;

  /**
   * 自動確認（lim playtest・lim shot。?autoplay=1 か、流す道具が true にする）で動いているか。true なら、autoplay を持つ命令
   * （遊ぶ人の操作を待つ画面、動画）は描かずに、命令の autoplay の答えで進める（Host.automated）。
   * 入れると automateWhile で決めた条件は外す。
   */
  get automated(): boolean {
    return this.automatedWhen ? this.automatedWhen() : this.automatedFlag;
  }
  set automated(on: boolean) {
    this.automatedFlag = on;
    this.automatedWhen = null;
  }
  private automatedFlag = false;
  private automatedWhen: (() => boolean) | null = null;

  /** when が真の間だけ自動確認にする（lim shot。撮る所に着くまで autoplay で進め、着いたらその画面を描く）。 */
  automateWhile(when: () => boolean): void {
    this.automatedWhen = when;
  }

  /** 操作待ちの画面（autoplay を持つ命令。PresentEvent の interactive）を描き始めた時刻（performance.now()）。描いていなければ null。 */
  private interactiveSince: number | null = null;

  /** 操作待ちの画面を描き続けているミリ秒（lim shot が撮る所の目印にする）。描いていなければ null。 */
  interactiveFor(): number | null {
    return this.interactiveSince === null ? null : performance.now() - this.interactiveSince;
  }

  /** 遊ぶ人の操作を待つ画面が知らせた、選べるもの（RenderContext.offer。録画が読む）。 */
  private readonly offers = new OfferBoard();

  /** 選べるものを知らせる（RenderContext.offer と同じ）。返す関数で外す。 */
  offer(offer: InputOffer): () => void {
    return this.offers.add(offer);
  }

  /** 今の選べるもの（録画の lim shot --video が読む。無ければ null）。 */
  offered(): OfferedInput | null {
    return this.offers.current();
  }

  /** 今の選べるもの（番号が id のもの）の index 番目を選ぶ（録画が呼ぶ）。選べなければ false。 */
  chooseOffered(id: number, index: number): boolean {
    return this.offers.choose(id, index);
  }

  /** 送り（クリック・決定キー・タップ・advance()）とスキップの始まりで終わらせる待ち。新しく足したものから。 */
  private readonly skipRequests: (() => void)[] = [];

  /**
   * 送り（クリック・決定キー・タップ・advance()）か、スキップが始まったときに呼ぶ関数を登録する（飛ばせる @movie のように、
   * 遊ぶ人が飛ばせる待ちに使う）。文字を出している途中とクリック待ちでは呼ばない。返す関数で外す（待ちが終わったら外す）。
   * 重ねて登録したら、送りでは新しいものだけを呼ぶ。
   */
  onSkipRequest(end: () => void): () => void {
    this.skipRequests.push(end);
    return () => {
      const i = this.skipRequests.indexOf(end);
      if (i >= 0) this.skipRequests.splice(i, 1);
    };
  }

  // ---- 作品の演出の口（RenderContext の scope・on・window・mask） ----

  /** 書体の読み込みを待つ口。 */
  readonly fonts: HostFonts = createHostFonts();
  /** システム画面の層（標準のシステム画面が置く）。無ければ RenderContext.systemLayer は overlay。 */
  systemLayer: HTMLElement | null = null;
  private readonly events = new RenderEvents();
  private readonly scopes = new Set<RenderScope>();
  /** 前のページの話者（speaker の出来事を、変わったときだけ出す）。undefined はまだページを出していない。 */
  private lastSpeaker: string | null | undefined = undefined;
  /** 前に知らせた立ち絵（sprites の出来事を、変わったときだけ出す）。 */
  private lastSprites = "{}";
  /** メッセージ枠を見せない頼み（RenderContext.window）の数。 */
  private windowHolds = 0;
  /**
   * 枠に出ている本文を、もう見せないもの（hide-window で枠を隠した。実行器も NVL の段落を捨てている）。
   * 次の本文か @window show で枠を出し直すとき、先に消す。
   */
  private staleText = false;

  /** 通知の見た目の差し替え（WebPlugin.screens.toast。プレイヤーが置く）。 */
  noticeLook: ((api: ToastApi) => HTMLElement) | undefined = undefined;
  /**
   * 本文の画面の部品の見た目の差し替え（WebPlugin.screens の choice・name・dialog。プレイヤーが置く。同じ部品は後のプラグインが勝つ）。
   * 名前欄（name）は一度だけ作るので、本文を出す前に置く。
   */
  screens: Readonly<Pick<StandardScreens, "choice" | "name" | "dialog">> = {};
  /** 積み上げる通知（RenderContext.notify・@notify）。 */
  readonly notices = new Notices({
    layer: () => this.overlay,
    skipping: () => this.skipping,
    covered: () => this.uiCovered,
    onCoverChange: (l) => this.onUiCoverChange(l),
    playSe: (file) => void this.audio.playSe("lm-notice", file, 100, false, 0),
    look: () => this.noticeLook,
  });

  /** 描画側の出来事を知らせる（システム画面がロードの終わりと画面を閉じたことを知らせるのにも使う）。 */
  emitRender(event: RenderEvent): void {
    this.events.emit(event);
  }

  /** 演出の scope を作る。 */
  private createScope(options: EffectScopeOptions = {}): EffectScope {
    const scope = new RenderScope(
      {
        effectTime: (ms) => this.effectTime(ms),
        onFastForward: (f) => this.onFastForward(f),
      },
      options,
      (s) => this.scopes.delete(s),
    );
    this.scopes.add(scope);
    return scope;
  }

  /** 演出の scope を片付ける（skip ならスキップの始まりで、keepOnSkip のものは残す）。 */
  private disposeScopes(skip: boolean): void {
    for (const scope of [...this.scopes]) if (!skip || !scope.options.keepOnSkip) scope.dispose();
  }

  /** 立ち絵が変わっていれば知らせる。 */
  private noticeSprites(stage: StageState): void {
    const key = JSON.stringify(stage.sprites ?? {});
    if (key === this.lastSprites) return;
    this.lastSprites = key;
    this.events.emit({ type: "sprites", sprites: stage.sprites, stage });
  }

  /** メッセージ枠を見せない頼みを一つ足す。返す関数で外す（二度呼んでもよい）。 */
  private holdWindow(): () => void {
    this.windowHolds++;
    this.message.classList.add("lm-window-held");
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.windowHolds = Math.max(0, this.windowHolds - 1);
      if (this.windowHolds === 0) this.message.classList.remove("lm-window-held");
    };
  }

  /** 画面の座標を舞台の座標にする。 */
  toStage(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.stage.getBoundingClientRect();
    const sx = r.width > 0 ? this.screen.width / r.width : 1;
    const sy = r.height > 0 ? this.screen.height / r.height : 1;
    return { x: (clientX - r.left) * sx, y: (clientY - r.top) * sy };
  }
  /** クリック待ちの最中か（撮影や自動テストが「画面が落ち着いた」ことを知るため）。 */
  waiting = false;
  /**
   * キー操作（Enter・Space で送る、Ctrl を押している間スキップ）を DomHost 自身が受けるか。
   * システム画面がキーを自分で振り分ける（advance() と skipping を使う）ときは false にする。
   */
  keyboard = true;
  /** オートの間は、クリック待ちを autoWait ミリ秒で自動で進める（システム画面がオートを扱わないときの既定の動き）。 */
  auto = false;
  autoWait = 1500;
  /** false の間はキーとマウスのショートカット（Ctrl のスキップ・プレイヤーのセーブ／ロードのキー）を止める（@shortcuts off）。 */
  shortcuts = true;
  /** シナリオからシステム画面への要求を受けるもの（プレイヤーがシステム画面の request をつなぐ）。true を返せば処理済み。 */
  systemRequest: ((req: SystemRequest) => boolean | Promise<boolean>) | null = null;
  /** 次のページへ進んだら、鳴っているボイスを止めるか（設定画面）。false なら次のボイスが鳴るまで鳴らし続ける。 */
  voiceStopOnPage = true;
  /** 今のページの話者（地の文は null）。本文の中の @voice の話者ごとの音量に使う。 */
  private speaker: string | null = null;
  /** 本文を入れる先。ふだんはメッセージ枠の文字の欄、NVL ではそのページの段落。 */
  private textTarget: HTMLElement;

  constructor(private readonly options: DomHostOptions) {
    // 素材の差し替え（表現を控えめにする設定など。setAssetRemap）を、すべての素材の URL に効かせる
    const asset = options.asset;
    options.asset = (kind, path) => asset(kind, this.assetRemap?.get(`${kind}/${path}`) ?? path);
    const audioLoop = options.audioLoop;
    this.audio = new AudioPlayer((kind, file) => options.asset(kind, file), audioLoop ? (kind, file) => audioLoop(kind, this.assetRemap?.get(`${kind}/${file}`) ?? file) : undefined);
    // 見た目を持たない UI 部品（ui-parts.ts）の効果音
    setUiSound((file) => void this.audio.playSe("lm-ui", file, 100, false, 0));
    const div = (cls: string, parent: HTMLElement) => {
      const el = document.createElement("div");
      el.className = cls;
      parent.append(el);
      return el;
    };
    this.stage = div("stage", options.root);
    this.screen = options.screen ?? DEFAULT_SCREEN;
    this.applyScreen();
    this.quake = div("layer", this.stage);
    this.camera = div("camera", this.quake);
    this.background = div("layer background", this.camera);
    this.sprites = div("layer sprites", this.camera);
    this.images = div("layer images", this.camera);
    this.fx = div("layer fx", this.stage);
    this.message = div("message", this.stage);
    div("message-frame", this.message);
    this.faceEl = Object.assign(document.createElement("img"), { className: "face", alt: "", draggable: false });
    this.message.append(this.faceEl);
    this.nameEl = div("name", this.message);
    this.textEl = div("text", this.message);
    // 常駐の表示と残すカットインは、メッセージ枠の上、暗転の下
    this.hud = div("layer hud", this.stage);
    // 暗転（@mask）はメッセージウィンドウも覆う（TyranoScript の [mask] と同じ）。選択肢と重ねる層はその上
    this.mask = div("layer mask", this.stage);
    this.choices = div("layer choices", this.stage);
    this.overlay = div("layer overlay", this.stage);
    this.textTarget = this.textEl;
    this.pointer = new UiPointer({ stage: this.stage, asset: (kind, path) => this.options.asset(kind, path), playSe: (file) => this.audio.playBlip(file, 100) });

    this.textEl.addEventListener("click", this.termClick);
    this.options.extensions?.text?.install?.(this.context);
    this.fit();
    window.addEventListener("resize", () => this.fit());
    // 向きを変えたとき、安全な表示領域は resize より少し遅れて決まることがある
    window.addEventListener("orientationchange", () => setTimeout(() => this.fit(), 250));
    this.stage.addEventListener("click", () => this.input());
    window.addEventListener("keydown", (e) => {
      if (!this.keyboard) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.input();
      }
      if (e.key === "Control" && this.shortcuts) {
        this.skipping = true;
        this.input();
      }
    });
    window.addEventListener("keyup", (e) => {
      if (this.keyboard && e.key === "Control") this.skipping = false;
    });
  }

  /** 本文の用語（用語集）を押したら、送らずに説明を出す。 */
  private readonly termClick = (e: Event): void => {
    const term = (e.target as Element | null)?.closest?.<HTMLElement>(".lm-term");
    if (!term?.dataset.term || !this.glossary) return;
    e.stopPropagation();
    this.glossary.open(term.dataset.term, term);
  };

  /**
   * 舞台を作品の画面の大きさにする。既定の大きさ（1280×720）の作品には何も書かない（style.css の既定のまま）。
   * 縦長は class の lm-portrait で system/portrait.css の並べ方になり、基準の大きさと違う作品は文字と枠を --lm-ui-scale で拡大・縮小する。
   */
  private applyScreen(): void {
    const { width, height } = this.screen;
    if (width === DEFAULT_SCREEN.width && height === DEFAULT_SCREEN.height) return;
    const style = this.stage.style;
    style.setProperty("--stage-w", `${width}px`);
    style.setProperty("--stage-h", `${height}px`);
    style.setProperty("--lm-stage-aspect", screenAspect(this.screen));
    this.stage.classList.toggle("lm-portrait", isPortrait(this.screen));
    const scale = uiScale(this.screen);
    if (scale !== 1) {
      style.setProperty("--lm-ui-scale", String(scale));
      this.stage.classList.add("lm-ui-scaled");
    }
  }

  /**
   * 舞台を画面に収める倍率と位置。iPhone などは安全な表示領域（ホームインジケータ・切り欠きにかからない範囲）の中に収め、
   * 画面の端の操作（下端のなぞり）とボタンが重ならないようにする。
   */
  private fit(): void {
    const safe = safeArea();
    const width = window.innerWidth - safe.left - safe.right;
    const height = window.innerHeight - safe.top - safe.bottom;
    const scale = Math.min(width / this.screen.width, height / this.screen.height);
    // 舞台の左上を画面の点（物理的な画素）にそろえる。端数の位置に置くと、高解像度の画面で文字と絵がにじむ
    const dpr = window.devicePixelRatio || 1;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    const left = snap(safe.left + (width - this.screen.width * scale) / 2);
    const top = snap(safe.top + (height - this.screen.height * scale) / 2);
    // .stage は left: 50%・top: 50% に置き、真ん中を中心に拡大する（style.css）。拡大したあとの左上が left・top に来るようにずらす
    const tx = left - window.innerWidth / 2 - (this.screen.width * (1 - scale)) / 2;
    const ty = top - window.innerHeight / 2 - (this.screen.height * (1 - scale)) / 2;
    this.stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    // 基準の座標（システム画面と標準の命令の画面の px）の 1px が、画面で何 px になるか（指の端末で文字と押す所を大きくするのに使う。style.css の --lm-touch）
    this.stage.style.setProperty("--lm-ui-fit", String(scale * uiScale(this.screen)));
    // 指で触る端末（主な入力が指か、制作画面のプレビューがスマホの見え方を真似ている）と縦長の作品は、標準の命令の画面の文字と押す所を大きくする
    const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    this.stage.classList.toggle("lm-touch", coarse || document.documentElement.classList.contains("lm-emulate-touch") || isPortrait(this.screen));
    this.watchPixelRatio(dpr);
  }

  /** 画素の細かさが変わったら（別の画面へウィンドウを移したとき。resize が来ないことがある）合わせ直す。 */
  private watchPixelRatio(dpr: number): void {
    if (this.pixelRatioWatched === dpr || typeof matchMedia === "undefined") return;
    this.pixelRatioWatched = dpr;
    matchMedia(`(resolution: ${dpr}dppx)`).addEventListener("change", () => this.fit(), { once: true });
  }

  private pixelRatioWatched = 0;

  /**
   * クリック・Enter・Space。表示途中なら次のクリック待ちまでの文字を出し、クリック待ちなら先へ進める。
   * どちらでもなければ、飛ばせる待ち（onSkipRequest。飛ばせる @movie）を終えるか、それも無ければ（演出を待っている間）
   * 今動いている演出を終わりまで飛ばす（fastForward）。
   */
  private input(): void {
    if (this.revealing.size > 0) {
      this.hurry = true;
      for (const finish of [...this.revealing]) finish();
      return;
    }
    const resolve = this.clickResolver;
    this.clickResolver = null;
    if (resolve) return resolve();
    const skip = this.skipRequests.at(-1);
    if (skip) skip();
    else this.fastForward();
  }

  // ---- 演出の早送り ----

  /**
   * 描いている命令。skip は、早送りできる演出の命令なら true、skip=false の命令なら false、演出でない命令（入力を待つ画面など）は undefined
   * （実行器が命令の仕様から決めて PresentEvent の skip で渡す）。
   */
  private readonly inFlight = new Set<{ skip: boolean | undefined }>();
  /** 早送りした命令。描き終わるまで、そのあと始まる動き（二段の切り替えの後半など）も、すぐ終わりの姿にする。 */
  private readonly rushing = new Set<{ skip: boolean | undefined }>();
  private rushFrame = 0;
  /** skip=false の命令が始めた動き（あとの早送りでも終わらせない）。 */
  private readonly heldAnimations = new WeakSet<Animation>();
  /** 早送りで終わらせるもの（@wait の待ち、ルールや色調の切り替えなど、Element.animate でない演出）。held は skip=false の命令のもの。 */
  private readonly fastForwards = new Set<{ finish(): void; held: boolean }>();

  /** クリックで演出を早送りするか（ui.input.skipEffects。既定は早送りする）。 */
  private get effectsSkippable(): boolean {
    return this.ui?.input?.skipEffects !== false;
  }

  /** skip=false の命令を描いている最中か（その間はクリックで早送りしない）。 */
  private get effectsHeld(): boolean {
    return [...this.inFlight].some((f) => f.skip === false);
  }

  /** 早送りする層で動いているもの（システム画面と選択肢の層は除く。選択肢の残り時間のバーを進めないため）。 */
  private runningAnimations(): Animation[] {
    return [this.quake, this.fx, this.message, this.hud, this.mask, this.overlay].flatMap((el) => (typeof el.getAnimations === "function" ? el.getAnimations({ subtree: true }) : []));
  }

  /**
   * 今動いている時間のかかる演出（背景や立ち絵の切り替え、カメラ、揺れ、暗転、@wait の待ち、作品の命令の動きなど）を、
   * 終わりの姿まで飛ばす。演出の命令（時間の引数を持つ待つ命令）を描いている最中だけ効き、その命令を描き終えるまで、
   * そのあと始まる動きもすぐ終わらせる。繰り返す動き、skip=false の命令の演出、選択肢を出している間は飛ばさない。音は止めない。
   * 飛ばしたら true。ui.input.skipEffects が false なら何もしない。
   */
  fastForward(): boolean {
    if (!this.effectsSkippable || this.effectsHeld || this.choosing) return false;
    const effects = [...this.inFlight].filter((f) => f.skip === true);
    if (effects.length === 0) return false;
    for (const f of effects) this.rushing.add(f);
    this.finishRunning();
    if (this.rushFrame === 0) {
      const step = () => {
        this.rushFrame = 0;
        if (this.rushing.size === 0) return;
        this.finishRunning();
        this.rushFrame = requestAnimationFrame(step);
      };
      this.rushFrame = requestAnimationFrame(step);
    }
    return true;
  }

  /** 動いているもの（繰り返す動きと skip=false の命令のものを除く）を終わりの姿にし、早送りの口に登録したものを呼ぶ。 */
  private finishRunning(): void {
    for (const animation of this.runningAnimations()) {
      if (this.heldAnimations.has(animation) || animation.playState !== "running") continue;
      const end = animation.effect?.getComputedTiming().endTime;
      if (typeof end !== "number" || !Number.isFinite(end)) continue;
      try {
        animation.finish();
      } catch {
        // 終わりの無い動き
      }
    }
    for (const entry of [...this.fastForwards]) {
      if (entry.held) continue;
      this.fastForwards.delete(entry);
      entry.finish();
    }
  }

  /** 早送りで呼ぶ関数を登録する（RenderContext.onFastForward）。skip=false の命令の描画中に登録したものは、早送りで呼ばない。 */
  onFastForward(finish: () => void): () => void {
    return this.fastForwardHook()(finish);
  }

  /**
   * 早送りで呼ぶ関数を登録する口（命令を描き始めたときに作る。skip=false の命令かどうかを、作った時点で決める。
   * 素材を読んでから動き始める演出が、命令の描画を終えたあとで登録しても、その命令のものとして扱うため）。
   */
  private fastForwardHook(): (finish: () => void) => () => void {
    const held = this.effectsHeld;
    return (finish) => {
      const entry = { finish, held };
      this.fastForwards.add(entry);
      return () => void this.fastForwards.delete(entry);
    };
  }

  /** 演出の時間（RenderContext.time）。スキップ中と、早送りした命令を描いている間は 0。 */
  private effectTime(ms: number): number {
    return this.skipping || this.rushing.size > 0 ? 0 : ms;
  }

  /** 演出の待ち（RenderContext.delay）。スキップ中は待たず、早送りでも終わる。 */
  delay(ms: number): Promise<void> {
    if (this.effectTime(ms) <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, ms);
      const off = this.onFastForward(done);
    });
  }

  /** 命令を描く。skip=false の命令なら、描いている間は早送りせず、その命令が始めた動きは後の早送りでも終わらせない。 */
  private async presentCommand(event: Extract<PresentEvent, { type: "command" }>): Promise<Value | void> {
    const flight = { skip: event.skip };
    const before = event.skip === false ? new Set(this.runningAnimations()) : null;
    this.inFlight.add(flight);
    const interactive = event.interactive === true;
    if (interactive) this.interactiveSince = performance.now();
    try {
      return await this.command(event.name, event.args, event.wait, event.stage);
    } finally {
      if (interactive) this.interactiveSince = null;
      this.inFlight.delete(flight);
      this.rushing.delete(flight);
      if (before) for (const animation of this.runningAnimations()) if (!before.has(animation)) this.heldAnimations.add(animation);
    }
  }

  // ---- 撮影の合図 ----

  private shotHolds = 0;

  /**
   * 撮影（書き出したあとの確かめ・lim shot）を、返した関数を呼ぶまで待たせる。タイトルが長いフェードで始まるなど、
   * 「ここで撮ってよい」を作品が決めるときに使う。
   */
  holdShot(): () => void {
    this.shotHolds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.shotHolds--;
    };
  }

  /** 撮ってよいか（holdShot で止めていない）。 */
  get shotReady(): boolean {
    return this.shotHolds === 0;
  }

  /** 外から一回送る（オート・ホイールなど、クリック以外の送り）。 */
  advance(): void {
    this.input();
  }

  /** 本文を消す（NVL なら積んだ段落もすべて）。 */
  private clearText(): void {
    this.textEl.replaceChildren();
    this.textEl.scrollTop = 0;
    this.textTarget = this.textEl;
  }

  /** 枠を次の本文まで隠し、いま出ている本文を見せないものにする（hide-window。隠している間に消すので、消えるところは見えない）。 */
  private hideUntilText(): void {
    this.setMessageSuppressed(true);
    this.staleText = true;
  }

  private readonly messageVisibilityListeners = new Set<() => void>();

  /** 暗転や背景切り替えで、次の本文までメッセージ枠を隠しているか。 */
  get messageSuppressed(): boolean {
    return this.message.classList.contains("bg-hidden");
  }

  onMessageVisibilityChange(listener: () => void): () => void {
    this.messageVisibilityListeners.add(listener);
    return () => this.messageVisibilityListeners.delete(listener);
  }

  private setMessageSuppressed(hidden: boolean): void {
    if (this.messageSuppressed === hidden) return;
    this.message.classList.toggle("bg-hidden", hidden);
    for (const listener of this.messageVisibilityListeners) listener();
  }

  /** 見せないものにした本文（hide-window）を、枠を出し直す前に消す。 */
  private dropStaleText(): void {
    if (!this.staleText) return;
    this.staleText = false;
    this.setName("");
    this.clearText();
  }

  /**
   * 枠の中でスクロールする本文（ui.message.scroll）と縦書きの NVL を、出している文字に合わせて送る（縦書きは左へ）。全文を出したら（押して飛ばしたときも）最後まで。
   */
  private follow(units: HTMLElement[], perChar: number): void {
    const list = this.message.classList;
    // 送るのは、枠の中でスクロールさせる本文と、縦書きの NVL（右から積むので、はみ出したら左へ送る）
    if (!(list.contains("scroll") || (list.contains("nvl") && list.contains("vertical"))) || units.length === 0) return;
    const text = this.textEl;
    const start = performance.now();
    const last = units.at(-1)!;
    const step = () => {
      const done = perChar <= 0 || last.classList.contains("shown");
      const u = done ? last : units[Math.min(units.length - 1, Math.floor((performance.now() - start) / perChar))]!;
      if (this.message.classList.contains("vertical")) {
        // 縦書きは行が左へ進むので、出した文字が枠の左からはみ出したら左へ送る（舞台は拡大・縮小しているので画面の座標を直す）
        const box = text.getBoundingClientRect();
        const over = box.left - u.getBoundingClientRect().left;
        if (over > 0) text.scrollLeft -= over / (box.width / (text.offsetWidth || 1));
      } else {
        const bottom = u.offsetTop + u.offsetHeight;
        if (bottom > text.scrollTop + text.clientHeight) text.scrollTop = bottom - text.clientHeight;
      }
      if (!done && last.isConnected) requestAnimationFrame(step);
    };
    step();
  }

  /**
   * NVL（画面全体に文章を積む）とメッセージ枠を切り替える。切り替えると文字は消える。
   * style は ui.nvlStyles の名前で、その見た目の CSS 変数を枠に置く（書いた項目だけ ui.nvl の上に重なる）。
   */
  private setNvl(on: boolean, style?: string): void {
    this.message.classList.toggle("nvl", on);
    this.stage.classList.toggle("nvl-mode", on);
    this.applyNvlLook(on ? style : undefined);
    this.setName("");
    this.clearText();
  }

  /** 名前を付けた NVL の見た目（ui.nvlStyles）を枠に置く（style が無いか、その名前の見た目が無ければ ui.nvl の見た目）。 */
  private applyNvlLook(style: string | undefined): void {
    const look = style ? this.ui?.nvlStyles?.[style] : undefined;
    applyNvlStyle(this.message, look, (path) => this.options.asset("image", path));
    if (look && style) this.message.dataset.nvlStyle = style;
    else delete this.message.dataset.nvlStyle;
  }

  /** 縦書きと横書きを切り替える（@vertical が無ければ ui.message.vertical）。変わったときだけ文字を消す。 */
  private setVertical(stage: StageState | null): void {
    const on = stage?.vertical ?? this.ui?.message?.vertical === true;
    if (this.message.classList.contains("vertical") === on) return;
    this.message.classList.toggle("vertical", on);
    this.clearText();
  }

  /**
   * 今のページの話者のボイスとして鳴らす（スキップ中は鳴らさず、鳴っているものを止める）。caption は字幕（@voice の caption）。
   * o.who はこのボイスの話者（省くと今のページの話者）、o.channel はボイスのチャンネル（違えば同時に鳴る）、o.filter は音のフィルター。
   */
  playVoice(folder: string, file: string, volume: number, caption?: string, o: { channel?: number; who?: string; filter?: unknown } = {}): void {
    if (this.skipping) {
      this.audio.stopVoice(0);
      return;
    }
    const filter = soundFilter(o.filter);
    void this.audio.playVoice(folder === "sound" ? "sound" : "voice", file, volume, o.who ?? this.speaker, { ...(o.channel !== undefined ? { channel: o.channel } : {}), ...(filter ? { filter } : {}) });
    if (caption) this.caption("voice", file, caption);
  }

  /** ページのボイス（同時に鳴らすもの also も）を鳴らす。speaker はそのページの話者（履歴から鳴らし直すときも）。 */
  playVoiceCue(cue: VoiceCue, speaker: string | null): void {
    const play = (c: VoiceCue, who: string | null) => {
      const filter = soundFilter(c.filter);
      void this.audio.playVoice(c.folder === "sound" ? "sound" : "voice", c.file, c.volume, c.who ?? who, { ...(c.channel !== undefined ? { channel: c.channel } : {}), ...(filter ? { filter } : {}) });
    };
    this.audio.stopVoice(0);
    play(cue, speaker);
    for (const c of cue.also ?? []) play(c, null);
  }

  /** 同時に話しているほかの話者（ページのボイスの also の who）。口パクと立ち絵を目立たせるのに使う。 */
  private coSpeakers: string[] = [];

  /** 一文字あたりの既定のミリ秒（設定画面の文字の速さ）。 */
  setDefaultTextSpeed(ms: number): void {
    this.options.defaultPerChar = ms;
  }

  // ---- Host ----

  loadSource(file: string): Promise<string> {
    return this.options.loadSource(file);
  }

  loadData(name: string): Promise<unknown> {
    return this.options.loadData ? this.options.loadData(name) : Promise.resolve(undefined);
  }

  onDiagnostic(d: Diagnostic): void {
    this.options.onDiagnostic?.(d);
  }

  /** ゲームの見た目の設定（liminalia.json の ui に、遊んでいる言語の ui.languages を重ねたもの）。setUi・setUiLanguage で替える。 */
  private ui: UiConfig | undefined;
  /** 言語の見た目を重ねる前の設定（liminalia.json の ui）。 */
  private baseUi: UiConfig | undefined;
  /** 見た目を重ねる言語（ui.languages の鍵）。 */
  private uiLanguage = "";
  /** 動くカーソルと押したところの演出（ui.cursor.animated・ui.tap）。 */
  private readonly pointer: UiPointer;

  /** ゲームの見た目の設定を当てる（開発中に liminalia.json が変わったときも呼ぶ）。遊んでいる言語の ui.languages を重ねる。 */
  setUi(base: UiConfig | undefined): void {
    this.baseUi = base;
    const ui = uiForLanguage(base, this.uiLanguage);
    this.ui = ui;
    this.setVertical(this.stageNow);
    this.syncDialogue();
    this.message.classList.toggle("has-frame-image", !!(this.stageNow?.windowImage || ui?.message?.image));
    applyUiStyle({ stage: this.stage, screen: this.screen, message: this.message, name: this.nameEl, asset: (kind, path) => this.options.asset(kind, path) }, ui);
    // NVL の間は、名前を付けた見た目も新しい設定で置き直す（開発中に ui.nvlStyles を書き換えたとき）
    if (this.stageNow?.nvl) this.applyNvlLook(this.stageNow.nvlStyle);
    this.pointer.set(ui);
    // 動画の音を掛ける系統（ui.sound.movie。既定は BGM）
    const movie = ui?.sound?.movie;
    this.audio.setMediaBus(movie === "se" ? "sound" : movie === "voice" ? "voice" : movie === "none" ? "none" : "bgm");
    // 長い BGM の流し読み（ui.sound.streamBgm。既定はする）
    this.audio.setStreaming(ui?.sound?.streamBgm !== false);
    // システム画面の効果音（ui.sound.ui）
    setUiSounds(ui?.sound?.ui);
    for (const img of this.background.querySelectorAll<HTMLElement>("img[data-bg]")) this.focusBackground(img);
    // 色調（ui.tones・ui.backgroundTones）を替えたら当て直す
    if (this.stageNow) void this.applyTones(this.stageNow, 0);
    void this.updateFace();
    // 話者強調（ui.chara）
    this.applyFocus(false);
  }

  /** 台詞の外側の括弧と引用符を外すか（ui.text.quotes が strip。遊んでいる言語の ui.languages を重ねたもの）。 */
  get stripsQuotes(): boolean {
    return this.ui?.text?.quotes === "strip";
  }

  /** 遊んでいる言語を替える（ui.languages のその言語の書体や文字の大きさを重ね直す）。同じ言語なら何もしない。 */
  setUiLanguage(language: string): void {
    if (language === this.uiLanguage) return;
    this.uiLanguage = language;
    if (this.baseUi?.languages) this.setUi(this.baseUi);
  }

  /** 本文を別の画面へ積む口。今の状態がそれを使うとき（ui.chat.dialogue で、@nvl on などの間でない）だけ返す。 */
  private get dialogue(): DialogueView | null {
    const view = this.options.extensions?.dialogue;
    return view && this.ui?.chat?.dialogue === true && this.stageNow && chatDialogueActive(this.stageNow) ? view : null;
  }

  /** 舞台の印を今の状態に合わせる（CSS がメッセージ枠とチャットの画面のどちらを出すかを決める）。 */
  private syncDialogue(): void {
    this.stage.classList.toggle("lm-chat-dialogue", this.dialogue !== null);
  }

  /** ページを待ちのあいだに次の組み立て直しが来たら、古いページの続きは捨てる。 */
  private dialogueToken = 0;
  /** 今のページの本文を別の画面へ積んでいるか。 */
  private inDialogue = false;
  /** 吹き出しに入れる本文から台詞の鉤括弧を外す関数（今のページが吹き出しの台詞のとき）。 */
  private unquote: ((text: string) => string) | null = null;

  /** 文字を出す前の間（クリックで飛ばせる。スキップ中はすぐ終わる）。 */
  pause(ms: number): Promise<void> {
    if (this.skipping || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.revealing.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.revealing.add(finish);
    });
  }

  /** 読み終えた本文（NVL の段落と同じ形）を、文字を出す動きなしで要素に入れる（ロードで吹き出しを組み直すとき）。quoted なら台詞の鉤括弧を外す。 */
  writeParts(el: HTMLElement, parts: readonly NvlPart[], quoted = false): void {
    const target = this.textTarget;
    const hurry = this.hurry;
    const unquote = this.unquote;
    this.textTarget = el;
    this.hurry = true;
    this.unquote = quoted ? chatQuoteStripper() : null;
    for (const part of parts) {
      if ("br" in part) el.append(document.createElement("br"));
      else void this.appendText(part.text, part.ruby, part.style);
    }
    this.hurry = hurry;
    this.unquote = unquote;
    this.textTarget = target;
    el.addEventListener("click", this.termClick);
  }

  /**
   * 本文のページがメッセージウィンドウに収まるかを計る（制作画面の「あふれるページ」。開発サーバーの ?studio=1 のときだけ呼ばれる）。
   * 今のメッセージウィンドウを見えない写しにして同じ場所に置き、ページごとに文字を出す動きなしで本文を入れて、
   * 本文の欄の高さが足りない（固定の高さならスクロールが要る、高さが決まっていなければ空のときより枠が伸びる）かを見る。
   * lines は本文の行の数、fits は空の枠に入る行の数（どちらも行の高さで割ったおおよそ）。
   */
  measurePages(pages: readonly { speaker: string | null; label?: string; parts: readonly NvlPart[] }[]): { overflow: boolean; lines: number; fits: number }[] {
    const probe = this.message.cloneNode(true) as HTMLElement;
    probe.classList.add("visible");
    probe.classList.remove("bg-hidden", "nvl");
    probe.setAttribute("aria-hidden", "true");
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    probe.style.transition = "none";
    this.message.after(probe);
    const text = probe.querySelector<HTMLElement>(".text")!;
    const name = probe.querySelector<HTMLElement>(".name");
    text.replaceChildren();
    if (name) name.textContent = "";
    const empty = probe.offsetHeight;
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight) || parseFloat(getComputedStyle(text).fontSize) * 1.75 || 1;
    // 空の枠で、本文の欄の頭から枠の中身の下の端まで（枠の下の余白を除く）が入る高さ。舞台は縮めて描くことがあるので、変形の前の大きさで見る
    const room = probe.clientHeight - parseFloat(getComputedStyle(probe).paddingBottom) - (text.offsetParent === probe ? text.offsetTop : 0);
    const out = pages.map((page) => {
      text.replaceChildren();
      if (name) name.textContent = page.label ?? page.speaker ?? "";
      this.writeParts(text, page.parts.filter((p) => !("text" in p) || !p.style.image));
      // 欄の中でスクロールが要る・枠が空のときより伸びる・枠の高さが決まっていて本文が下の端を越える
      const overflow = text.scrollHeight > text.clientHeight + 2 || probe.offsetHeight > empty + 2 || text.scrollHeight > room + 2;
      return { overflow, lines: Math.max(1, Math.round(text.scrollHeight / lineHeight)), fits: Math.max(1, Math.floor(room / lineHeight)) };
    });
    probe.remove();
    return out;
  }

  /** クリック待ちの印を置く先を替える（@chat の吹き出しへ。組み立て直すと枠の文字の欄に戻る）。 */
  setTextTarget(el: HTMLElement): void {
    this.textTarget = el;
  }

  /** 今のページを既読として見せるか（ui.text.readColor）。システム画面がページごとに決める。 */
  setPageRead(read: boolean): void {
    this.message.classList.toggle("is-read", read);
  }

  async waitClick(signal: AbortSignal): Promise<void> {
    this.hurry = false;
    if (this.skipping) return new Promise((r) => setTimeout(r, this.devSkipping ? 16 : this.skipPageMs));
    const glyph = this.options.extensions?.text?.glyph?.() ?? uiGlyph(this.ui, (kind, path) => this.options.asset(kind, path)) ?? document.createElement("span");
    if (!glyph.className) {
      glyph.className = "glyph";
      glyph.textContent = "▼";
    }
    this.textTarget.append(glyph);
    if (this.message.classList.contains("scroll")) glyph.scrollIntoView({ block: "nearest" });
    if (this.inDialogue) this.options.extensions?.dialogue?.follow(this.context);
    this.waiting = true;
    // 実行器の signal は一回の遊びのあいだ同じなので、進んだら受け口を外す（残すとページの数だけたまる）
    let onAbort = (): void => undefined;
    await new Promise<void>((resolve) => {
      onAbort = () => resolve();
      this.clickResolver = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
      if (this.skipping) resolve();
      if (this.auto) setTimeout(() => this.clickResolver === resolve && this.input(), this.autoWait);
    });
    signal.removeEventListener("abort", onAbort);
    this.waiting = false;
    glyph.remove();
    // クリックを待つ間に見えていた立ち絵（文の後に出たものも）は、次に並べ方が変わったら滑らせる
    this.markSeenSprites();
  }

  private uiCovers = 0;
  private readonly uiCoverListeners = new Set<() => void>();

  /** 全画面の動画などが、ゲーム中の操作の UI（クイックメニュー、メニューのボタン）を覆っているか。 */
  get uiCovered(): boolean {
    return this.uiCovers > 0;
  }

  /**
   * ゲーム中の操作の UI を覆う（全画面の動画などを出している間）。システムはその間クイックメニューを出さない
   * （プラグインが差し替えたものも、status.menuBar が false になる）。返す関数で覆いを外す（二度呼んでもよい）。
   */
  coverUi(): () => void {
    this.uiCovers++;
    this.stage.classList.add("lm-ui-covered");
    for (const l of this.uiCoverListeners) l();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.uiCovers--;
      this.stage.classList.toggle("lm-ui-covered", this.uiCovers > 0);
      for (const l of this.uiCoverListeners) l();
    };
  }

  /** 覆いが変わったら呼ぶ。返す関数で外す。 */
  onUiCoverChange(listener: () => void): () => void {
    this.uiCoverListeners.add(listener);
    return () => this.uiCoverListeners.delete(listener);
  }

  /** 本文の流れに出している選択肢の箱（ui.choice.position: inline。文字を出す所の終わりに置く）。 */
  private inlineChoice: HTMLElement | null = null;

  /** 選択肢を出して選ばれるのを待っているか。 */
  get choosing(): boolean {
    return this.choices.childElementCount > 0 || this.inlineChoice !== null;
  }

  /** fixed があれば、それ以外の選択肢は押せなくする（巻き戻しで戻ってから同じ選択肢に来たとき）。read は先を読んだことがあるか。 */
  /** 次の選択肢の制限時間（ミリ秒。choice-timer で受け取り、選択肢を出したら使う）。 */
  private choiceTimer = 0;

  /** 制限時間を止めているか（システム画面を開いている間）。 */
  private timersPaused = false;
  /** 計っている制限時間（止める・続ける）。 */
  private readonly countdowns = new Set<{ pause(): void; resume(): void }>();

  /**
   * 選択肢の制限時間を計る（実行器の countdown）。止めている間（pauseTimers）は減らさず、続けたら残りから計る。
   * 残り時間のバーも同じように止める。
   */
  countdown(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let left = ms;
      let since = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry = {
        pause: () => {
          if (timer === undefined) return;
          clearTimeout(timer);
          timer = undefined;
          left = Math.max(0, left - (performance.now() - since));
        },
        resume: () => {
          if (timer !== undefined) return;
          since = performance.now();
          timer = setTimeout(() => {
            this.countdowns.delete(entry);
            resolve();
          }, left);
        },
      };
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          this.countdowns.delete(entry);
        },
        { once: true },
      );
      if (signal.aborted) return;
      this.countdowns.add(entry);
      if (!this.timersPaused) entry.resume();
    });
  }

  /** 選択肢の制限時間を止める・続ける（システムがメニューやセーブなどの画面を開いている間）。残り時間のバーも止める。 */
  pauseTimers(paused: boolean): void {
    if (this.timersPaused === paused) return;
    this.timersPaused = paused;
    this.stage.classList.toggle("lm-timers-paused", paused);
    for (const c of this.countdowns) {
      if (paused) c.pause();
      else c.resume();
    }
  }

  /** 作品の画面の型（liminalia.json の ui.templates。選択肢の型を重ねる）。システムが入れる（main.ts）。 */
  templateSource: () => Readonly<Record<string, string>> | undefined = () => undefined;

  /** 型から選択肢を作る部品を読む（書き出しでは初めて選択肢を出すときに読む）。読めなければ少し待って読み直す（止めたら null）。 */
  private async choiceViews(signal: AbortSignal): Promise<Awaited<ReturnType<typeof loadScreenTemplates>> | null> {
    for (;;) {
      try {
        return await loadScreenTemplates();
      } catch (e) {
        console.warn(e);
        await new Promise((r) => setTimeout(r, 1000));
        if (signal.aborted) return null;
      }
    }
  }

  async choose(options: string[], signal: AbortSignal, looks?: (ChoiceLook | null)[], targets?: (string | null)[], fixed: number | null = null, read: readonly boolean[] = []): Promise<number | null> {
    try {
      return await this.showChoices(options, signal, looks, targets, fixed, read);
    } finally {
      // 選択肢を出している間に見えていた立ち絵は、選んだあとに並べ方が変わったら滑らせる
      this.markSeenSprites();
    }
  }

  private async showChoices(options: string[], signal: AbortSignal, looks: (ChoiceLook | null)[] | undefined, targets: (string | null)[] | undefined, fixed: number | null, read: readonly boolean[]): Promise<number | null> {
    this.choices.replaceChildren();
    const time = this.choiceTimer;
    this.choiceTimer = 0;
    const view = this.dialogue;
    const custom = this.screens.choice;
    // 標準の選択肢は型から作る（作品の ui.templates.choice を重ねる）
    const views = custom ? null : await this.choiceViews(signal);
    if (!custom && (!views || signal.aborted)) return null;
    // 本文の流れに出す（ui.choice.position: inline）。文字を出す所の続きに書き込み、選んでも本文の一部として残す。
    // 作品の選択肢（screens.choice）とチャットの画面（ui.chat.dialogue）は、いつもの層と帯のまま
    const inline = !custom && !view && this.ui?.choice?.position === "inline";
    let withdraw = () => {
      // 選択肢を並べる前に止めたときは、外すものが無い
    };
    let shown = null as { remove(): void } | null;
    let choiceRoot = this.choices;
    let choiceButtons: HTMLElement[] = [];
    let onAbort = (): void => undefined;
    const selected = await new Promise<number | null>((resolve) => {
      onAbort = () => resolve(null);
      signal.addEventListener("abort", onAbort, { once: true });
      // 押せない選択肢（locked= が真、巻き戻しで前に選んだもの以外）
      const locked = (i: number) => (fixed !== null && i !== fixed) || !!looks?.[i]?.locked;
      if (custom) {
        // 作品の選択肢（WebPlugin.screens.choice）。置き方は作品の CSS が決める
        let chosen = false;
        const choose = (i: number) => {
          if (chosen || !Number.isInteger(i) || i < 0 || i >= options.length || locked(i)) return;
          chosen = true;
          playSound("choice");
          resolve(i);
        };
        const el = custom({
          options: options.map((text, i) => ({ index: i, text, locked: locked(i), read: !!read[i], look: looks?.[i] ?? null })),
          time,
          choose,
          asset: (kind, path) => this.options.asset(kind, path),
        });
        el.addEventListener("click", (e) => e.stopPropagation());
        this.choices.classList.add("lm-choices-custom");
        this.choices.append(el);
        withdraw = this.offers.add({ options: options.map((text, i) => (locked(i) ? null : text)), choose, ...(targets ? { targets } : {}) });
      } else {
        screenTemplates.setAuthor(this.templateSource());
        let chosen = false;
        const layer = inline ? this.openInlineChoice() : this.choices;
        choiceRoot = layer;
        const made = views!.showChoices(screenTemplates, layer, {
          options,
          looks,
          read,
          locked,
          time,
          asset: (kind, path) => this.options.asset(kind, path),
          choose: (i) => {
            if (chosen) return;
            chosen = true;
            resolve(i);
          },
        });
        shown = made;
        choiceButtons = made.buttons;
        // 録画（lim shot --video）が選べるように知らせる。飛び先は避けるエンディングに使う
        withdraw = this.offers.add({ buttons: made.buttons, ...(targets ? { targets } : {}) });
      }
      // 制限時間: 残り時間が減っていくバー（演出を弱める設定でも、残り時間は分かるように動かす）。標準の選択肢は型に書いてある
      if (time > 0 && custom) {
        const bar = document.createElement("div");
        bar.className = "choice-timer";
        bar.style.setProperty("--choice-time", `${time}ms`);
        bar.setAttribute("role", "progressbar");
        this.choices.prepend(bar);
      }
      // 選択肢の置き方（ui.choice.position）。チャットの画面に出すときと、作品の選択肢は、その並べ方のまま
      if (!view && !custom && !inline) this.placeChoices();
      choiceRoot.querySelector<HTMLElement>("button:not(:disabled), [role=button]:not([aria-disabled=true])")?.focus();
      view?.choosing(this.context, true, this.choices);
    });
    signal.removeEventListener("abort", onAbort);

    withdraw();
    const inlineEl = this.inlineChoice;
    this.inlineChoice = null;
    if (inlineEl) {
      // 本文の一部として残す: ボタンを押せない文字の行に戻し、選んだものに印を付ける
      this.sealInlineChoice(inlineEl, choiceButtons, selected);
      shown?.remove();
    } else {
      this.choices.replaceChildren();
      shown?.remove();
    }
    this.choices.classList.remove("lm-choices-custom");
    resetChoicePlace(this.choices);
    view?.choosing(this.context, false, this.choices);
    return selected;
  }

  /** 本文の続きに選択肢を書き込む箱を作る（ui.choice.position: inline。文字を出す所の終わりに置く）。 */
  private openInlineChoice(): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "choice-inline";
    this.textEl.append(el);
    this.inlineChoice = el;
    // 枠の中でスクロールする本文と縦書きの NVL は、新しく書き込んだ選択肢が見える所へ送る（選択肢の行が入ってから動かす）
    const list = this.message.classList;
    if (list.contains("scroll") || (list.contains("nvl") && list.contains("vertical"))) queueMicrotask(() => el.isConnected && el.scrollIntoView({ block: "nearest", inline: "nearest" }));
    return el;
  }

  /** 選び終えた本文の選択肢を、押せない文字の行に戻して本文の一部として残す（picked は選んだ番号）。 */
  private sealInlineChoice(el: HTMLElement, buttons: HTMLElement[], picked: number | null): void {
    el.classList.add("is-done");
    el.style.removeProperty("--choice-time");
    for (const [i, b] of buttons.entries()) {
      const line = document.createElement("span");
      if (i === picked) line.className = "is-picked";
      line.append(...b.childNodes);
      b.replaceWith(line);
    }
    // 制限時間のバーなど、選択肢の行でないものは残さない
    el.querySelectorAll(".choice-timer").forEach((t) => t.remove());
  }

  /**
   * 並べた選択肢を ui.choice.position に合わせてずらす。y を書いたときは、上と下の置き方より y を使う。
   * 書かなければ avoid-faces（縦の中央に置き、立ち絵の顔に重なるときだけずらす）。y だけを書いた作品は y のまま（前の既定の center と同じ）。
   */
  private placeChoices(): void {
    const c = this.ui?.choice;
    const position = c?.position ?? (c?.y !== undefined ? "center" : "avoid-faces");
    if (position === "center" || position === "inline" || (c?.y !== undefined && position !== "avoid-faces")) return;
    const place = () => placeChoices({ position, stage: this.stage, choices: this.choices, message: this.message, sprites: [...this.spriteEls].map(([who, e]) => ({ who, el: e.el })), cast: this.options.cast, state: this.stageNow });
    place();
    // 画像のボタンは、絵を読み終えて大きさが決まってから置き直す
    const loading = [...this.choices.querySelectorAll("img")].filter((img) => !img.complete);
    if (loading.length === 0) return;
    const buttons = this.choices.firstElementChild;
    // 壊れた画像でも、読み込みが終わった後に並べ直す
    void Promise.all(loading.map((img) => img.decode().catch(() => undefined))).then(() => {
      if (this.choices.firstElementChild === buttons && buttons) place();
    });
  }

  /** 作品固有の演出に渡す描画の部品。 */
  get context(): RenderContext {
    const host = this;
    return {
      host,
      stage: this.stage,
      screen: this.screen,
      uiScale: uiScale(this.screen),
      camera: this.camera,
      layers: { background: this.background, sprites: this.sprites, images: this.images, fx: this.fx, hud: this.hud, overlay: this.overlay },
      message: { root: this.message, name: this.nameEl, text: this.textEl },
      asset: (kind, path) => this.options.asset(kind, path),
      cast: this.options.cast,
      image: (url) => this.image(url),
      spriteReady: (who) => (who === undefined ? Promise.all(this.spritesPlacing.values()).then(() => undefined) : (this.spritesPlacing.get(who) ?? Promise.resolve())),
      fade: (el, to, ms) => this.fade(el, to, ms),
      time: (ms) => this.effectTime(ms),
      delay: (ms) => this.delay(ms),
      onFastForward: (finish) => this.onFastForward(finish),
      get skipping() {
        return host.skipping;
      },
      waitClick: (signal) => this.waitClick(signal ?? new AbortController().signal),
      audio: this.audio,
      loadData: (name) => (this.options.loadData ? this.options.loadData(name) : Promise.reject(new Error(`データを読み込めません: ${name}`))),
      studio: this.options.studio === true,
      get reduceShake() {
        return host.reduceShake;
      },
      get reduceFlash() {
        return host.reduceFlash;
      },
      get ui() {
        return host.ui;
      },
      get system() {
        return host.system;
      },
      world: this.quake,
      mask: {
        cover: (color = "#000") => {
          for (const a of this.mask.getAnimations()) a.cancel();
          this.mask.style.background = color;
          this.mask.style.opacity = "1";
          this.setMasked(true);
        },
        uncover: () => {
          for (const a of this.mask.getAnimations()) a.cancel();
          this.mask.style.opacity = "0";
          this.setMasked(false);
        },
      },
      window: {
        hide: () => this.holdWindow(),
        hideWhile: async (job) => {
          const release = this.holdWindow();
          try {
            return await job();
          } finally {
            release();
          }
        },
      },
      get systemLayer() {
        return host.systemLayer ?? host.overlay;
      },
      setBackground: (image, o = {}) => this.changeBackground(image, this.effectTime(o.fade ?? 0), true, o.method ?? "crossfade", false, false, null, o.folder ?? "bgimage"),
      toStage: (x, y) => this.toStage(x, y),
      scope: (options) => this.createScope(options),
      on: (type, listener) => this.events.on(type, listener),
      notify: (text, options) => this.notices.show(text, options),
      toast: (message, ms) => toast(this.systemLayer ?? this.overlay, message, ms),
      offer: (offer) => this.offers.add(offer),
    };
  }

  async present(event: PresentEvent): Promise<Value | void> {
    switch (event.type) {
      case "page": {
        // この文を出す時点で見えている立ち絵（並べ方が変わったとき、これだけを滑らせる）
        this.markSeenSprites();
        this.speaker = event.speaker;
        this.hurry = this.instantPage;
        this.instantPage = false;
        // 隠した枠（hide-window）を出し直す。前の本文は見せない（NVL でも新しいページから積む）
        this.dropStaleText();
        this.setMessageSuppressed(false);
        // 本文を別の画面へ積むなら、その要素を先に用意する（入力中の表示の間を置くなら、ボイスはそのあとで鳴らす）
        const view = this.dialogue;
        this.inDialogue = view !== null;
        this.unquote = view && event.speaker !== null ? chatQuoteStripper() : null;
        this.syncDialogue();
        if (view) {
          const token = ++this.dialogueToken;
          const target = await view.page(this.context, { speaker: event.speaker, ...(event.label ? { label: event.label } : {}), read: this.message.classList.contains("is-read"), instant: this.hurry }, this.stageNow!);
          if (token !== this.dialogueToken) return;
          target.addEventListener("click", this.termClick);
          this.textTarget = target;
        }
        // 同時に話すほかの話者（二つ目のボイスの who。実行器が with に載せる。載せない描き直しでは、ボイスから拾い、名前は @name のもの）
        const together = event.with ?? [...new Set((event.voice?.also ?? []).flatMap((c) => (c.who && c.who !== event.speaker ? [c.who] : [])))].map((w) => ({ speaker: w, label: this.stageNow?.names?.[w] }));
        this.coSpeakers = together.map((w) => w.speaker);
        if (event.voice) {
          if (this.skipping) this.audio.stopVoice(0);
          else {
            this.playVoiceCue(event.voice, event.speaker);
            if (event.voice.caption) this.caption("voice", event.voice.file, event.voice.caption);
          }
        } else if (this.voiceStopOnPage) this.audio.stopVoice(0);
        if (view) {
          // 枠の名前と本文は使わない（@nvl on などで枠に戻ったとき、前の字が残らないように空にしておく）
          this.setName("");
          this.textEl.replaceChildren();
        } else if (this.message.classList.contains("nvl")) {
          // NVL: ページごとに段落を足していく（話者名は段落の頭に）
          this.textTarget = this.nvlParagraph(event.speaker, event.label);
        } else {
          // 二人が同時に話すページは、名前欄に二人の名前を出す
          this.setName(joinSpeakerNames([event.label ?? event.speaker ?? "", ...together.map((w) => w.label ?? w.speaker)]), event.speaker);
          this.clearText();
        }
        // 人物ごとの見た目（cast.json の text、nameImage、windowImage）
        this.applySpeakerLook(event.speaker);
        void this.updateFace();
        this.applyFocus(true);
        this.placeBalloon();
        this.options.extensions?.text?.page?.(this.context, event.at);
        this.options.onPage?.(event.at, event.key);
        this.events.emit({ type: "page", at: event.at, speaker: event.speaker, label: event.label ?? event.speaker ?? null });
        if (this.lastSpeaker !== event.speaker) {
          const previous = this.lastSpeaker ?? null;
          this.lastSpeaker = event.speaker;
          this.events.emit({ type: "speaker", speaker: event.speaker, previous });
        }
        return;
      }
      case "text":
        return this.appendText(event.text, event.ruby, event.style);
      case "br":
        this.textTarget.append(document.createElement("br"));
        return;
      case "command": {
        // 自動確認で、命令の autoplay が答えを出す（描かない）
        if (event.autoplay) return;
        // 立ち絵の出入り・差分の切り替え（作品の命令が stage.sprites を変えたときも）。組み立て直しは終わってから知らせる
        if (event.name !== "restore") this.noticeSprites(event.stage);
        if (event.afterPage) this.clearAfterPage(event.name, event.args);
        const done = this.presentCommand(event);
        // 顔ウィンドウの表情・出す出さないが変わりうる命令（枠の形は命令の初めに切り替わる）
        if (FACE_COMMANDS.has(event.name)) queueMicrotask(() => void this.updateFace());
        if (!event.wait || event.name === "restore") return done;
        // 終わるまで待った命令（背景の切り替え、揺れ、待つ @chara など）の間に見えていた立ち絵は、次に並べ方が変わったら滑らせる。
        // すぐに終わった命令は見る間が無いので数えない
        const started = performance.now();
        return done.then((value) => {
          if (performance.now() - started >= SEEN_WAIT_MS) this.markSeenSprites();
          return value;
        });
      }
    }
  }

  private faceToken = 0;

  /** 顔ウィンドウ（ui.face）を今の話者と状態に合わせる。出せなければ隠す。 */
  private async updateFace(): Promise<void> {
    const token = ++this.faceToken;
    // 顔の画像が決まらなければ顔ウィンドウを隠す（素材が無いことは lim check が知らせる）
    const url = await this.faceUrl().catch(() => null);
    if (token !== this.faceToken) return;
    const placed = this.ui?.face?.x !== undefined || this.ui?.face?.y !== undefined;
    this.message.classList.toggle("face-placed", placed);
    this.message.classList.toggle("face-right", !placed && this.ui?.face?.side === "right");
    if (!url) {
      this.message.classList.remove("has-face");
      this.faceEl.removeAttribute("src");
      return;
    }
    if (this.faceEl.getAttribute("src") !== url) this.faceEl.src = url;
    this.message.classList.add("has-face");
  }

  /** 話者の顔の絵の URL。差分の face か、立ち絵（パーツ合成なら重ねた後）から立ち絵セットの face の範囲を切り出したもの。 */
  private async faceUrl(): Promise<string | null> {
    const face = this.ui?.face;
    const stage = this.stageNow;
    if (!face || !stage) return null;
    const explicit = face.show === "explicit";
    if (!explicit && (!this.speaker || this.nameShown.label === "")) return null;
    if (["nvl", "balloon", "vertical"].some((c) => this.message.classList.contains(c))) return null;
    if (explicit && !stage.faceShown) return null;
    const who = explicit ? stage.faceShown!.who : castForSpeaker(this.options.cast, this.speaker!);
    if (!who || !this.options.cast[who]) return null;
    const sprite = explicit ? undefined : stage.sprites[who];
    if (sprite && face.show === "offstage") return null;
    return this.castFace(who, explicit ? stage.faceShown! : (sprite ?? stage.faces?.[who] ?? { appearance: "", variant: "" }));
  }

  /** そのキャストのその姿の顔の絵の URL（顔ウィンドウとチャットの吹き出し）。無ければ null。 */
  async castFace(who: string, pose: { appearance: string; variant: string }): Promise<string | null> {
    const entry = this.options.cast[who];
    if (!entry) return null;
    const { appearance, variant } = resolveVariant(entry, pose.appearance, pose.variant);
    const set = entry.appearances[appearance];
    const source = variant ? variantFace(set, variant) : null;
    if (!variant || !source) return null;
    if ("image" in source) {
      const url = withCacheKey(this.options.asset("fgimage", source.image), variant.cacheKey);
      await this.image(url);
      return url;
    }
    const whole = await this.spriteUrl(set, variant);
    const { x, y, width, height } = source.crop;
    const key = `crop ${x},${y},${width},${height}\n${whole}`;
    return this.cached(key, async () => {
      const img = await this.image(whole);
      const canvas = Object.assign(document.createElement("canvas"), { width, height });
      canvas.getContext("2d")?.drawImage(img, x, y, width, height, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      return blob ? URL.createObjectURL(blob) : whole;
    });
  }

  // ---- 本文 ----

  private appendText(text: string, ruby: string | null, style: TextStyle): Promise<void> {
    if (this.unquote && ruby === null && !style.image) text = this.unquote(text);
    const perChar = this.skipping || this.hurry ? 0 : (style.perChar ?? this.textSpeed ?? this.options.defaultPerChar ?? 30);
    const wrap = document.createElement("span");
    if (style.bold) wrap.style.fontWeight = "bold";
    if (style.italic) wrap.style.fontStyle = "italic";
    if (style.color) wrap.style.color = style.color;
    if (style.size) wrap.style.fontSize = `${style.size}px`;
    if (style.mark) wrap.style.backgroundColor = style.mark;
    if (style.emphasis) wrap.classList.add("lm-emphasis");

    const units: HTMLElement[] = [];
    if (style.image) {
      // 本文の中の画像（{img …}）。一字と同じに数えて出す
      const unit = document.createElement("span");
      unit.className = "ch lm-inline-image-unit";
      const img = document.createElement("img");
      img.className = "lm-inline-image";
      img.src = this.options.asset("image", style.image);
      img.alt = "";
      if (style.imageHeight) img.style.height = `${style.imageHeight}px`;
      unit.append(img);
      units.push(unit);
    } else if (ruby !== null) {
      // ルビは <ruby><rt> ではなく span で組む。WebKit（iOS・Safari）は rt の position:absolute を受け付けず、
      // ルビが左にずれ、行の高さに数えられて行が下がるため（style.css の .ruby と .rt）
      const r = document.createElement("span");
      r.className = "ch ruby";
      const rt = document.createElement("span");
      rt.className = "rt";
      rt.textContent = ruby;
      r.append(text, rt);
      units.push(r);
    } else if (this.message.classList.contains("vertical") && !this.message.classList.contains("balloon")) {
      // 縦書き: 半角の数字は 2 桁までを縦中横、3 桁からは一文字ずつ立てる。!! !? ?! も縦中横（横に寝かせない）
      for (const [m] of text.matchAll(/[0-9]{3,}|[0-9]{1,2}|[!?][!?]|[\s\S]/gu)) {
        if (/^[0-9]{3,}$/.test(m)) {
          for (const d of m) units.push(Object.assign(document.createElement("span"), { className: "ch upright", textContent: d }));
        } else {
          units.push(Object.assign(document.createElement("span"), { className: /^(?:[0-9]{1,2}|[!?][!?])$/.test(m) ? "ch tcy" : "ch", textContent: m }));
        }
      }
    } else {
      for (const ch of text) {
        const s = document.createElement("span");
        s.className = "ch";
        s.textContent = ch;
        units.push(s);
      }
    }
    units.forEach((u, i) => {
      if (perChar === 0) u.classList.add("shown");
      else u.style.animationDelay = `${i * perChar}ms`;
    });
    // 用語集の語: 出たことを知らせ、横書きの一字ずつの並びなら印を付ける（縦書きの数字のまとまりなどは一字と並びがずれるので印は付けない）
    if (this.glossary && ruby === null) {
      const chars = [...text];
      const marking = units.length === chars.length;
      for (const m of text.matchAll(this.glossary.pattern)) {
        const id = this.glossary.ids.get(m[0]);
        if (!id) continue;
        this.glossary.shown(id);
        if (!marking || !this.glossary.link.has(m[0])) continue;
        const start = [...text.slice(0, m.index)].length;
        const length = [...m[0]].length;
        for (const u of units.slice(start, start + length)) {
          u.classList.add("lm-term");
          u.dataset.term = id;
        }
      }
    }
    // 文字の動き（{fx …}）は内側の要素に付ける（外側は一字ずつ出す動きに使っている）。出てくる動き（pop・fade）は、一度に出すときは付けない
    const fx = style.fx;
    if (fx && !(perChar === 0 && (fx === "pop" || fx === "fade"))) {
      units.forEach((u, i) => {
        const inner = document.createElement("span");
        inner.className = `tfx tfx-${fx}`;
        inner.style.setProperty("--i", String(i));
        // 動きの大きさと速さ（{fx … strength= speed=}）
        if (style.fxStrength !== undefined) inner.style.setProperty("--fx-strength", String(style.fxStrength));
        if (style.fxSpeed !== undefined) inner.style.setProperty("--fx-speed", String(style.fxSpeed));
        if (perChar > 0) inner.style.setProperty("--reveal", `${i * perChar}ms`);
        inner.append(...u.childNodes);
        u.append(inner);
      });
    }
    wrap.append(...units);
    this.textTarget.append(wrap);
    this.follow(units, perChar);
    if (this.inDialogue) this.options.extensions?.dialogue?.follow(this.context);
    this.options.extensions?.text?.reveal?.(units, perChar);
    const charHook = this.options.extensions?.text?.char;
    if (charHook) units.forEach((u, i) => charHook(u, { index: i, delay: perChar === 0 ? 0 : i * perChar, perChar }));
    if (perChar === 0 || units.length === 0) return Promise.resolve();
    const stopSound = this.textSound(units.length, perChar);

    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        stopSound();
        this.revealing.delete(finish);
        for (const u of units) {
          u.classList.add("shown");
          // 本文の見た目（TextTheme.char）が足した動きも終わりの姿にする（CSS の動きは .shown で外れる）
          if (charHook) finishScriptedAnimations(u);
        }
        resolve();
      };
      const timer = setTimeout(finish, units.length * perChar);
      this.revealing.add(finish);
    });
  }

  // ---- 命令 ----

  private async command(name: string, a: Record<string, Value>, wait: boolean, stage: StageState): Promise<Value | void> {
    this.stageNow = stage;
    const t = (ms: number) => (this.skipping ? 0 : ms);
    const renderer = this.options.extensions?.renderers[name];
    // 背景をほかの命令（@bg-place、作品の命令など）が替えて背景の色調が替わったら、立ち絵の色調も合わせる。@bg・場面転換・ロードは新しい背景を出すときに合わせる
    // 時間は time（版 4 で fade から替えた命令）か、プラグインの命令の fade
    if (renderer || !OWN_BACKGROUND_TONE.has(name)) this.followBackgroundTone(stage, t(num(RENAMED_PARAMS[name] ? a.time : a.fade)));
    if (renderer) return renderer(this.context, a, wait, stage);
    switch (name) {
      case "restore":
        return this.restore(stage);
      case "plane":
      case "plane-hide": {
        const done = this.syncPlanes(stage, t(num(a.time)));
        if (wait) await done;
        return;
      }
      case "bg":
        // 前の背景の奥行きの絵（手前のもの）を外す。奥のものは背景と一緒に消える
        void this.syncPlanes(stage, t(num(a.time)));
        // 単色の背景（color=）は絵の代わりに色の板を出す
        return this.changeBackground(typeof a.color === "string" ? { color: a.color } : str(a.image), t(num(a.time)), wait, str(a.method, "crossfade"), a.cross === true, a["hide-window"] === true, ruleOf(a));
      case "chara": {
        const who = str(a.who);
        if (typeof a["replace-who"] === "string") {
          const target = a["replace-who"];
          const fade = t(num(a.time));
          const done = (async () => {
            if (this.autoReflowJob) await this.autoReflowJob;
            await this.hideSprite(target, fade);
            if (!this.stageNow?.sprites[who]) return;
            const motion: SpriteMotion = { kind: spriteMotion(a.enter), distance: num(a.distance, 160) };
            await this.trackSprite(who, this.showSprite(who, this.stageNow, fade, wait, a.cross !== false, motion, false, true));
          })();
          if (wait) await done;
          else void done.catch((error) => console.warn("立ち絵の入れ替えに失敗しました", error));
          return;
        }
        if (a.clear !== undefined) this.cancelAutoReflow();
        const managed = Object.values(stage.sprites).some((sprite) => sprite.autoLayout === true);
        const changed = !this.spriteEls.has(who) || [...this.spriteEls.keys()].some((name) => !(name in stage.sprites));
        // 並べ直しが出し直しに入った後の、顔ぶれの変わらない表情替えは、並べ直しを繰り返さない（全員がもう一度消えて点滅する）。
        // 出し終わるのを待ってから、ふだんの差し替えとして最新の状態で替える。
        const reflow = this.autoReflowJob;
        if (reflow && this.autoReflowShowing && a.clear === undefined && !changed && Object.keys(stage.sprites).every((name) => this.spriteEls.has(name))) {
          // 待つ間にロード、巻き戻し、全消しで並べ直しを止めたら（epoch が変わる）、組み立て直した舞台には効かせない
          // （そこから先の命令が始めた立ち絵の動きを、この差し替えが途中で終わらせてしまう）
          const epoch = this.autoReflowEpoch;
          const done = reflow.then(() => {
            const now = this.stageNow;
            if (this.autoReflowEpoch !== epoch || !now?.sprites[who] || !this.spriteEls.has(who)) return;
            return this.command(name, a, wait, now);
          });
          if (wait) await done;
          else void done.catch((error) => console.warn("立ち絵の差し替えに失敗しました", error));
          return;
        }
        let otherMoved = false;
        // 退場しても動かさない並べ方で、空いた枠に新しい人物が入るだけなら、ほかの人物は動かないので並べ直さない
        const keepGap = managed && changed && !this.autoReflowJob && this.options.autoLayout?.exit === "keep" && !this.spriteEls.has(who)
          && [...this.spriteEls.keys()].every((name) => name in stage.sprites) && !(await this.keptLayoutMoves(stage, who));
        if (managed && !changed && !this.autoReflowJob && (a.at !== undefined || a.x !== undefined || a.y !== undefined)) {
          const boxes = await this.layoutSprites(stage);
          otherMoved = [...this.spriteEls].some(([name, entry]) => name !== who && boxes.has(name) && !sameBox(entry.box, boxes.get(name)!));
        }
        if (a.clear === undefined && !keepGap && (this.autoReflowJob || (managed && (changed || otherMoved) && this.spriteEls.size > 0))) {
          const motion = !this.spriteEls.has(who) ? { who, motion: { kind: spriteMotion(a.enter), distance: num(a.distance, 160) } } : undefined;
          const job = this.scheduleAutoReflow(t(num(a["auto-fade"], 300)), t(num(a.time)), motion);
          if (wait) await job;
          return;
        }
        // 全消しと同時に新しい立ち絵を出す。本人も一度外すので、差し替えや移動にはならない。
        const cleared = a.clear !== undefined ? Promise.all([...this.spriteEls.keys()].map((other) => this.hideSprite(other, t(num(a.clear))))) : Promise.resolve([]);
        // まだ出ていない人物が出るのを待つ間は、前の話者の名前と本文を残さない（前の話者の名前のまま次の人物が見えないように）
        if (wait && !this.spriteEls.has(who) && t(num(a.time)) > 0) this.clearForEntrance(who);
        // solo: 状態から消えたほかの人物を、同じ時間で消す（入れ替わるように）
        const others = a.solo === true ? [...this.spriteEls.keys()].filter((other) => other !== who && !(other in stage.sprites)) : [];
        const hidden = Promise.all(others.map((other) => this.hideSprite(other, t(num(a.time)))));
        const motion: SpriteMotion = { kind: spriteMotion(a.enter), distance: num(a.distance, 160) };
        const shown = this.trackSprite(who, this.showSprite(who, stage, t(num(a.time)), wait, a.cross !== false, motion, a.slide === true, a.swap !== "cross"));
        if (wait) await Promise.all([hidden, shown]);
        void cleared;
        return shown;
      }
      case "chara-hide": {
        const keepLeave = !this.autoReflowJob && this.options.autoLayout?.exit === "keep" && !(await this.keptLayoutMoves(stage, str(a.who)));
        if (!keepLeave && (this.autoReflowJob || (Object.values(stage.sprites).some((sprite) => sprite.autoLayout === true) && this.spriteEls.has(str(a.who))))) {
          const job = this.scheduleAutoReflow(t(num(a.time)), t(num(a.time)), undefined, { who: str(a.who), motion: { kind: spriteMotion(a.exit), distance: num(a.distance, 160) } });
          if (wait) await job;
          return;
        }
        // 残りの立ち絵の位置が変わる（自動配置）なら、消し終わってから動かす。
        const motion: SpriteMotion = { kind: spriteMotion(a.exit), distance: num(a.distance, 160) };
        const done = this.hideSprite(str(a.who), t(num(a.time)), motion).then(async () => Promise.all(this.placeSprites(await this.layoutSprites(stage), t(stage.spriteConfig?.moveTime ?? num(a.time)), undefined, stage.spriteConfig?.easing)));
        if (wait) await done;
        return;
      }
      case "chara-hide-all": {
        this.cancelAutoReflow();
        const motion: SpriteMotion = { kind: spriteMotion(a.exit), distance: num(a.distance, 160) };
        const done = Promise.all([...this.spriteEls.keys()].map((who) => this.hideSprite(who, t(num(a.time)), motion)));
        if (wait) await done;
        return;
      }
      case "mask":
        this.mask.style.background = str(a.color, "#000");
        await this.moveMask("show", str(a.method, "crossfade"), t(num(a.time)), ruleOf(a));
        // 明転のときに前の本文を見せない（次の本文で出し直す。@scene-change の hide-window と同じ）
        if (a["hide-window"] !== false) this.hideUntilText();
        return;
      case "mask-off":
        await this.moveMask("hide", str(a.method, "crossfade"), t(num(a.time)), ruleOf(a));
        return;
      case "scene-change": {
        if (a["hide-chara"] !== false && a["hide-who"] === undefined) this.cancelAutoReflow();
        // 場面転換: 暗転 → 覆っている間に立ち絵をすべて消して背景を替える → 暗転したまま置く → 明転。
        // もう覆いきっていれば（前のファイルの終わりの @mask から飛んできたなど）、暗転の時間は待たない
        this.mask.style.background = str(a.color, "#000");
        const keepLeave = typeof a["hide-who"] === "string" && !this.autoReflowJob && this.options.autoLayout?.exit === "keep" && !(await this.keptLayoutMoves(stage, a["hide-who"]));
        const hideSprites = () => {
          const who = typeof a["hide-who"] === "string" ? a["hide-who"] : null;
          const fade = t(num(a["hide-fade"]));
          if (who !== null && !keepLeave && (this.autoReflowJob || (Object.values(stage.sprites).some((sprite) => sprite.autoLayout === true) && this.spriteEls.has(who)))) {
            return this.scheduleAutoReflow(fade, fade);
          }
          const hidden = who === null ? Promise.all([...this.spriteEls.keys()].map((name) => this.hideSprite(name, fade))) : this.hideSprite(who, fade);
          // 一人だけ消した場合は @chara-hide と同じく、消え終えてから自動配置を整える。
          if (who !== null) return hidden.then(async () => Promise.all(this.placeSprites(await this.layoutSprites(stage), t(stage.spriteConfig?.moveTime ?? fade), undefined, stage.spriteConfig?.easing)));
          return hidden;
        };
        if (a["hide-chara"] !== false && a["hide-chara-at"] === "start") void hideSprites();
        if (a["hide-window"] !== false && a["hide-window-at"] === "start") this.hideUntilText();
        if (!this.maskCovering()) await this.moveMask("show", "crossfade", t(num(a["fade-out"])));
        // 明転のときに前の本文を見せない（次の本文で出し直す。@bg の hide-window と同じ）
        if (a["hide-window"] !== false && a["hide-window-at"] !== "start") this.hideUntilText();
        if (a["hide-chara"] !== false && a["hide-chara-at"] !== "start") {
          const hidden = hideSprites();
          // 従来の「暗転後に全員を即座に消す」は、要素の後片付けまで済ませてから明転する。
          if (typeof a["hide-who"] !== "string" && t(num(a["hide-fade"])) === 0) await hidden;
          else void hidden;
        }
        // 暗転の後ろで BGM を替える・止める（フェードは bgm-fade、音量は bgm-volume）
        if (typeof a.bgm === "string") {
          void this.audio.playBgm(a.bgm, num(a["bgm-volume"], 100), true, t(num(a["bgm-fade"])), { crossfadeMs: 0 });
          this.caption("bgm", a.bgm, undefined);
        } else if (a["stop-bgm"] === true) this.audio.stopBgm(t(num(a["bgm-fade"])));
        if (typeof a.image === "string" || typeof a["bg-color"] === "string") {
          void this.syncPlanes(stage, 0);
          await this.changeBackground(typeof a.image === "string" ? a.image : { color: String(a["bg-color"]) }, 0, true, "crossfade", false, false);
        }
        const hold = t(num(a.hold));
        if (hold > 0) await this.delay(hold);
        await this.moveMask("hide", "crossfade", t(num(a["fade-in"])));
        return;
      }
      case "window-image":
        this.applyWindowImage(stage);
        return;
      case "window":
        // 隠した枠（hide-window）の前の本文は、出し直す枠に残さない
        this.dropStaleText();
        this.setMessageSuppressed(false);
        this.message.classList.toggle("visible", stage.window);
        if (!stage.window) this.clearText();
        this.syncDialogue();
        return;
      case "chara-config":
        this.applyFocus(false);
        return;
      case "dof": {
        const done = this.applyDof(stage, t(num(a.time)));
        if (wait) await done;
        return;
      }
      case "tone": {
        const done = this.applyTones(stage, t(num(a.time)));
        if (wait) await done;
        return;
      }
      case "balloon":
        this.syncDialogue();
        this.placeBalloon();
        return;
      case "text-sound":
      case "text-sound-off":
        // 鳴らすのは文字を出すとき（状態から引く）
        return;
      case "clear":
        this.setName("");
        this.clearText();
        this.dialogue?.clear(this.context);
        return;
      case "nvl":
        this.setNvl(stage.nvl === true, stage.nvlStyle);
        this.syncDialogue();
        return;
      case "vertical":
        this.setVertical(stage);
        this.syncDialogue();
        return;
      case "wait":
        // クリックで早送りできる待ち（skip=false の @wait と ui.input.skipEffects: false では待ち切る）
        await this.delay(t(num(a.time)));
        // 待つ間に見えていた立ち絵は、次に並べ方が変わったら滑らせる
        this.markSeenSprites();
        return;
      case "quake": {
        const done = this.shake(t(num(a.time, 300)), num(a.count, 5), num(a.horizontal), num(a.vertical, 10), a.target === "background" ? this.background : this.quake);
        if (wait) await done;
        return;
      }
      case "camera":
      case "reset-camera": {
        const time = t(num(a.time, 1000));
        const ease = str(a.ease, "ease");
        // 行って戻る（yoyo）: 半分の時間で書いた姿へ、残りで今の状態（変えていない）へ戻す
        const c = stage.camera;
        const done =
          name === "camera" && a.yoyo === true
            ? this.moveCamera({ zoom: num(a.zoom, c.zoom), x: num(a.x, c.x), y: num(a.y, c.y), rotate: num(a.rotate, c.rotate) }, a, time / 2, ease).then(() => this.moveCamera(c, {}, time / 2, ease))
            : this.moveCamera(c, a, time, ease);
        if (wait) await done;
        return;
      }
      case "bgm":
        void this.audio.playBgm(str(a.file), num(a.volume, 100), a.loop !== false, t(num(a.time)), { ...playOptions(a), crossfadeMs: t(num(a.crossfade)), filterFadeMs: t(num(a["filter-fade"])) });
        this.caption("bgm", str(a.file), undefined);
        return;
      case "stop-bgm":
        this.audio.stopBgm(t(num(a.time)));
        return;
      case "se":
        void this.audio.playSe(String(a.channel ?? 0), str(a.file), num(a.volume, 100), a.loop === true, t(num(a.time)), playOptions(a));
        this.caption("se", str(a.file), typeof a.caption === "string" ? a.caption : undefined);
        return;
      case "stop-se":
        this.audio.stopSe(String(a.channel ?? 0), t(num(a.time)));
        return;
      case "text-speed":
      case "text-speed-reset":
        this.textSpeed = stage.textSpeed;
        return;
      case "choice-timer":
        // 次に出す選択肢に、残り時間のバーを付ける（実行器が @choice timeout= のときに送る）
        this.choiceTimer = num(a.time);
        return;
      default:
        return renderPlay(this, this.context, name, a, wait, stage);
    }
  }

  /** 背景を切り抜くときの焦点（ui.backgroundFocus）。書いていなければ真ん中（style.css）。 */
  private focusBackground(img: HTMLElement): void {
    const focus = this.ui?.backgroundFocus;
    const at = focus?.[img.dataset.bg ?? ""] ?? focus?.["*"];
    if (at) img.style.objectPosition = at;
    else img.style.removeProperty("object-position");
  }

  /**
   * 背景を替える。新しい背景を method の動きで出し、出し終えたら古い背景を消す。
   * cross なら古い背景も同時に対になる動きで消していく（TyranoScript の [bg] と同じ）。
   */
  /**
   * 背景を替える。hideWindow なら、時間をかけて替えるあいだメッセージ枠を隠し、次の本文を出すとき（か @window show・ロード）に出し直す
   * （見せ方だけで、@window の状態は変えない）。
   */
  private async changeBackground(image: string | { color: string }, fade: number, wait: boolean, method = "crossfade", cross = false, hideWindow = false, rule: RuleArgs | null = null, folder: AssetKind = "bgimage"): Promise<void> {
    // 隠すのは時間をかけて替えるときだけ（スキップ中は一瞬なので隠さない）。前の本文は、隠さなくても次に枠を出すとき見せない（実行器も捨てている）
    if (hideWindow) {
      if (fade > 0) this.setMessageSuppressed(true);
      this.staleText = true;
    }
    let img: HTMLElement;
    if (typeof image === "string") {
      img = await this.image(this.options.asset(folder, image));
      img.dataset.bg = image;
      this.focusBackground(img);
    } else {
      // 単色の背景（@bg color=）。絵と同じに切り替えられる板
      img = document.createElement("div");
      img.className = "fill lm-bg-color";
      img.dataset.bgColor = image.color;
      img.style.background = image.color;
    }
    const previous = [...this.background.children] as HTMLElement[];
    // ルールで出すなら、マスクをかけ終わるまで見せない
    if (rule && fade > 0) img.style.opacity = "0";
    this.background.append(img);
    // 背景の色調（@bg の tone= と ui.backgroundTones）が替わったら、立ち絵の色調も背景と同じ時間で替える
    if (this.stageNow) this.followBackgroundTone(this.stageNow, fade);
    const jobs: Promise<unknown>[] = [];
    if (fade === 0) {
      previous.forEach((p) => p.remove());
    } else if (rule) {
      const fastForward = this.fastForwardHook();
      jobs.push(this.ruleLevels(img, rule).then((levels) => ruleTransition(img, levels, fade, "show", rule.vague, fastForward)));
    } else {
      jobs.push(img.animate(transitionKeyframes(method, "show"), { duration: fade, easing: "ease" }).finished);
      if (cross) for (const p of previous) jobs.push(p.animate(transitionKeyframes(method, "hide"), { duration: fade, easing: "ease", fill: "forwards" }).finished);
    }
    const done = Promise.all(jobs).then(() => previous.forEach((p) => p.remove()));
    if (wait) await done;
  }

  private async resolveSprite(who: string, stage: StageState): Promise<{ variant: CastVariant; url: string; at: SpritePartVariant } | null> {
    const s = stage.sprites[who];
    const entry = this.options.cast[who];
    if (!s || !entry) {
      console.warn(`立ち絵の定義がありません: ${who}`);
      return null;
    }
    const { appearance, variant } = resolveVariant(entry, s.appearance, s.variant);
    if (!variant) {
      console.warn(`立ち絵の差分がありません: ${who} / ${appearance} / ${s.variant}`);
      return null;
    }
    // 部品（Live2D・Spine など）が表情や動きを選ぶ差分の名前（「smile+blush」なら smile、書かなければ基準の差分）
    const name = s.variant.split("+")[0] || baseVariant(entry.appearances[appearance]) || "";
    return { variant, url: await this.spriteUrl(entry.appearances[appearance], variant), at: { name, appearance } };
  }

  /** キャストの差分の絵の URL（立ち絵の鑑賞など。パーツ合成なら重ねた一枚）。無ければ ""。 */
  async spriteImage(who: string, appearance: string, variant: string): Promise<string> {
    const entry = this.options.cast[who];
    if (!entry) return "";
    const r = resolveVariant(entry, appearance, variant);
    return r.variant ? this.spriteUrl(entry.appearances[r.appearance], r.variant) : "";
  }

  /** パーツ合成で重ねた一枚と顔ウィンドウの切り出し（作り方の鍵 → blob の URL）。 */
  private readonly composites = new Map<string, Promise<string>>();

  /** 差分の絵の URL。パーツ合成なら層を下から重ねた一枚を作る（同じ組み合わせは作り直さない）。 */
  private spriteUrl(appearance: CastAppearance | undefined, variant: CastVariant): Promise<string> {
    const layers = variantLayers(appearance, variant);
    if (!layers) return Promise.resolve(withCacheKey(this.options.asset("fgimage", variant.image), variant.cacheKey));
    const urls = layers.map((p) => withCacheKey(this.options.asset("fgimage", p), variant.cacheKey));
    return this.cached(urls.join("\n"), () => this.compose(urls));
  }

  /** 作った一枚（合成・切り出し）を覚えておく。多すぎたら古いものから手放す。 */
  private cached(key: string, make: () => Promise<string>): Promise<string> {
    let made = this.composites.get(key);
    if (!made) {
      made = make();
      this.composites.set(key, made);
      while (this.composites.size > COMPOSITE_LIMIT) {
        const [oldKey, old] = this.composites.entries().next().value!;
        this.composites.delete(oldKey);
        void old.then((u) => u.startsWith("blob:") && URL.revokeObjectURL(u));
      }
    }
    return made;
  }

  private async compose(urls: string[]): Promise<string> {
    if (urls.length === 1) return urls[0]!;
    const images = await Promise.all(urls.map((u) => this.image(u)));
    const width = Math.max(1, ...images.map((i) => i.naturalWidth));
    const height = Math.max(1, ...images.map((i) => i.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d");
    if (!g) return urls[0] ?? "";
    for (const img of images) if (img.naturalWidth > 0) g.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? URL.createObjectURL(blob) : (urls[0] ?? "");
  }

  /**
   * 表示中のすべての立ち絵の位置と大きさ。並べ方は状態だけから決まる（sprite-layout.ts）。絵を引けない人物（キャストや差分が無い。
   * 実行時に知らせる）も、人数と自動配置の枠には状態のとおりに数える（制作画面のシーンの情報やセーブと同じ並びにする）。
   */
  private async layoutSprites(stage: StageState): Promise<Map<string, Box>> {
    const inputs: [string, SpriteLayoutInput][] = [];
    for (const [who, sprite] of Object.entries(stage.sprites)) {
      const r = await this.resolveSprite(who, stage);
      if (!r) {
        inputs.push([who, { sprite, variant: { image: "" }, natural: { width: 0, height: 0 } }]);
        continue;
      }
      let natural = this.naturalSizes.get(r.url);
      if (!natural && !r.variant.frame) {
        const img = await this.image(r.url);
        natural = { width: img.naturalWidth, height: img.naturalHeight };
      }
      inputs.push([who, { sprite, variant: r.variant, natural: natural ?? { width: 0, height: 0 } }]);
    }
    return layoutSprites(inputs, this.screen, { rules: this.options.autoLayout, side: castSides(this.options.cast) });
  }

  /**
   * 退場しても動かさない自動配置（autoLayout の exit が keep）で、状態 stage のときに、表示中のほかの立ち絵（except 以外）が動くか。
   * 動かないなら、並べ直し（全員を消して出し直す）をせずに、出入りする人物だけを出し入れする。
   */
  private async keptLayoutMoves(stage: StageState, except: string): Promise<boolean> {
    const boxes = await this.layoutSprites(stage);
    return [...this.spriteEls].some(([name, entry]) => name !== except && boxes.has(name) && !sameBox(entry.box, boxes.get(name)!));
  }

  /**
   * ほかの立ち絵を、並べ方が変わったものだけ新しい位置へ滑らせる（自動配置の並べ直し）。
   * 前に置いた位置と比べるので、作品の演出が直接動かした立ち絵は、並べ方が変わらない限りそのまま。
   * 遊ぶ人に見る間のあった時点でまだ見えていなかった立ち絵は滑らせずに置く（seenSprites）。
   */
  private placeSprites(boxes: Map<string, Box>, ms: number, except?: string, easing = "ease"): Promise<unknown>[] {
    const jobs: Promise<unknown>[] = [];
    for (const [who, entry] of this.spriteEls) {
      const box = boxes.get(who);
      if (who === except || !box || (entry.box && sameBox(entry.box, box))) continue;
      const { el } = entry;
      const from = { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height };
      const to = geometry(box);
      entry.box = box;
      Object.assign(el.style, to);
      // 見る間のあった時点でまだ見えていなかった立ち絵（文も待ちも挟まずにいっしょに出てきたもの）は滑らせず、新しい位置に置く。
      // 最初からその位置に出てきたように見せる（三人目が出て並べ方が変わったときなど）
      if (ms > 0 && this.seenSprites.has(el)) jobs.push(el.animate([from, to], { duration: ms, easing }).finished);
    }
    return jobs;
  }

  /**
   * 遊ぶ人に見る間のあった時点（文を出したとき、クリックを待ち終えたとき、選択肢を選び終えたとき、@wait と終わるまで待った命令を
   * 待ち終えたとき）で見えていた立ち絵の要素（placeSprites が滑らせるのはこれだけ）。
   */
  private seenSprites = new WeakSet<HTMLElement>();

  private markSeenSprites(): void {
    this.seenSprites = new WeakSet([...this.spriteEls.values()].map((entry) => entry.el));
  }

  /** 置いている途中の立ち絵（@chara は絵を読み終えるまで要素ができない）。次の命令が待つのに使う。 */
  private readonly spritesPlacing = new Map<string, Promise<void>>();

  /** 人数変更をまとめ、全員を消してから最新の状態で一緒に出し直す。 */
  private autoReflowJob: Promise<void> | null = null;
  private autoReflowEpoch = 0;
  private autoReflowDirty = false;
  /** 並べ直しが状態を取り込み、出し直しに入ったか（ここから先の変更を取り込むと、全員をもう一度消すことになる）。 */
  private autoReflowShowing = false;
  private autoReflowOut = 300;
  private autoReflowIn = 0;
  private readonly autoReflowEntrances = new Map<string, SpriteMotion>();
  private readonly autoReflowExits = new Map<string, SpriteMotion>();

  private cancelAutoReflow(): void {
    if (!this.autoReflowJob) return;
    this.autoReflowEpoch++;
    this.autoReflowDirty = false;
    this.autoReflowJob = null;
    this.autoReflowEntrances.clear();
    this.autoReflowExits.clear();
    for (const who of this.spriteTokens.keys()) this.nextSpriteToken(who);
  }

  private scheduleAutoReflow(fadeOut: number, fadeIn: number, entrance?: { who: string; motion: SpriteMotion }, exit?: { who: string; motion: SpriteMotion }): Promise<void> {
    this.autoReflowDirty = true;
    this.autoReflowOut = fadeOut;
    this.autoReflowIn = fadeIn;
    if (entrance) this.autoReflowEntrances.set(entrance.who, entrance.motion);
    if (exit) this.autoReflowExits.set(exit.who, exit.motion);
    if (this.autoReflowJob) return this.autoReflowJob;
    const epoch = ++this.autoReflowEpoch;
    const work = async () => {
      while (this.autoReflowDirty && this.autoReflowEpoch === epoch) {
        this.autoReflowDirty = false;
        this.autoReflowShowing = false;
        await Promise.all([...this.spritesPlacing.values()]);
        if (this.autoReflowEpoch !== epoch) return;
        // 要素は残したまま隠す。立ち絵に付いた漫符やプラグインの部品を失わない。
        // 出始めの途中の人物は、その動きを止めて今の濃さから消す（止めないと、消し終えた後に出始めの続きが現れる）。
        // 消す時間は今の濃さに比例させ、まだほとんど見えていない人物を待たない。
        await Promise.all(
          [...this.spriteEls].map(([name, entry]) => {
            const opacity = Number(getComputedStyle(entry.el).opacity);
            for (const animation of entry.el.getAnimations()) animation.cancel();
            entry.el.style.opacity = String(opacity);
            // 消す動きが途中で止められても、並べ直しは続ける
            return this.moveSprite(entry.el, "out", this.autoReflowExits.get(name), Math.round(this.autoReflowOut * opacity)).catch(() => undefined);
          }),
        );
        if (this.autoReflowEpoch !== epoch || !this.stageNow) return;
        // 消えていく間の追加・削除・表情変更は、最新の状態にまとめて反映する。
        const stage = structuredClone(this.stageNow);
        this.autoReflowShowing = true;
        const fade = this.autoReflowIn;
        const entrances = new Map(this.autoReflowEntrances);
        this.autoReflowEntrances.clear();
        this.autoReflowExits.clear();
        this.autoReflowDirty = false;
        await Promise.all([...this.spriteEls.keys()].filter((name) => !(name in stage.sprites)).map((name) => this.hideSprite(name, 0)));
        if (this.autoReflowEpoch !== epoch) return;
        await Promise.all(Object.keys(stage.sprites).map((name) => this.showSprite(name, stage, 0, true, true, undefined, false, false, true)));
        if (this.autoReflowEpoch !== epoch) return;
        // 出す動きが途中で止められても、残りの人物は出し終える
        await Promise.all([...this.spriteEls].map(([name, entry]) => this.moveSprite(entry.el, "in", entrances.get(name), fade).catch(() => undefined)));
      }
    };
    const job = work().finally(() => {
      if (this.autoReflowJob === job) this.autoReflowJob = null;
    });
    this.autoReflowJob = job;
    void job.catch((error) => console.warn("自動配置の更新に失敗しました", error));
    return job;
  }

  private trackSprite(who: string, job: Promise<void>): Promise<void> {
    const settled = job.then(
      () => undefined,
      () => undefined,
    );
    this.spritesPlacing.set(who, settled);
    void settled.then(() => {
      if (this.spritesPlacing.get(who) === settled) this.spritesPlacing.delete(who);
    });
    return job;
  }

  /**
   * 立ち絵を出す・差し替える。出すときはフェードイン。表示中の差し替えは tatie と同じ四通り:
   * 画像も枠（位置と大きさ）も同じなら即座に、画像だけ同じなら半分の時間で消えて枠を替えて残りの時間で現れる、
   * 枠だけ同じなら画像を重ねて切り替える（cross が false なら新しい画像を出し切ってから古い画像を消す）、
   * 両方違えば立ち絵全体の写しを残して重ねて切り替える。after（@chara の swap=after）なら、行き先の立ち位置で、ほかの人物の立ち絵が消えていく途中のときは、
   * 消え終わってから現す（消えかけと出かけの二人が半透明で重ならないように）。まだ出ていない人物は消え終わってから出し、
   * 立っている人物を動かすときは、前の位置から消すのは今から、行き先に現すのは消え終わってから（滑らせるときは消え終わってから滑らせる）。
   */
  private async showSprite(who: string, stage: StageState, fade: number, wait: boolean, cross: boolean, enter?: SpriteMotion, slide = false, after = true, setupHidden = false): Promise<void> {
    const token = this.nextSpriteToken(who);
    const live = () => this.spriteTokens.get(who) === token;
    const r = await this.resolveSprite(who, stage);
    if (!r) return;
    const img = await this.image(r.url);
    const boxes = await this.layoutSprites(stage);
    const box = boxes.get(who);
    if (!box || !live()) return;
    let vacated: Promise<unknown> | undefined;
    const standing = this.spriteEls.get(who);
    if (after && (!standing || !samePlace(standing.box, box))) {
      const leaving = [...this.leavingSprites.values()].filter((l) => l.who !== who && samePlace(l.box, box));
      if (leaving.length > 0) vacated = Promise.all(leaving.map((l) => l.done));
    }
    if (vacated && !standing) {
      await vacated;
      if (!live()) return;
    }
    const flip = stage.sprites[who]?.flip === true;
    // 反転するときの軸（枠の幅に対する割合。cast.json の frame の flipAxis。書かなければ中央）
    const axis = flipAxisRatio(r.variant.frame, img.naturalWidth);
    // 自動配置なら、ほかの立ち絵も並べ直す。
    const moveMs = this.skipping ? 0 : (stage.spriteConfig?.moveTime ?? fade);
    const jobs: Promise<unknown>[] = setupHidden ? [] : this.placeSprites(boxes, moveMs, who, stage.spriteConfig?.easing);

    const existing = this.spriteEls.get(who);
    if (!existing) {
      const el = document.createElement("div");
      el.className = "sprite";
      // 作品固有の演出（立ち絵の移動・揺らし）が立ち絵を探すための目印。
      el.dataset.who = who;
      el.style.opacity = "0";
      el.append(img);
      const entry: SpriteElement = { el, image: r.url, box };
      watchPartCanvases(entry);
      this.attachPart(who, entry, r.variant, r.at);
      applyFrame(entry, box, flip, axis);
      applyZ(el, stage.sprites[who]?.z);
      this.sprites.append(el);
      this.spriteEls.set(who, entry);
      this.applyFocus(false);
      void this.applyTones(stage, 0, who);
      this.applyDofSprite(who, el, stage);
      if (!setupHidden) jobs.push(this.moveSprite(el, "in", enter, fade));
    } else {
      applyZ(existing.el, stage.sprites[who]?.z);
      if (setupHidden) {
        // 隠れている間に枠と差分を更新する。直下の画像以外の部品は維持する。
        this.sprites.querySelectorAll(`[data-snapshot="${CSS.escape(who)}"]`).forEach((n) => n.remove());
        endDissolve(existing.el);
        const images = [...existing.el.querySelectorAll<HTMLImageElement>(":scope > img")];
        images.slice(0, -1).forEach((image) => image.remove());
        const base = images.at(-1);
        if (base) {
          for (const animation of base.getAnimations()) animation.finish();
          base.style.opacity = "1";
          base.src = r.url;
        }
        existing.image = r.url;
        applyFrame(existing, box, flip, axis);
        existing.el.style.opacity = "0";
      } else jobs.push(this.changeSprite(who, existing, r.url, box, flip, axis, fade, cross, live, slide, vacated));
      this.attachPart(who, existing, r.variant, r.at);
    }
    if (wait || setupHidden) await Promise.all(jobs);
  }

  /** vacated は行き先が空くまでの待ち（showSprite の after）。行き先に現すのは、それを待ってから。 */
  private async changeSprite(who: string, entry: SpriteElement, url: string, box: Box, flip: boolean, axis: number, ms: number, cross: boolean, live: () => boolean, slide = false, vacated?: Promise<unknown>): Promise<void> {
    const { el } = entry;
    // 前の切り替えの途中なら、終わった姿にしてから始める。
    for (const a of el.getAnimations({ subtree: true })) a.finish();
    this.sprites.querySelectorAll(`[data-snapshot="${CSS.escape(who)}"]`).forEach((n) => n.remove());
    endDissolve(el);
    // 立ち絵の画像は直下の img（口パク・まばたきの重ね画像は .sprite-face の中）
    const images = [...el.querySelectorAll<HTMLImageElement>(":scope > img")];
    images.slice(0, -1).forEach((i) => i.remove());
    el.style.opacity = "1";
    const base = images.at(-1)!;
    base.style.opacity = "1";

    const sameImage = entry.image === url;
    const current = { x: parseFloat(el.style.left), y: parseFloat(el.style.top), width: parseFloat(el.style.width), height: parseFloat(el.style.height) };
    const sameFrame = sameBox(current, box);
    // 切り替えが完了する前に別の人物が出ても、行き先を古い配置と誤認して滑らせない。
    entry.box = box;
    const swap = () => {
      base.src = url;
      entry.image = url;
    };

    /** 行き先が空くまで待つ。待つ間に次の切り替えが始まったら false。 */
    const vacant = async () => {
      if (!vacated) return true;
      await vacated;
      return live();
    };
    if (ms === 0 || (sameImage && sameFrame)) {
      if (!sameFrame && !(await vacant())) return;
      applyFrame(entry, box, flip, axis);
      swap();
      return;
    }
    if (slide && !sameFrame) {
      // 立ち位置が変わるなら、消さずに新しい枠へ滑らせる（画像が違えば、滑らせながら重ねて切り替える）
      if (!(await vacant())) return;
      const from = geometry(current);
      applyFrame(entry, box, flip, axis);
      const moving = el.animate([from, geometry(box)], { duration: ms, easing: "ease" }).finished.then(() => undefined, () => undefined);
      if (sameImage) return moving;
      const next = base.cloneNode() as HTMLImageElement;
      next.src = url;
      next.style.opacity = "0";
      base.after(next);
      entry.image = url;
      await Promise.all([moving, this.fade(base, 0, ms), this.fade(next, 1, ms)]);
      if (live()) base.remove();
      return;
    }
    if (sameImage) {
      const first = Math.floor(ms / 2);
      await this.fade(el, 0, first);
      if (!live() || !(await vacant())) return;
      applyFrame(entry, box, flip, axis);
      swap();
      await this.fade(el, 1, ms - first);
      return;
    }
    if (sameFrame) {
      applyFrame(entry, box, flip, axis);
      const next = base.cloneNode() as HTMLImageElement;
      next.src = url;
      next.style.opacity = "0";
      base.after(next);
      entry.image = url;
      if (cross) {
        // 半透明の二枚を重ねると途中で背景が透けるので、足し合わせて（plus-lighter）重なりを不透明に保つ。
        if (PLUS_LIGHTER) {
          el.style.isolation = "isolate";
          base.style.mixBlendMode = next.style.mixBlendMode = "plus-lighter";
        }
        const dissolve = Math.max(1, Math.round(ms * (this.options.extensions?.sprites?.expressionDissolveScale ?? 1)));
        await Promise.all([this.fade(base, 0, dissolve), this.fade(next, 1, dissolve)]);
        next.style.mixBlendMode = "";
        if (live()) el.style.isolation = "";
      } else {
        await this.fade(next, 1, ms);
        if (!live()) return;
        await this.fade(base, 0, ms);
      }
      if (live()) base.remove();
      return;
    }
    const snapshot = el.cloneNode(true) as HTMLElement;
    delete snapshot.dataset.who;
    snapshot.dataset.snapshot = who;
    snapshot.style.pointerEvents = "none";
    el.after(snapshot);
    if (PLUS_LIGHTER) {
      // 枠が違う二つを、一つの切り離した層の中で足し合わせる。
      const group = document.createElement("div");
      group.dataset.dissolve = who;
      Object.assign(group.style, { position: "absolute", inset: "0", isolation: "isolate", zIndex: el.style.zIndex, pointerEvents: "none" });
      el.before(group);
      group.append(snapshot, el);
      snapshot.style.mixBlendMode = el.style.mixBlendMode = "plus-lighter";
    }
    applyFrame(entry, box, flip, axis);
    swap();
    el.style.opacity = "0";
    void this.fade(snapshot, 0, ms).then(() => snapshot.remove());
    if (!(await vacant())) return;
    await this.fade(el, 1, ms);
    if (live()) endDissolve(el);
  }

  /**
   * キャストを差し替え、表示中の立ち絵を状態から描き直す（演出なし。ページは進めない）。
   * 開発時、立ち絵の位置調整画面で cast.json を保存したときに使う。stage が無ければ（タイトル画面など）差し替えるだけ。
   */
  /** 今のキャストの定義（開発中に replaceCast で替わる）。 */
  get cast(): Cast {
    return this.options.cast;
  }

  /** 自動配置の並べ方を差し替え（開発中に liminalia.json の autoLayout を書き換えた）、表示中の立ち絵を新しい並べ方の位置に置き直す。 */
  async replaceAutoLayout(rules: AutoLayoutRules | undefined, stage: StageState | null): Promise<void> {
    if (JSON.stringify(rules ?? null) === JSON.stringify(this.options.autoLayout ?? null)) return;
    if (rules) this.options.autoLayout = rules;
    else delete this.options.autoLayout;
    if (!stage) return;
    for (const who of Object.keys(stage.sprites)) await this.showSprite(who, stage, 0, true, false);
  }

  async replaceCast(cast: Cast, stage: StageState | null): Promise<void> {
    this.options.cast = cast;
    if (!stage) return;
    for (const who of Object.keys(stage.sprites)) await this.showSprite(who, stage, 0, true, false);
  }

  private nextSpriteToken(who: string): number {
    const token = (this.spriteTokens.get(who) ?? 0) + 1;
    this.spriteTokens.set(who, token);
    return token;
  }

  /** 消えていく途中の立ち絵（要素 → 人物、最後の位置と大きさ、消え終わり）。同じ位置に入る人物を待たせる（showSprite の after）。 */
  private readonly leavingSprites = new Map<HTMLElement, { who: string; box: Box; done: Promise<void> }>();

  private async hideSprite(who: string, fade: number, exit?: SpriteMotion): Promise<void> {
    this.nextSpriteToken(who);
    this.sprites.querySelectorAll(`[data-snapshot="${CSS.escape(who)}"]`).forEach((n) => n.remove());
    const s = this.spriteEls.get(who);
    if (!s) return;
    this.spriteEls.delete(who);
    // 消えていく間も口パク・まばたきは止める（部品は要素と一緒に消える）
    const part = s.part?.part;
    delete s.part;
    endDissolve(s.el);
    const moving = this.moveSprite(s.el, "out", exit, fade);
    if (fade > 0) {
      const done = moving.then(
        () => undefined,
        () => undefined,
      );
      this.leavingSprites.set(s.el, { who, box: s.box, done });
      void done.then(() => this.leavingSprites.delete(s.el));
    }
    await moving;
    s.el.remove();
    s.watch?.disconnect();
    part?.dispose();
  }

  /**
   * 立ち絵を出す（in）・消す（out）。不透明度を変えながら、motion の向きへ滑らせるか（left・right・top・bottom）、大きさを変える（zoom）。
   */
  private moveSprite(el: HTMLElement, way: "in" | "out", motion: SpriteMotion | undefined, ms: number): Promise<void> {
    const kind = motion?.kind ?? "fade";
    if (kind === "fade" || ms === 0) return this.fade(el, way === "in" ? 1 : 0, ms);
    const d = motion?.distance ?? 160;
    const away = kind === "zoom" ? { scale: "0.8" } : { translate: kind === "left" ? `${-d}px 0` : kind === "right" ? `${d}px 0` : kind === "top" ? `0 ${-d}px` : `0 ${d}px` };
    const still = kind === "zoom" ? { scale: "1" } : { translate: "0 0" };
    const from = getComputedStyle(el).opacity;
    el.style.opacity = way === "in" ? "1" : "0";
    const frames = way === "in" ? [{ opacity: from, ...away }, { opacity: "1", ...still }] : [{ opacity: from, ...still }, { opacity: "0", ...away }];
    return el.animate(frames, { duration: ms, easing: way === "in" ? "ease-out" : "ease-in" }).finished.then(() => undefined);
  }

  // ---- 立ち絵に重ねる部品（口パク・まばたき・プラグインの立ち絵） ----

  /** 差分に合わせて部品を付ける・差し替える。同じ種類の部品なら update で差分だけ替える。 */
  private attachPart(who: string, entry: SpriteElement, own: CastVariant, at: SpritePartVariant): void {
    // 人物ごとの model（cast.json の人物の項目）は、model を書いていない差分すべてに効く。差分の model が同じ type なら、
    // 人物の model に差分の項目を重ねる（Live2D のモデルは人物に書き、差分には表情だけを書く、など）
    const shared = this.options.cast[who]?.model;
    const model = own.model && shared && own.model.type === shared.type ? { ...shared, ...own.model } : (own.model ?? shared);
    const variant = model && model !== own.model ? { ...own, model } : own;
    const key = model ? `model:${model.type}` : hasFace(variant) ? "face" : "";
    if (entry.part && entry.part.key === key) {
      entry.part.part.update(variant, at);
      return;
    }
    entry.part?.part.dispose();
    delete entry.part;
    entry.el.classList.remove("sprite-covered");
    if (key === "") return;
    let factory: SpritePartFactory | undefined = model
      ? (this.options.extensions?.spriteParts?.[model.type] ?? BUILTIN_SPRITE_PARTS[model.type as keyof typeof BUILTIN_SPRITE_PARTS])
      : createFace;
    if (!factory) {
      console.warn(`立ち絵のモデル ${model!.type} が登録されていません（プラグインの extensions.spriteParts）。画像で表示します: ${who}`);
      if (!hasFace(variant)) return;
      factory = createFace;
    }
    const part = factory({
      who,
      variant,
      ...at,
      el: entry.el,
      asset: (kind, path) => this.options.asset(kind, path),
      skipping: () => this.skipping,
      holdShot: () => this.holdShot(),
    });
    entry.part = { part, key };
    entry.el.classList.toggle("sprite-covered", part.coversImage === true);
    // 枠と反転を当てたあとに部品を作ることがある（表示中に同じ枠のまま差分の部品が替わるとき）。部品のキャンバスにも今の反転を当てる
    flipPartCanvases(entry);
    this.startPartLoop();
  }

  private partFrame = 0;

  /** 部品のある立ち絵がある間、毎フレーム口の開き具合を渡す。 */
  private startPartLoop(): void {
    if (this.partFrame) return;
    const loop = (now: number) => {
      const level = this.audio.voiceLevel();
      let any = false;
      for (const [who, entry] of this.spriteEls) {
        const part = entry.part?.part;
        if (!part) continue;
        any = true;
        part.tick?.(now, this.mouth(who, now, level));
      }
      this.partFrame = any ? requestAnimationFrame(loop) : 0;
    };
    this.partFrame = requestAnimationFrame(loop);
  }

  /** 今の舞台の状態（命令とロードのたびに描画側に渡されるもの）。ページの見せ方（目立たせる・吹き出し・文字の音）に使う。 */
  private stageNow: StageState | null = null;
  /** 前のページの話者（話し始めたときだけ跳ねさせる）。 */
  private focusedSpeaker: string | null = null;

  /** その話者のキャスト（キャスト名か speaker が話者と同じもの）。 */
  private speakingCast(speaker: string | null): Set<string> {
    const out = new Set<string>();
    if (!speaker) return out;
    for (const who of this.spriteEls.keys()) if ((this.options.cast[who]?.speaker ?? who) === speaker) out.add(who);
    return out;
  }

  /**
   * 話している人物を目立たせる（@chara-config focus・jump）。話していない人物を暗く・ぼかし、page なら話し始めた人物を跳ねさせる。
   * 地の文のときと、話者の立ち絵が出ていないときは、誰も変えない。
   */
  /** 奥行きのある背景の絵（@plane）。名前 → 要素と奥行き。 */
  private readonly planeEls = new Map<string, { el: HTMLImageElement; image: string; depth: number; front: boolean }>();

  /** 奥行きの絵を状態に合わせる（無くなったものは消し、新しいものは出し、奥のものほど後ろに重ねる）。 */
  private async syncPlanes(stage: StageState, ms: number): Promise<void> {
    const want = stage.planes ?? {};
    const jobs: Promise<unknown>[] = [];
    for (const [name, p] of [...this.planeEls]) {
      const w = want[name];
      if (w && w.image === p.image && (w.front === true) === p.front) {
        p.depth = w.depth;
        continue;
      }
      this.planeEls.delete(name);
      jobs.push(this.fade(p.el, 0, ms).then(() => p.el.remove()));
    }
    for (const [name, w] of Object.entries(want)) {
      if (this.planeEls.has(name)) continue;
      const el = await this.image(this.options.asset("bgimage", w.image));
      el.className = "plane";
      el.dataset.plane = name;
      el.style.opacity = "0";
      this.planeEls.set(name, { el, image: w.image, depth: w.depth, front: w.front === true });
      jobs.push(this.fade(el, 1, ms));
    }
    // 奥のもの（depth が大きい）ほど後ろ。奥の絵は背景の絵より前、手前の絵は前景の画像の層のいちばん後ろから
    for (const front of [false, true]) {
      const list = [...this.planeEls.values()].filter((p) => p.front === front).sort((a, b) => b.depth - a.depth);
      const parent = front ? this.images : this.background;
      if (front) parent.prepend(...list.map((p) => p.el));
      else parent.append(...list.map((p) => p.el));
    }
    for (const a of this.camera.getAnimations()) a.finish();
    this.placePlanes(stage.camera);
    await Promise.all(jobs);
  }

  /** 奥行きの絵を、今のカメラ（状態の値）に合わせて置く。 */
  private placePlanes(camera: CameraParams): void {
    for (const p of this.planeEls.values()) p.el.style.transform = planeTransform(camera, p.depth);
  }

  /**
   * 被写界深度（@dof）。ピントの合っていないレイヤー（と、人物に合わせたときのほかの立ち絵）をぼかす。
   * レイヤーは --dof-layer、立ち絵は --dof-sprite に置き、CSS の filter の移り変わりで ms かけて変える。
   * fade が 0 なら即座に切り替える。立ち絵の filter は普段 200ms で移るので、その時間のまま戻すと
   * WebKit は none への移り変わりをやり直して、計算値が途中（blur の数 px）で止まって戻ったように見えない。
   * 時間を 0 にしてからレイアウトを読み、終わった値に確定させてから普段の時間に戻す。
   */
  private async applyDof(stage: StageState, ms: number): Promise<void> {
    const dof = stage.dof;
    const blur = (px: number) => (dof && px > 0 ? `blur(${px}px)` : "");
    const layers: [HTMLElement, number][] = [
      [this.background, dof && dof.on !== "background" ? dof.blur : 0],
      [this.sprites, dof?.on === "background" ? dof.blur : 0],
      [this.images, dof ? dof.blur : 0],
    ];
    this.camera.style.setProperty("--dof-time", `${ms}ms`);
    this.sprites.style.setProperty("--sprite-filter-time", `${ms}ms`);
    for (const [el, px] of layers) el.style.setProperty("--dof-layer", blur(px));
    for (const [who, entry] of this.spriteEls) this.applyDofSprite(who, entry.el, stage);
    // ぼかしの変化は CSS の transition（早送りで終わりまで進む）。待ちも早送りで終わる
    if (ms > 0) await this.delay(ms);
    this.camera.style.setProperty("--dof-time", "0ms");
    this.sprites.style.setProperty("--sprite-filter-time", "0ms");
    void this.sprites.offsetWidth;
    this.camera.style.removeProperty("--dof-time");
    this.sprites.style.removeProperty("--sprite-filter-time");
  }

  /** 人物に合わせた被写界深度で、ほかの立ち絵を半分の強さでぼかす。 */
  private applyDofSprite(who: string, el: HTMLElement, stage: StageState): void {
    const dof = stage.dof;
    if (dof?.on === "chara" && dof.who !== who && dof.blur > 0) el.style.setProperty("--dof-sprite", `blur(${dof.blur / 2}px)`);
    else el.style.removeProperty("--dof-sprite");
  }

  /** 立ち絵ごとの色調の行列（今かけているもの）と、その SVG のフィルタ。 */
  private readonly tones = new Map<string, { matrix: number[]; node: SVGFEColorMatrixElement; id: string; frame: number }>();
  private toneDefs: SVGSVGElement | null = null;

  /** 今の立ち絵に合わせた背景の色調（applyTones がすべての立ち絵に当てたもの）。 */
  private backgroundToneNow: string | null = null;

  /** 背景が立ち絵に掛ける色調の名前（@bg の tone= → ui.backgroundTones）。 */
  private backgroundTone(stage: StageState): string | null {
    return backgroundToneName(stage.background, stage.backgroundTone, this.ui?.backgroundTones);
  }

  /** 背景の色調が替わっていたら、立ち絵の色調を ms かけて合わせる。 */
  private followBackgroundTone(stage: StageState, ms: number): void {
    if (this.backgroundTone(stage) !== this.backgroundToneNow) void this.applyTones(stage, ms);
  }

  /** 立ち絵の色調（@tone と背景の色調）を状態に合わせる。only を書けばその人物だけ。 */
  private async applyTones(stage: StageState, ms: number, only?: string): Promise<void> {
    const jobs: Promise<void>[] = [];
    const background = this.backgroundTone(stage);
    if (only === undefined) this.backgroundToneNow = background;
    for (const [who, entry] of this.spriteEls) {
      if (only !== undefined && who !== only) continue;
      const name = spriteToneName(stage.tones, who, background);
      const tone = findTone(name, this.ui?.tones);
      if (tone === undefined) console.warn(`色調がありません: ${name}`);
      jobs.push(this.toneTo(who, entry.el, toneMatrix(tone), ms));
    }
    // 消えた立ち絵のフィルタを片付ける
    for (const [who, t] of this.tones) {
      if (this.spriteEls.has(who)) continue;
      cancelAnimationFrame(t.frame);
      t.node.parentElement?.remove();
      this.tones.delete(who);
    }
    await Promise.all(jobs);
  }

  private toneTo(who: string, el: HTMLElement, target: number[], ms: number): Promise<void> {
    const identity = target.every((v, i) => Math.abs(v - IDENTITY_MATRIX[i]!) < 1e-6);
    let t = this.tones.get(who);
    if (!t) {
      if (identity) {
        el.style.removeProperty("--tone-filter");
        return Promise.resolve();
      }
      this.toneDefs ??= document.createElementNS("http://www.w3.org/2000/svg", "svg");
      if (!this.toneDefs.isConnected) {
        this.toneDefs.setAttribute("aria-hidden", "true");
        Object.assign(this.toneDefs.style, { position: "absolute", width: "0", height: "0", overflow: "hidden" });
        this.stage.append(this.toneDefs);
      }
      const id = `lm-tone-${++toneSerial}`;
      const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
      filter.id = id;
      filter.setAttribute("color-interpolation-filters", "sRGB");
      const node = document.createElementNS("http://www.w3.org/2000/svg", "feColorMatrix");
      node.setAttribute("type", "matrix");
      filter.append(node);
      this.toneDefs.append(filter);
      t = { matrix: [...IDENTITY_MATRIX], node, id, frame: 0 };
      this.tones.set(who, t);
    }
    const entry = t;
    cancelAnimationFrame(entry.frame);
    el.style.setProperty("--tone-filter", `url(#${entry.id})`);
    const set = (m: number[]) => {
      entry.matrix = m;
      entry.node.setAttribute("values", m.map((v) => v.toFixed(4)).join(" "));
    };
    const finish = () => {
      set(target);
      if (identity) el.style.removeProperty("--tone-filter");
    };
    if (ms <= 0) {
      finish();
      return Promise.resolve();
    }
    const from = entry.matrix;
    const start = performance.now();
    let skipped = false;
    const off = this.fastForwardHook()(() => (skipped = true));
    return new Promise((resolve) => {
      const step = (now: number) => {
        const k = skipped ? 1 : Math.min(1, (now - start) / ms);
        if (k >= 1) {
          off();
          finish();
          return resolve();
        }
        set(mixMatrix(from, target, k));
        entry.frame = requestAnimationFrame(step);
      };
      entry.frame = requestAnimationFrame(step);
    });
  }

  /**
   * ページをクリックで送ってから最初の命令で、前のページの名前と本文を消す（TyranoScript の [p] の改ページと同じ。枠は残す）。
   * 話者強調と顔ウィンドウは次のページまでそのまま（表情を替えるだけの命令で、強調が外れて戻ることがないように）。
   * ui.message.keepText が true か、@bg の keep-text=true なら消さない（次のページまで残す前の版の動き）。NVL とチャットの画面では何もしない。
   */
  private clearAfterPage(name: string, args: Record<string, Value>): void {
    if (this.ui?.message?.keepText === true || (name === "bg" && args["keep-text"] === true)) return;
    if (this.inDialogue || this.message.classList.contains("nvl")) return;
    this.setName("");
    this.clearText();
    this.placeBalloon();
  }

  /**
   * wait=true の @chara で、まだ出ていない人物が出るのを待つ間、前のページの話者の名前と本文を消す（前の話者の名前のまま
   * 次の人物が見えて、ずれて見えないように）。地の文と、出る人物自身の台詞は残す。NVL とチャットの画面では何もしない。
   * ui.chara.keepText が true なら残す（前の版の動き）。
   */
  private clearForEntrance(who: string): void {
    const speaker = this.speaker;
    if (this.ui?.chara?.keepText === true || speaker === null || this.inDialogue || this.message.classList.contains("nvl")) return;
    if ((this.options.cast[who]?.speaker ?? who) === speaker) return;
    this.speaker = null;
    this.setName("");
    this.clearText();
    this.applyFocus(false);
    this.placeBalloon();
    void this.updateFace();
  }

  private applyFocus(page: boolean): void {
    // 書いた項目は @chara-config、書いていない項目は作品の設定（ui.chara）
    const c = this.stageNow?.spriteConfig;
    const base = this.ui?.chara;
    const speaking = this.speakingCast(this.speaker);
    // 同時に話しているほかの話者も目立たせる
    for (const w of this.coSpeakers) for (const x of this.spriteEls.has(w) ? [w] : this.speakingCast(w)) speaking.add(x);
    const focus = c?.focus ?? base?.focus ?? "none";
    const dim = c?.dim ?? base?.dim ?? 0.6;
    const lower = c?.lower ?? base?.lower ?? 12;
    for (const [who, entry] of this.spriteEls) {
      const off = focus !== "none" && speaking.size > 0 && !speaking.has(who);
      const parts: string[] = [];
      if (off && (focus === "dim" || focus === "dim-blur" || focus === "dim-lower")) parts.push(`brightness(${dim})`);
      if (off && (focus === "blur" || focus === "dim-blur")) parts.push("blur(2px)");
      entry.el.style.setProperty("--focus-filter", parts.join(" "));
      // 下げるのは上の余白で（位置の top、出入りの translate、@kanim の transform とぶつからない）
      if (off && (focus === "lower" || focus === "dim-lower") && lower > 0) entry.el.style.setProperty("--focus-lower", `${lower}px`);
      else entry.el.style.removeProperty("--focus-lower");
    }
    if (page && (c?.jump ?? base?.jump) && this.speaker !== this.focusedSpeaker && !this.skipping) {
      for (const who of speaking) {
        this.spriteEls.get(who)?.el.animate([{ translate: "0 0" }, { translate: "0 -16px", offset: 0.4 }, { translate: "0 0" }], { duration: 320, easing: "ease-out" });
      }
    }
    if (page) this.focusedSpeaker = this.speaker;
  }

  /**
   * 吹き出し（@balloon on）: 話者の立ち絵が出ていれば、メッセージ枠をその立ち絵の頭の上に吹き出しとして置く。
   * 出ていない台詞は、置く位置（x・y）が決めてあればそこへ、無ければ（地の文も）いつものメッセージ枠に戻す。
   * 尾の位置（tail-x）・出さない（tail=none）を決めてあれば、それを使う。尾の向き（tail=up・down）は立ち絵の無い吹き出しのもの
   * （立ち絵があれば、頭の上なら下・あごの下なら上へ向ける）。
   */
  private placeBalloon(): void {
    const balloon = this.stageNow?.balloon;
    const nvl = this.message.classList.contains("nvl");
    const who = balloon && !nvl ? [...this.speakingCast(this.speaker)][0] : undefined;
    const box = who ? this.spriteEls.get(who)?.box : undefined;
    const fixed = balloon && !nvl && !box && this.speaker !== null && balloon.x !== undefined && balloon.y !== undefined;
    const m = this.message;
    if (!balloon || (!box && !fixed)) {
      if (m.classList.contains("balloon")) {
        m.classList.remove("balloon", "balloon-below", "balloon-no-tail");
        m.style.removeProperty("--balloon-tail");
        // 位置はゲームの設定（ui.message）か CSS の既定に戻す
        this.setUi(this.baseUi);
      }
      return;
    }
    m.classList.toggle("balloon-no-tail", balloon.tail === "none");
    // 枠は文字と枠の座標（uiSpace）で置き、話者の立ち絵は舞台の座標なので直す
    const scale = uiScale(this.screen);
    const { width: STAGE_W, height: STAGE_H } = uiSpace(this.screen);
    const tailAt = (width: number, auto: number) => `${Math.round(Math.max(24, Math.min(width - 24, balloon.tailX ?? auto)))}px`;
    if (!box) {
      // 立ち絵の無い台詞（画面の外の声など）: 決めた位置に置く。尾は下（up なら上）
      const width = Math.min(STAGE_W - 32, balloon.width ?? 520);
      m.classList.add("balloon");
      m.classList.toggle("balloon-below", balloon.tail === "up");
      Object.assign(m.style, { left: `${balloon.x}px`, right: "auto", top: `${balloon.y}px`, bottom: "auto", width: `${width}px`, height: "auto", minHeight: "0" });
      m.style.setProperty("--balloon-tail", tailAt(width, width / 2));
      return;
    }
    const center = (box.x + box.width / 2) / scale;
    // 頭のてっぺんのあたり（枠の上から 6%）。上に二行ほどの吹き出しを置く余地があれば頭の上、無ければ空いている側の横に置く
    const head = (box.y + box.height * 0.06) / scale;
    const ABOVE = 150;
    m.classList.add("balloon");
    m.classList.remove("balloon-below");
    if (head - 16 >= ABOVE) {
      const width = Math.min(STAGE_W - 32, balloon.width ?? 520);
      const left = Math.round(Math.max(16, Math.min(STAGE_W - width - 16, center - width / 2)));
      Object.assign(m.style, { left: `${left}px`, right: "auto", top: "auto", bottom: `${Math.round(STAGE_H - (head - 16))}px`, width: `${width}px`, height: "auto", minHeight: "0" });
      m.classList.remove("balloon-below");
      m.style.setProperty("--balloon-tail", tailAt(width, center - left));
      return;
    }
    // 頭の上に余地が無ければ、あごの下（枠の上から 42%）に置いて尾を上へ向ける（ほかの人物の顔をふさがない）
    const width = Math.min(STAGE_W - 32, balloon.width ?? 520);
    const left = Math.round(Math.max(16, Math.min(STAGE_W - width - 16, center - width / 2)));
    const top = Math.round(Math.max(16, Math.min(STAGE_H - 180, (box.y + box.height * 0.42) / scale)));
    m.classList.add("balloon-below");
    Object.assign(m.style, { left: `${left}px`, right: "auto", top: `${top}px`, bottom: "auto", width: `${width}px`, height: "auto", minHeight: "0" });
    m.style.setProperty("--balloon-tail", tailAt(width, center - left));
  }

  /** 文字を出すときの音（@text-sound）を、文字を出している間 every 文字ごとに鳴らす。止める関数を返す。 */
  private textSound(chars: number, perChar: number): () => void {
    const sounds = this.stageNow?.textSound;
    const s = sounds ? ((this.speaker !== null ? sounds[this.speaker] : undefined) ?? sounds[""]) : undefined;
    if (!s || this.skipping || perChar <= 0) return () => undefined;
    let left = Math.ceil(chars / s.every);
    const play = () => {
      if (left-- <= 0 || this.skipping) return stop();
      this.audio.playBlip(s.file, s.volume);
    };
    const timer = setInterval(play, perChar * s.every);
    const stop = () => clearInterval(timer);
    play();
    return stop;
  }

  /** 話者のキャストの定義（キャスト名か speaker が話者と同じもの）。無ければ undefined。 */
  private speakerEntry(speaker: string | null): CastEntry | undefined {
    if (!speaker) return undefined;
    const who = castForSpeaker(this.options.cast, speaker);
    return who ? this.options.cast[who] : undefined;
  }

  /**
   * 今のページの話者の見た目を当てる（cast.json の text・nameImage・windowImage）。本文の文字は今のページの本文の入れ物に CSS 変数で載せ
   * （既読の色 ui.text.readColor と、遊ぶ人が選んだ書体が先）、名前の欄の画像と枠の画像は話者が替わるたびに入れ替える。
   */
  private applySpeakerLook(speaker: string | null): void {
    const entry = this.speakerEntry(speaker);
    applySpeakerText(this.textTarget, entry?.text);
    if (entry?.nameImage) this.nameEl.style.setProperty("--name-image", cssUrl(this.options.asset("image", entry.nameImage)));
    else this.nameEl.style.removeProperty("--name-image");
    this.speakerWindowImage = entry?.windowImage ?? null;
    if (this.stageNow) this.applyWindowImage(this.stageNow);
  }

  /** 今の話者の枠の画像（cast.json の windowImage）。@window-image が先。 */
  private speakerWindowImage: string | null = null;

  /** 話者の台詞の文字の見た目（cast.json の text。履歴の画面が本文に当てる）。無ければ undefined。 */
  speakerText(speaker: string): CastEntry["text"] {
    return this.speakerEntry(speaker)?.text;
  }

  /** 話者の名前の色（cast.json のキャストの color。キャスト名か speaker が話者と同じもの）。無ければ ""（システム画面の色）。 */
  /** 名前欄に出している話者（作品の名前欄 WebPlugin.screens.name に渡す）。 */
  private nameShown: NameShown = { speaker: null, label: "", color: "" };
  private readonly nameListeners = new Set<(name: NameShown) => void>();
  /** 作品の名前欄の要素（まだ作っていなければ undefined、差し替えていなければ null）。 */
  private nameCustom: HTMLElement | null | undefined = undefined;

  /** 名前欄に名前を出す（空なら隠す）。作品が名前欄を差し替えていれば、その受け手に知らせる。 */
  private setName(label: string, speaker: string | null = null): void {
    const color = speaker && label ? this.nameColor(speaker) : "";
    this.nameShown = { speaker: label ? speaker : null, label, color };
    if (this.nameCustom === undefined) {
      const build = this.screens.name;
      this.nameCustom = null;
      if (build) {
        const host = this;
        const el = build({
          get current() {
            return host.nameShown;
          },
          onChange: (listener) => {
            this.nameListeners.add(listener);
            return () => this.nameListeners.delete(listener);
          },
        });
        this.nameEl.replaceChildren(el);
        this.nameEl.classList.add("lm-name-custom");
        this.nameCustom = el;
      }
    }
    if (this.nameCustom) {
      this.nameEl.classList.toggle("is-empty", label === "");
      for (const listener of this.nameListeners) listener(this.nameShown);
      return;
    }
    this.nameEl.textContent = label;
    this.nameEl.style.color = color;
  }

  nameColor(speaker: string): string {
    const cast = this.options.cast;
    const entry = cast[speaker]?.speaker === undefined || cast[speaker]?.speaker === speaker ? cast[speaker] : undefined;
    return (entry ?? Object.values(cast).find((c) => c.speaker === speaker))?.color ?? "";
  }

  /**
   * その人物の口の開き（0〜1）。その人物のボイスが鳴っていれば音の大きさ、ボイスが鳴っておらず
   * その人物のページの文字を出している最中なら、文字に合わせて開け閉めする。
   */
  private mouth(who: string, now: number, _level: number): number {
    const name = this.options.cast[who]?.speaker ?? who;
    // 鳴っているボイスごとに、その話者の口を動かす（二人が同時に話すときは二人とも）
    const voice = this.audio.speakerLevel([name, who]);
    if (voice !== undefined) return voice;
    if ((this.speaker === name || this.coSpeakers.includes(name) || this.coSpeakers.includes(who)) && this.revealing.size > 0 && !this.skipping) return (Math.sin(now / 55) + 1) / 2;
    return 0;
  }

  private shake(time: number, count: number, h: number, v: number, target: HTMLElement): Promise<void> {
    if (time === 0 || this.reduceShake) return Promise.resolve();
    const frames: Keyframe[] = [{ transform: "translate(0, 0)" }];
    for (let i = 0; i < count; i++) {
      const sx = (i % 2 === 0 ? 1 : -1) * h;
      const sy = (i % 2 === 0 ? -1 : 1) * v;
      frames.push({ transform: `translate(${sx}px, ${sy}px)` });
    }
    frames.push({ transform: "translate(0, 0)" });
    return target.animate(frames, { duration: time }).finished.then(() => undefined);
  }

  /** ルールの濃さ（ルール画像か組み込みの型）。 */
  private async ruleLevels(el: HTMLElement, rule: RuleArgs): Promise<RuleLevels> {
    if (rule.image) return ruleFromImage(el, await this.image(this.options.asset("image", rule.image)));
    return ruleFromPattern(el, rule.pattern ?? "wipe-right");
  }

  /**
   * 覆いを出す・外す。ルールがあればルールで、crossfade と fadeIn は不透明度だけ、それ以外は @bg の method と同じ動き。
   * 覆いきったら常駐の表示の層（hud）を隠し、外し始めたら戻す（覆いの下で一緒に暗くなり、明るくなる）。
   */
  private async moveMask(mode: "show" | "hide", method: string, ms: number, rule: RuleArgs | null = null): Promise<void> {
    if (mode === "hide") this.setMasked(false);
    await this.runMask(mode, method, ms, rule);
    if (mode === "show") this.setMasked(true);
  }

  private async runMask(mode: "show" | "hide", method: string, ms: number, rule: RuleArgs | null): Promise<void> {
    if (rule && ms > 0) {
      const fastForward = this.fastForwardHook();
      return ruleTransition(this.mask, await this.ruleLevels(this.mask, rule), ms, mode, rule.vague, fastForward);
    }
    if (method === "crossfade" || method === "fadeIn" || ms === 0) return this.fade(this.mask, mode === "show" ? 1 : 0, ms);
    this.mask.style.opacity = mode === "show" ? "1" : "0";
    return this.mask.animate(transitionKeyframes(method, mode), { duration: ms, easing: "ease" }).finished.then(() => undefined);
  }

  /** 暗転しきっているか（舞台の class の lm-masked。常駐の表示の層を隠す）。 */
  private setMasked(on: boolean): void {
    this.stage.classList.toggle("lm-masked", on);
  }

  /** 覆いが出きっているか（出している途中と外している途中は false）。 */
  private maskCovering(): boolean {
    return this.stage.classList.contains("lm-masked") && this.mask.getAnimations().length === 0 && getComputedStyle(this.mask).opacity === "1";
  }

  /**
   * 実際に当てるカメラ。縦長の舞台は幅が狭く、横長と同じ移動量では背景の端が見えてしまうので、背景が画面を覆う範囲に収める。
   * 画面より大きい背景（@bg-place）は動かす先があるので収めない。横長の作品は書いたとおり。
   */
  private cameraView(camera: StageState["camera"]): StageState["camera"] {
    if (!isPortrait(this.screen) || this.stageNow?.extra["screen.bgPlace"]) return camera;
    return { ...camera, ...coverCamera(camera, this.screen) };
  }

  private moveCamera(camera: StageState["camera"], a: Record<string, Value>, time: number, ease: string): Promise<void> {
    const hasFrom = ["from-zoom", "from-x", "from-y", "from-rotate"].some((k) => a[k] !== undefined);
    // 始めは今の見た目（動いている途中ならその位置）。値に戻して、拡大・回転・移動をそれぞれまっすぐ動かす
    const start: CameraParams = hasFrom ? { zoom: num(a["from-zoom"], 1), x: num(a["from-x"]), y: num(a["from-y"]), rotate: num(a["from-rotate"]) } : cameraParams(getComputedStyle(this.camera).transform);
    const end = cameraTransform(this.cameraView(camera));
    this.camera.style.transform = end;
    const timing = { duration: time, easing: EASINGS[ease] ?? "ease" };
    // 奥行きの絵は、同じ時間・同じ緩急で、途中の位置を細かく決めて一緒に動かす（カメラの中で動きを打ち消すため）
    const planes: Animation[] = [];
    for (const p of this.planeEls.values()) {
      for (const old of p.el.getAnimations()) old.cancel();
      const frames = Array.from({ length: PLANE_STEPS + 1 }, (_, i) => ({ transform: planeTransform(lerpCamera(start, camera, i / PLANE_STEPS), p.depth) }));
      p.el.style.transform = frames.at(-1)!.transform;
      if (time > 0) planes.push(p.el.animate(frames, timing));
    }
    const moving = this.camera.animate([{ transform: cameraTransform(start) }, { transform: end }], timing);
    // 始まる時刻をそろえる。要素ごとに始まりが決まると、重いときに別のフレームになり、動いている途中で奥行きの絵がずれる（WebKit）
    const now = document.timeline?.currentTime;
    if (planes.length && now !== null && now !== undefined) for (const animation of [moving, ...planes]) animation.startTime = now;
    return moving.finished.then(() => undefined);
  }

  /** @window-image の絵（無ければ ui.message.image のまま）。 */
  private applyWindowImage(stage: StageState): void {
    // @window-image → 話者の枠の画像（cast.json の windowImage）→ ui.message.image の順
    const image = stage.windowImage ?? this.speakerWindowImage;
    if (image) this.message.style.setProperty("--message-image", cssUrl(this.options.asset("image", image)));
    else this.message.style.removeProperty("--message-image");
    this.message.classList.toggle("has-frame-image", !!(image || this.ui?.message?.image));
  }

  /** 読み終えた NVL の段落を出し直す（今のページはこのあとシナリオがもう一度出す）。 */
  private async restoreNvlPages(stage: StageState): Promise<void> {
    if (stage.nvl !== true) return;
    const hurry = this.hurry;
    this.hurry = true;
    for (const page of stage.nvlPages ?? []) {
      if (page.choice) {
        // 本文の流れに出した選択肢（ui.choice.position: inline）は、選んだあとの姿で出し直す
        const el = document.createElement("div");
        el.className = "choice-inline is-done";
        for (const [i, o] of page.choice.options.entries()) {
          const line = Object.assign(document.createElement("span"), { textContent: o.text });
          if (i === page.choice.picked) line.className = "is-picked";
          el.append(line);
        }
        this.textEl.append(el);
        continue;
      }
      this.textTarget = this.nvlParagraph(page.speaker, page.label);
      for (const part of page.parts) {
        if ("br" in part) this.textTarget.append(document.createElement("br"));
        else await this.appendText(part.text, part.ruby, part.style);
      }
    }
    this.hurry = hurry;
  }

  /** クリックを待たずに残した本文（{noclick}）を、メッセージウィンドウに出し直す（ロードしたのが、その本文を残したままの選択肢などのとき）。 */
  private restoreNoclickPage(stage: StageState): void {
    const page = stage.noclickPage;
    if (!page || stage.nvl === true || this.dialogue) return;
    this.setName(page.label ?? page.speaker ?? "", page.speaker);
    this.writeParts(this.textEl, page.parts);
  }

  private nvlParagraph(speaker: string | null, label?: string): HTMLElement {
    const p = document.createElement("p");
    p.className = "nvl-page";
    // 段落のフェード（ui.nvl の fade）は、組み立て直すとき（hurry）とスキップ中はしない
    if (this.hurry || this.skipping) p.style.animation = "none";
    if (speaker) {
      const name = Object.assign(document.createElement("span"), { className: "nvl-name", textContent: label ?? speaker });
      name.style.color = this.nameColor(speaker);
      p.append(name);
    }
    this.textEl.append(p);
    return p;
  }

  /** 言語を替えたあと、置いたままの文字を今の言語で出し直す（Extensions.relocalizers）。stage は訳し直したもの。 */
  async relocalize(stage: StageState): Promise<void> {
    for (const relocalize of this.options.extensions?.relocalizers ?? []) await relocalize(this.context, stage);
  }

  /** 状態から画面を組み立て直す（ロード時）。演出はせず、そのままの姿にする。 */
  private async restore(stage: StageState): Promise<void> {
    this.cancelAutoReflow();
    this.stageNow = stage;
    // 一回きりの演出の後始末（scope）と、メッセージ枠を見せない頼みは、組み立て直す前に捨てる
    this.disposeScopes(false);
    this.notices.clear();
    this.windowHolds = 0;
    this.message.classList.remove("lm-window-held");
    this.lastSpeaker = undefined;
    // 待っている途中のページ（入力中の表示）の続きを捨てる
    this.dialogueToken++;
    this.inDialogue = false;
    this.unquote = null;
    this.syncDialogue();
    this.setMessageSuppressed(stage.windowSuppressed === true);
    this.staleText = stage.windowSuppressed === true;
    this.background.replaceChildren();
    for (const entry of this.spriteEls.values()) {
      entry.watch?.disconnect();
      entry.part?.part.dispose();
    }
    this.sprites.replaceChildren();
    this.spriteEls.clear();
    this.leavingSprites.clear();
    for (const who of this.spriteTokens.keys()) this.nextSpriteToken(who);
    this.setNvl(stage.nvl === true, stage.nvlStyle);
    this.setVertical(stage);
    // 話者ごとの見た目は、次のページで当て直す
    this.speakerWindowImage = null;
    this.nameEl.style.removeProperty("--name-image");
    this.applyWindowImage(stage);
    await this.restoreNvlPages(stage);
    this.restoreNoclickPage(stage);
    this.audio.stopAll(stage.bgm?.file);
    if (stage.background) await this.changeBackground(stage.background, 0, true);
    else if (stage.backgroundColor) await this.changeBackground({ color: stage.backgroundColor }, 0, true);
    for (const p of this.planeEls.values()) p.el.remove();
    this.planeEls.clear();
    await this.syncPlanes(stage, 0);
    for (const who of Object.keys(stage.sprites)) await this.showSprite(who, stage, 0, true, false);
    this.mask.style.background = stage.mask ?? "#000";
    this.mask.style.opacity = stage.mask ? "1" : "0";
    this.setMasked(!!stage.mask);
    this.message.classList.toggle("visible", stage.window);
    this.camera.style.transform = cameraTransform(this.cameraView(stage.camera));
    this.placePlanes(stage.camera);
    this.textSpeed = stage.textSpeed;
    // 一時停止中の音は鳴らさない（@resume-bgm は止めた位置 bgm.pausedAt から、@resume-se は始めから鳴らす）。
    if (stage.bgm && !stage.bgm.paused) void this.audio.playBgm(stage.bgm.file, stage.bgm.volume, stage.bgm.loop, 0, stageSound(stage.bgm));
    for (const [channel, se] of Object.entries(stage.loopingSe)) if (!se.paused) void this.audio.playSe(channel, se.file, se.volume, true, 0, stageSound(se));
    this.applyFocus(false);
    void this.applyDof(stage, 0);
    this.placeBalloon();
    void this.updateFace();
    await restorePlay(this, this.context, stage);
    for (const restore of this.options.extensions?.restorers ?? []) await restore(this.context, stage);
    this.events.emit({ type: "restore", stage });
    this.lastSprites = "";
    this.noticeSprites(stage);
  }

  // ---- 部品 ----

  /**
   * この先で使う素材を読んでおく（実行器がページごとに呼ぶ）。画像は読み込んで復号まで済ませた要素を少数だけ持っておき、
   * ブラウザのメモリ上の画像の置き場に残るようにする（表示するときの image() は同じ URL ですぐ読める）。音は復号したものを持つ。
   */
  prefetch(items: PrefetchItem[]): void {
    for (const item of items) {
      let url: string | null = null;
      if (item.kind === "sprite") {
        const entry = this.options.cast[item.who];
        const resolved = entry ? resolveVariant(entry, item.appearance, item.variant) : null;
        const variant = resolved?.variant;
        // パーツ合成は重ねた一枚を先に作っておく
        if (entry && resolved && variant && variant.parts) {
          void this.spriteUrl(entry.appearances[resolved.appearance], variant);
          continue;
        }
        if (variant) url = withCacheKey(this.options.asset("fgimage", variant.image), variant.cacheKey);
      } else if (item.folder === "bgm" || item.folder === "sound" || item.folder === "voice") {
        this.audio.preload(item.folder, item.path);
        continue;
      } else if (item.folder === "bgimage" || item.folder === "fgimage" || item.folder === "image") {
        url = this.options.asset(item.folder, item.path);
      }
      if (url === null || this.warm.has(url)) continue;
      this.warm.set(url, this.image(url, false));
      // 古いものから手放す（持ちすぎるとメモリを食う）。
      while (this.warm.size > PREFETCH_LIMIT) this.warm.delete(this.warm.keys().next().value!);
    }
  }

  /** 読み込みを待っている数と、待ちの印（0.5 秒以上待つときだけ出す）。 */
  private busyCount = 0;
  private busyEl: HTMLDivElement | null = null;

  /** 待ちを数える（on で増やし、off で減らす）。待っているものがあるあいだ、舞台の隅に小さな印を出す。 */
  private busy(on: boolean): void {
    this.busyCount = Math.max(0, this.busyCount + (on ? 1 : -1));
    if (this.busyCount > 0 && !this.busyEl) {
      this.busyEl = document.createElement("div");
      this.busyEl.className = "lm-busy";
      this.busyEl.setAttribute("aria-hidden", "true");
      this.stage.append(this.busyEl);
    }
    this.busyEl?.toggleAttribute("hidden", this.busyCount === 0);
  }

  /** 画像を読み込んで復号する。wait（表示するために待つ）なら、0.5 秒を超えたら待ちの印を出す（先読みは出さない）。 */
  private async image(url: string, wait = true): Promise<HTMLImageElement> {
    const img = new Image();
    img.src = url;
    img.draggable = false;
    let shown = false;
    const timer = wait
      ? setTimeout(() => {
          shown = true;
          this.busy(true);
        }, BUSY_AFTER)
      : undefined;
    try {
      await img.decode();
    } catch {
      console.warn(`画像を読み込めません: ${url}`);
    } finally {
      clearTimeout(timer);
      if (shown) this.busy(false);
    }
    this.naturalSizes.set(url, { width: img.naturalWidth, height: img.naturalHeight });
    return img;
  }

  private fade(el: HTMLElement, to: number, ms: number): Promise<void> {
    const from = getComputedStyle(el).opacity;
    el.style.opacity = String(to);
    if (ms === 0) return Promise.resolve();
    return el.animate([{ opacity: from }, { opacity: String(to) }], { duration: ms, easing: "linear" }).finished.then(() => undefined);
  }
}

/** 終わるまで待った命令がこれより長くかかったら、その間に見えていた立ち絵を「見る間のあった」ものにする（placeSprites が滑らせる）。 */
const SEEN_WAIT_MS = 100;

/** 立ち絵の出方・消え方（@chara の enter、@chara-hide の exit）。 */
interface SpriteMotion {
  kind: "fade" | "left" | "right" | "top" | "bottom" | "zoom";
  distance: number;
}

function spriteMotion(v: Value | undefined): SpriteMotion["kind"] {
  return v === "left" || v === "right" || v === "top" || v === "bottom" || v === "zoom" ? v : "fade";
}

/** 重なり順（@chara の z）。0 は書かない（出した順のまま）。 */
function applyZ(el: HTMLElement, z: number | undefined): void {
  el.style.zIndex = z ? String(z) : "";
}

interface SpriteElement {
  el: HTMLDivElement;
  /** 表示中の画像の URL。 */
  image: string;
  /** 最後に置いた位置と大きさ。 */
  box: Box;
  /** 重ねた部品（口パク・まばたき・プラグインの立ち絵）。key は部品の種類。 */
  part?: { part: SpritePart; key: string };
  /** 最後に当てた反転と、裏返す軸（枠の幅に対する割合）。あとから付けた部品のキャンバスにも同じに当てる。 */
  flip?: { on: boolean; axis: number };
  /** 直下にキャンバスが足されたら反転を当てる見張り（読み込みを待ってからキャンバスを足す部品のため）。 */
  watch?: MutationObserver;
}

function geometry(box: Box): { left: string; top: string; width: string; height: string } {
  return { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` };
}

/** 位置と大きさが同じか（0.5px 未満の違いは同じとみなす。tatie と同じ）。 */
function sameBox(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

/** 同じ立ち位置か（横の中心のずれが、狭い方の幅の 4 分の 1 より小さい）。 */
function samePlace(a: Box, b: Box): boolean {
  return Math.abs(a.x + a.width / 2 - (b.x + b.width / 2)) < Math.min(a.width, b.width) / 4;
}

/**
 * 立ち絵を枠（位置・大きさ）に合わせ、反転を当てる。axis は裏返す軸の、枠の幅に対する割合（flipAxisRatio。0.5 は中央）。
 * 軸は枠に対する割合で書くので、@chara の width や @chara-move、@anim で枠の大きさが変わっても、絵の同じ所で裏返す。
 */
function applyFrame(entry: SpriteElement, box: Box, flip: boolean, axis: number): void {
  const g = geometry(box);
  Object.assign(entry.el.style, g);
  // 大きさは枠に書くだけにする。中の絵は枠いっぱい（style.css の .sprite img）なので、@chara-move や @anim で枠を変えれば絵も変わる
  // 反転は scaleX(-1) の文字のまま（選択肢の置き場所と画面効果が、これで反転を見分ける）。軸が中央でなければ、変形の起点を軸に置く
  // （選択肢の置き場所と漫符は、この起点から軸を読む）
  const origin = flip && axis !== 0.5 ? `${Number((axis * 100).toFixed(4))}% 50%` : "";
  for (const img of entry.el.querySelectorAll("img")) {
    img.style.transform = flip ? "scaleX(-1)" : "";
    img.style.transformOrigin = origin;
  }
  entry.flip = { on: flip, axis };
  flipPartCanvases(entry);
  entry.box = box;
}

/**
 * 部品が立ち絵の要素の直下に置いたキャンバス（揺れる立ち絵、プラグインの Live2D と Spine）も、絵と同じ軸で裏返す。
 * プラグインには反転を渡さず、エンジンが枠の側で裏返す（口の版を変えない。プラグインの説明の「反転はエンジンの立ち絵のまま効く」のとおり）。
 * キャンバスは動いた分が切れないよう枠より大きいので、軸をキャンバス自身の幅に対する割合に直して変形の起点にする。
 */
function flipPartCanvases(entry: SpriteElement): void {
  const on = entry.flip?.on === true;
  const axis = entry.flip?.axis ?? 0.5;
  for (const canvas of entry.el.querySelectorAll<HTMLCanvasElement>(":scope > canvas")) {
    canvas.style.transform = on ? "scaleX(-1)" : "";
    canvas.style.transformOrigin = on ? layerFlipOrigin(canvas, axis) : "";
  }
}

/**
 * 立ち絵の要素の直下にキャンバスが足されたら、今の反転を当てる（読み込みを待ってから描くキャンバスを足す部品も裏返す）。
 * 見るのは直下の子の出入りだけ（中の要素の変化と属性は見ない）。
 */
function watchPartCanvases(entry: SpriteElement): void {
  entry.watch = new MutationObserver((records) => {
    if (records.some((r) => [...r.addedNodes].some((n) => n instanceof HTMLCanvasElement))) flipPartCanvases(entry);
  });
  entry.watch.observe(entry.el, { childList: true });
}

/**
 * 枠の幅に対する割合の軸を、枠の中に置いた要素の変形の起点（要素の幅に対する %）に直す。中央になるなら "" （既定の起点）。
 * 位置と幅は要素の style の %（枠に対する割合。部品はこう書く）から読む。% でなければ今の大きさから求め、測れなければ要素の中央。
 */
function layerFlipOrigin(layer: HTMLElement, axis: number): string {
  const ratio = (v: string) => (v.trim().endsWith("%") ? Number.parseFloat(v) / 100 : Number.NaN);
  let left = ratio(layer.style.left);
  let width = ratio(layer.style.width);
  if (!Number.isFinite(left) || !Number.isFinite(width) || width <= 0) {
    const frame = layer.parentElement?.offsetWidth ?? 0;
    if (frame <= 0 || layer.offsetWidth <= 0) return "";
    left = layer.offsetLeft / frame;
    width = layer.offsetWidth / frame;
  }
  const at = (axis - left) / width;
  return Math.abs(at - 0.5) < 1e-6 ? "" : `${Number((at * 100).toFixed(4))}% 50%`;
}

/** 透けない重ね方（plus-lighter）を使えるか。使えないブラウザでは普通に重ねる。 */
const PLUS_LIGHTER = typeof CSS !== "undefined" && CSS.supports("mix-blend-mode", "plus-lighter");

/** 立ち絵の枠ごとの切り替えのために包んだ層を外し、重ね方を元に戻す。 */
function endDissolve(el: HTMLElement): void {
  el.style.mixBlendMode = "";
  el.style.isolation = "";
  for (const img of el.querySelectorAll("img")) img.style.mixBlendMode = "";
  const group = el.parentElement;
  if (group?.dataset.dissolve !== undefined) {
    group.before(el);
    group.remove();
  }
}

/** 安全な表示領域の余白（CSS の env(safe-area-inset-*)。viewport-fit=cover のときだけ 0 以外になる）。 */
let safeProbe: HTMLDivElement | null = null;
function safeArea(): { top: number; right: number; bottom: number; left: number } {
  // 制作画面がスマホの見え方を真似ているとき（data-safe-area="上 右 下 左"）
  const emulated = document.documentElement.dataset.safeArea;
  if (emulated) {
    const [top = 0, right = 0, bottom = 0, left = 0] = emulated.split(" ").map(Number);
    return { top, right, bottom, left };
  }
  if (!safeProbe) {
    safeProbe = document.createElement("div");
    Object.assign(safeProbe.style, { position: "fixed", inset: "0", visibility: "hidden", pointerEvents: "none", padding: "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)" });
    document.body.append(safeProbe);
  }
  const c = getComputedStyle(safeProbe);
  const px = (v: string) => Number.parseFloat(v) || 0;
  return { top: px(c.paddingTop), right: px(c.paddingRight), bottom: px(c.paddingBottom), left: px(c.paddingLeft) };
}

/** 先読みして持っておく画像の数。 */
const PREFETCH_LIMIT = 24;
/** パーツ合成で重ねた一枚を持っておく数。 */
const COMPOSITE_LIMIT = 48;
let toneSerial = 0;

/** 背景の色調を、新しい背景を出すときに合わせる命令（ほかの命令は、描く前に合わせる）。 */
const OWN_BACKGROUND_TONE = new Set(["bg", "scene-change", "restore"]);
/** 字幕を出しておく時間（ミリ秒）。 */
const CAPTION_MS = 3500;

type CameraParams = StageState["camera"];
/** 奥行きの絵の動きを、カメラの途中の位置で区切る数。 */
const PLANE_STEPS = 24;

function lerpCamera(a: CameraParams, b: CameraParams, k: number): CameraParams {
  return { zoom: a.zoom + (b.zoom - a.zoom) * k, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, rotate: a.rotate + (b.rotate - a.rotate) * k };
}

/** カメラの変形（CSS の transform の計算値）を値に戻す（拡大・回転・中心の位置）。 */
function cameraParams(css: string): CameraParams {
  const m = css === "none" || css === "" ? new DOMMatrix() : new DOMMatrix(css);
  const zoom = Math.hypot(m.a, m.b) || 1;
  const rotate = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  // 移動の部分 = S·R·(−x, −y)
  const p = new DOMMatrix().rotate(-rotate).scale(1 / zoom).transformPoint({ x: m.e, y: m.f });
  return { zoom, rotate, x: -p.x || 0, y: -p.y || 0 };
}

/**
 * 奥行き depth の絵の変形。カメラ（拡大 s・回転 θ・中心 (x, y)）に対して、絵の見え方を拡大 1 + (s − 1)(1 − d)・
 * 回転 θ(1 − d)・中心 (x, y)(1 − d) にする。絵はカメラの中にあるので、カメラの変形の逆を掛けておく。
 */
function planeTransform(c: CameraParams, depth: number): string {
  const k = 1 - depth;
  const camera = new DOMMatrix(cameraTransform(c));
  const seen = new DOMMatrix(cameraTransform({ zoom: 1 + (c.zoom - 1) * k, rotate: c.rotate * k, x: c.x * k, y: c.y * k }));
  return camera.inverse().multiply(seen).toString();
}
/** 顔ウィンドウを合わせ直す命令。 */
const FACE_COMMANDS = new Set(["face", "face-off", "chara", "chara-hide", "chara-hide-all", "scene-change", "restore", "nvl", "balloon", "vertical", "clear", "window"]);

function withCacheKey(url: string, cacheKey: string | undefined): string {
  return cacheKey ? `${url}${url.includes("?") ? "&" : "?"}cache=${encodeURIComponent(cacheKey)}` : url;
}

/** 要素に el.animate(…) で付けた動き（CSS の動きではないもの）を終わりの姿まで進める。終わらない動き（繰り返し続けるもの）は外す。 */
function finishScriptedAnimations(el: HTMLElement): void {
  for (const a of el.getAnimations()) {
    if ("animationName" in a || "transitionProperty" in a) continue;
    try {
      a.finish();
      // 終わりの無い動き（無限の繰り返し）は finish できないので止める
    } catch {
      a.cancel();
    }
  }
}
