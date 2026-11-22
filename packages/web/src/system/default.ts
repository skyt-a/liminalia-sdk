import { achievementGoals, endingKinds, endingRef, endingValueText, mapProjectTexts, OTHER_ENDING, pageKeys, parse, type ChapterInfo, type Diagnostic, type ExtraChapter, type ExtraReplay, type Flow, type FlowScene, type Script } from "@liminalia/lang";
import { argOrigin, initialStage, projectRuntimeOptions, Runtime, saveProblem, type PresentEvent, type ProgramCache, type RunResult, type SaveData, type Sprite, type StageState, type Value } from "@liminalia/runtime";
import type { DomHost } from "../dom-host.ts";
import { screenActionName, type DefineScreenOptions, type ScreenAction } from "../plugin.ts";
import type { BacklogEntry, BacklogScreenApi, ConfigScreenApi, ConfirmScreenApi, EndingScreenApi, ExtraScreenApi, FlowchartScreenApi, HelpScreenApi, ImportData, ItemsScreenApi, LoadFrom, MenuScreenApi, SaveLoadScreenApi, ScreenContent, ScreenHandle, ScreenLifecycle, ScreenOptions, SeedSave, StandardScreens, SlotInfo, SystemController, SystemEnv, SystemEvent, SystemFactory, SystemRequest, SystemStatus, PlayerProject } from "../plugin.ts";
import { relocatedLine } from "./reload-here.ts";
import { Backlog, entryName, plainText, REWIND_IN_SAVE, spokenText, voiceSpeakers, type LogEntry } from "./backlog.ts";
import { ChoiceHistory, findChoiceAhead, unreadAhead } from "./choice-history.ts";
import { keyName, resetSettings } from "./config.ts";
import { anyExtraUnlocked, createExtra, extraCompletion, extraState, type Completion, type CompletionCount, type ExtraEnding, type ExtraTab } from "./extra.ts";
import { sendCrashRecord, takeCrashRecord } from "../crash.ts";
import { analyticsAskable, analyticsConsent, setAnalyticsConsent } from "../analytics-consent.ts";
import { Accessibility } from "./accessibility.ts";
import { createFlowchart, localizeFlow } from "./flowchart.ts";
import { createItems } from "./items.ts";
import type { HelpRow } from "./help.ts";
import { MenuBar, menuItems, menuLabel, withScreens, type MenuAction, type MenuEntry } from "./menu.ts";
import { bindPlayerInput, type PlayerInput } from "./input.ts";
import { focusables, KEYED, keyMatches, PLAY_NAV, shown } from "./navigation.ts";
import type { ReadSet } from "./read-set.ts";
import { PAGE_SIZE, slotName } from "./saveload.ts";
import { padLabel } from "./pad-names.ts";
import { saveFile } from "./download.ts";
import { appearanceKey, autosaveSlotCount, autosaveTimings, chapterOf, quickSlotCount, backlogPages, UI_KEY_ACTIONS, baseVariant, DEFAULT_MENU_BAR_ITEMS, ITEMS_KEY, resolveTitle, resolveKeys, saveSlotCount, systemVoiceEntries, uiSpace, type UiKeyAction, type UiVoiceEntry } from "@liminalia/lang";
import { pickSystemVoice, systemCondition, systemVoiceCharacters } from "./system-voice.ts";
import { Session, type SessionOwner } from "./session.ts";
import { autoDelay, configureSettings, DUCK_LEVEL, PAD_BUTTONS, mergeSettings, normalizeSettings, playerTextEdge, PLAYER_FONTS, settingsDefaults, SKIP_PAGE_MS, type InactiveAction, type Settings, type SettingsPatch } from "./settings.ts";
import { fullscreen } from "./fullscreen.ts";
import { detectPlatform } from "../platform.ts";
import { canQuitApp, keepAwake, quitApp } from "../native.ts";
import { applyColorVision } from "./color-vision.ts";
import { autoSlotIds, flushSaveStore, onSaveStoreError, quickSlotIds, Storage, type ChoicePoint, type SlotId, type SlotRecord } from "./storage.ts";
import { setUiLanguage, TEXT, translatedUi } from "./strings.ts";
import { runUpdate } from "./update.ts";
import { createTranslator, pickLanguage, setDataTranslation } from "./translation.ts";
import type { Translator } from "@liminalia/runtime";
import { captureStage, captureThumbnail } from "./thumbnail.ts";
import { button, el, swallow, toast } from "./ui.ts";
import { confirmScreen } from "./confirm.ts";
import { lazyScreensNow, loadScreenTemplates, screenTemplates, type LazyScreens } from "./standard-templates.ts";
import { playSound } from "../ui-parts.ts";
import { runBackHandler } from "../back.ts";
import { playSplash } from "./splash.ts";
import "./default.css";
import "./portrait.css";

/** 文字をクリップボードへ写す（使えなければ、見えない入力欄を選んで写す）。写せたら true。 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    Object.assign(area.style, { position: "fixed", opacity: "0", pointerEvents: "none" });
    document.body.append(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

/** コンフィグで確認を省いても、尋ねるもの（セーブの削除・読み込み・引き継ぎ・止まったときの記録を送る）。 */
const ALWAYS_CONFIRM: ReadonlySet<string> = new Set(["delete", "import", "carry", "crash-report", "analytics"]);
/** カーソルを隠すまで、マウスを動かさずにいる時間（ミリ秒）。 */
const CURSOR_IDLE_MS = 3000;

/**
 * 既定のシステム画面。作品のプラグインがシステム画面を差し替えないときに使う。
 *
 * 「クリックで開始」→ タイトル（はじめから / つづきから / おまけ / コンフィグ / 終了）→ ゲーム。終わったらタイトルへ戻る。
 * おまけ（CG・回想・音楽・実績。liminalia.json の extra）は、何か一つでも解放したらタイトルに出る。回想は再生し終えるか
 * @replay-end でおまけへ戻る（回想の間はセーブできない）。
 * ゲーム中:
 * - 画面下の帯: Qセーブ・Qロード・セーブ・ロード・オート・スキップ・履歴・設定・枠を隠す・タイトルへ
 * - 右クリック・Esc でメニュー（帯と同じ操作。デスクトップ版は終了も）。開いている画面は右クリック・Esc で閉じる
 * - クリック・Enter・Space・ホイール下で送る。ホイール上で履歴。Ctrl を押している間スキップ。S / L でクイックセーブ／ロード
 * - オート・スキップ中のクリック・Enter・Space は止めるだけ。選択肢でもオート・スキップは止まる
 * - 枠を隠している間は、クリック・右クリック・キー・ホイールで戻すだけ
 * - 指で触る端末: タップで送り、長押しでメニュー、下へなぞると履歴、上へなぞると枠を隠す。下の帯の代わりに
 *   右上のメニューのボタンを出し、縦に持っていれば横向きにするよう知らせる（横長の作品のとき）
 * - 矢印キー・ゲームパッドの十字キー（左スティック）で、開いている画面・タイトル・選択肢のボタンを選ぶ。
 *   ゲームパッドは A で決定・送り、B で戻る・メニュー、X で枠を隠す、Y で履歴、RB を押している間スキップ、START でメニュー、SELECT で設定
 * 既読（ページの位置の集合）・設定・システム変数は全セーブ共通で保存する。
 * 見た目は default.css の CSS 変数（--lm-*）で変えられる。文言は strings.ts。
 */

/** 舞台のクリックで、本文送りやオートの解除より先に、そのものの働きに任せる操作の部品。 */
/** 出している選択肢のうち押せるもの（標準の型の選択肢と、作品の screens.choice のボタン）。 */
const CHOICE_BUTTONS =
  ".choices button:not(:disabled), .choices [role=button]:not(button):not([aria-disabled=true]), .choice-inline button:not(:disabled), .choice-inline [role=button]:not(button):not([aria-disabled=true])";
const CONTROL_SELECTOR = "button, a[href], input, select, textarea, label, [role=button], [role=option], [role=checkbox], [role=radio], [contenteditable=\"true\"]";
export const createDefaultSystem: SystemFactory = (env) => new DefaultSystem(env);

type Mode = "boot" | "title" | "game";

/** 巻き戻しで進め直す先。key はページなら「ファイル:行」、選択肢なら実行器の位置。log はそこまでの履歴の件数。 */
interface RollStep {
  kind: "page" | "choice";
  key: string;
  log: number;
  save: SaveData;
}

/** 開いている画面。後に開いたものほど上。 */
interface OpenScreen {
  name: string;
  el: HTMLElement;
  /** Esc・右クリック・閉じるボタン。 */
  close(): void;
  /**
   * 遊ぶ人の操作を待つゲームの中の画面（作品の画面の allowMenu、@item-select の持ち物）。開いている間も、メニュー・セーブ・ロード・履歴・
   * コンフィグを開け、閉じるとこの画面に戻る。
   */
  allowMenu?: boolean;
  /** 戻る（Esc・右クリック・パッドの B）を画面が扱ったか（扱わなければ、allowMenu の画面ではメニューを開く）。無ければ close して扱ったことにする。 */
  back?(): boolean;
  /** 開いている間、シナリオの次の命令を止める（作品の画面は openScreen の pauseScenario、標準の画面は ui.screen.pauseScenario）。 */
  pause?: boolean;
  /** ロード・タイトルへ戻るなどで、まとめて捨てるとき（作品の画面は結果を null にする）。 */
  discard?(): void;
  /** 閉じたときに呼ぶもの（ScreenLifecycle.onClose）。 */
  closed?: (() => void)[];
  /** 閉じる演出（ScreenLifecycle.leave）。済むまで待ってから外す。 */
  leave?: (el: HTMLElement) => Promise<void> | void;
  /** 開く前に選んでいたもの（閉じたらそこへ戻す）。 */
  returnFocus?: HTMLElement | null;
}

/** 画面の見出しに付ける id の番号。 */
let screenHeadingId = 0;

/** オートの間に、エンディングの名前（@title-screen ending=）を見せておく長さ（ミリ秒）。 */
const ENDING_AUTO_MS = 4000;

/** 出すエンディングの名前（EndingScreenApi の name、kind、label、title と同じ）。 */
interface EndingShown {
  kind: string;
  label: string;
  title: string;
  name: string;
}

/** 閉じる演出（ScreenLifecycle.leave）を待つ長さの上限（ミリ秒）。 */
const LEAVE_LIMIT = 2000;

/** 矢印キー（input.ts が先に作品の画面へ渡す）。 */
const NAV_ARROWS: Readonly<Record<string, true>> = { ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true };

/**
 * 遊ぶ人の操作を待つ画面（調べる画面・地図・持ち物を選ぶ画面・文字の入力・確認の枠など）を出している間も効くキーの操作
 * （キーの割り当ての操作 → する操作）。本文を読み進める操作は入れない。
 */
const OVER_SCREEN_KEYS: readonly (readonly [UiKeyAction, MenuAction])[] = [
  ["menu", "menu"],
  ["quickSave", "quick-save"],
  ["quickLoad", "quick-load"],
  ["save", "save"],
  ["load", "load"],
  ["backlog", "backlog"],
  ["config", "config"],
  ["screenshot", "screenshot"],
];

/** ゲームパッドのボタン → 作品の画面に渡すキーの名前（ExtraScreenApi.onKey）。 */
const PAD_KEYS: Readonly<Record<string, string>> = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", a: "Enter", b: "Escape", lb: "PageUp", rb: "PageDown" };

/**
 * 画面の口の、閉じたときの知らせ（onClose）と閉じる演出（leave）。api に onClose を入れて画面を作り、開いた画面に bind でつなぐ
 * （leave は作品が api に入れたものを、閉じるときに読む）。
 */
function lifecycle(): { onClose: ScreenLifecycle["onClose"]; bind(screen: OpenScreen, api: Partial<ScreenLifecycle>): void } {
  const closed: (() => void)[] = [];
  return {
    onClose: (listener) => {
      closed.push(listener);
      return () => {
        const i = closed.indexOf(listener);
        if (i >= 0) closed.splice(i, 1);
      };
    },
    bind: (screen, api) => {
      for (const l of screen.closed ?? []) if (!closed.includes(l)) closed.push(l);
      screen.closed = closed;
      screen.leave = (el) => api.leave?.(el);
    },
  };
}

/** 開いている作品の画面の状態をセーブに残す stage.extra のキー（{ key, state } の並び）。 */
const SCREENS_KEY = "lm.screens";
/** このプレイで最後に着いたおまけの章の題（セーブの一覧に出す章の名前）を残す stage.extra のキー。 */
const CHAPTER_KEY = "lm.chapter";


/** 名前で開ける標準の画面（@open-screen・openScreenByName）。log と backlog は同じ。 */
const STANDARD_SCREENS: ReadonlySet<string> = new Set(["save", "load", "log", "backlog", "menu", "config", "extra", "items", "help", "flowchart"]);

/** セーブに入れる履歴の件数。 */
const LOG_IN_SAVE = 50;
/** セーブに入れる「前の選択肢へ」の控えの数（一つずつがセーブ一つぶんの大きさなので、メモリの控えより少なく）。 */
const CHOICES_IN_SAVE = 10;
/** ホイールで続けて送るときの間隔（ミリ秒）。 */
const WHEEL_INTERVAL = 150;

class DefaultSystem implements SystemController, SessionOwner {
  mode: Mode = "boot";
  runtime: Runtime | null = null;
  pages = 0;
  devSkipUntil = 0;

  private readonly storage: Storage;
  private readonly layer: HTMLDivElement;
  private readonly bar: MenuBar;
  /** 作品が差し替えた操作の帯（WebPlugin.screens.menuBar）。 */
  private readonly customBar: HTMLElement | null;
  /** @title-screen で、プレイが止まったらタイトルへ戻る。 */
  private returnToTitle = false;
  /** 指の長押し・なぞり・ゲームパッド・矢印キー・指向けのメニューのボタン（input.ts）。 */
  private input!: PlayerInput;
  private readonly system: Record<string, Value>;
  private readonly read: ReadSet;
  /** 設定画面の値（公開は settings・updateSettings）。 */
  private prefs: Settings;
  /** 履歴（公開は backlog）。 */
  private readonly log: Backlog;
  /** タイトル画面の BGM を鳴らしているか（ゲームを始めたら止める）。 */
  private titleBgm = false;
  /** 今全画面か（ゲームの外での切り替えも onChange で知る）。 */
  private fullscreenNow = false;
  /** 開いている作品の画面がキーを先に受ける（ExtraScreenApi.onKey）。扱ったら true。 */
  private screenKey: ((e: KeyboardEvent) => boolean) | null = null;
  private session: Session | null = null;
  private screens: OpenScreen[] = [];
  private titleEl: HTMLElement | null = null;
  /** 標準のタイトルの画面の JS の片付け。 */
  private titleDispose: (() => void) | null = null;

  // ゲーム中の状態
  private auto = false;
  private skip = false;
  /** 次の選択肢まで飛ばしている（未読も飛ばし、選択肢を出したら止まる）。 */
  private toChoice = false;
  /** 次の未読まで飛ばしている（設定によらず未読のページで止まる。選択肢でも止まる）。 */
  private toUnread = false;
  /** 「次の未読へ」を押したページ（未読でも、このページは飛ばす）。次のページで外す。 */
  private passUnreadPage = false;
  /**
   * このプレイで出した選択肢（そこから選び直すセーブと、そのときの履歴の長さ）。「前の選択肢へ」で戻る。
   * 覚えるのはこのプレイの間だけ（スロットのセーブには入れない）。
   */
  /** 「前の選択肢へ」の控え。 */
  private readonly choices = new ChoiceHistory();
  /** 読み上げとスクリーンリーダー。 */
  private a11y!: Accessibility;
  /**
   * 巻き戻しで戻ったところから進め直す先（近い順。ページの頭のセーブか、選択肢を出した時点のセーブ）。
   * 戻ったあと読み進めて同じところへ着いたら一つずつ消し、違うところへ着いたら（選び直したなど）捨てる。
   */
  private future: RollStep[] = [];
  /** 戻ったときに外した選択肢の控え（進め直したら戻す。前に選んだもの chosen を持つ）。 */
  private futureChoices: ChoicePoint[] = [];
  /** 巻き戻しで組み立て直したところ（最初のページか選択肢は、進め直す先と照らさない）。 */
  private rolling = false;
  /** 巻き戻しで組み立て直している途中（続けて押したものは捨てる）。 */
  private rollBusy = false;
  /** 今出している選択肢が、戻る前に選んだことのあるものなら、その控え。 */
  private revisited: ChoicePoint | null = null;
  private ctrlHeld = false;
  private hidden = false;
  private choosing = false;
  /** 今のページが、表示する前から既読だったか。 */
  private pageWasRead = true;
  private readSaveTimer: ReturnType<typeof setTimeout> | undefined;
  /** 開発用の startAt で始めたプレイは、終わっても画面をそのまま残す（撮影のため）。 */
  private stayOnEnd = false;
  /** シナリオから隠せるメニューの帯（@menu-button）。 */
  private menuButton = true;
  /** システム画面がすべて閉じるのを待っているもの（@open-screen）。 */
  private screenWaiters: (() => void)[] = [];
  /** loadSave が、ページ（か選択肢）を出し始めるのを待っているもの。 */
  private shownWaiter: (() => void) | null = null;
  /** 再生中の回想（おまけから始めたとき）。 */
  private replaying: ExtraReplay | null = null;
  /** 遊ぶ言語（多言語でなければ空）と、その訳（原文の言語なら null）。 */
  private language = "";
  private translator: Translator | null = null;
  /** 読んでいる途中の訳のファイル（読み終えたら null）。始めるのを待つのに使う。 */
  private translationLoading: Promise<unknown> | null = null;
  /** 作品の設定を遊んでいる言語に訳したもの（言語を替えたときと、開発中に設定が変わったときに作り直す）。 */
  private localized: PlayerProject | null = null;

  /**
   * 作品の設定（おまけ・章・持ち物と、ui の章の名前・注意書き・操作説明・字幕）を、遊んでいる言語の訳に替えたもの。
   * 訳が無ければ作品の設定そのもの。見せる文字はここから読む（id や画像のパスは元のまま）。
   */
  private get project(): PlayerProject {
    const tr = this.translator;
    if (!tr?.text) return this.env.project;
    return (this.localized ??= mapProjectTexts(this.env.project, (source) => tr.text?.(source) || source));
  }

  constructor(private readonly env: SystemEnv) {
    this.storage = new Storage(env.project.id, undefined, { protect: env.project.saves?.protect ?? false });
    // IndexedDB に書けなかったとき（容量が足りないなど。書き込みは後で分かる）
    onSaveStoreError(() => toast(this.layer, TEXT.toast.saveFailed));
    this.system = this.storage.loadSystemVariables();
    this.read = this.storage.loadReadSet();
    // 作品の設定の幅を先に当ててから、保存していた設定を読む（幅の外は幅に収める）
    configureSettings(env.project.ui?.settings);
    this.prefs = this.storage.loadSettings({ ...settingsDefaults(env.project.ui?.defaults), contentFilter: env.project.ui?.contentFilter?.default === true });
    this.log = new Backlog(backlogPages(env.project.ui));
    this.layer = el("div", "layer lm-sys");
    // 作品の演出が使うシステム画面の層（RenderContext.systemLayer）と、ロードの終わり（組み立て直しが済んだ）
    env.host.systemLayer = this.layer;
    env.host.context.on("restore", () => this.loadRestored());
    this.bar = new MenuBar((a) => void this.act(a), env.project.ui?.menuBar, (path) => env.host.context.asset("image", path), (name) => this.screenLabel(name));
    // 作品が帯の見た目を差し替えていれば、標準の帯は置かずにそれを置く
    this.customBar = env.screens?.menuBar ? this.makeCustomBar(env.screens.menuBar) : null;
    this.layer.append(this.customBar ?? this.bar.el);
    // オート中・スキップ中の表示（作品が差し替えていればそれ）
    this.indicator = this.makeIndicator();
    this.layer.append(this.indicator);
    env.host.stage.append(this.layer);
    // 全画面の動画などが操作の UI を覆っている間は、クイックメニューを出さない
    env.host.onUiCoverChange(() => this.sync());
    env.host.onMessageVisibilityChange(() => this.sync());
    // 全画面: 設定と、ゲームの外（Esc・F11・Alt+Enter）での切り替えを合わせる。ブラウザでは起動したときには戻せない
    fullscreen.allow(env.project.ui?.screen?.fullscreen !== false);
    if (!fullscreen.restorable()) this.prefs = { ...this.prefs, fullscreen: false };
    // 前に終えたときの全画面とウィンドウの大きさで起動したデスクトップ版は、その様子を今のものとする（起動したときに当て直さない）
    if (typeof window !== "undefined" && window.liminaliaDesktop?.fullscreenAtStart) this.fullscreenNow = true;
    if (typeof window !== "undefined" && window.liminaliaDesktop?.windowRestored) this.windowScaleNow = this.prefs.windowScale;
    fullscreen.onChange((on) => {
      this.fullscreenNow = on;
      if (this.prefs.fullscreen === on) return;
      this.prefs = { ...this.prefs, fullscreen: on };
      this.storeSettings(this.prefs);
    });
    this.a11y = new Accessibility(env.host.stage);
    this.applySettings();
    this.setupGlossary();
    this.setupItems();
    this.setupCaptions();
    this.bindInput();
    this.input.setPadMap(this.prefs.pad);
    env.host.stage.addEventListener("pointermove", () => this.wakeCursor());
    this.sync();
    // 閉じるときと裏へ回ったとき（タブの切り替え・スマホでホームへ戻る・最小化）は、全セーブ共通のものを書き、オートセーブする
    window.addEventListener("pagehide", () => this.leave());
    document.addEventListener("visibilitychange", () => {
      const hidden = document.visibilityState === "hidden";
      if (hidden) this.leave();
      // 戻ってきたら、このページが裏へ回したときに残した印（resumeLeft）は要らない。
      // 裏にいる間に読み直したページ（スマホのアプリが作り直した WebView）は、前のページの印を残したまま戻ってくる
      else if (this.leftMarked) {
        this.leftMarked = false;
        this.storage.remove("resume");
      }
      this.syncInactive();
    });
    // デスクトップ版: 最小化（描画を絞らない設定では visibilitychange が来ない）と、ほかのウィンドウを選んだとき
    window.liminaliaDesktop?.onWindowVisible?.((visible) => {
      this.windowMinimized = !visible;
      if (!visible) this.leave();
      this.syncInactive();
    });
    window.addEventListener("blur", () => {
      this.unfocused = true;
      this.syncInactive();
    });
    window.addEventListener("focus", () => {
      this.unfocused = false;
      this.syncInactive();
    });
    // 言語: システム画面の文言は組み込みの表ですぐ替え、訳のファイルは読めたら効かせる
    const languages = env.project.languages ?? [];
    this.language = pickLanguage(languages, env.language && languages.includes(env.language) ? env.language : this.prefs.language, typeof navigator === "undefined" ? [] : navigator.languages);
    setUiLanguage(this.language || "ja", env.texts ?? {});
    this.useAssetLanguage();
    this.relabel();
    void this.loadLanguage(this.language);
    // 解放済みの実績を送り直す（Steam につながっていないときに解放したもの。送り先が重複を無視する）
    const achieved = this.system.achievements;
    if (env.onAchievement && achieved && typeof achieved === "object") for (const id of Object.keys(achieved)) env.onAchievement(id);
    // 数を数える実績の進み具合も送り直す
    const progress = this.system.achievement_progress;
    const goals = achievementGoals(env.project.extra);
    if (env.onAchievementProgress && progress && typeof progress === "object" && !Array.isArray(progress))
      for (const [id, value] of Object.entries(progress)) if (typeof value === "number") env.onAchievementProgress(id, value, goals[id] ?? 0);
  }

  /** 言語ごとの素材を使う（原文の言語なら差し替えない）。 */
  private useAssetLanguage(): void {
    const original = this.env.project.languages?.[0] ?? "";
    this.env.setAssetLanguage?.(this.language && this.language !== original ? this.language : "");
    // 言語ごとの見た目（ui.languages の書体や文字の大きさ。原文の言語にも書ける）
    this.host.setUiLanguage(this.language || original);
    // 文書の言語（スクリーンリーダーの読み方と、ブラウザの訳の判断に使う）。多言語でない作品は index.html のまま
    const lang = this.language || original;
    if (lang && typeof document !== "undefined") document.documentElement.lang = lang;
    // デスクトップ版の Mac のメニューの文言も合わせる（作品が言語を決めていなければ空で、OS の言語のまま）
    if (typeof window !== "undefined") window.liminaliaDesktop?.setLanguage?.(lang);
  }

  /** 言語を替えたあと、出したままの部品の文言を読み直す。 */
  private relabel(): void {
    this.bar.relabel();
    delete this.indicator.dataset.state;
    this.syncIndicator();
    this.input.relabel({ menu: TEXT.menu.heading, rotate: TEXT.rotate, rotateKeep: TEXT.rotateKeep });
  }

  /** 言語の訳を読み、システム画面の文言と、遊んでいる実行器の訳を替える（次のページから効く）。 */
  private async loadLanguage(language: string): Promise<void> {
    const original = (this.env.project.languages ?? [])[0] ?? "";
    const pending = language && language !== original && this.env.loadTranslation ? this.env.loadTranslation(language).catch(() => null) : null;
    this.translationLoading = pending;
    const file = pending ? ((await pending) ?? null) : null;
    if (this.translationLoading === pending) this.translationLoading = null;
    if (this.language !== language) return; // 読んでいる間に替えた
    this.translator = file ? createTranslator(file) : null;
    // 作品のデータの訳す文（std の図鑑などが dataText で引く）
    setDataTranslation(file);
    this.localized = null;
    this.setupGlossary();
    this.chapterAt = null;
    if (this.runtime) {
      this.runtime.translator = this.translator;
      this.runtime.language = this.language;
      // 置いたままの文字（@layer-text・チャットの吹き出し）も今の言語で出し直す
      if (this.runtime.retranslate()) void this.host.relocalize(this.runtime.state.stage);
    }
    setUiLanguage(language || "ja", { ...translatedUi(file?.ui), ...(this.env.texts ?? {}) });
    // ページの題（ブラウザのタブ）も作品の題の訳にする
    if (this.env.project.title && typeof document !== "undefined") document.title = this.project.title;
    this.relabel();
    if (this.mode === "title" && this.titleEl && !this.screen) this.renderTitle();
  }

  private get host(): DomHost {
    return this.env.host;
  }

  get screen(): string | null {
    return this.screens.at(-1)?.name ?? null;
  }

  /** ゲーム中で、遊ぶ人の操作を待つゲームの中の画面（allowMenu）だけを出している（上にメニュー・セーブ・履歴・コンフィグを開ける）。 */
  private get overScreen(): boolean {
    return this.mode === "game" && this.screens.length > 0 && this.screens.every((s) => s.allowMenu === true);
  }

  /** 文字の入力や確認の枠（@text-input・@dialog）を出している。 */
  private get panelShown(): boolean {
    return this.host.stage.querySelector(".lm-panel") !== null;
  }

  /** メニュー・履歴・持ち物・操作説明・フローチャートを開けない（標準の画面か、上にメニューを開けない画面を出している）。 */
  private get menuBlocked(): boolean {
    return this.screen !== null && !this.overScreen;
  }

  // ---- 起動・タイトル ----

  showGate(): void {
    this.mode = "boot";
    const touch = typeof matchMedia === "function" && matchMedia("(any-pointer: coarse)").matches;
    const gate = el("div", "lm-gate", touch ? TEXT.gateTouch : TEXT.gate);
    // タイトル画面の背景があれば、暗くして敷く（ページに組み込んだときに、真っ黒な四角にならないように）
    const background = resolveTitle(this.env.project.ui?.title, (c) => systemCondition(c, this.system))?.background;
    if (background) {
      const url = this.env.host.context.asset("bgimage", background).replace(/"/g, '\\"');
      gate.style.backgroundImage = `linear-gradient(rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.55)), url("${url}")`;
      gate.classList.add("has-image");
    }
    gate.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        void this.boot();
      },
      { once: true },
    );
    this.layer.append(gate);
  }

  async boot(): Promise<void> {
    this.mode = "boot";
    this.layer.querySelector(".lm-gate")?.remove();
    // ふつうに起動したら、前に裏へ回したときの印（resumeLeft）は使わない
    this.storage.remove("resume");
    // フローチャートは先に読んでおく（場面に着いたときの控えのため）
    void this.loadFlow();
    // 体験版などのセーブを引き継ぐか（はじめて起動したときに一度だけ尋ねる）
    if (await this.offerCarry()) return;
    // 前の起動で止まった記録があれば、送ってよいかを尋ねる
    await this.offerCrashReport();
    // 遊ばれ方の統計（作品が使うとき）を送ってよいか、はじめて起動したときに一度だけ尋ねる
    await this.askAnalytics();
    // アップデートの確認（デスクトップ版で build.update があるとき）。待たずに確かめ、タイトル画面で尋ねる
    if (window.liminaliaDesktop?.update?.startup) void this.offerUpdate(false);
    // 注意書き（同意しなければ始めない）
    if (!(await this.showContentWarning())) return;
    await this.host.audio.unlock();
    // 起動の演出（WebPlugin.splash。無ければ liminalia.json の ui.splash）は、立ち上げてから一度だけ
    if (this.env.splash && !this.splashed) {
      this.splashed = true;
      try {
        await this.env.splash(this.host.context);
      } catch (e) {
        console.warn("起動時の演出（splash）を表示できません", e);
      }
    } else if (this.env.project.ui?.splash && !this.splashed) {
      this.splashed = true;
      try {
        await playSplash(this.layer, this.env.project.ui.splash, { asset: (path) => this.host.context.asset("image", path) });
      } catch (e) {
        console.warn("起動時の演出（ui.splash）を表示できません", e);
      }
    }
    await this.showTitle(false);
  }

  /** @title-screen ending= で終えたプレイの、タイトルへ戻る前に出すエンディングの名前（card=false なら null）。 */
  private ending: (EndingShown & { text: string }) | null = null;

  /**
   * シナリオが終わってタイトルへ戻る。結末の名前（@title-screen ending=）があれば出して押されるのを待ち、
   * 作品の演出があれば流す（WebPlugin.endSplash）。
   */
  private async endToTitle(): Promise<void> {
    const ending = this.ending;
    this.ending = null;
    // 自動確認（lim shot・lim playtest）では出さない（遊ぶ人の操作を待つ画面と同じ）
    if (ending && !this.host.automated) await this.showEnding(ending);
    if (this.env.endSplash) {
      this.endGame();
      try {
        await this.env.endSplash(this.host.context);
      } catch (e) {
        console.warn("終わりの演出（endSplash）を表示できません", e);
      }
    }
    await this.showTitle(true);
  }

  /**
   * 結末の名前を出し、押されるまで待つ（@title-screen ending=。Esc・右クリックでも進む）。作品の screens.ending があればその見た目。
   * オートの間はしばらく見せてから進める。録画（lim shot --video）には進める操作を知らせる。
   */
  private async showEnding(ending: EndingShown & { text: string }): Promise<void> {
    const views = this.env.screens?.ending ? null : await this.loadViews();
    return new Promise<void>((resolve) => {
      let done = false;
      let withdraw = () => {
        // 知らせる前に閉じたときは、外すものが無い
      };
      let timer = 0;
      const finish = () => {
        if (done) return;
        done = true;
        withdraw();
        clearTimeout(timer);
        this.closeScreen(screen);
        resolve();
      };
      const life = lifecycle();
      const api: EndingScreenApi = { name: ending.name, kind: ending.kind, label: ending.label, title: ending.title, text: ending.text || TEXT.ending.mark, proceed: TEXT.ending.proceed, close: finish, onClose: life.onClose };
      const custom = this.env.screens?.ending;
      if (!custom && !views) {
        // 型を読めなかった（書き出しで、束を取りに行けなかった）。名前は出さずにタイトルへ
        resolve();
        return;
      }
      const made = custom ? null : views!.createEnding(this.templatesNow(), api);
      const screen = this.openStandard("ending", made ? made.el : custom!(api), finish);
      if (made) this.whenGone(screen, made.dispose);
      life.bind(screen, api);
      if (done) return;
      withdraw = this.host.offer({ options: [TEXT.ending.proceed], proceed: 0, choose: finish });
      if (this.auto) timer = window.setTimeout(finish, ENDING_AUTO_MS);
    });
  }

  /** 作品のエンディングの種類（liminalia.json の endingKinds と組み込み）。 */
  private get endingKinds() {
    return endingKinds(this.env.project.endingKinds);
  }

  /** エンディングの種類の文言（遊んでいる言語。作品の endingKinds の訳、既定のシステム画面の ending.kinds の順。other は ""）。 */
  private endingKindLabel(kind: string): string {
    const own = this.project.endingKinds?.[kind];
    if (typeof own === "string") return own;
    return TEXT.ending.kinds[kind] ?? "";
  }

  /**
   * プレイを終える命令の ending= と title=（実行器が訳したもの）から、出すエンディングの名前を作る。どちらも無ければ null。
   * 前の書き方（ending= に文言を書いた、移していない作品）は、書いた文言（の訳）をそのまま名前にする。
   */
  private endingShown(args: Record<string, unknown>): EndingShown | null {
    const value = endingValueText(args.ending);
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (value === "" && title === "") return null;
    const kinds = this.endingKinds;
    if (value !== "" && !kinds.names.has(value)) {
      // 種類は原文の文言から読む（訳した文言では読めないことがある）
      const source = argOrigin(args as Record<string, Value>, "ending")?.source ?? value;
      return { kind: endingRef(source, title, kinds)!.kind, label: "", title, name: value };
    }
    const kind = value === "" ? OTHER_ENDING : value;
    const label = this.endingKindLabel(kind);
    return { kind, label, title, name: title || label };
  }

  /** フローチャートの終わりの場面のエンディングの名前（一覧の一行は name。種類の文言と名前、前の書き方は書いた文言）。 */
  private flowEnding(scene: FlowScene): EndingShown {
    const end = scene.end!;
    const file = scene.id.split("#")[0]!;
    if (end.legacy) return { kind: end.ending, label: "", title: "", name: this.translator?.arg?.(file, end.legacy) || end.legacy };
    const title = end.title ? this.translator?.arg?.(file, end.title) || end.title : "";
    const label = end.ending ? this.endingKindLabel(end.ending) : "";
    return { kind: end.ending, label, title, name: title && label ? TEXT.ending.listName(label, title) : title || label };
  }

  private splashed = false;
  /** 次に作るタイトルで導入の演出を出すか（起動して最初のタイトルだけ）。 */
  private titleIntro = false;

  async showTitle(skipIntro: boolean): Promise<void> {
    this.titleIntro = !skipIntro;
    this.endGame();
    this.closeAllScreens();
    if (!this.env.project.titleScreen) {
      void this.newGame();
      return;
    }
    this.mode = "title";
    window.liminaliaDesktop?.presence?.("");
    this.renderTitle();
    this.sayOnTitle();
    void this.emit({ type: "title" });
  }

  /** タイトルコール（タイトルの画面を出したとき。導入の演出があってもすぐ鳴らす）。 */
  private sayOnTitle(): void {
    this.sayVoice(this.env.project.ui?.systemVoice?.title);
  }

  /** システムボイスを鳴らす（ui.systemVoice の候補から、コンフィグの担当と if で一つ選ぶ）。 */
  private sayVoice(list: readonly UiVoiceEntry[] | undefined): void {
    const file = pickSystemVoice(list, this.prefs.systemVoice, this.system);
    if (file) void this.host.audio.playSystemVoice(file, this.env.project.ui?.systemVoice?.volume ?? 100);
  }

  /** 操作のシステムボイス（ui.systemVoice.actions の操作の名前）。 */
  private sayAction(action: string): void {
    this.sayVoice(this.env.project.ui?.systemVoice?.actions?.[action]);
  }

  /** タイトルの画面を作り直す（言語を替えたときも）。標準のタイトルは、型を読み終えていなければ読んでから作る（書き出しでは初めて出すときに読む）。 */
  private renderTitle(): void {
    // クリアの状況などで変わるタイトル（ui.title.variants）
    const t = resolveTitle(this.env.project.ui?.title, (c) => systemCondition(c, this.system));
    const asset = (kind: "bgimage" | "image", path: string) => this.env.host.context.asset(kind, path);
    if (t?.bgm && !this.titleBgm) {
      this.titleBgm = true;
      void this.env.host.audio.playBgm(t.bgm, t.bgmVolume ?? 100, true, 1000);
    }
    let made: HTMLElement;
    let dispose: (() => void) | null = null;
    if (this.env.title) {
      this.removeTitleEl();
      // 作品が作るタイトル（WebPlugin.title）。ボタンの動きは標準のタイトルと同じものを渡す
      const latest = () => this.latestSave();
      made = el(
        "div",
        "lm-title lm-title-custom",
        this.env.title({
          // 題や章などの文字は遊んでいる言語の訳
          project: this.project,
          host: this.env.host,
          start: () => {
            this.sayAction("start");
            void this.newGame();
          },
          load: () => {
            this.sayAction("load");
            this.openSaveLoad("load");
          },
          loadLatest: async () => {
            const slot = latest();
            if (slot !== null) await this.loadFrom(slot);
          },
          hasSave: () => latest() !== null,
          config: () => {
            this.sayAction("config");
            this.openConfig();
          },
          extra: () => {
            this.sayAction("extra");
            this.openExtra();
          },
          hasExtra: () => this.hasExtra(),
          flowchart: () => void this.openFlowchart(),
          hasFlowchart: () => this.hasFlowchart(),
          exit: () => {
            if (canQuitApp()) this.quit();
          },
          canExit: () => canQuitApp(),
          ask: (m, kind) => this.ask(m, kind),
          intro: this.titleIntro,
        }),
      );
    } else {
      const views = lazyScreensNow();
      if (!views) return this.waitTitle();
      this.removeTitleEl();
      const title = this.standardTitle(views, t, asset);
      made = title.el;
      dispose = title.dispose;
    }
    this.titleEl = made;
    this.titleDispose = dispose;
    // 導入の演出は一度だけ（言語を替えて作り直したときは出さない）
    this.titleIntro = false;
    if (t?.background) {
      made.style.backgroundImage = `url("${asset("bgimage", t.background).replace(/"/g, '\\"')}")`;
      made.classList.add("has-image");
      const focus = this.env.project.ui?.backgroundFocus;
      const at = focus?.[t.background] ?? focus?.["*"];
      if (at) made.style.backgroundPosition = at;
    }
    this.layer.prepend(made);
    this.sync();
  }

  /** タイトルの型を読んでいるか。 */
  private titleWaiting = false;

  /** 標準のタイトルの型を読み、読めたらタイトルを作る。読めなければ一秒ごとに読み直す（タイトルに居る間）。 */
  private waitTitle(): void {
    if (this.titleWaiting) return;
    this.titleWaiting = true;
    const again = () => {
      this.titleWaiting = false;
      if (this.mode === "title") this.renderTitle();
    };
    void this.loadViews().then((views) => (views ? again() : setTimeout(again, 1000)));
  }

  /** 標準のタイトル（題名かロゴと、ボタンの並び）。 */
  private standardTitle(views: LazyScreens, t: ReturnType<typeof resolveTitle>, asset: (kind: "bgimage" | "image", path: string) => string): { el: HTMLElement; dispose(): void } {
    // 押したときのシステムボイスは、ui.systemVoice.actions の start、load、extra、flowchart、config、help、exit
    const said = (action: string, run: () => void) => () => {
      this.sayAction(action);
      run();
    };
    // ui.title.resume なら、ロード画面を開かずにいちばん新しいセーブから再開する
    const resume = t?.resume === true;
    return views.createTitle(this.templatesNow(), {
      // 作品の題は遊んでいる言語の訳（訳のファイルの作品の設定の文字）
      name: this.project.title,
      logo: t?.logo ? asset("image", t.logo) : "",
      showName: t?.showName !== false,
      canLoad: this.latestSave() !== null,
      roles: {
        start: said("start", () => void this.newGame()),
        load: said("load", () => {
          const latest = this.latestSave();
          if (resume && latest !== null) void this.loadFrom(latest);
          else this.openSaveLoad("load");
        }),
        extra: this.hasExtra() ? said("extra", () => this.openExtra()) : null,
        flowchart: this.hasFlowchart() ? said("flowchart", () => void this.openFlowchart()) : null,
        config: said("config", () => this.openConfig()),
        help: this.env.project.ui?.help?.title ? said("help", () => this.openHelp()) : null,
        exit: canQuitApp() ? said("exit", () => this.quit()) : null,
      },
    });
  }

  async newGame(): Promise<void> {
    this.closeAllScreens();
    const rt = this.createRuntime();
    // 作品が変数を入れる・舞台を整えるのを待ってからタイトルを外す
    await this.emit({ type: "start", runtime: rt });
    if (this.runtime !== rt) return;
    this.removeTitle();
    this.stayOnEnd = false;
    this.resetPlayTime();
    this.enterGame();
    this.run(rt, this.startTranslated(rt, this.env.project.entry));
  }

  /**
   * 訳のファイルを読んでいる途中なら、読み終えてから始める（はじめのページと、`@set 変数 = "文字"` で入れる文字を訳すため）。
   * 待っている間にほかのプレイに替わったら始めない。
   */
  private startTranslated(rt: Runtime, target: string): Promise<RunResult> {
    const pending = this.translationLoading;
    if (!pending) return rt.start(target);
    return pending.then(() => (this.runtime === rt ? rt.start(target) : { reason: "stopped" as const, at: { ...rt.state.position } }));
  }

  startAt(target: string): void {
    void this.loadFlow();
    this.removeTitle();
    // 開発用の早送り（?skip=N）は、ここで始めるプレイにだけ効かせる（createRuntime が外すので控えておく）
    const skip = this.devSkipUntil;
    const rt = this.createRuntime();
    this.devSkipUntil = skip;
    this.stayOnEnd = true;
    this.resetPlayTime();
    this.enterGame();
    // 開発用の早送りは最初のページより前の演出から効かせる
    this.host.devSkipping = this.devSkipUntil > 0;
    this.host.skipping = this.devSkipUntil > 0;
    this.run(rt, this.startTranslated(rt, target));
  }

  // ---- セーブ・ロード ----

  saveTo(slot: SlotId, meta?: Record<string, Value>): boolean {
    const record = this.slotRecord(meta);
    return record !== null && this.storage.saveSlot(slot, record);
  }

  /** 今のプレイをスロットに書く形にする（回想の間・遊んでいないときは null）。save を渡せばそのセーブで（裏へ回ったときの控え）。 */
  private slotRecord(meta?: Record<string, Value>, save?: SaveData): SlotRecord | null {
    const rt = this.runtime;
    // 回想の間はセーブしない
    if (!rt || this.replaying) return null;
    this.flush();
    const tagged = { ...(this.env.slotMeta?.(rt) ?? {}), ...(meta ?? {}) };
    const title = plainText(this.log.current).replace(/\s+/g, " ").trim().slice(0, 60);
    const chapter = this.chapterName(rt);
    const data = save ?? rt.save();
    return {
      version: 1,
      save: data,
      date: new Date().toISOString(),
      title,
      ...(chapter ? { chapter } : {}),
      playTime: Math.round(this.playTime()),
      thumb: captureThumbnail(this.host.stage),
      // 直近のページの読み直すセーブも差分にして入れる（ロードしたあとも一つ戻る・ここに戻るが使える）
      log: this.log.tail(LOG_IN_SAVE, REWIND_IN_SAVE, data),
      ...(Object.keys(tagged).length > 0 ? { meta: tagged } : {}),
      ...this.choicesForSave(),
    };
  }

  /**
   * セーブの一覧に出す章の名前。作品のプラグイン（slotChapter）→ ui.chapterNames（"ファイル#ラベル"、"ファイル"）→
   * liminalia.json の chapters（そのファイルの章の番号と題）→ このプレイで最後に着いたおまけの章の題 → ファイルの名前。
   */
  private chapterName(rt: Runtime): string {
    const at = rt.label;
    const custom = this.env.slotChapter?.(rt, at);
    if (typeof custom === "string") return custom;
    const names = this.project.ui?.chapterNames;
    const named = at && names ? ((at.label !== null ? names[`${at.file}#${at.label}`] : undefined) ?? names[at.file]) : undefined;
    if (named) return named;
    const chapter = at ? chapterOf(this.project.chapters, at.file) : null;
    if (chapter) return typeof chapter.number === "string" && chapter.number !== "" && chapter.number !== chapter.title ? `${chapter.number} ${chapter.title}` : chapter.title;
    const reached = rt.state.stage.extra[CHAPTER_KEY];
    if (typeof reached === "string" && reached) return reached;
    return at?.file ?? "";
  }

  // ---- プレイ時間 ----

  /** 数え終えたプレイ時間（ミリ秒）。 */
  private playMs = 0;
  /** 数えはじめた時刻（遊んでいる最中で、回想でも裏へ回してもいない間。数えていなければ null）。 */
  private playFrom: number | null = null;

  /** このプレイの時間（ミリ秒。はじめから、またはロードしたセーブのプレイ時間から）。 */
  private playTime(): number {
    return this.playMs + (this.playFrom !== null ? performance.now() - this.playFrom : 0);
  }

  /** プレイ時間を ms から数え直す（はじめから・ロード・章から読み直すとき）。 */
  private resetPlayTime(ms = 0): void {
    this.playMs = ms;
    this.playFrom = null;
    this.tickPlayTime();
  }

  /** 遊んでいる最中かどうかに合わせて、数えるのを止める・続ける。 */
  private tickPlayTime(): void {
    const counting = this.mode === "game" && this.runtime !== null && !this.replaying && !this.backgrounded;
    if (counting && this.playFrom === null) this.playFrom = performance.now();
    else if (!counting && this.playFrom !== null) {
      this.playMs += performance.now() - this.playFrom;
      this.playFrom = null;
    }
  }

  /** オートセーブの枠の数（liminalia.json の ui.autosave.slots）。 */
  private get autoCount(): number {
    return autosaveSlotCount(this.env.project.ui);
  }

  autosave(meta?: Record<string, Value>, save?: SaveData): SlotId | null {
    // 制作画面のプレビューでは書かない（テストプレイのセーブに混ざるため）
    if (this.autoCount === 0 || this.mode !== "game" || this.host.context.studio) return null;
    const record = this.slotRecord(meta, save);
    const slot = record ? this.storage.saveAuto(this.autoCount, record) : null;
    if (slot !== null) this.pagesSinceAuto = 0;
    return slot;
  }

  // ---- 時機を決めたオートセーブ（ui.autosave.on） ----

  /** 前のオートセーブから読んだページの数（ui.autosave.on.pages）。 */
  private pagesSinceAuto = 0;
  /** 前のページの章（liminalia.json の chapters の id。このプレイの最初のページの前は undefined）。 */
  private lastChapterKey: string | null | undefined = undefined;
  /** 今のページが章の頭か（ページの頭のセーブができたらオートセーブする）。 */
  private chapterHead = false;

  /** 時機を決めたオートセーブをしてよいか（回想・開発用に途中から始めたプレイ・開発用の早送りの間はしない）。 */
  private get timedAutosave(): boolean {
    return this.mode === "game" && !this.replaying && !this.stayOnEnd && this.pages > this.devSkipUntil;
  }

  /** ページを出し始めた。章の頭なら印を付ける（おまけの章の始まりと、liminalia.json の chapters の章が替わった最初のページ）。 */
  private noteChapterHead(at: { file: string; line: number }): void {
    if (!autosaveTimings(this.env.project.ui).chapter) return;
    const key = chapterOf(this.project.chapters, at.file)?.id ?? null;
    const extraHead = this.chapterAt?.has(`${at.file}:${at.line}`) === true;
    if (this.lastChapterKey !== undefined && ((key !== null && key !== this.lastChapterKey) || extraHead)) this.chapterHead = true;
    this.lastChapterKey = key;
  }

  /** 書くのを待っているページの頭のセーブ（本文を出し終えたら、一覧の見出しにその本文を入れて書く）。 */
  private pendingAutosave: SaveData | null = null;

  /** ページの頭のセーブができた。章の頭か、決めたページ数を読んだら、本文を出し終えたところでオートセーブする。 */
  private autosavePage(save: SaveData): void {
    const timing = autosaveTimings(this.env.project.ui);
    this.pagesSinceAuto++;
    const head = this.chapterHead;
    this.chapterHead = false;
    if (!this.timedAutosave) return;
    if (head || (timing.pages > 0 && this.pagesSinceAuto >= timing.pages)) this.pendingAutosave = save;
  }

  /** 待っていたオートセーブを書く（本文を出し終えた・次のページか選択肢に進んだ）。 */
  private flushPendingAutosave(): void {
    const save = this.pendingAutosave;
    this.pendingAutosave = null;
    if (save && this.timedAutosave) this.autosave(undefined, save);
  }

  autoSlots(): SlotInfo[] {
    return this.newestFirst(autoSlotIds(this.autoCount));
  }

  quickSlots(): SlotInfo[] {
    return this.newestFirst(quickSlotIds(this.quickCount));
  }

  /** 枠の中身を新しい順に（空の枠は後ろ）。 */
  private newestFirst(ids: readonly SlotId[]): SlotInfo[] {
    const time = (s: SlotInfo) => (s.empty ? -Infinity : Date.parse(s.date ?? "") || 0);
    return ids.map((id) => this.slot(id)).sort((a, b) => time(b) - time(a));
  }

  /** クイックセーブの枠の数（liminalia.json の ui.quickSave.slots）。 */
  private get quickCount(): number {
    return quickSlotCount(this.env.project.ui);
  }

  /**
   * 終了するときと裏へ回ったときにもオートセーブするか（ui.autosave.leave）。書いていなければ、ロード画面が標準のときだけ
   * （作品が差し替えたロード画面はオートセーブを出さないことがあり、遊ぶ人が読めない枠を書き続けないように）。
   */
  private get leaveAutosave(): boolean {
    const leave = this.env.project.ui?.autosave?.leave;
    return leave ?? !this.env.screens?.saveload;
  }

  /** 最後に裏へ回ったときにオートセーブした時刻（pagehide と visibilitychange など、続けて来たものを一つにする）。 */
  private leftAt = -Infinity;
  /** このページが裏へ回ったときに、続きの印（resumeLeft）を残したか。 */
  private leftMarked = false;

  leave(): void {
    this.flush();
    const rt = this.runtime;
    // 遊んでいないとき・回想・開発用に途中から始めたプレイ（制作画面のプレビューを含む）・巻き戻しの組み立て直しの途中は書かない
    if (!this.leaveAutosave || !rt || this.mode !== "game" || this.replaying || this.stayOnEnd || this.rollBusy) {
      // 遊んでいないところで裏へ回ったら、このページが前に残した印は要らない（読み直す前のページの印は消さない）
      if (this.leftMarked) {
        this.leftMarked = false;
        this.storage.remove("resume");
      }
      return;
    }
    // クリック待ちか選択肢ならその時点、演出の途中なら最後に出したページ（か選択肢）の頭から再開する
    const settled = this.host.waiting || this.choosing;
    const save = settled ? undefined : this.stableSave;
    if (!settled && !save) return;
    const now = performance.now();
    if (now - this.leftAt < 1000) return;
    this.leftAt = now;
    const slot = this.autosave(undefined, save ?? undefined);
    // 裏にいる間に描画のプロセスが落ちて読み直したら（スマホのアプリ）、このオートセーブから続ける（resumeLeft）
    if (slot !== null) this.leftMarked = this.storage.write("resume", slot);
  }

  /**
   * 裏へ回したときのオートセーブから続ける（スマホのアプリが、落ちた描画のプロセスを作り直して読み直したとき。?resume=1）。
   * 裏へ回したまま戻っていなければ、そのときのオートセーブを読み込んで true。無ければ false（ふつうに起動する）。
   */
  async resumeLeft(): Promise<boolean> {
    const slot = this.storage.read<string>("resume");
    this.storage.remove("resume");
    if (typeof slot !== "string" || !slot.startsWith("auto:") || !this.storage.loadSlot(slot as SlotId)) return false;
    await this.loadFrom(slot as SlotId);
    return this.mode === "game";
  }

  /**
   * ゲームを終える（メニューとタイトルの「終了」）。デスクトップ版でもページから閉じると閉じる前の知らせ（onBeforeClose）が来ないので、
   * 先に書いてから閉じる（書き込みは閉じる前に送ったものから届く）。Android のアプリはアプリを閉じる。
   */
  private quit(): void {
    this.leave();
    // IndexedDB に書き終えてから閉じる（長くは待たない。書き終わらなかった分は閉じるときに JOURNAL へ置く）
    void Promise.race([flushSaveStore(), new Promise((r) => setTimeout(r, 1000))]).then(() => quitApp());
  }

  /**
   * 戻る（Android のアプリの戻るボタンとなぞり、スマホのブラウザの戻る。SystemController.back）。扱ったら true。
   * 開いている画面を閉じる（Esc と同じ。遊ぶ人の操作を待つ画面が戻るを扱わなければメニュー）→ 隠した枠を戻す →
   * ゲーム中はメニュー（ショートカットを止めていれば何もしない）→
   * タイトルでは、アプリを閉じられるなら終わるかを尋ね、閉じられなければ扱わない（ブラウザは前のページへ戻る）。
   */
  back(): boolean {
    if (this.screens.length > 0) {
      this.backScreen();
      return true;
    }
    if (this.mode === "game") {
      if (this.hidden) this.setHidden(false);
      else if (this.host.shortcuts) this.openMenu();
      return true;
    }
    if (this.mode === "title" && canQuitApp()) {
      void this.ask(TEXT.confirm.exit, "exit").then((yes) => yes && this.quit());
      return true;
    }
    return false;
  }

  /** いちばん新しいセーブ（番号つき・クイック・オートセーブのうち）。タイトルの「つづきから」。 */
  private latestSave(): SlotId | null {
    return this.storage.latestSlot(this.slotCount, this.autoCount, this.quickCount);
  }

  /** セーブに入れる選択肢の控え（履歴の件数は、セーブに入れる履歴の末尾から数え直す。それより前に出したものは 0）。 */
  private choicesForSave(): { choices?: ChoicePoint[] } {
    if (this.choices.points.length === 0) return {};
    return { choices: this.choices.forSave(Math.max(0, this.log.entries.length - LOG_IN_SAVE), CHOICES_IN_SAVE) };
  }

  /** そのスロットから再開する。読み込みを始めたら解決する（プレイの終わりは待たない）。 */
  async loadFrom(slot: SlotId): Promise<void> {
    const record = this.storage.loadSlot(slot);
    if (!record) return;
    // 新しい版のゲームで作ったセーブ・壊れたセーブは、プレイを捨てる前に知らせて止める
    const problem = saveProblem(record.save);
    if (problem) return toast(this.layer, problem === "newer" ? TEXT.saves.newer : TEXT.saves.broken);
    await this.emit({ type: "load-start", from: "slot" });
    this.closeAllScreens();
    this.removeTitle();
    // 舞台は load の restore が組み立て直すので、ここでは空にしない
    const rt = this.createRuntime();
    this.log.restore(record.log, record.save);
    this.choices.replace(record.choices ?? []);
    this.stayOnEnd = false;
    this.resetPlayTime(typeof record.playTime === "number" && Number.isFinite(record.playTime) ? Math.max(0, record.playTime) : 0);
    this.enterGame();
    this.run(rt, rt.load(record.save));
    this.reopenScreens(record.save);
  }

  /**
   * 今の状態を控えて台本を読み直し、同じ場所から続ける（テストプレイの「この場所から読み直す」。SystemController.reloadHere）。
   * スロットからのロードと同じく履歴・選択肢の控え・プレイ時間を引き継ぎ、新しい実行器が台本を読み直す（行がずれていても、ロードと同じく
   * 同じページを探して続ける）。開発用に途中から始めたプレイなら、終わってもタイトルへ戻らないまま。遊んでいないとき・回想中は false。
   */
  async reloadHere(): Promise<boolean> {
    const rt = this.runtime;
    if (!rt || this.mode !== "game" || this.replaying) return false;
    this.flush();
    const save = rt.save();
    const log = this.log.tail(LOG_IN_SAVE, REWIND_IN_SAVE, save);
    const { choices } = this.choicesForSave();
    const playTime = this.playTime();
    const stay = this.stayOnEnd;
    // 今のページの文を直していても同じページから続けられるよう、前後の変わっていないページから直したあとの行を求めておく
    const file = save.position.unit.split("::")[0]!;
    const oldKeys = rt.pageKeysOf(file);
    // 選択肢の飛び先の既読を割り出すために読んだ台本も読み直す
    this.scripts.clear();
    this.closeAllScreens();
    const next = this.createRuntime();
    const anchor = save.position.anchor;
    if (anchor && oldKeys) {
      try {
        const oldProgram = await rt.program(file, true);
        const newProgram = await next.program(file);
        const line = relocatedLine(oldProgram, newProgram, anchor.line);
        if (line !== null) save.position.anchor = { ...anchor, line };
      } catch {
        // 読めなければロードと同じ探し方に任せる（誤りは load が知らせる）
      }
      if (this.runtime !== next) return false;
    }
    this.log.restore(log, save);
    this.choices.replace(choices ?? []);
    this.stayOnEnd = stay;
    this.resetPlayTime(playTime);
    this.enterGame();
    this.run(next, next.load(save));
    this.reopenScreens(save);
    return true;
  }

  /** セーブデータから始める（制作画面の舞台）。ページか選択肢を出し始めたら解決する。終わってもタイトルへは戻らない。 */
  async loadSave(save: SaveData): Promise<void> {
    this.markShown();
    this.closeAllScreens();
    this.removeTitle();
    const rt = this.createRuntime();
    this.stayOnEnd = true;
    this.enterGame();
    let waiter: (() => void) | null = null;
    const shown = new Promise<void>((resolve) => (waiter = this.shownWaiter = resolve));
    const done = rt.load(save);
    this.reopenScreens(save);
    this.run(rt, done);
    // 着く前に終わったとき（捨てたプレイが後から終わっても、次の loadSave の待ちは解かない）
    void done.finally(() => this.shownWaiter === waiter && this.markShown());
    await shown;
  }

  private markShown(): void {
    const resolve = this.shownWaiter;
    this.shownWaiter = null;
    resolve?.();
  }

  installSeedSaves(seeds: SeedSave[]): void {
    const applied = this.storage.read<string[]>("seed-applied") ?? [];
    for (const seed of seeds) {
      if (applied.includes(seed.id)) continue;
      if (this.storage.loadSlot(seed.slot) && !seed.overwrite) {
        console.info(`テスト用セーブデータ ${seed.id} は、スロット ${seed.slot} が使用中のため追加しませんでした`);
        continue;
      }
      if (this.storage.saveSlot(seed.slot, { version: 1, save: seed.save, date: new Date().toISOString(), title: seed.title })) applied.push(seed.id);
    }
    this.storage.write("seed-applied", applied);
  }

  // ---- 一回のプレイ ----

  /** 読んだ台本の控え（プレイをまたいで使う。runtime の ProgramCache）。 */
  private readonly programCache: ProgramCache = new Map();

  /** 前のプレイを（舞台は残したまま）捨てて、新しい Runtime を作る。 */
  private createRuntime(): Runtime {
    this.endGame(false);
    this.returnToTitle = false;
    this.ending = null;
    this.replaying = null;
    this.pages = 0;
    // 開発用の早送りは startAt で始めたプレイだけのもの。巻き戻し、ロード、タイトルからの開始で作り直したプレイでは、頭からまた飛ばさない
    this.devSkipUntil = 0;
    this.log.clear();
    this.choices.clear();
    this.future = [];
    this.futureChoices = [];
    this.rolling = false;
    this.revisited = null;
    this.stableSave = null;
    this.pagesSinceAuto = 0;
    this.lastChapterKey = undefined;
    this.chapterHead = false;
    this.pendingAutosave = null;
    const session = new Session(this.host, this, this.log);
    const rt = new Runtime(session, {
      // 作品の設定から作るもの（画面なしで流す lim trace、lim test、制作画面の現在地なども同じ関数で作る）。章の題とおまけ（CG、実績）は
      // 遊んでいる言語の訳を当てたもの
      ...projectRuntimeOptions({
        config: { ...this.env.project, chapters: this.project.chapters, extra: this.project.extra },
        speakers: this.env.speakers,
        commands: this.env.commands,
        cast: this.env.host.cast,
        voiceLock: this.env.project.voiceLock ?? null,
        // 式の lang() と訳（言語を替えたら loadLanguage が入れ直す）
        language: this.language,
        translator: this.translator,
      }),
      onError: "continue",
      // 巻き戻しやロードで実行器を作り直しても、本文の同じ台本は読み解き直さない
      programCache: this.programCache,
      ...(this.env.onAssign ? { onAssign: this.env.onAssign } : {}),
      // 作品の画面（openScreen の pauseScenario）が開いている間は、次の命令を実行しない
      beforeStep: (at: { file: string; line: number }) => {
        const gate = this.scenarioGate();
        return gate ? gate.then(() => this.env.beforeStep?.(at)) : this.env.beforeStep?.(at);
      },
      // 台詞の外側の括弧と引用符（ui.text.quotes）は描画側の今の設定で決める（開発中に設定を替えても、言語を替えても次のページから効く）
      stripQuotes: () => this.host.stripsQuotes,
    });
    rt.system = this.system;
    // 式の platform()・app()
    rt.platform = detectPlatform();
    this.session = session;
    this.runtime = rt;
    return rt;
  }

  private enterGame(): void {
    this.mode = "game";
    this.pageWasRead = true;
    this.sync();
  }

  private run(rt: Runtime, done: Promise<RunResult>): void {
    void done.then((result) => {
      if (this.runtime !== rt) return; // ロード・タイトルで捨てたプレイ
      this.flush();
      this.env.onEnd?.(result);
      if (this.replaying) {
        void this.endReplay();
        return;
      }
      // @title-screen で終えたプレイは、開発用の ?start= で始めたものでもタイトルへ戻る
      if (this.returnToTitle) {
        this.returnToTitle = false;
        void this.endToTitle();
        return;
      }
      if (this.stayOnEnd || result.reason === "stopped") return;
      void this.endToTitle();
    });
  }

  /** 今のプレイを捨てる。clear なら舞台も空にする（何も表示していない状態で組み立て直す）。 */
  private endGame(clear = true): void {
    if (this.runtime) {
      this.session?.close();
      this.runtime.dispose();
      this.runtime = null;
      this.session = null;
      this.flush();
      if (clear) void this.host.present({ type: "command", name: "restore", args: {}, wait: false, stage: initialStage() });
    }
    this.auto = false;
    this.skip = false;
    this.toChoice = false;
    this.toUnread = false;
    this.hidden = false;
    this.choosing = false;
    this.afterChoice = null;
    this.host.devSkipping = false;
    this.host.skipping = false;
    this.host.instantPage = false;
    this.sync();
  }

  /** タイトルの要素を外す（画面の JS の片付けも呼ぶ）。 */
  private removeTitleEl(): void {
    this.titleEl?.remove();
    this.titleEl = null;
    const dispose = this.titleDispose;
    this.titleDispose = null;
    dispose?.();
  }

  private removeTitle(): void {
    this.removeTitleEl();
    if (this.titleBgm) {
      this.titleBgm = false;
      this.env.host.audio.stopBgm(500);
    }
  }

  // ---- Session から ----

  afterPage(): void {
    // 実行器はページの頭で再開する位置と状態を控えているので、ここでのセーブはこのページから読み直すもの
    const rt = this.runtime;
    if (!rt || this.mode !== "game" || this.replaying) return;
    const save = rt.save();
    this.log.attachResume(save);
    this.stableSave = save;
    this.autosavePage(save);
  }

  /** 最後に出したページの頭（か選択肢）のセーブ。演出の途中で裏へ回ったときは、ここから再開するようにオートセーブする。 */
  private stableSave: SaveData | null = null;

  beforePage(at: { file: string; line: number; key?: string }): void {
    this.markShown();
    // 前のページで待っていたオートセーブ（クリックを待たずに進んだページなど）
    this.flushPendingAutosave();
    this.pages++;
    this.a11y?.stop();
    this.snapshotScene(at);
    this.reachChapter(at);
    this.noteChapterHead(at);
    this.passRoll("page", `${at.file}:${at.line}`, this.log.entries.length);
    this.pruneScreenEntries();
    const devSkipping = this.pages < this.devSkipUntil;
    // 前のバージョンが行で覚えた既読は、そのファイルを読んだところで今のシナリオの鍵に移す
    this.adoptLegacyRead(at.file);
    this.pageWasRead = this.read.has(at);
    this.passUnreadPage = false;
    this.host.setPageRead(this.pageWasRead && !devSkipping);
    // 開発用の早送りで飛ばしたページは既読にしない
    if (!devSkipping && this.read.add(at)) this.scheduleReadSave();
    // 既読だけを飛ばす設定なら、未読のページでスキップを止める
    if (this.skip && (!this.prefs.skipUnread || this.toUnread) && !this.pageWasRead && !this.toChoice) {
      this.skip = false;
      this.toUnread = false;
    }
    this.updateSkipping(false);
    this.sync();
  }

  autoDelay(chars: number): number | null {
    if (!this.auto || this.mode !== "game" || this.screen || this.hidden || this.choosing || this.host.skipping || this.backgrounded) return null;
    return autoDelay(this.prefs, chars);
  }

  speaking(): boolean {
    return this.a11y.speaking;
  }

  choiceTimers(): boolean {
    return this.prefs.choiceTimer;
  }

  /** 本文の外で出したもの（章の扉の題など）を、すぐにスクリーンリーダーとテキスト読み上げに渡す（飛ばしている間は渡さない）。 */
  announce(text: string): void {
    if (this.host.skipping) return;
    this.a11y.announce(text);
  }

  heardVoice(speaker: string): void {
    if (this.prefs.voiceSpeakers.includes(speaker)) return;
    this.prefs = { ...this.prefs, voiceSpeakers: [...this.prefs.voiceSpeakers, speaker] };
    this.storeSettings(this.prefs);
  }

  /**
   * 描画側へ送った命令（ムービーを @movie で流したら、立ち絵の差分を出したら解放する）。
   * 一覧にある CG を @bg などで出したときの解放は、実行器がする（Runtime の options.cg。スキップ中や画面のない実行でも同じに効くように）。
   */
  command(name: string, args: Record<string, Value>): void {
    // 読み上げのときだけの文（@describe）と、絵の説明（@bg・@chara・@image の alt）は、次の本文と一緒に読む（飛ばしている間のものは読まない）
    if (!this.host.skipping) {
      if (name === "describe" && typeof args.text === "string") this.a11y.describe(args.text);
      else if ((name === "bg" || name === "chara" || name === "image") && typeof args.alt === "string" && args.alt !== "") this.a11y.describe(args.alt);
    }
    this.noteSeen(name, args, this.runtime?.state.stage.sprites);
  }

  /**
   * 見たものを鑑賞のために覚える（ムービーを @movie で流したら、立ち絵の差分を出したら解放する）。sprites はその命令を動かした直後の
   * 立ち絵（「次の選択肢へ」で飛ばした命令は、先へ流した実行器のその時点のもの）。
   */
  private noteSeen(name: string, args: Record<string, Value>, sprites: Readonly<Record<string, Sprite>> | undefined): void {
    const extra = this.project.extra;
    if (name === "movie" && typeof args.file === "string" && extra?.movies?.some((m) => m.file === args.file)) {
      ((this.system.movies_seen ??= {}) as Record<string, Value>)[args.file] = true;
      return;
    }
    if (name === "chara" && typeof args.who === "string" && extra?.characters?.some((c) => c.who === args.who)) {
      this.seeSprite(args.who, sprites?.[args.who]);
      return;
    }
  }

  /** 出した立ち絵の差分を、立ち絵の鑑賞のために覚える（sprites_seen: キャスト → 立ち絵セット → 差分）。 */
  private seeSprite(who: string, sprite: Sprite | undefined): void {
    const entry = this.host.context.cast[who];
    if (!sprite || !entry) return;
    const appearance = appearanceKey(entry, sprite.appearance);
    const set = entry.appearances[appearance];
    const name = sprite.variant.split("+")[0] || baseVariant(set);
    if (!name || !set?.variants[name]) return;
    const seen = (this.system.sprites_seen ??= {}) as Record<string, Record<string, Record<string, Value>>>;
    ((seen[who] ??= {})[appearance] ??= {})[name] = true;
  }

  /** 選択肢を選んだら戻すオート・スキップ（コンフィグの「選択肢のあとのオート」「選択肢のあとのスキップ」）。 */
  private afterChoice: { auto: boolean; skip: boolean } | null = null;

  setChoosing(active: boolean): void {
    if (active) this.markShown();
    const was = this.choosing;
    this.choosing = active;
    if (active) {
      // 選択肢では止める。選んだあとに続けるなら控えておく（次の選択肢へ・次の未読へで始めたスキップは続けない）
      this.afterChoice = {
        auto: this.auto && this.prefs.autoAfterChoice,
        skip: this.skip && this.prefs.skipAfterChoice && !this.toChoice && !this.toUnread,
      };
      this.auto = false;
      this.skip = false;
      this.toChoice = false;
      this.toUnread = false;
      const rt = this.runtime;
      const at = rt ? `${rt.state.position.unit}:${rt.state.position.index}` : "";
      const log = this.log.entries.length;
      this.revisited = this.futureChoices.find((p) => p.at === at && p.log === log) ?? null;
      // 巻き戻しで組み立て直した選択肢か（オートセーブしない）
      const rebuilt = this.rolling;
      this.flushPendingAutosave();
      this.passRoll("choice", at, log);
      this.rememberChoice();
      if (rt && !this.replaying) this.stableSave = rt.save();
      // 選択肢を出したらオートセーブ（ui.autosave.on.choice。既定はする）
      if (!rebuilt && this.stableSave && this.timedAutosave && autosaveTimings(this.env.project.ui).choice) this.autosave(undefined, this.stableSave);
      // 選択肢を読み上げる（ボタンを並べ終えてから。書き出しで初めての選択肢は、型を読む間だけ遅れるので、並ぶまで少し待つ）
      const announce = (tries: number) =>
        setTimeout(() => {
          if (!this.choosing) return;
          const options = [...this.host.stage.querySelectorAll<HTMLElement>(CHOICE_BUTTONS)].map((b) => b.getAttribute("aria-label") || b.textContent || b.querySelector("img")?.alt || "");
          if (options.length > 0) this.a11y.choices(options, TEXT.a11y.choices);
          else if (tries > 0) announce(tries - 1);
        }, 80);
      announce(25);
    }
    this.updateSkipping(false);
    this.sync();
    // 選んだら、控えたオート・スキップに戻す
    const resume = !active && was ? this.afterChoice : null;
    if (!active) this.afterChoice = null;
    if (resume?.auto) this.setAuto(true);
    else if (resume?.skip) this.setSkip(true);
  }

  onDiagnostic(d: Diagnostic): void {
    this.env.onDiagnostic(d);
  }

  // ---- オート・スキップ・枠 ----

  /** 今スキップしてよいかを host.skipping に入れる。kick なら、スキップに入ったときに今の待ちをすぐ送る。 */
  private updateSkipping(kick = true): void {
    const dev = this.pages < this.devSkipUntil;
    const wanted = (this.skip || this.ctrlHeld) && this.mode === "game" && !this.choosing && !this.screen && !this.hidden;
    const allowed = (this.prefs.skipUnread && !this.toUnread) || this.pageWasRead || this.toChoice || (this.toUnread && this.passUnreadPage);
    const was = this.host.skipping;
    this.host.devSkipping = dev;
    this.host.skipping = dev || (wanted && allowed);
    if (kick && this.host.skipping && !was) this.host.advance();
    if (this.host.skipping !== was) this.syncIndicator();
  }

  private setAuto(on: boolean): void {
    this.auto = on && this.mode === "game";
    if (this.auto) this.skip = false;
    this.updateSkipping();
    this.sync();
    this.session?.scheduleAuto();
  }

  private setSkip(on: boolean): void {
    this.skip = on && this.mode === "game" && !this.choosing;
    if (!this.skip) {
      this.toChoice = false;
      this.toUnread = false;
    }
    if (this.skip) this.auto = false;
    this.updateSkipping();
    this.sync();
  }

  private setHidden(hidden: boolean): void {
    // 枠が出ていないとき（@window hide の後・作品の命令が自分の画面を出しているとき）は隠すものがない。
    // 隠した扱いにすると、次のクリックが枠を戻すだけに使われ、その画面の操作が一度効かなくなる
    this.hidden = hidden && this.status.window && !this.choosing;
    this.updateSkipping();
    this.sync();
    if (!this.hidden) this.session?.scheduleAuto();
  }

  /** 帯と枠の表示を今の状態に合わせる。 */
  private sync(): void {
    const game = this.mode === "game" && this.runtime !== null;
    const barVisible = game && this.menuButton && !this.screen && !this.hidden && !this.host.uiCovered && !this.host.messageSuppressed;
    const { canRollback, canRollforward, canReplayVoice } = this.status;
    this.bar.sync({ visible: barVisible, auto: this.auto, skip: this.skip, replay: this.replaying !== null, canRollback, canRollforward, canReplayVoice: canReplayVoice === true });
    // スマホのメニューのボタンは、遊ぶ人の操作を待つ画面（調べる画面・地図など）を出している間も出す（帯はその画面に隠れるので出さない）。
    // その画面は右上をボタンの分だけ空ける（class の lm-menu-room。空ける大きさは input.css の --lm-menu-room-x・y。上にメニューを開いている間も空けたまま）
    this.input?.setMenuButtonVisible(barVisible || (game && this.menuButton && this.overScreen && !this.hidden && !this.host.uiCovered));
    this.host.stage.classList.toggle("lm-menu-room", game && this.menuButton && this.screens.some((s) => s.allowMenu === true));
    this.host.stage.classList.toggle("lm-window-hidden", game && this.hidden);
    this.host.stage.classList.toggle("lm-choosing", game && this.choosing);
    this.syncIndicator();
    this.tickPlayTime();
    // 画面を開いている間と裏へ回している間は、選択肢の制限時間を止める（ui.screen.pauseScenario にかかわらず）
    this.host.pauseTimers(this.screens.length > 0 || this.backgrounded);
    // オートの間は画面を消さない（スリープさせない）
    keepAwake("auto", game && this.auto);
    this.emitStatus();
  }

  // ---- 裏へ回したとき ----

  /**
   * 止めているわけ。background はタブを裏へ回している（ui.screen.pauseInBackground が false でなければ）、rotate は横長の作品を
   * 縦に持っていて「横にしてください」が画面を覆っている。どれかがあれば、音・動画・オート・選択肢の制限時間を止めている。
   */
  private readonly pauseReasons = new Set<"background" | "rotate">();
  /** 裏へ回したときに止めた動画と音の要素（戻ったら続ける）。 */
  private pausedMedia: HTMLMediaElement[] = [];
  /** デスクトップ版で最小化している（殻が知らせる）。 */
  private windowMinimized = false;
  /** ほかのウィンドウを選んでいる（ゲームのウィンドウが前に出ていない）。 */
  private unfocused = false;
  /** 裏へ回したかほかのウィンドウを選んだので、音を消している（遊ぶ人の設定がミュート）。 */
  private inactiveMute = false;

  /** 最小化したとき（タブを裏へ回したとき）の動き。遊ぶ人が決めていなければ作品の設定（ui.screen.pauseInBackground）。 */
  private get hiddenAction(): InactiveAction {
    return this.prefs.whenHidden || (this.env.project.ui?.screen?.pauseInBackground === false ? "play" : "pause");
  }

  /** 裏へ回したか、ほかのウィンドウを選んだかと、遊ぶ人の設定から、止める・音を消す・そのままにする。 */
  private syncInactive(): void {
    const hidden = (typeof document !== "undefined" && document.visibilityState === "hidden") || this.windowMinimized;
    const action = hidden ? this.hiddenAction : this.unfocused ? this.prefs.whenUnfocused : "play";
    this.setBackground(action === "pause");
    if (this.inactiveMute !== (action === "mute")) {
      this.inactiveMute = action === "mute";
      this.host.audio.setVolume(this.prefs.master, this.prefs.mute || this.inactiveMute);
    }
  }

  /**
   * デスクトップ版で、最小化したときに描画と時計を絞るか。最小化しても進める設定（ミュートかそのまま）なら絞らない
   * （絞ると、文字の表示とオートが進まない）。
   */
  private syncThrottling(): void {
    window.liminaliaDesktop?.setBackgroundThrottling?.(this.hiddenAction === "pause");
  }

  /** 止めているか（裏へ回している・縦持ちの知らせが覆っている）。 */
  private get backgrounded(): boolean {
    return this.pauseReasons.size > 0;
  }

  /** 裏へ回した・ほかのウィンドウを選んだ（syncInactive が、遊ぶ人の設定と作品の設定から止めるかを決める）。 */
  private setBackground(hidden: boolean): void {
    this.setPaused("background", hidden);
  }

  /** 止めるわけを足す・外す。止めるのは鳴っている音（Web Audio）、再生中の動画、テキスト読み上げ、オート、選択肢の制限時間。 */
  private setPaused(reason: "background" | "rotate", on: boolean): void {
    const was = this.backgrounded;
    if (on) this.pauseReasons.add(reason);
    else this.pauseReasons.delete(reason);
    const hidden = this.backgrounded;
    if (hidden === was) return;
    const context = this.host.audio.context;
    const speech = typeof speechSynthesis === "undefined" ? null : speechSynthesis;
    if (hidden) {
      void context.suspend().catch(() => undefined);
      this.pausedMedia = [...this.host.stage.querySelectorAll<HTMLMediaElement>("video, audio")].filter((m) => !m.paused && !m.ended);
      for (const m of this.pausedMedia) m.pause();
      speech?.pause?.();
    } else {
      void context.resume().catch(() => undefined);
      for (const m of this.pausedMedia.splice(0)) if (m.isConnected) void m.play().catch(() => undefined);
      speech?.resume?.();
    }
    this.sync();
    // 戻ったら、オートは待ち時間を数え直して送る
    if (!hidden) this.session?.scheduleAuto();
  }

  // ---- オート中・スキップ中の表示 ----

  /** オート中・スキップ中の表示（ui.indicator の位置。作品の差し替えは screens.indicator）。 */
  private readonly indicator: HTMLElement;

  private makeIndicator(): HTMLElement {
    const custom = this.env.screens?.indicator;
    const status = () => this.status;
    const node = custom
      ? custom({
          get status() {
            return status();
          },
          onStatusChange: (l) => this.onStatusChange(l),
          label: (state) => (state === "auto" ? TEXT.menu.auto : TEXT.menu.skip),
        })
      : el("div", "", el("span", "lm-indicator-mark"), el("span", "lm-indicator-label"));
    node.classList.add("lm-indicator");
    node.setAttribute("role", "status");
    node.hidden = true;
    return node;
  }

  /** 表示の位置。書いていなければ左上で、作品が帯だけを差し替えているときは出さない（作品の帯がオート・スキップを見せるため）。 */
  private get indicatorAt(): string {
    return this.env.project.ui?.indicator ?? (this.env.screens?.menuBar && !this.env.screens.indicator ? "hidden" : "top-left");
  }

  /** 今の様子に合わせる。Ctrl・RB を押している間のスキップも「スキップ」に数える。 */
  private syncIndicator(): void {
    const node = this.indicator;
    if (!node) return;
    const at = this.indicatorAt;
    const playing = this.mode === "game" && this.runtime !== null && !this.screen && !this.hidden;
    const state = !playing ? "" : this.auto ? "auto" : this.skip || (this.ctrlHeld && this.host.skipping) ? "skip" : "";
    for (const c of [...node.classList]) if (c.startsWith("lm-indicator-at-")) node.classList.remove(c);
    node.classList.add(`lm-indicator-at-${at}`);
    node.hidden = at === "hidden" || state === "";
    if (node.dataset.state === state) return;
    node.dataset.state = state;
    const label = node.querySelector(":scope > .lm-indicator-label");
    if (label && state) label.textContent = state === "auto" ? TEXT.menu.auto : TEXT.menu.skip;
  }

  // ---- 引き継ぎ ----

  get systemVariables(): Record<string, Value> {
    return this.system;
  }

  importData(data: ImportData): number {
    let failed = 0;
    for (const s of data.slots ?? []) {
      const ok = this.storage.saveSlot(s.slot, { version: 1, save: s.save, date: s.date ?? new Date().toISOString(), title: s.title ?? "", ...(s.thumb ? { thumb: s.thumb } : {}), ...(s.meta ? { meta: s.meta } : {}) });
      if (!ok) failed++;
    }
    if (data.system) Object.assign(this.system, structuredClone(data.system));
    for (const [file, pages] of Object.entries(data.read ?? {})) if (Array.isArray(pages)) this.read.merge(file, pages);
    if (data.settings) this.updateSettings(data.settings);
    this.flush();
    return failed;
  }

  // ---- 様子と出来事（作品の UI が見る） ----

  private readonly statusListeners = new Set<(s: SystemStatus) => void>();
  private readonly eventListeners = new Set<(e: SystemEvent) => void | Promise<void>>();
  private lastStatus = "";

  /** 標準の画面の見た目の差し替え（WebPlugin.screens を重ねたもの）。標準の命令の画面（図鑑）が読む。 */
  get standardScreens(): Readonly<StandardScreens> | undefined {
    return this.env.screens;
  }

  /** 選んでいるテーマ（ui.system.preset。標準のテーマなら null）。 */
  get theme(): string | null {
    return this.env.project.ui?.system?.preset ?? null;
  }

  /** 全画面とウィンドウを切り替える（Alt+Enter と、操作の fullscreen）。全画面にできない環境では何もしない。 */
  private toggleFullscreen(): void {
    if (!fullscreen.supported() && !window.liminaliaDesktop?.setFullscreen) return;
    this.updateSettings({ fullscreen: !this.fullscreenNow });
  }

  get status(): SystemStatus {
    const game = this.mode === "game" && this.runtime !== null;
    const window = game && this.runtime!.state.stage.window;
    return {
      mode: this.mode,
      screen: this.screen,
      choosing: this.choosing,
      hidden: this.hidden,
      window,
      waiting: game && this.host.waiting && !this.choosing,
      auto: this.auto,
      skip: this.skip,
      replay: this.replaying !== null,
      menuBar: game && !this.screen && !this.hidden && window && !this.choosing && !this.host.uiCovered && !this.host.messageSuppressed,
      canPrevChoice: game && this.choices.previous(this.choosing) !== null,
      canRollback: game && this.rollbackTarget() !== null,
      canRollforward: game && this.rollbackOn && !this.replaying && this.future.length > 0,
      canReplayVoice: game && !!this.pageVoice(),
    };
  }

  onStatusChange(listener: (s: SystemStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onEvent(listener: (e: SystemEvent) => void | Promise<void>): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** 様子が変わっていれば知らせる。 */
  private emitStatus(): void {
    // 作品の帯は、メッセージ枠が出ていて選択肢を出していないときだけ（status.menuBar）。
    // @window hide のように sync を通らずに状態だけ変わる命令でも合わせるため、状態を知らせるたびに合わせる
    if (this.customBar) this.customBar.hidden = !(this.menuButton && this.status.menuBar && this.env.project.ui?.menuBar?.position !== "hidden");
    if (this.statusListeners.size === 0) return;
    const status = this.status;
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    for (const l of this.statusListeners) l(status);
  }

  /** 出来事を知らせ、受け手の Promise が済むまで待つ（受け手が投げても止めない）。 */
  private async emit(event: SystemEvent): Promise<void> {
    await Promise.all([...this.eventListeners].map(async (l) => {
      try {
        await l(event);
      } catch (e) {
        console.warn(e);
      }
    }));
    if (event.type === "load-start") {
      // ロードの幕（WebPlugin.transitions.load）を下ろし切ってから、今のプレイを捨てる。組み立て直したら load-end で上げる
      this.pendingLoad = event.from;
      try {
        await this.env.transitions?.load?.cover(this.host.context, { from: event.from });
      } catch (e) {
        console.warn("ロードの幕（transitions.load）を下ろせません", e);
      }
    }
  }

  /** load-start を知らせ、組み立て直しを待っているロード。 */
  private pendingLoad: LoadFrom | null = null;

  /** 組み立て直したら、待っていたロードの終わりを知らせて幕を上げる。 */
  private loadRestored(): void {
    const from = this.pendingLoad;
    if (from === null) return;
    this.pendingLoad = null;
    void this.emit({ type: "load-end", from });
    this.host.emitRender({ type: "load-end", from });
    try {
      void Promise.resolve(this.env.transitions?.load?.reveal(this.host.context, { from })).catch((e: unknown) => console.warn("ロードの幕（transitions.load）を上げられません", e));
    } catch (e) {
      console.warn("ロードの幕（transitions.load）を上げられません", e);
    }
  }

  afterCommand(): void {
    this.emitStatus();
  }

  waitingChanged(waiting?: boolean): void {
    // ページを出し終えたら、帯の「ボイスを再生」をそのページのボイスに合わせる（本文の中の @voice は出す途中で付く）
    if (waiting) this.sync();
    else this.emitStatus();
    // ページを出し終えたら、待っていたオートセーブを書く（一覧の見出しはそのページの本文）
    if (waiting) this.flushPendingAutosave();
    // ページを出し終えたら、読み上げとスクリーンリーダーに渡す（飛ばしている間は読まない）
    const entry = this.log.current;
    if (waiting && entry && !this.host.skipping) this.a11y.page(entryName(entry), plainText(entry), !!entry.voice, spokenText(entry));
  }

  // ---- 操作 ----

  perform(action: MenuEntry): Promise<void> {
    return this.act(action);
  }

  get toggles(): { auto: boolean; skip: boolean; hidden: boolean } {
    return { auto: this.auto, skip: this.skip, hidden: this.hidden };
  }

  // ---- 作品の章（遊びはじめる前でも読める） ----

  get chapters(): readonly ChapterInfo[] {
    return this.project.chapters ?? [];
  }

  chapterOf(file: string): ChapterInfo | null {
    return chapterOf(this.project.chapters, file);
  }

  // ---- 設定・履歴・スロット（作品の画面から使う） ----

  private readonly settingsListeners = new Set<(s: Readonly<Settings>) => void>();

  get settings(): Readonly<Settings> {
    return this.prefs;
  }

  /**
   * 古い書き方（公開する前の、設定を直に書き換えるもの）。保存と反映はしないので、updateSettings を使う。
   * 書き換えていた作品が壊れないように残す。
   */
  set settings(next: Readonly<Settings>) {
    this.prefs = normalizeSettings(next, this.prefs);
  }

  updateSettings(patch: SettingsPatch): Readonly<Settings> {
    const before = this.prefs;
    this.prefs = mergeSettings(this.prefs, patch);
    this.storeSettings(this.prefs);
    this.applySettings();
    // 言語を替えたら、文言を替えてから設定画面を開き直す（訳のファイルは読めたら効く）
    const language = this.prefs.language;
    if (language !== before.language && language !== "" && language !== this.language) {
      this.language = language;
      setUiLanguage(language, this.env.texts ?? {});
      this.useAssetLanguage();
      void this.loadLanguage(language).then(() => this.reopenConfig());
      this.reopenConfig();
    }
    return this.prefs;
  }

  onSettingsChange(listener: (s: Readonly<Settings>) => void): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  /** 設定を保存して、変わったことを知らせる。 */
  private storeSettings(s: Settings): void {
    this.storage.saveSettings(s);
    for (const listener of this.settingsListeners) listener(s);
  }

  get backlog(): readonly BacklogEntry[] {
    const all = this.log.entries;
    const list = all.map((e, i) => ({
      speaker: e.speaker,
      label: entryName(e),
      ...(e.with?.length ? { with: e.with.map((w) => w.speaker) } : {}),
      parts: e.parts,
      voice: e.voice ?? null,
      at: e.at,
      canJump: i < all.length - 1 && !!e.resume,
      ...(e.choice ? { choice: true } : {}),
    }));
    // 古い読み方（公開する前の backlog.entries・backlog.current）。読んでいた作品が壊れないように残す
    Object.defineProperties(list, { entries: { value: all }, current: { value: this.log.current } });
    return list;
  }

  /** 今のページ（選んだ選択肢の項目を除く、いちばん新しいページ）のボイス。無ければ null。 */
  private pageVoice(): LogEntry["voice"] | null {
    for (let i = this.log.entries.length - 1; i >= 0; i--) {
      const e = this.log.entries[i]!;
      if (!e.choice) return e.voice ?? null;
    }
    return null;
  }

  /** 今のページの本文をコピーする（話者があれば頭に付ける）。 */
  private async copyPage(): Promise<void> {
    const entry = this.log.entries.findLast((e) => !e.choice);
    const text = plainText(entry ?? null).trim();
    if (!entry || !text) return;
    const speaker = entryName(entry);
    // 括弧の台詞は名前に続け（ユイ「…」）、引用符の台詞は半角の空白を挟む（Yui "…"）
    const line = speaker ? `${speaker}${/^[「『（(]/.test(text) ? "" : /^["“]/.test(text) ? " " : "："}${text}` : text;
    toast(this.layer, (await copyToClipboard(line)) ? TEXT.toast.textCopied : TEXT.toast.copyFailed);
  }

  /** 今のページのボイスをもう一度鳴らす（キーの V、メニュー、クイックメニューの "replay-voice"）。 */
  private replayVoice(): void {
    const voice = this.pageVoice();
    const speaker = this.log.entries.findLast((e) => !e.choice)?.speaker ?? null;
    if (voice) this.host.playVoiceCue(voice, speaker);
  }

  playBacklogVoice(index: number): void {
    const e = this.log.entries[index];
    if (e?.voice) this.host.playVoiceCue(e.voice, e.speaker);
  }

  async jumpToBacklog(index: number): Promise<void> {
    if (index < this.log.entries.length - 1) await this.jumpBack(index);
  }

  slots(range?: { from: number; to: number }): SlotInfo[] {
    const from = Math.max(0, range?.from ?? 0);
    const to = Math.min(this.slotCount - 1, range?.to ?? this.slotCount - 1);
    const out: SlotInfo[] = [];
    for (let n = from; n <= to; n++) out.push(this.slot(n));
    return out;
  }

  slot(slot: SlotId): SlotInfo {
    const r = this.storage.loadSlot(slot);
    if (!r) return { slot, empty: true };
    // Unit の id の頭がファイル（"chapter1::title-card" は chapter1）
    const unit = r.save?.position?.unit;
    const slotChapterId = typeof unit === "string" ? this.chapterOf(unit.split("::")[0]!)?.id : undefined;
    return {
      slot,
      empty: false,
      date: r.date,
      title: r.title,
      ...(r.thumb ? { thumb: r.thumb } : {}),
      ...(r.meta ? { meta: structuredClone(r.meta) } : {}),
      ...(r.chapter ? { chapter: r.chapter } : {}),
      ...(slotChapterId ? { chapterId: slotChapterId } : {}),
      ...(typeof r.playTime === "number" ? { playTime: r.playTime } : {}),
    };
  }

  deleteSlot(slot: SlotId): void {
    this.storage.deleteSlot(slot);
  }

  private async act(entry: MenuEntry): Promise<void> {
    if (this.mode !== "game" || !this.runtime) return;
    // 作品の画面（"screen:<名前>"。defineScreen で登録したもの）
    const named = screenActionName(entry);
    if (named !== null) {
      await this.openScreenByName(named);
      return;
    }
    const a = entry as MenuAction;
    this.sayAction(a);
    // 回想の間はセーブもロードもしない（キーの S・L も）
    if (this.replaying && (a === "quick-save" || a === "quick-load" || a === "save" || a === "load")) return;
    switch (a) {
      case "quick-save": {
        // 空いている枠か、いちばん古い枠に書く（ui.quickSave.slots 個を回す）
        const record = this.slotRecord();
        toast(this.layer, record && this.storage.saveQuick(this.quickCount, record) ? TEXT.toast.quickSaved : TEXT.toast.saveFailed);
        return;
      }
      case "quick-load": {
        const slot = this.storage.latestQuick(this.quickCount);
        if (slot) await this.loadFrom(slot);
        else toast(this.layer, TEXT.toast.noQuickSave);
        return;
      }
      case "save":
      case "load":
        this.openSaveLoad(a);
        return;
      case "auto":
        this.setAuto(!this.auto);
        return;
      case "skip":
        this.setSkip(!this.skip);
        return;
      case "rollback":
        await this.rollback();
        return;
      case "rollforward":
        await this.rollforward();
        return;
      case "prev-choice":
        await this.prevChoice();
        return;
      case "next-choice":
        await this.nextChoice();
        return;
      case "next-unread":
        await this.nextUnread();
        return;
      case "backlog":
        this.openBacklog();
        return;
      case "replay-voice":
        this.replayVoice();
        return;
      case "config":
        this.openConfig();
        return;
      case "flowchart":
        await this.openFlowchart();
        return;
      case "items":
        this.openItems();
        return;
      case "help":
        this.openHelp();
        return;
      case "screenshot":
        await this.screenshot();
        return;
      case "menu":
        this.openMenu();
        return;
      case "hide":
        this.setHidden(true);
        return;
      case "title":
        if (this.replaying) {
          if (await this.ask(TEXT.confirm.endReplay, "end-replay")) await this.endReplay();
          return;
        }
        if (await this.ask(TEXT.confirm.title, "title")) await this.showTitle(true);
        return;
      case "exit":
        if (await this.ask(TEXT.confirm.exit, "exit")) this.quit();
        return;
      case "check-update":
        await this.offerUpdate(true);
        return;
      case "fullscreen":
        this.toggleFullscreen();
        return;
    }
  }

  // ---- 画面 ----

  private openStandard(name: string, element: HTMLElement, close?: () => void): OpenScreen {
    // 中のクリック・ホイールは本文の送りへ流さない（作品が差し替えた画面も）
    swallow(element);
    const screen: OpenScreen = { name, el: element, close: close ?? (() => this.closeScreen(screen)) };
    // ui.screen.pauseScenario: 開いている間はシナリオの次の命令を止める（既定は止める。false なら前の版と同じく止めない）
    if (this.env.project.ui?.screen?.pauseScenario !== false) screen.pause = true;
    return this.pushScreen(screen);
  }

  private pushScreen(screen: OpenScreen): OpenScreen {
    const element = screen.el;
    // スクリーンリーダーには一つの画面（ダイアログ）として渡し、外は読ませない。フォーカスは画面の中へ移し、閉じたら戻す
    // 中にダイアログを持つもの（確認の枠の alertdialog）は、そちらをダイアログにする
    const dialog = element.matches("[role=dialog], [role=alertdialog]") ? element : (element.querySelector<HTMLElement>("[role=dialog], [role=alertdialog]") ?? element);
    if (!dialog.hasAttribute("role")) dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    element.dataset.lmScreen = screen.name;
    // 遊ぶ人の操作を待つゲームの中の画面の印（指で触る端末で右上のメニューのボタンを避ける CSS が見る）
    if (screen.allowMenu) element.dataset.lmAllowMenu = "true";
    const heading = element.querySelector<HTMLElement>(".lm-screen-title, h1, h2");
    if (heading && !dialog.hasAttribute("aria-label") && !dialog.hasAttribute("aria-labelledby")) {
      heading.id ||= `lm-screen-heading-${++screenHeadingId}`;
      dialog.setAttribute("aria-labelledby", heading.id);
    }
    if (!element.hasAttribute("tabindex")) element.tabIndex = -1;
    screen.returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    requestAnimationFrame(() => {
      if (this.screens.at(-1) === screen && !element.contains(document.activeElement)) element.focus({ preventScroll: true });
    });
    // 画面を開いたらスキップは止める（オートは閉じるまで待つ）
    this.skip = false;
    this.toChoice = false;
    this.toUnread = false;
    this.screens.push(screen);
    this.layer.append(element);
    this.updateSkipping(false);
    this.sync();
    playSound("open");
    void this.emit({ type: "screen-open", name: screen.name, from: this.mode });
    this.screenTransition(screen.name, true);
    return screen;
  }

  /** 画面の切り替えの演出（WebPlugin.transitions.screen。待たない）。 */
  private screenTransition(name: string, open: boolean): void {
    const play = this.env.transitions?.screen;
    if (!play) return;
    try {
      void Promise.resolve(play(this.host.context, { name, open })).catch((e: unknown) => console.warn("画面の切り替えの演出（transitions.screen）が失敗しました", e));
    } catch (e) {
      console.warn("画面の切り替えの演出（transitions.screen）が失敗しました", e);
    }
  }

  /** 画面が閉じた（閉じた・まとめて捨てた）ことを、画面の受け手と描画側に知らせる。 */
  private screenGone(screen: OpenScreen): void {
    for (const l of screen.closed?.splice(0) ?? []) {
      try {
        l();
      } catch (e) {
        console.warn(e);
      }
    }
    this.host.emitRender({ type: "screen-close", name: screen.name });
    if (screen.name === "menu") this.host.emitRender({ type: "menu-close" });
  }

  private closeScreen(screen: OpenScreen): void {
    const i = this.screens.indexOf(screen);
    if (i < 0) return;
    this.screens.splice(i, 1);
    const hadFocus = screen.el.contains(document.activeElement);
    this.removeScreenEl(screen);
    // 画面を開いている間は隠していたもの（クイックメニューの帯）を先に出し直す。隠れたままのボタンへはフォーカスを戻せない
    this.releaseScenario();
    this.updateSkipping();
    this.sync();
    // 開く前に選んでいたもの（下の画面のボタン、クイックメニューのボタンなど）へ戻す。下が文字の入力や確認の枠なら、その欄かボタンへ
    if (hadFocus || document.activeElement === document.body) {
      const back = screen.returnFocus;
      if (back?.isConnected && !back.closest("[inert]") && !back.closest("[hidden]")) back.focus({ preventScroll: true });
      else if (this.screens.length > 0) this.screens.at(-1)!.el.focus({ preventScroll: true });
      else this.host.stage.querySelector<HTMLElement>(".lm-panel input, .lm-panel button")?.focus({ preventScroll: true });
    }
    playSound("close");
    void this.emit({ type: "screen-close", name: screen.name, from: this.mode });
    this.screenGone(screen);
    this.screenTransition(screen.name, false);
    if (!this.screen) {
      this.session?.scheduleAuto();
      for (const resolve of this.screenWaiters.splice(0)) resolve();
    }
  }

  /**
   * 閉じた画面の要素を外す。閉じる演出（ScreenLifecycle.leave）があれば、押せなくしてから済むまで待って外す（LEAVE_LIMIT で打ち切る。
   * 早送り中は待たない）。
   */
  private removeScreenEl(screen: OpenScreen): void {
    const el = screen.el;
    let pending: Promise<void> | void = undefined;
    if (screen.leave && !this.host.skipping) {
      try {
        pending = screen.leave(el);
      } catch (e) {
        console.warn("画面の閉じる演出（leave）が失敗しました", e);
      }
    }
    if (!pending || typeof (pending as Promise<void>).then !== "function") {
      el.remove();
      return;
    }
    el.inert = true;
    el.dataset.lmLeaving = "true";
    let timer = 0;
    const limit = new Promise<void>((r) => (timer = window.setTimeout(r, LEAVE_LIMIT)));
    const done = Promise.resolve(pending).catch((e: unknown) => console.warn("画面の閉じる演出（leave）が失敗しました", e));
    void Promise.race([done, limit]).then(() => {
      clearTimeout(timer);
      el.remove();
    });
  }

  // ---- シナリオからの要求 ----

  async request(req: SystemRequest): Promise<boolean> {
    const a = req.args;
    switch (req.name) {
      case "title-screen":
        // プレイが止まったら（実行器がこの命令のあとで止める）タイトルへ
        this.returnToTitle = true;
        // エンディング（ending= と title=）があれば、タイトルへ戻る前に暗転して名前を出す（card=false なら出さない）
        {
          const shown = a.card !== false ? this.endingShown(a) : null;
          this.ending = shown ? { ...shown, text: typeof a.text === "string" ? a.text : "" } : null;
        }
        // 見たエンディングの記録（実行器が全セーブ共通の変数に書いたもの）をすぐ残す
        this.flush();
        return true;
      case "auto":
        this.setAuto(a.mode === "start");
        return true;
      case "skip":
        this.setSkip(a.mode === "start");
        return true;
      case "open-screen": {
        // 標準の画面か、作品の画面（defineScreen）。開いた画面が閉じるまでシナリオを止める
        const name = String(a.screen ?? "");
        // 録画（lim shot --video）は、開いた画面を読む時間だけ見せてから閉じる（作品の画面が選べるものを知らせたら、そちらが先）
        const withdraw = this.host.offer({ options: [TEXT.close], proceed: 0, choose: () => this.screens.at(-1)?.close() });
        try {
          if (!(await this.openScreenByName(name)) && !STANDARD_SCREENS.has(name)) {
            const at = this.runtime?.at;
            this.env.onDiagnostic({ severity: "warning", code: "unknown-screen", message: `@open-screen ${name} の画面がありません（標準の画面か、プラグインが system.defineScreen で登録した名前を書きます）`, file: at?.file ?? "", line: at?.line ?? 0 });
          }
        } finally {
          withdraw();
        }
        return true;
      }
      case "menu-button":
        this.menuButton = a.mode === "show";
        this.sync();
        return true;
      case "shortcuts":
        this.host.shortcuts = a.mode === "on";
        return true;
      case "backlog":
        this.log.paused = a.mode === "off";
        return true;
      case "backlog-add":
        this.log.add(String(a.text ?? ""), a.join === true, this.log.current?.at ?? { file: "", line: 0 });
        return true;
      case "replay-end":
        if (this.replaying) await this.endReplay();
        return true;
      case "achieve": {
        const id = String(a.id ?? "");
        const entry = this.project.extra?.achievements?.find((x) => x.id === id);
        toast(this.layer, TEXT.toast.achieved(entry?.title ?? id), 2600);
        this.flush();
        this.env.onAchievement?.(id);
        return true;
      }
      case "achieve-progress": {
        // 数を数える実績の進み具合。目標に届いて解除したら @achieve と同じく知らせる
        const id = String(a.id ?? "");
        const entry = this.project.extra?.achievements?.find((x) => x.id === id);
        const value = typeof a.value === "number" ? a.value : 0;
        const goal = typeof a.goal === "number" ? a.goal : 0;
        this.env.onAchievementProgress?.(id, value, goal);
        if (a.unlocked === true) {
          toast(this.layer, TEXT.toast.achieved(entry?.title ?? id), 2600);
          this.env.onAchievement?.(id);
        }
        this.flush();
        return true;
      }
      case "check-update":
        await this.offerUpdate(true);
        return true;
      case "quit":
        // ゲームからアプリを閉じられない（iOS のアプリとブラウザ）なら、そう知らせてタイトルへ戻る
        if (!canQuitApp()) {
          if (this.mode !== "game") return true;
          if (a.ask !== false && !(await this.ask(TEXT.confirm.cannotQuit, "title"))) return true;
          if (a.ask === false) toast(this.layer, TEXT.toast.cannotQuit, 2600);
          await this.showTitle(true);
          return true;
        }
        // メニューの「終了」と同じ確認のダイアログで尋ね、書いてから閉じる
        if (a.ask === false || (await this.ask(TEXT.confirm.exit, "exit"))) this.quit();
        return true;
      case "autosave":
        // 枠を持たない作品（ui.autosave.slots が 0）は何もしない
        this.autosave();
        return true;
      case "autoload": {
        // いちばん新しいオートセーブから続ける（無ければ何もせずに次へ進む）
        const slot = this.storage.latestAuto(this.autoCount);
        if (slot !== null && this.mode === "game" && !this.replaying) await this.loadFrom(slot);
        return true;
      }
      case "config": {
        const s = { ...this.prefs };
        if (typeof a["bgm-volume"] === "number") s.bgm = a["bgm-volume"];
        if (typeof a["se-volume"] === "number") s.se = a["se-volume"];
        if (typeof a["voice-volume"] === "number") s.voice = a["voice-volume"];
        if (typeof a["text-speed"] === "number") s.textSpeed = a["text-speed"];
        if (typeof a["auto-wait"] === "number") s.autoWait = a["auto-wait"];
        this.prefs = s;
        this.storeSettings(s);
        this.applySettings();
        return true;
      }
      default:
        // fullscreen・window-title・open-url は描画側の既定の動き
        return false;
    }
  }

  private closeAllScreens(): void {
    for (const s of [...this.screens].reverse()) (s.discard ?? s.close)();
    for (const s of this.screens) {
      s.el.remove();
      this.screenGone(s);
    }
    this.screens = [];
    this.releaseScenario();
    this.sync();
  }

  // ---- 作品の画面（openScreen） ----

  /** 開いている作品の画面（key → 扱い）。 */
  private readonly customScreens = new Map<string, ScreenHandle<unknown, Value>>();
  /** ロードで開き直す作品の画面の作り方（defineScreen）。 */
  private readonly screenDefs = new Map<string, { build: ScreenContent<unknown, Value>; options: ScreenOptions<Value>; label?: string | Readonly<Record<string, string>>; menu: boolean; extra?: boolean | (() => boolean); state?: Value }>();

  /** おまけに並べる作品の画面（defineScreen の extra）。 */
  private extraScreens(): { name: string; label: string }[] {
    return [...this.screenDefs].filter(([, d]) => (typeof d.extra === "function" ? d.extra() : d.extra === true)).map(([key]) => ({ name: key, label: this.screenLabel(key) ?? key }));
  }

  /** タイトルに「おまけ」を出すか（一覧の何かを解放しているか、おまけに並べる作品の画面があるか）。 */
  private hasExtra(): boolean {
    return anyExtraUnlocked(this.project.extra, this.system) || this.extraScreens().length > 0;
  }
  /** シナリオを止めている画面が閉じるのを待っているもの。 */
  private scenarioWaiters: (() => void)[] = [];

  openScreen<T = unknown, S extends Value = Value>(content: ScreenContent<T, S>, o: ScreenOptions<S> = {}): ScreenHandle<T, S> {
    if (o.key && this.customScreens.has(o.key)) return this.customScreens.get(o.key) as unknown as ScreenHandle<T, S>;
    const frame = el("div", "lm-custom-screen");
    // クリック・ホイールは下（本文の送り・履歴）へ流さない。右クリック・Esc はシステムが一番上の画面の close を呼ぶ
    swallow(frame);
    let settle: (v: T | null) => void = () => undefined;
    const result = new Promise<T | null>((resolve) => (settle = resolve));
    const saved = o.key ? this.screenEntries().find((e) => e.key === o.key) : undefined;
    let state = (saved ? saved.state : (o.state ?? null)) as S;
    let done = false;
    const life = lifecycle();
    let back: () => boolean = () => false;
    const finish = (value: T | null, remove: boolean) => {
      if (done) return;
      done = true;
      if (remove) this.closeScreen(screen);
      if (o.key) {
        this.customScreens.delete(o.key);
        this.writeScreenEntry(o.key, undefined);
      }
      settle(value);
    };
    const handle: ScreenHandle<T, S> = {
      el: frame,
      result,
      get state() {
        return state;
      },
      setState: (next: S) => {
        state = next;
        if (o.key) this.writeScreenEntry(o.key, next);
      },
      close: (value?: T) => finish(value ?? null, true),
      onClose: life.onClose,
      onBack: (handler) => {
        back = handler;
      },
    };
    const screen: OpenScreen = {
      name: o.name ?? o.key ?? "custom",
      el: frame,
      pause: o.pauseScenario !== false,
      allowMenu: o.allowMenu === true,
      close: () => void screen.back?.(),
      back: () => {
        if (back()) return true;
        if (!o.closeOnBack) return false;
        finish(null, true);
        return true;
      },
      discard: () => finish(null, false),
    };
    life.bind(screen, handle);
    frame.append(typeof content === "function" ? content(handle) : content);
    if (o.key) {
      this.customScreens.set(o.key, handle as unknown as ScreenHandle<unknown, Value>);
      this.writeScreenEntry(o.key, state);
    }
    this.pushScreen(screen);
    return handle;
  }

  defineScreen<T = unknown, S extends Value = Value>(key: string, build: ScreenContent<T, S>, options: DefineScreenOptions<S> = {}): void {
    const { label, menu, state, extra, ...open } = options;
    this.screenDefs.set(key, {
      build: build as unknown as ScreenContent<unknown, Value>,
      options: open as ScreenOptions<Value>,
      ...(label !== undefined ? { label } : {}),
      menu: menu === true,
      ...(extra !== undefined ? { extra } : {}),
      ...(state !== undefined ? { state } : {}),
    });
    // 帯に "screen:<名前>" を置いていれば、文字を読み直す
    this.bar.relabel();
  }

  /** 作品の画面の文字（defineScreen の label。言語ごとに書いていれば今の言語のもの）。無ければ null。 */
  private screenLabel(name: string): string | null {
    const label = this.screenDefs.get(name)?.label;
    if (label === undefined) return null;
    if (typeof label === "string") return label;
    const lang = this.language || "ja";
    return label[lang] ?? label[lang.split("-")[0]!] ?? label.ja ?? Object.values(label)[0] ?? null;
  }

  /** 操作の文字（作品の画面は label か名前）。 */
  private actionLabel(entry: MenuEntry): string {
    const name = screenActionName(entry);
    return name === null ? menuLabel(entry as MenuAction) : (this.screenLabel(name) ?? name);
  }

  /** メニューに並べる作品の画面（defineScreen の menu）。 */
  private menuScreens(): ScreenAction[] {
    return [...this.screenDefs].filter(([, d]) => d.menu).map(([key]) => `screen:${key}` as const);
  }

  async openScreenByName(name: string): Promise<boolean> {
    const def = this.screenDefs.get(name);
    if (def) {
      // 同じ名前の画面が開いていれば、それが閉じるのを待つ（二つ重ねて開かない）
      const handle = this.openScreen(def.build, { ...def.options, key: name, ...(def.state !== undefined ? { state: def.state } : {}) });
      await handle.result;
      return true;
    }
    if (!STANDARD_SCREENS.has(name)) return false;
    const before = this.screens.length;
    if (name === "save" || name === "load") this.openSaveLoad(name);
    else if (name === "log" || name === "backlog") this.openBacklog();
    else if (name === "menu") this.openMenu();
    else if (name === "config") this.openConfig();
    else if (name === "extra") this.openExtra();
    else if (name === "items") this.openItems();
    else if (name === "help") this.openHelp();
    else if (name === "flowchart") await this.openFlowchart();
    if (this.screens.length === before) return false;
    // 開いた画面が閉じるまで待つ（その上に開いたものも閉じるまで）
    await new Promise<void>((resolve) => this.screenWaiters.push(resolve));
    return true;
  }

  persist(): void {
    this.flush();
  }

  /** セーブに残っている、開いていた作品の画面。 */
  private screenEntries(): { key: string; state: Value }[] {
    const list = this.runtime?.state.stage.extra[SCREENS_KEY];
    return Array.isArray(list) ? (list as unknown as { key: string; state: Value }[]) : [];
  }

  /** 作品の画面の状態をセーブに残す（state が undefined なら外す）。 */
  private writeScreenEntry(key: string, state: Value | undefined): void {
    const rt = this.runtime;
    if (!rt) return;
    const list = this.screenEntries().filter((e) => e.key !== key);
    if (state !== undefined) list.push({ key, state: structuredClone(state) });
    if (list.length > 0) rt.state.stage.extra[SCREENS_KEY] = list as unknown as Value;
    else delete rt.state.stage.extra[SCREENS_KEY];
  }

  /** ロードしたら、作り方のある作品の画面を同じ状態で開き直す（作り方の無いものは、開いた命令がもう一度開く）。 */
  private reopenScreens(save: SaveData): void {
    const list = save.stage.extra[SCREENS_KEY];
    if (!Array.isArray(list)) return;
    for (const e of list as unknown as { key: string; state: Value }[]) {
      const def = this.screenDefs.get(e.key);
      if (def) this.openScreen(def.build, { ...def.options, key: e.key, state: e.state });
    }
  }

  /** ページを出したとき、開いていない作品の画面の状態を外す（開いた命令が画面を閉じずに終わったなど）。 */
  private pruneScreenEntries(): void {
    for (const e of this.screenEntries()) if (!this.customScreens.has(e.key)) this.writeScreenEntry(e.key, undefined);
  }

  /** シナリオを止めている画面があれば、すべて閉じるまで待つ（Runtime の beforeStep）。 */
  private scenarioGate(): Promise<void> | undefined {
    if (!this.screens.some((s) => s.pause)) return undefined;
    return new Promise((resolve) => this.scenarioWaiters.push(resolve));
  }

  private releaseScenario(): void {
    if (this.screens.some((s) => s.pause)) return;
    for (const resolve of this.scenarioWaiters.splice(0)) resolve();
  }

  /** 画面の型（標準の型に、作品の ui.templates を重ねたもの。docs/design/screen-templates.md）。作品の型は開くたびに今のものを重ねる。 */
  private templatesNow() {
    screenTemplates.setAuthor(this.env.project.templates);
    return screenTemplates;
  }

  /** 型から画面を作る部品を読む（書き出しでは初めて開くときに読む）。読めなければ null（コンソールに出す）。 */
  private loadViews(): Promise<LazyScreens | null> {
    return loadScreenTemplates().catch((e: unknown) => {
      console.warn(e);
      return null;
    });
  }

  /** 画面が閉じたら（まとめて捨てたときも）f を呼ぶ（画面の JS の片付け）。 */
  private whenGone(screen: OpenScreen, f: () => void): void {
    (screen.closed ??= []).push(f);
  }

  /** 読み込み中の画面（同じ画面を二度開かない）。 */
  private readonly viewsWaiting = new Set<string>();

  /** 型から画面を作る部品を使う。読み終えていればすぐ、まだなら読んでから run を呼ぶ（読む間に同じ画面をもう一度開こうとしても一度だけ）。 */
  private withViews(name: string, run: (views: LazyScreens) => void): void {
    const now = lazyScreensNow();
    if (now) return run(now);
    if (this.viewsWaiting.has(name)) return;
    this.viewsWaiting.add(name);
    void this.loadViews().then((views) => {
      this.viewsWaiting.delete(name);
      if (views) run(views);
    });
  }

  /** はい／いいえを尋ねる（Esc・右クリックは「いいえ」）。kind は作品の確かめの画面に渡す種類。描画の側からは RenderSystem.ask。 */
  async ask(message: string, kind = "confirm"): Promise<boolean> {
    // コンフィグで確認を省いている（消す・読み込む・送るなど、取り返しのつかないものと同意は省かない）
    if (!this.prefs.confirm && !ALWAYS_CONFIRM.has(kind)) return true;
    this.sayVoice(this.env.project.ui?.systemVoice?.confirm);
    // プラグインの screens.confirm（TypeScript の口）が先。無ければ画面の型（作品の ui.templates.confirm を標準に重ねたもの）
    const custom = this.env.screens?.confirm;
    if (!custom) {
      const dialog = confirmScreen(this.templatesNow(), message, kind);
      const screen = this.openStandard("confirm", dialog.el, dialog.close);
      const ok = await dialog.answer;
      this.closeScreen(screen);
      return ok;
    }
    let settle: (ok: boolean) => void = () => undefined;
    const answer = new Promise<boolean>((resolve) => (settle = resolve));
    const life = lifecycle();
    const api: ConfirmScreenApi = { kind, message, yes: TEXT.confirm.yes, no: TEXT.confirm.no, answer: (ok) => settle(ok), onClose: life.onClose };
    const screen = this.openStandard("confirm", custom(api), () => settle(false));
    life.bind(screen, api);
    const ok = await answer;
    this.closeScreen(screen);
    return ok;
  }

  /** 作品の操作の帯（WebPlugin.screens.menuBar）を作る。 */
  private makeCustomBar(build: NonNullable<NonNullable<SystemEnv["screens"]>["menuBar"]>): HTMLElement {
    const items = this.env.project.ui?.menuBar?.items ?? DEFAULT_MENU_BAR_ITEMS;
    const status = () => this.status;
    const bar = build({
      items,
      label: (a) => this.actionLabel(a),
      perform: (a) => void this.act(a),
      get status() {
        return status();
      },
      onStatusChange: (l) => this.onStatusChange(l),
    });
    // 帯の上のクリックは本文の送りにしない
    bar.addEventListener("click", (e) => e.stopPropagation());
    bar.hidden = true;
    return bar;
  }

  uiChanged(): void {
    this.localized = null;
    configureSettings(this.env.project.ui?.settings);
    // おまけ（用語集・章）も開発中に変わる
    this.setupGlossary();
    this.chapterAt = null;
    fullscreen.allow(this.env.project.ui?.screen?.fullscreen !== false);
    this.bar.configure(this.env.project.ui?.menuBar);
    this.sync();
    if (this.mode === "title" && this.titleEl) this.renderTitle();
  }

  /** セーブの枠の数（liminalia.json の ui.saveSlots）。 */
  private get slotCount(): number {
    return saveSlotCount(this.env.project.ui);
  }

  private openSaveLoad(mode: "save" | "load"): void {
    if (mode === "save" && this.mode !== "game") return;
    const custom = this.env.screens?.saveload;
    if (!custom) {
      this.withViews(mode, (views) => {
        if (mode === "save" && this.mode !== "game") return;
        const made = views.createSaveLoad(this.templatesNow(), {
          mode,
          storage: this.storage,
          save: (slot) => this.saveTo(slot),
          load: (slot) => void this.loadFrom(slot),
          confirmLoad: this.mode === "game",
          slots: this.slotCount,
          autoSlots: this.autoCount,
          quickSlots: this.quickCount,
          ask: (m, kind) => this.ask(m, kind),
          notify: (m) => toast(this.layer, m),
          close: () => screen.close(),
        });
        const screen = this.openStandard(mode, made.el);
        this.whenGone(screen, made.dispose);
      });
      return;
    }
    const life = lifecycle();
    const api: SaveLoadScreenApi = {
      mode,
      system: this,
      slotCount: this.slotCount,
      autoSlotCount: this.autoCount,
      quickSlotCount: this.quickCount,
      lastSlot: this.storage.lastSlot(),
      latestSlot: this.storage.latestSlot(this.slotCount, this.autoCount, this.quickCount),
      pageSize: PAGE_SIZE,
      chapterId: this.mode === "game" ? (this.runtime?.chapter?.id ?? null) : null,
      inGame: this.mode === "game",
      save: (slot) => this.saveTo(slot),
      load: (slot) => void this.loadFrom(slot),
      ask: (m, kind) => this.ask(m, kind),
      notify: (m) => toast(this.layer, m),
      close: () => screen.close(),
      onClose: life.onClose,
    };
    const screen = this.openStandard(mode, custom(api));
    life.bind(screen, api);
  }

  private openBacklog(): void {
    if (this.mode !== "game" || this.menuBlocked) return;
    const custom = this.env.screens?.backlog;
    if (!custom) {
      this.withViews("backlog", (views) => {
        if (this.mode !== "game" || this.menuBlocked) return;
        const made = views.createBacklogView(
          this.templatesNow(),
          this.log.entries,
          () => screen.close(),
          (entry) => entry.voice && this.host.playVoiceCue(entry.voice, entry.speaker),
          {
            color: (speaker) => this.host.nameColor(speaker),
            textStyle: (speaker) => this.host.speakerText(speaker),
            // 今のページ（最後の項目）へは戻らない
            jump: (entry, index) => (index < this.log.entries.length - 1 && entry.resume ? () => void this.jumpBack(index) : null),
            image: (path) => this.host.context.asset("image", path),
          },
        );
        const screen = this.openStandard("backlog", made.el);
        this.whenGone(screen, made.dispose);
      });
      return;
    }
    const life = lifecycle();
    const api: BacklogScreenApi = {
      entries: this.backlog,
      playVoice: (i) => this.playBacklogVoice(i),
      jump: (i) => this.jumpToBacklog(i),
      color: (speaker) => this.host.nameColor(speaker),
      textStyle: (speaker) => this.host.speakerText(speaker) ?? null,
      asset: (kind, path) => this.host.context.asset(kind, path),
      close: () => screen.close(),
      onClose: life.onClose,
    };
    const screen = this.openStandard("backlog", custom(api));
    life.bind(screen, api);
  }

  /** 履歴のそのページから読み直す（そのページより後の進み具合は捨てる。確かめてから）。 */
  private async jumpBack(index: number): Promise<void> {
    const entry = this.log.entries[index];
    if (!entry?.resume || !(await this.ask(TEXT.backlog.jumpConfirm, "backlog-jump"))) return;
    await this.emit({ type: "load-start", from: "backlog" });
    const save = entry.resume;
    this.closeAllScreens();
    // 新しいプレイを作ると履歴と選択肢の控えは空になるので、そのページより前を控えて戻す
    const log = this.log.entries.slice(0, index);
    // そのページより前に出した選択肢（そのページの直前のものも含む）
    const points = this.choices.points.filter((p) => p.log <= index);
    const rt = this.createRuntime();
    this.log.restoreKeeping(log);
    this.choices.replace(points);
    this.stayOnEnd = false;
    this.enterGame();
    this.run(rt, rt.load(save));
    this.reopenScreens(save);
  }

  /**
   * 読んでいるページから場面を呼ぶ（常駐のボタンの call=）。そのページの頭から組み立て直して場面を呼び、戻ったらそのページを出し直す。
   * 選択肢を出しているあいだは、その選択肢を出した時点から呼び、戻ったら選択肢を出し直す（選ぶ前にメモや持ち物を見る）。
   * 履歴、選択肢の控え、temp の変数は今のまま続ける。ページでクリックを待っているときか選択肢を出しているとき（画面を開いていない）だけ。
   */
  async callScene(target: string): Promise<boolean> {
    const rt = this.runtime;
    const entries = this.log.entries;
    if (!rt || this.mode !== "game" || this.screen || this.replaying || this.rollBusy) return false;
    // 選択肢なら、出した時点の控え（戻ったら出し直すときに控え直すので、これは外す）
    const point = this.choosing ? this.choices.points.at(-1) : undefined;
    const page = entries.at(-1);
    let from: { save: SaveData; log: LogEntry[]; points: ChoicePoint[] };
    if (this.choosing) {
      if (!point) return false;
      from = { save: point.save, log: entries.slice(0, point.log), points: this.choices.points.filter((p) => p !== point) };
    } else {
      if (!this.host.waiting || !page?.resume) return false;
      from = { save: page.resume, log: entries.slice(0, -1), points: this.choices.points.filter((p) => p.log < entries.length) };
    }
    const { save, log, points } = from;
    const temp = rt.state.temp;
    const next = this.createRuntime();
    next.state.temp = temp;
    this.log.restoreKeeping(log);
    this.choices.replace(points);
    this.stayOnEnd = false;
    this.enterGame();
    this.run(next, next.load(save, { call: target, afterLoad: false }));
    return true;
  }

  // ---- 巻き戻し ----

  /** 巻き戻しを使えるか（ui.rollback.enabled。既定は使える）。 */
  private get rollbackOn(): boolean {
    return this.env.project.ui?.rollback?.enabled !== false;
  }

  /**
   * 一つ戻る先。今のページの直前に選択肢を出していればその選択肢、そうでなければ一つ前のページ
   * （選択肢を出している最中なら、その直前のページ）。戻れなければ null。
   */
  private rollbackTarget(): { kind: "page"; index: number } | { kind: "choice"; point: ChoicePoint } | null {
    if (!this.rollbackOn || this.replaying || this.mode !== "game" || !this.runtime) return null;
    const entries = this.log.entries;
    const length = entries.length;
    const point = this.choices.points.at(-1);
    // 選んだ選択肢の項目（ui.backlogChoices）はページではないので数えない
    if (!this.choosing && point && point.log < length && entries.slice(point.log).filter((e) => !e.choice).length === 1) return { kind: "choice", point };
    let index = length - (this.choosing ? 1 : 2);
    while (index >= 0 && entries[index]?.choice) index--;
    return index >= 0 && entries[index]?.resume ? { kind: "page", index } : null;
  }

  /** 一つ戻る（確かめない）。今いるところまでは、進め直す先として控える。 */
  private async rollback(): Promise<void> {
    const target = this.rollbackTarget();
    if (!target || this.screen || this.rollBusy) return;
    const entries = this.log.entries;
    const step = (e: LogEntry, log: number): RollStep[] => (e.resume ? [{ kind: "page", key: `${e.at.file}:${e.at.line}`, log, save: e.resume }] : []);
    if (target.kind === "choice") {
      // 今のページの直前の選択肢へ（前に選んだものは、選択肢の控えの chosen に残っている）
      const { point } = target;
      this.future = [...step(entries.at(-1)!, entries.length - 1), ...this.future];
      this.futureChoices = [...this.choices.points.filter((p) => p.log >= point.log), ...this.futureChoices];
      await this.rollTo(point.save, entries.slice(0, point.log), this.choices.points.filter((p) => p.log < point.log), "back", false);
      return;
    }
    const { index } = target;
    const ahead = entries.slice(index + 1).flatMap((e, i) => step(e, index + 1 + i));
    // 選択肢を出していれば、そこへ進め直せるように
    const shown = this.choosing ? this.choices.points.at(-1) : undefined;
    if (shown) ahead.push({ kind: "choice", key: shown.at, log: shown.log, save: shown.save });
    this.future = [...ahead, ...this.future];
    this.futureChoices = [...this.choices.points.filter((p) => p.log > index), ...this.futureChoices];
    await this.rollTo(entries[index]!.resume!, entries.slice(0, index), this.choices.points.filter((p) => p.log <= index), "back", true);
  }

  /** 戻ったところから一つ進め直す（前に選んだ選択肢もそのまま）。 */
  private async rollforward(): Promise<void> {
    const next = this.future[0];
    if (!next || !this.rollbackOn || this.replaying || this.screen || this.rollBusy || !this.runtime) return;
    this.future = this.future.slice(1);
    // 進め直す先より前に出した選択肢を戻す（選択肢そのものへ進め直すときは、出したときに控え直す）
    const back = (p: ChoicePoint) => p.log < next.log || (next.kind === "page" && p.log === next.log);
    // 出し直している選択肢は、前に選んだもの（chosen）を持つ控えのほうを残す
    const merged = [...this.choices.points, ...this.futureChoices.filter(back)];
    const points = merged.filter((p, i) => !merged.slice(i + 1).some((q) => q.at === p.at && q.log === p.log));
    this.futureChoices = this.futureChoices.filter((p) => !back(p));
    await this.rollTo(next.save, this.log.entries.slice(0, next.log), points, "forward", next.kind === "page");
  }

  /** セーブから組み立て直す（巻き戻し）。履歴と選択肢の控えはそこまでのものにし、進め直す先は残す。ページへ戻るなら文字は一度に出す。 */
  private async rollTo(save: SaveData, log: readonly LogEntry[], points: readonly ChoicePoint[], direction: "back" | "forward", instant: boolean): Promise<void> {
    this.rollBusy = true;
    try {
      await this.emit({ type: "rollback", direction });
      const future = this.future;
      const futureChoices = this.futureChoices;
      const stay = this.stayOnEnd;
      const rt = this.createRuntime();
      this.future = future;
      this.futureChoices = futureChoices;
      this.log.restoreKeeping(log);
      this.choices.replace(points);
      this.stayOnEnd = stay;
      this.rolling = true;
      this.host.instantPage = instant;
      this.enterGame();
      this.run(rt, rt.load(save));
      this.reopenScreens(save);
    } finally {
      this.rollBusy = false;
    }
  }

  /**
   * 読み進めて着いたところ（ページか選択肢）を、進め直す先と照らす。次の先と同じならそれを消し、違えば進め直す先を捨てる。
   * 巻き戻しで組み立て直した最初のところは照らさない。
   */
  private passRoll(kind: RollStep["kind"], key: string, log: number): void {
    if (this.rolling) {
      this.rolling = false;
      return;
    }
    const next = this.future[0];
    if (!next) return;
    if (next.kind === kind && next.key === key && next.log === log) {
      this.future.shift();
      // ここまでに出した選択肢は、出し直したときに控え直している
      this.futureChoices = this.futureChoices.filter((p) => p.log > log || (kind === "choice" && p.log === log));
    } else this.dropFuture();
  }

  private dropFuture(): void {
    this.future = [];
    this.futureChoices = [];
  }

  /** 選択肢で前に選んだものしか選べなくするなら、その番号（ui.rollback.fixChoices）。 */
  fixedChoice(): number | null {
    const chosen = this.revisited?.chosen;
    return this.env.project.ui?.rollback?.fixChoices === true && chosen !== undefined ? chosen : null;
  }

  /** 選んだ選択肢を履歴に残す（ui.backlogChoices が false なら残さない。回想の間も残す）。 */
  chosenText(text: string): void {
    const at = this.runtime?.at;
    if (this.env.project.ui?.backlogChoices === false || !at) return;
    this.log.choice(text, at);
  }

  chose(index: number): void {
    // 戻る前と違うものを選んだら、その先へは進め直せない
    if (this.revisited && this.revisited.chosen !== index) this.dropFuture();
    if (this.revisited) this.futureChoices = this.futureChoices.filter((p) => p !== this.revisited);
    this.revisited = null;
    const point = this.choices.points.at(-1);
    if (point && this.runtime) point.chosen = index;
  }

  // ---- スクリーンショット ----

  /**
   * 画面写真。デスクトップ版はウィンドウをそのまま撮って写真のフォルダの <題名>/ に置く。ほかは舞台の絵の部分（メッセージ枠・システム画面は除く）を
   * 舞台の大きさで描いて、画像として保存させる。メニューから撮ったときはメニューが閉じてから撮る。
   */
  private async screenshot(): Promise<void> {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const desktop = window.liminaliaDesktop?.screenshot;
    if (desktop) {
      const path = await desktop().catch(() => "");
      toast(this.layer, path ? TEXT.toast.screenshot : TEXT.toast.screenshotFailed);
      return;
    }
    const url = captureStage(this.host.stage, this.host.stage.offsetWidth || 1280, this.host.stage.offsetHeight || 720);
    if (!url) return toast(this.layer, TEXT.toast.screenshotFailed);
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name = `${this.env.project.title} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.png`;
    // スマホ版のアプリでは、アプリの共有のシートへ渡す（system/download.ts）
    toast(this.layer, (await saveFile(name, url)) ? TEXT.toast.screenshot : TEXT.toast.screenshotFailed);
  }

  // ---- 表現を控えめにする・注意書き ----

  /** 表現を控えめにしているか（版で決めたものは変えられない）。 */
  private get filtered(): boolean {
    return this.env.project.variant?.contentFilter === true || (!!this.env.project.ui?.contentFilter && this.prefs.contentFilter);
  }

  private filterApplied: boolean | null = null;

  /** 控えめのときは素材を差し替え、台本に system.content_filter（と system.variant）で知らせる。変えたらゲーム中の画面を組み直す。 */
  private applyContentFilter(): void {
    const on = this.filtered;
    this.system.content_filter = on;
    if (this.env.project.variant) this.system.variant = this.env.project.variant.name;
    this.host.setAssetRemap(on ? (this.env.project.ui?.contentFilter?.assets ?? null) : null);
    const changed = this.filterApplied !== null && this.filterApplied !== on;
    this.filterApplied = on;
    const rt = this.runtime;
    if (changed && rt && this.mode === "game") void this.host.present({ type: "command", name: "restore", args: {}, wait: false, stage: rt.state.stage });
  }

  /** 注意書き（ui.contentWarning）。同意したら（文が同じなら）次からは出さない。always ならいつも。やめたら false。 */
  private async showContentWarning(): Promise<boolean> {
    const w = this.project.ui?.contentWarning;
    if (!w?.text) return true;
    const seen = this.storage.read<string>("warning-ack");
    if (!w.always && seen === w.text) return true;
    const root = el("div", "lm-screen lm-warning");
    const ok = button("lm-button lm-primary", w.button ?? TEXT.warning.agree, () => undefined);
    const quit = window.liminaliaDesktop ? button("lm-button", TEXT.warning.quit, () => undefined) : null;
    root.append(el("div", "lm-warning-panel", el("h2", "lm-screen-title", w.title ?? TEXT.warning.heading), el("p", "lm-warning-text", w.text), el("div", "lm-warning-buttons", ...(quit ? [quit] : []), ok)));
    swallow(root);
    this.layer.append(root);
    requestAnimationFrame(() => ok.focus({ preventScroll: true }));
    const agreed = await new Promise<boolean>((resolve) => {
      ok.onclick = () => resolve(true);
      if (quit) quit.onclick = () => resolve(false);
    });
    root.remove();
    if (!agreed) {
      window.close();
      return false;
    }
    this.storage.write("warning-ack", w.text);
    return true;
  }

  // ---- 遊ばれ方の統計（analytics.ts） ----

  /** 書き出したゲームで、作品が build.analytics を書いていて、まだ答えていなければ尋ねる（開発サーバーと自動の確かめでは尋ねない。答えるまで送らない）。 */
  private async askAnalytics(): Promise<void> {
    if (import.meta.hot || !this.env.project.analytics || !analyticsAskable(this.host) || analyticsConsent(this.env.project.id) !== null) return;
    setAnalyticsConsent(this.env.project.id, await this.ask(TEXT.analytics.ask, "analytics"));
  }

  // ---- 止まったときの記録 ----

  private async offerCrashReport(): Promise<void> {
    const url = this.env.project.crashReport?.url;
    const r = takeCrashRecord(this.env.project.id);
    if (!r || !url) return;
    if (!(await this.ask(TEXT.crash.ask, "crash-report"))) return;
    toast(this.layer, (await sendCrashRecord(url, this.env.project.id, r)) ? TEXT.crash.sent : TEXT.crash.failed);
  }

  // ---- アップデート ----

  /**
   * アップデートを確かめ、あれば尋ねて更新する（system/update.ts）。manual はメニューと @check-update から。
   * 起動したときの確認は、タイトル画面でほかの画面が開いていないときに尋ねる（遊んでいる途中では尋ねない）。
   */
  private async offerUpdate(manual: boolean): Promise<void> {
    const update = window.liminaliaDesktop?.update;
    if (!update) return;
    const ask = async (message: string, kind: string) => {
      while (!manual && (this.mode !== "title" || this.screen)) await new Promise((r) => setTimeout(r, 500));
      return this.ask(message, kind);
    };
    await runUpdate(update, {
      ask,
      toast: (message) => toast(this.layer, message, 3000),
      language: this.language || "ja",
      declined: { get: () => this.storage.read<string>("update-declined"), set: (key) => void this.storage.write("update-declined", key) },
    }, manual);
  }

  // ---- 体験版などからの引き継ぎ ----

  /**
   * liminalia.json の saves.carryFrom の作品（体験版など）のセーブが見つかり、この作品にまだセーブが無ければ、引き継ぐかを一度だけ尋ねる。
   * ブラウザでは同じ保存先（同じ場所に置いたもの）から、デスクトップ版はその作品の題名の保存先から読む。引き継いだら読み込み直して true。
   */
  private async offerCarry(): Promise<boolean> {
    const from = Object.entries(this.env.project.saves?.carryFrom ?? {});
    if (from.length === 0 || this.storage.read("carry-asked") !== null || this.latestSave() !== null) return false;
    for (const [id, title] of from) {
      const found = this.storage.foreign(id) ?? (await window.liminaliaDesktop?.carry?.({ id, title }).catch(() => null)) ?? null;
      if (!found || !Object.keys(found.entries).some((k) => k.startsWith("slot:"))) continue;
      // 尋ねたら、答えによらず二度は尋ねない（見つからなかったときは、あとで体験版を遊んだら尋ねられるように覚えない）
      this.storage.write("carry-asked", true);
      if (!(await this.ask(TEXT.saves.carryConfirm(title), "carry"))) return false;
      const problem = this.storage.importAll({ format: "liminalia-saves", version: 1, project: id, date: "", entries: found.entries }, [id]);
      if (problem) {
        toast(this.layer, problem === "full" ? TEXT.saves.full : TEXT.saves.invalid);
        return false;
      }
      this.storage.write("carry-asked", true);
      await flushSaveStore();
      location.reload();
      return true;
    }
    return false;
  }

  // ---- フローチャート ----

  /** フローチャートを使うか（liminalia.json の extra.flowchart）。 */
  private get flowOn(): boolean {
    return !!this.project.extra?.flowchart;
  }

  private flow: Flow | null = null;
  private flowLoading: Promise<Flow | null> | null = null;
  /** 場面の最初の本文の位置（"ファイル:行"）→ 場面の id。 */
  private sceneAt = new Map<string, string>();

  /** フローチャート（project/flow.json）を読む。一度だけ。 */
  private loadFlow(): Promise<Flow | null> {
    if (!this.flowOn || !this.env.loadFlow) return Promise.resolve(null);
    this.flowLoading ??= this.env.loadFlow().then(
      (flow) => {
        this.flow = flow;
        this.sceneAt = new Map((flow?.scenes ?? []).flatMap((s) => (s.anchor ? [[`${s.anchor.file}:${s.anchor.line}`, s.id] as const] : [])));
        return flow;
      },
      () => null,
    );
    return this.flowLoading;
  }

  /** フローチャートを出すか（使っていて、何か一つでも読んだ）。 */
  private hasFlowchart(): boolean {
    return this.flowOn && this.read.size > 0;
  }

  // ---- 操作説明 ----

  private openHelp(): void {
    if (this.menuBlocked) return;
    const custom = this.env.screens?.help;
    if (!custom) {
      this.withViews("help", (views) => {
        if (this.menuBlocked) return;
        const rows = this.helpRows();
        const made = views.createHelp(this.templatesNow(), { rows, pages: this.project.ui?.help?.pages ?? [], asset: (k, p) => this.host.context.asset(k, p), close: () => screen.close() });
        const screen = this.openStandard("help", made.el);
        this.whenGone(screen, made.dispose);
      });
      return;
    }
    const life = lifecycle();
    const api: HelpScreenApi = { rows: this.helpRows(), pages: this.project.ui?.help?.pages ?? [], asset: (k, p) => this.host.context.asset(k, p), close: () => screen.close(), onClose: life.onClose };
    const screen = this.openStandard("help", custom(api));
    life.bind(screen, api);
  }

  /** 操作の表（今の割り当て: 遊ぶ人のキー → 作品の ui.keys → 既定。ゲームパッドは入れ替えたあとのボタン）。 */
  private helpRows(): HelpRow[] {
    const T = TEXT.help;
    const map = this.keyMap();
    const keys = (action: UiKeyAction) => [...new Set(map[action].map(keyName))];
    const join = (...parts: (string | false | undefined)[]) => parts.filter((x): x is string => !!x).join(T.or);
    const pad = (role: string) => padLabel(PAD_BUTTONS.find((p) => (this.prefs.pad[p] ?? p) === role) ?? role, this.prefs.padStyle);
    const wheelUpRollback = this.env.project.ui?.input?.wheelUp === "rollback";
    const swipeSide = this.env.project.ui?.input?.swipeSide !== "none";
    const label = (action: UiKeyAction) => TEXT.config.keyActions[action] ?? action;
    return [
      { label: label("advance"), keyboard: join(T.click, ...keys("advance"), T.wheelDown), touch: T.tap, pad: pad("a") },
      { label: label("menu"), keyboard: join(T.rightClick, ...keys("menu")), touch: T.longPress, pad: join(pad("start"), pad("b")) },
      ...(this.env.project.ui?.input?.numberKeys === false ? [] : [{ label: T.choose, keyboard: T.numberKeys, touch: T.tap, pad: pad("a") }]),
      { label: label("backlog"), keyboard: join(!wheelUpRollback && T.wheelUp, ...keys("backlog")), touch: T.swipeDown, pad: pad("y") },
      { label: label("hide"), keyboard: join(...keys("hide"), this.env.project.ui?.input?.middleClick !== "none" && T.middleClick, T.menuBar), touch: T.swipeUp, pad: pad("x") },
      { label: label("skip"), keyboard: join(T.holdCtrl, ...keys("skip")), touch: "", pad: join(T.holdPad(pad("rb")), pad("l3")) },
      { label: label("auto"), keyboard: join(...keys("auto"), T.menuBar), touch: "", pad: pad("rt") },
      { label: label("rollback"), keyboard: join(wheelUpRollback && T.wheelUp, ...keys("rollback")), touch: swipeSide ? T.swipeRight : "", pad: pad("lb") },
      { label: label("rollforward"), keyboard: join(...keys("rollforward")), touch: swipeSide ? T.swipeLeft : "", pad: pad("lt") },
      { label: label("quickSave"), keyboard: join(...keys("quickSave")), touch: "", pad: T.dpadRight },
      { label: label("quickLoad"), keyboard: join(...keys("quickLoad")), touch: "", pad: T.dpadLeft },
      { label: label("config"), keyboard: join(...keys("config"), T.menuBar), touch: "", pad: pad("select") },
      { label: label("mute"), keyboard: join(...keys("mute")), touch: "", pad: pad("r3") },
      { label: label("replayVoice"), keyboard: join(...keys("replayVoice")), touch: "", pad: "" },
      { label: label("copyText"), keyboard: join(T.copyKey, ...keys("copyText")), touch: "", pad: "" },
      // キーを割り当てた常駐のボタンなど（[data-lm-key]。出す条件で隠しているものは並べない）
      ...[...this.host.stage.querySelectorAll<HTMLElement>(KEYED)]
        .filter((el) => !el.closest("[hidden]"))
        .map((el) => ({
          label: (el.getAttribute("aria-label") || el.textContent || "").trim(),
          keyboard: join(T.click, keyName(el.dataset.lmKey!)),
          touch: T.tap,
          pad: el.closest(PLAY_NAV) ? T.dpadChoose(pad("a")) : "",
        }))
        .filter((r) => r.label !== ""),
    ];
  }

  // ---- 字幕 ----

  /** 字幕の文字: 効果音は caption= か ui.captions.sounds、BGM は ui.captions.music ならおまけの音楽の題名。 */
  private setupCaptions(): void {
    this.host.captionText = (kind, file, caption) => {
      const c = this.project.ui?.captions;
      if (kind === "se") return caption ?? c?.sounds?.[file] ?? null;
      // 本文に書いていない声の字幕（@voice の caption）
      if (kind === "voice") return caption ?? null;
      if (!c?.music) return null;
      const title = this.project.extra?.music?.find((m) => m.file === file)?.title;
      return title ? TEXT.captions.music(title) : null;
    };
  }

  // ---- 持ち物 ----

  /** 作品が持ち物を使うか（liminalia.json の items）。 */
  private hasItems(): boolean {
    return Object.keys(this.project.items ?? {}).length > 0;
  }

  /** 今のプレイで持っている数（ゲームの変数の @items）。 */
  private heldItems(): Record<string, number> {
    const bag = this.runtime?.state.game[ITEMS_KEY];
    if (!bag || typeof bag !== "object" || Array.isArray(bag)) return {};
    return Object.fromEntries(Object.entries(bag).filter((e): e is [string, number] => typeof e[1] === "number"));
  }

  /** 持ち物を選ばせる（@item-select）と手に入れた知らせ（@item-add）を描画側から受ける。 */
  private setupItems(): void {
    this.host.pickItem = (title) =>
      new Promise((resolve) => {
        let done = false;
        // 録画（lim shot --video）は、読む時間だけ見せてから選ばずに閉じる（自動確認の autoplay と同じ）
        const withdraw = this.host.offer({ options: [TEXT.close], proceed: 0, choose: () => finish(null) });
        const finish = (key: string | null) => {
          if (done) return;
          done = true;
          withdraw();
          screen.close();
          resolve(key);
        };
        const life = lifecycle();
        const api: ItemsScreenApi = { items: this.project.items ?? {}, held: this.heldItems(), asset: (k, p) => this.host.context.asset(k, p), select: { ...(title ? { title } : {}), pick: (key) => finish(key) }, close: () => finish(null), onClose: life.onClose };
        const custom = this.env.screens?.items;
        const screen = this.openStandard("items", custom ? custom(api) : createItems({ ...api, held: { ...api.held } }), () => {
          this.closeScreen(screen);
          finish(null);
        });
        life.bind(screen, api);
        // 選ぶのを待っている間も、メニュー・セーブ・履歴・コンフィグを開ける（Esc・右クリックはこれまでどおり選ぶのをやめる）
        screen.allowMenu = true;
        screen.el.dataset.lmAllowMenu = "true";
        this.sync();
      });
    this.host.onItemAdded = (key) => {
      const item = this.project.items?.[key];
      if (item && !this.host.skipping) toast(this.layer, TEXT.items.added(item.name));
    };
  }

  private openItems(): void {
    if (!this.hasItems() || this.menuBlocked) return;
    const life = lifecycle();
    const api: ItemsScreenApi = { items: this.project.items ?? {}, held: this.heldItems(), asset: (k, p) => this.host.context.asset(k, p), close: () => screen.close(), onClose: life.onClose };
    const custom = this.env.screens?.items;
    const screen = this.openStandard("items", custom ? custom(api) : createItems({ ...api, held: { ...api.held } }));
    life.bind(screen, api);
  }

  // ---- 用語集・章 ----

  /** 用語集の語を描画側に渡す（本文に出たら解放し、押されたら説明を出す）。 */
  private setupGlossary(): void {
    const items = this.project.extra?.glossary ?? [];
    this.host.setGlossary(
      items.length === 0
        ? null
        : {
            words: items.flatMap((g) => [g.term, ...(g.aliases ?? [])].map((word) => ({ word, id: g.id, link: g.link !== false }))),
            shown: (id) => this.unlockTerm(id),
            open: (id, at) => this.openTerm(id, at),
          },
    );
  }

  private unlockTerm(id: string): void {
    if (this.replaying) return;
    const unlocked = (this.system.glossary_unlocked ??= {}) as Record<string, Value>;
    if (unlocked[id]) return;
    unlocked[id] = true;
    this.storage.saveSystemVariables(this.system);
    const g = this.project.extra?.glossary?.find((x) => x.id === id);
    if (g) toast(this.layer, TEXT.extra.termAdded(g.term));
  }

  /** 用語の説明を本文の近くに出す（どこかを押すと閉じる）。 */
  private openTerm(id: string, at: HTMLElement): void {
    const g = this.project.extra?.glossary?.find((x) => x.id === id);
    if (!g) return;
    this.layer.querySelector(".lm-term-pop")?.remove();
    const pop = el("div", "lm-term-pop", el("span", "lm-term-name", g.term), el("span", "lm-term-desc", g.description));
    const stage = this.host.stage.getBoundingClientRect();
    const box = at.getBoundingClientRect();
    // 文字と枠の座標（system/default.css の .lm-sys は --lm-ui-scale で拡大・縮小する）
    const space = uiSpace(this.env.project.screen);
    const scale = stage.width / space.width;
    pop.style.left = `${Math.max(16, Math.min((box.left - stage.left) / scale, space.width - 436))}px`;
    pop.style.bottom = `${Math.max(16, (stage.bottom - box.top) / scale + 10)}px`;
    const close = (e: Event) => {
      e.stopPropagation();
      pop.remove();
      this.host.stage.removeEventListener("click", close, true);
    };
    this.host.stage.addEventListener("click", close, true);
    this.layer.append(pop);
  }

  /** 章の始まりの最初のページの位置（"ファイル:行"）→ 章の id。 */
  private chapterAt: Map<string, string> | null = null;

  private async loadChapters(): Promise<void> {
    if (this.chapterAt) return;
    const at = new Map<string, string>();
    for (const c of this.project.extra?.chapters ?? []) {
      const page = await this.firstPage(c.target);
      if (page) at.set(`${page.file}:${page.line}`, c.id);
    }
    this.chapterAt = at;
  }

  /**
   * 章の始まりに着いたら解放し、はじめてならその時点を控える（章から読み直すため）。stage は、セーブの一覧に出す章の名前を書く舞台
   * （省けば遊んでいる実行器の舞台。「次の選択肢へ」は飛んだ先のセーブの舞台に書く）。
   */
  private reachChapter(at: { file: string; line: number }, save?: () => SaveData, stage?: StageState): void {
    const rt = this.runtime;
    if (!rt || this.replaying || !this.project.extra?.chapters?.length || this.pages <= this.devSkipUntil) return;
    if (!this.chapterAt) {
      void this.loadChapters().then(() => this.runtime === rt && this.reachChapter(at, save, stage));
      return;
    }
    const id = this.chapterAt.get(`${at.file}:${at.line}`);
    if (!id) return;
    // 章に着いたら Steam の在席表示に章の題を出す
    const chapter = this.project.extra?.chapters?.find((c) => c.id === id);
    if (chapter) window.liminaliaDesktop?.presence?.(chapter.title);
    // セーブの一覧に出す章の名前（セーブに入るので、ロードしても続く）
    if (chapter) (stage ?? rt.state.stage).extra[CHAPTER_KEY] = chapter.title;
    const unlocked = (this.system.chapters_unlocked ??= {}) as Record<string, Value>;
    if (this.storage.read(`chapter:${id}`) === null) this.storage.write(`chapter:${id}`, save ? save() : rt.save());
    if (!unlocked[id]) {
      unlocked[id] = true;
      this.storage.saveSystemVariables(this.system);
    }
  }

  /** 章から読み直す（控えから。確かめてから）。 */
  private async startChapter(chapter: ExtraChapter, close: () => void): Promise<void> {
    const save = this.storage.read<SaveData>(`chapter:${chapter.id}`);
    if (!save || !(await this.ask(TEXT.extra.chapterConfirm(chapter.title), "chapter"))) return;
    close();
    await this.emit({ type: "load-start", from: "chapter" });
    this.closeAllScreens();
    this.removeTitle();
    const rt = this.createRuntime();
    this.stayOnEnd = false;
    this.resetPlayTime();
    this.enterGame();
    this.run(rt, rt.load(save));
    this.reopenScreens(save);
  }

  /** 場面の最初の本文を出すとき、はじめてならその時点を控える（フローチャートから読み直すため。全セーブ共通）。 */
  private snapshotScene(at: { file: string; line: number }, save?: () => SaveData): void {
    const rt = this.runtime;
    if (!this.flowOn || !rt || this.replaying || this.pages <= this.devSkipUntil) return;
    if (!this.flow) {
      void this.loadFlow().then(() => this.runtime === rt && this.snapshotScene(at, save));
      return;
    }
    const id = this.sceneAt.get(`${at.file}:${at.line}`);
    if (!id || this.storage.read(`scene:${id}`) !== null) return;
    this.storage.write(`scene:${id}`, save ? save() : rt.save());
  }

  /** 場面を読んだことがあるか。本文の無い場面（選択肢だけなど）は、その先の場面を読んでいれば読んだことにする。 */
  private sceneReached(scene: FlowScene, seen = new Set<string>()): boolean {
    if (this.storage.read(`scene:${scene.id}`) !== null) return true;
    if (scene.anchor) return this.read.has(scene.anchor);
    if (!this.flow || seen.has(scene.id)) return false;
    seen.add(scene.id);
    const byId = new Map(this.flow.scenes.map((s) => [s.id, s]));
    return this.flow.links.some((l) => l.from === scene.id && byId.has(l.to) && this.sceneReached(byId.get(l.to)!, seen));
  }

  /** 本文のページのうち読んだもの（フローチャートのページの一覧から数える）。 */
  private readCount(flow: Flow): CompletionCount {
    let total = 0;
    let done = 0;
    for (const [file, lines] of Object.entries(flow.pages)) {
      const keys = flow.keys?.[file];
      lines.forEach((line, i) => {
        total++;
        if (this.read.has({ file, line, key: keys?.[i] })) done++;
      });
    }
    return { done, total };
  }

  /**
   * コンプリート率。既読とエンディングは台本から作ったフローチャートで数える（extra.flowchart を使わない作品でも読む。読めなければ null）。
   */
  /** シナリオから作ったフローチャート（extra.flowchart を書いていなくても読む。既読とエンディングを数えるため）。 */
  private async storyFlow(): Promise<Flow | null> {
    if (this.flowOn) return this.loadFlow();
    if (!this.env.loadFlow) return null;
    this.flowLoading ??= this.env.loadFlow().then(
      (f) => (this.flow = f),
      () => null,
    );
    return this.flowLoading;
  }

  /** おまけのエンディングの一覧（extra.endings）。フローチャートのエンディングのタブと同じ名前と題。 */
  private async extraEndings(): Promise<ExtraEnding[]> {
    const loaded = await this.storyFlow();
    if (!loaded) return [];
    const flow = localizeFlow(loaded, this.translator);
    const config = this.project.extra?.flowchart;
    const titles = typeof config === "object" ? (config.titles ?? {}) : {};
    let n = 0;
    return flow.scenes
      .filter((s) => s.end)
      .map((scene) => {
        const ending = this.flowEnding(scene);
        const name = ending.name || TEXT.flowchart.endingName(++n);
        const reached = this.sceneReached(scene);
        const canJump = reached && this.storage.read(`scene:${scene.id}`) !== null;
        return { name, kind: ending.kind, title: titles[scene.id] ?? scene.title ?? "", reached, ...(canJump ? { jump: () => void this.jumpToScene(scene) } : {}) };
      });
  }

  async completion(): Promise<Completion> {
    const flow = await this.storyFlow();
    const ends = flow?.scenes.filter((s) => s.end) ?? [];
    return extraCompletion(this.project.extra, this.system, flow ? { read: this.readCount(flow), endings: { done: ends.filter((s) => this.sceneReached(s)).length, total: ends.length } } : null);
  }

  /** フローチャートの画面（作品が差し替えていればそれ）。 */
  private async openFlowchart(): Promise<void> {
    if (this.menuBlocked || !this.flowOn) return;
    const loaded = await this.loadFlow();
    if (!loaded || this.menuBlocked) return;
    // 場面の題と選択肢の文は、遊んでいる言語の訳で出す
    const flow = localizeFlow(loaded, this.translator);
    const config = this.project.extra?.flowchart;
    const titles = typeof config === "object" ? (config.titles ?? {}) : {};
    const { done, total } = this.readCount(flow);
    let n = 0;
    // エンディングは種類の文言と名前（title= はコマンドの文字として訳す）
    const endings = flow.scenes
      .filter((s) => s.end)
      .map((scene) => {
        const e = this.flowEnding(scene);
        return { scene, name: e.name || TEXT.flowchart.endingName(++n), reached: this.sceneReached(scene), kind: e.kind, label: e.label, title: e.title };
      });
    let back: () => boolean = () => false;
    const life = lifecycle();
    const api: FlowchartScreenApi = {
      flow,
      // 本文の無い場面は、選択肢を出すところなら「選択肢」
      title: (scene) => titles[scene.id] ?? (scene.title || (flow.links.some((l) => l.from === scene.id && l.choice) ? TEXT.flowchart.choice : "")),
      reached: (scene) => this.sceneReached(scene),
      canJump: (scene) => this.storage.read(`scene:${scene.id}`) !== null,
      jump: (scene) => void this.jumpToScene(scene),
      readRate: total > 0 ? done / total : 0,
      endings,
      close: () => screen.close(),
      onBack: (handler) => (back = handler),
      onClose: life.onClose,
    };
    const custom = this.env.screens?.flowchart;
    const view = custom ? null : createFlowchart(api);
    const screen = this.openStandard("flowchart", custom ? custom(api) : view!.el, () => {
      if (back() || view?.back()) return;
      this.closeScreen(screen);
    });
    life.bind(screen, api);
  }

  /** フローチャートの場面から読み直す（はじめて着いたときの控えから。確かめてから）。 */
  private async jumpToScene(scene: FlowScene): Promise<void> {
    const save = this.storage.read<SaveData>(`scene:${scene.id}`);
    if (!save || !(await this.ask(TEXT.flowchart.jumpConfirm, "flowchart-jump"))) return;
    await this.emit({ type: "load-start", from: "flowchart" });
    this.closeAllScreens();
    this.removeTitle();
    const rt = this.createRuntime();
    this.stayOnEnd = false;
    this.enterGame();
    this.run(rt, rt.load(save));
    this.reopenScreens(save);
  }

  // ---- 既読の選択肢 ----

  /** 読んだ台本（選択肢の飛び先の最初のページを割り出すため）。 */
  private readonly scripts = new Map<string, Promise<Script | null>>();

  private script(file: string): Promise<Script | null> {
    let p = this.scripts.get(file);
    if (!p) {
      p = this.host.loadSource(file).then(
        (text) => parse(text, file, { speakers: this.env.speakers }),
        () => null,
      );
      this.scripts.set(file, p);
    }
    return p;
  }

  /** 読んだ台本のページの鍵（行 → 鍵）。 */
  private readonly scriptKeys = new WeakMap<Script, Map<number, string>>();

  private keysOf(script: Script): Map<number, string> {
    let keys = this.scriptKeys.get(script);
    if (!keys) this.scriptKeys.set(script, (keys = pageKeys(script)));
    return keys;
  }

  /** 前のバージョンが行で覚えた既読を、今のシナリオの鍵に移す（そのファイルを読み込んでいれば）。 */
  private adoptLegacyRead(file: string): void {
    if (!this.read.hasLegacy(file)) return;
    const keys = this.runtime?.pageKeysOf(file);
    if (keys) this.read.adopt(file, keys);
    else void this.script(file).then((script) => script && this.read.adopt(file, this.keysOf(script)));
    this.scheduleReadSave();
  }

  /** 飛び先（`ファイル` か `ファイル#ラベル`）の最初のページの位置と鍵。飛び先の頭の @jump は三つまでたどる。分からなければ null。 */
  private async firstPage(target: string, depth = 0): Promise<{ file: string; line: number; key?: string } | null> {
    const [file = "", label] = target.split("#");
    const script = await this.script(file);
    if (!script) return null;
    let start = 0;
    if (label) {
      start = script.body.findIndex((s) => s.kind === "label" && s.name === label) + 1;
      if (start === 0) return null;
    }
    for (const s of script.body.slice(start)) {
      if (s.kind === "say" || s.kind === "prose") {
        const key = this.keysOf(script).get(s.line);
        return { file, line: s.line, ...(key ? { key } : {}) };
      }
      if (s.kind === "jump") return s.target.expr || depth >= 3 ? null : this.firstPage(`${s.target.file ?? file}${s.target.label ? `#${s.target.label}` : ""}`, depth + 1);
      if (s.kind === "choice" || s.kind === "call" || s.kind === "if") return null;
    }
    return null;
  }

  async choiceRead(targets: readonly (string | null)[]): Promise<boolean[]> {
    return Promise.all(targets.map(async (t) => {
      if (!t) return false;
      const at = await this.firstPage(t);
      return at !== null && this.read.has(at);
    }));
  }

  // ---- 前の選択肢・次の選択肢 ----

  /** 選択肢を出した時点を控える（回想の間は控えない）。 */
  private rememberChoice(): void {
    const rt = this.runtime;
    if (!rt || this.replaying || this.mode !== "game") return;
    this.choices.remember(rt, this.log.entries.length);
  }

  /** 前の選択肢から選び直す（選んでいる最中なら、その一つ前）。それより後の進み具合は捨てる（確かめてから）。 */
  private async prevChoice(): Promise<void> {
    const back = this.choices.previous(this.choosing);
    if (!back) return toast(this.layer, TEXT.choice.noPrev);
    if (!(await this.ask(TEXT.choice.prevConfirm, "prev-choice"))) return;
    await this.emit({ type: "load-start", from: "choice" });
    this.closeAllScreens();
    const log = this.log.entries.slice(0, back.point.log);
    const rt = this.createRuntime();
    this.log.restoreKeeping(log);
    this.choices.replace(back.before);
    this.stayOnEnd = false;
    this.enterGame();
    this.run(rt, rt.load(back.point.save));
    this.reopenScreens(back.point.save);
  }

  /**
   * 次の選択肢へ飛ぶ。今の位置から画面なしで流して次の選択肢の時点を見つけ、そこをロードと同じように組み立て直す
   * （文字送りはしない）。飛ばした本文はバックログに入れ、CG と章の解放、フローチャートのシーンの控え、全セーブ共通の変数の変化、
   * 実績、聞いた声の記録など、スキップで通っても起きることは起こす。既読にはしない（読んでいないため）。
   * 未読はスキップの設定に従う: 「既読のみ」なら選択肢の手前の最初の未読のページへ飛んで止まる（スキップが止まるのと同じ位置）。
   * 作品が ui.nextChoice.readOnly にしていれば、未読があるときは知らせるだけで飛ばない。この先に選択肢が無ければ知らせて飛ばない。
   */
  private async nextChoice(): Promise<void> {
    const rt = this.runtime;
    if (!rt || this.choosing || this.replaying) return;
    const readOnly = this.env.project.ui?.nextChoice?.readOnly === true;
    const stopAtUnread = readOnly || !this.prefs.skipUnread;
    const skipped = new Backlog(this.log.limit);
    // 章の始まりの位置は先に読んでおく（飛ばした所で着いた章を、組み立て直す前に解放するため）
    const chapters = !!this.project.extra?.chapters?.length;
    if (chapters) await this.loadChapters();
    if (this.runtime !== rt) return;
    // ページの頭のセーブは、章とフローチャートのシーンを控えるときだけ要る（ページごとに写すので、要らなければ作らない）
    const wantSaves = this.flowOn || chapters;
    const passed: { event: PresentEvent; save: () => SaveData; sprites?: Record<string, Sprite> }[] = [];
    // 先へ流す実行器は、遊んでいる実行器（rt）を作ったときの設定と今の言語と訳で作る（choice-history.ts の AHEAD_RUNTIME_OPTIONS）
    const jump = await findChoiceAhead({
      runtime: rt,
      loadSource: (f) => this.host.loadSource(f),
      loadData: (name) => this.host.loadData(name),
      ...(stopAtUnread ? { isRead: (at: { file: string; line: number; key?: string }) => this.read.has(at) } : {}),
      present: (event, save, walker) => {
        // バックログ（@backlog off の間と、ここで足す本文も、プレイしたときと同じに）
        if (event.type === "page") skipped.page(event.speaker, event.at, event.voice, event.label, event.with);
        else if (event.type === "text") skipped.text(event.text, event.ruby, event.style);
        else if (event.type === "br") skipped.br();
        else if (event.name === "voice") skipped.voice({ file: String(event.args.file ?? ""), volume: Number(event.args.volume ?? 100), folder: String(event.args.folder ?? "voice") });
        else if (event.name === "backlog") skipped.paused = event.args.mode === "off";
        else if (event.name === "backlog-add") skipped.add(String(event.args.text ?? ""), event.args.join === true, skipped.current?.at ?? { file: "", line: 0 });
        // ページの頭のセーブは、そのときに作らないと先へ進んでしまう
        if (event.type === "page" && wantSaves) {
          const at = save();
          passed.push({ event, save: () => at });
        } else if (event.type === "command" && event.name === "chara") {
          // 立ち絵の鑑賞は、出した時点の差分で覚える（流し終えたあとの舞台は、後で替えた差分や消した人物のもの）
          passed.push({ event, save, sprites: structuredClone(walker.state.stage.sprites) });
        } else passed.push({ event, save });
      },
    });
    if (this.runtime !== rt) return;
    if (!jump) return toast(this.layer, TEXT.choice.noNext);
    if (jump.kind === "unread") {
      if (readOnly) return toast(this.layer, TEXT.choice.unreadAhead);
      // 止めた未読のページは、組み立て直したあとに出すので、飛ばしたものから除く
      const last = passed.findLastIndex((p) => p.event.type === "page");
      const page = passed[last]?.event;
      if (last >= 0) passed.splice(last);
      // バックログを止めている（@backlog off）間のページは入っていないので、同じ位置のときだけ除く
      const entry = skipped.entries.at(-1);
      if (page?.type === "page" && entry && entry.at.file === page.at.file && entry.at.line === page.at.line) skipped.truncate(skipped.entries.length - 1);
    }
    // 先へ流した実行器が変えた全セーブ共通の変数（CG の解放、実績、@set system.… など）を先に移し、その上に、飛ばしても起きること
    // （章、ムービー、立ち絵の鑑賞）を足す。順が逆だと、流す前の写しから来た一番上の鍵（chapters_unlocked など）が足したものを消す
    Object.assign(this.system, jump.system);
    let speaker: string | null = null;
    for (const { event, save, sprites } of passed) {
      if (event.type === "page") {
        speaker = event.speaker;
        this.snapshotScene(event.at, save);
        // セーブの一覧に出す章の名前は、飛んだ先の舞台に書く
        this.reachChapter(event.at, save, jump.save.stage);
        for (const who of voiceSpeakers(event.voice, speaker)) this.heardVoice(who);
      } else if (event.type === "command") {
        // 読み上げの文（@describe と絵の説明）は飛ばした所では読まない
        this.noteSeen(event.name, event.args, sprites);
        if (event.name === "voice" && speaker !== null) this.heardVoice(speaker);
        // 実績の解除（数える実績が目標に届いたときも）は、店へ知らせて通知を出す
        if (event.name === "achieve" || event.name === "achieve-progress") await this.request({ name: event.name, args: event.args });
      }
    }
    this.storage.saveSystemVariables(this.system);
    await this.emit({ type: "load-start", from: "choice" });
    this.closeAllScreens();
    const log = [...this.log.entries, ...skipped.entries].slice(-this.log.limit);
    const choices = [...this.choices.points];
    const next = this.createRuntime();
    this.log.restoreKeeping(log);
    this.choices.replace(choices);
    next.state.temp = jump.temp;
    this.stayOnEnd = false;
    this.enterGame();
    this.run(next, next.load(jump.save));
    this.reopenScreens(jump.save);
    if (jump.kind === "unread") toast(this.layer, TEXT.choice.stoppedAtUnread);
  }

  /**
   * 次の未読まで飛ばす（設定が「すべて飛ばす」でも未読のページで止まる。選択肢でも止まる）。
   * 先に画面なしで流して、次の選択肢までに未読があるかを確かめる（選択肢まで既読なら選択肢まで飛ばし、終わりまで既読なら知らせる）。
   */
  private async nextUnread(): Promise<void> {
    const rt = this.runtime;
    if (!rt || this.choosing) return;
    const ahead = await unreadAhead({
      runtime: rt,
      loadSource: (f) => this.host.loadSource(f),
      loadData: (name) => this.host.loadData(name),
      isRead: (at) => this.read.has(at),
    });
    if (this.runtime !== rt) return;
    if (ahead === "none") return toast(this.layer, TEXT.choice.noUnread);
    this.toUnread = true;
    // 押したページが未読でも、そのページは飛ばしてよい（次のページから既読かを見る。見なければスキップの印だけが立って進まない）
    this.passUnreadPage = true;
    this.setSkip(true);
  }

  /** おまけの画面。 */
  private openExtra(tab?: ExtraTab): void {
    const screens = this.extraScreens();
    const extra = this.project.extra ?? (screens.length > 0 ? {} : undefined);
    if (!extra) return;
    const custom = this.env.screens?.extra;
    if (custom) {
      const s = extraState(extra, this.system);
      let back: () => boolean = () => false;
      const life = lifecycle();
      const keys = new Set<(key: string, e: KeyboardEvent | null) => boolean>();
      const api: ExtraScreenApi = {
          extra,
          ...(tab ? { tab } : {}),
          cgImages: s.cgImages,
          replayUnlocked: s.replay,
          musicUnlocked: s.music,
          movieUnlocked: s.movie,
          achievement: s.achievement,
          achievementProgress: s.achievementProgress,
          completion: () => this.completion(),
          glossaryUnlocked: s.glossary,
          chapterUnlocked: s.chapter,
          chapters: this.chapters,
          startChapter: (c) => void this.startChapter(c, () => screen.close()),
          asset: (kind, path) => this.host.context.asset(kind, path),
          audio: this.host.audio,
          replay: (entry) => {
            screen.close();
            this.startReplay(entry);
          },
          close: () => screen.close(),
          onBack: (handler) => (back = handler),
          onKey: (handler) => {
            keys.add(handler);
            return () => void keys.delete(handler);
          },
          onClose: life.onClose,
      };
      const screen = this.openStandard("extra", custom(api), () => {
        if (back()) return;
        this.closeScreen(screen);
      });
      life.bind(screen, api);
      // 作品のキー（ExtraScreenApi.onKey）は、標準の動き（矢印でボタンを移る・Enter で押す）より先に受ける（矢印は input.ts、ほかはキーの受け口から）
      const onKey = (e: KeyboardEvent) => this.screens.at(-1) === screen && !e.isComposing && [...keys].some((h) => h(e.key, e));
      this.screenKey = onKey;
      // ゲームパッドの十字キーと A・B も、キーの名前にして届ける（lm-pad。input.ts）
      screen.el.addEventListener("lm-pad", (e) => {
        const key = PAD_KEYS[String((e as CustomEvent<{ button?: string }>).detail?.button)];
        if (key && [...keys].some((h) => h(key, null))) e.preventDefault();
      });
      life.onClose(() => {
        if (this.screenKey === onKey) this.screenKey = null;
      });
      return;
    }
    const view = createExtra({
      extra,
      system: this.system,
      asset: (kind, path) => this.host.context.asset(kind, path),
      audio: this.host.audio,
      replay: (entry) => {
        screen.close();
        this.startReplay(entry);
      },
      startChapter: (c) => void this.startChapter(c, () => screen.close()),
      cast: this.host.context.cast,
      sprite: (who, appearance, variant) => this.host.spriteImage(who, appearance, variant),
      completion: this.completion(),
      ...(this.project.chapters ? { chapters: this.project.chapters } : {}),
      ...(extra.endings === true ? { endings: this.extraEndings() } : {}),
      close: () => screen.close(),
      ...(tab ? { tab } : {}),
      screens: screens.map((s) => ({ label: s.label, open: () => void this.openScreenByName(s.name) })),
    });
    const screen = this.openStandard("extra", view.el, () => {
      // Esc・右クリックは、CG を大きく見ていればそれだけ閉じる
      if (view.back()) return;
      view.dispose();
      this.closeScreen(screen);
    });
  }

  /** 回想を再生する。終わるか @replay-end でおまけの回想のタブへ戻る。 */
  private startReplay(entry: ExtraReplay): void {
    this.closeAllScreens();
    this.removeTitle();
    const rt = this.createRuntime();
    this.replaying = entry;
    this.stayOnEnd = false;
    this.enterGame();
    // 回想の中は replaying() が真。本編で決まる値は extra.replay の variables で渡す
    this.run(rt, rt.start(entry.target, { replay: entry.id, ...(entry.variables ? { variables: entry.variables as Record<string, Value> } : {}) }));
  }

  private async endReplay(): Promise<void> {
    this.replaying = null;
    await this.showTitle(true);
    if (this.mode === "title") this.openExtra("replay");
  }

  private openConfig(): void {
    const custom = this.env.screens?.config;
    const defaults = settingsDefaults(this.env.project.ui?.defaults);
    if (!custom) {
      // 型（作品の ui.templates.config を標準に重ねたもの）から作る。書き出しでは型を初めて開くときに読む
      this.withViews("config", (views) => {
        const made = views.createConfig(this.templatesNow(), this.prefs, (s) => void this.updateSettings(s), () => screen.close(), this.env.project.languages ?? [], {
          defaults,
          exportSaves: () => this.exportSaves(),
          importSaves: () => void this.importSaves(),
          // 表現を控えめにする（作品が使い、版で決めていないときだけ選べる）
          ...(this.env.project.ui?.contentFilter && !this.env.project.variant?.contentFilter ? { contentFilter: { label: this.project.ui!.contentFilter!.label ?? TEXT.config.contentFilter } } : {}),
          ...(this.env.project.ui?.systemVoice ? { systemVoice: { characters: systemVoiceCharacters(systemVoiceEntries(this.env.project.ui.systemVoice)) } } : {}),
          subscribe: (listener) => this.onSettingsChange(listener),
          controls: { keys: (action, player) => resolveKeys(this.env.project.ui, player)[action], capturePad: (take) => this.input?.capturePad(take) },
          ...(window.liminaliaDesktop?.setWindowScale ? { screenSize: { game: this.env.project.screen, available: { width: window.screen.availWidth, height: window.screen.availHeight - 40 } } } : {}),
          // 最小化したときと、ほかのウィンドウを選んだときの動き（デスクトップ版だけ）。最小化したときの既定は作品の設定
          ...(window.liminaliaDesktop ? { inactive: { hiddenDefault: this.env.project.ui?.screen?.pauseInBackground === false ? ("play" as const) : ("pause" as const) } } : {}),
          // 音量の欄の試聴（ui.settings.samples）
          ...(this.env.project.ui?.settings?.samples ? { sample: (kind: "bgm" | "se" | "voice") => this.playSample(kind) } : {}),
          // 既読の文の色を作品が決めているか、話者ごとの声の音量にまだ聞いていない人物も並べるか（ui.settings.voiceSpeakers）
          readColor: !!this.env.project.ui?.text?.readColor,
          ...(this.env.project.ui?.settings?.voiceSpeakers === "all" || this.env.project.ui?.settings?.voiceSpeakers === "masked" ? { speakers: { all: this.env.speakers ?? [], masked: this.env.project.ui.settings.voiceSpeakers === "masked" } } : {}),
          // 遊ばれ方の統計（作品が build.analytics を書いたときだけ）
          ...(this.env.project.analytics && !import.meta.hot ? { analytics: { get: () => analyticsConsent(this.env.project.id) === true, set: (on: boolean) => setAnalyticsConsent(this.env.project.id, on) } } : {}),
        });
        const screen = this.openStandard("config", made.el);
        this.whenGone(screen, made.dispose);
        // 閉じたら試聴を止める
        this.whenGone(screen, () => this.host.audio.stopSample());
      });
      return;
    }
    const life = lifecycle();
    const api: ConfigScreenApi = {
      system: this,
      languages: this.env.project.languages ?? [],
      defaults,
      reset: () => this.updateSettings(resetSettings(this.prefs, defaults)),
      close: () => screen.close(),
      exportSaves: () => this.exportSaves(),
      importSaves: () => void this.importSaves(),
      onClose: life.onClose,
    };
    const screen = this.openStandard("config", custom(api));
    life.bind(screen, api);
    // 閉じたら試聴を止める
    this.whenGone(screen, () => this.host.audio.stopSample());
  }

  /** 音量の欄の試聴を鳴らす（ui.settings.samples。決めていない系統は鳴らさない）。 */
  private playSample(kind: "bgm" | "se" | "voice"): void {
    const file = this.env.project.ui?.settings?.samples?.[kind];
    if (file) void this.host.audio.playSample(kind, file);
  }

  /** セーブ・既読・設定を一つのファイルに書き出す（バックアップと、別のコンピューターへの移し替え）。スマホ版のアプリでは共有のシートへ渡す。 */
  private exportSaves(): void {
    this.flush();
    const data = this.storage.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    void saveFile(`${this.env.project.id}-saves-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`, blob).then((ok) => ok || toast(this.layer, TEXT.toast.exportFailed));
  }

  /** 書き出したファイルを読み込む（今のセーブは置き換わる。確かめてから。読み込めたら最初から組み立て直す）。 */
  private async importSaves(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    const file = await new Promise<File | null>((resolve) => {
      input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
      input.click();
    });
    if (!file) return;
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return toast(this.layer, TEXT.saves.invalid);
    }
    if (!(await this.ask(TEXT.saves.importConfirm, "import"))) return;
    const problem = this.storage.importAll(data, Object.keys(this.env.project.saves?.carryFrom ?? {}));
    if (problem) return toast(this.layer, problem === "other-project" ? TEXT.saves.otherProject : problem === "full" ? TEXT.saves.full : TEXT.saves.invalid);
    // 読み込んだ既読・設定・全セーブ共通の変数を使うため、保存先に書き終えてからプレイヤーを開き直す
    await flushSaveStore();
    location.reload();
  }

  /** 開いている設定画面を閉じて開き直す（言語を替えたとき、文言を読み直すため）。 */
  private reopenConfig(): void {
    const current = this.screens.find((s) => s.name === "config");
    if (!current) return;
    this.closeScreen(current);
    this.relabel();
    if (this.mode === "title" && this.titleEl) this.renderTitle();
    this.openConfig();
  }

  private openMenu(): void {
    if (this.mode !== "game" || this.menuBlocked) return;
    // 遊ぶ人の操作を待つ画面（文字の入力と確認の枠も）の上で開いたメニューには、本文を読み進める操作（オート・スキップ・選択肢へ戻るなど）を並べない
    const overScreen = this.overScreen || (this.screen === null && this.panelShown);
    const custom = this.env.screens?.menu;
    if (custom) {
      const status = () => this.status;
      const life = lifecycle();
      const api: MenuScreenApi = {
          items: withScreens(menuItems({ desktop: canQuitApp(), replay: this.replaying !== null, flowchart: this.flowOn, items: this.hasItems(), update: !!window.liminaliaDesktop?.update, voice: !!this.pageVoice(), overScreen }), this.menuScreens()),
          label: (a) => this.actionLabel(a),
          perform: (a) => {
            screen.close();
            void this.act(a);
          },
          get status() {
            return status();
          },
          close: () => screen.close(),
          onClose: life.onClose,
      };
      const screen = this.openStandard("menu", custom(api));
      life.bind(screen, api);
      return;
    }
    this.withViews("menu", (views) => {
      if (this.mode !== "game" || this.menuBlocked) return;
      const made = views.menuPanel(this.templatesNow(), {
        desktop: canQuitApp(),
        auto: this.auto,
        skip: this.skip,
        replay: this.replaying !== null,
        flowchart: this.flowOn,
        items: this.hasItems(),
        update: !!window.liminaliaDesktop?.update,
        voice: !!this.pageVoice(),
        overScreen,
        screens: this.menuScreens().map((action) => ({ action, label: this.actionLabel(action) })),
        run: (a) => {
          screen.close();
          void this.act(a);
        },
        close: () => screen.close(),
      });
      const screen = this.openStandard("menu", made.el);
      this.whenGone(screen, made.dispose);
    });
  }

  private cursorTimer = 0;

  /** マウスが動いた（か設定が変わった）。カーソルを出し、隠す設定なら、ゲーム中に動かさずに少したったら隠す。 */
  private wakeCursor(): void {
    const stage = this.host.stage;
    stage.classList.remove("lm-cursor-idle");
    clearTimeout(this.cursorTimer);
    if (!this.prefs.hideCursor) return;
    this.cursorTimer = window.setTimeout(() => {
      if (this.mode === "game" && !this.screen) stage.classList.add("lm-cursor-idle");
    }, CURSOR_IDLE_MS);
  }

  /** 今のウィンドウの大きさ（設定の値。変わったときだけデスクトップ版に頼む）。 */
  private windowScaleNow = 0;

  private applySettings(): void {
    if (fullscreen.supported() && this.fullscreenNow !== this.prefs.fullscreen) fullscreen.set(this.prefs.fullscreen);
    this.wakeCursor();
    if (!this.prefs.fullscreen && this.windowScaleNow !== this.prefs.windowScale) {
      this.windowScaleNow = this.prefs.windowScale;
      window.liminaliaDesktop?.setWindowScale?.(this.prefs.windowScale);
    }
    this.host.audio.setVolume(this.prefs.master, this.prefs.mute || this.inactiveMute);
    this.host.audio.setMasterVolume("bgm", this.prefs.bgm);
    this.host.audio.setMasterVolume("sound", this.prefs.se);
    this.host.audio.setMasterVolume("voice", this.prefs.voice);
    this.host.audio.setSpeakerVolumes(this.prefs.speakerVoice);
    this.host.voiceStopOnPage = this.prefs.voiceStopOnPage;
    this.env.setTextSpeed(this.prefs.textSpeed);
    this.host.audio.setDucking(this.prefs.duckBgm ? DUCK_LEVEL : 1);
    // 最小化したときと、ほかのウィンドウを選んだときの動き（設定を変えたら今の様子に当て直す）
    this.syncInactive();
    this.syncThrottling();
    this.host.shakeReduced = this.prefs.reduceShake;
    this.host.flashReduced = this.prefs.reduceFlash;
    this.host.skipPageMs = SKIP_PAGE_MS[this.prefs.skipSpeed];
    this.host.stage.classList.toggle("lm-high-contrast", this.prefs.highContrast);
    // 既読の文の色（style.css の lm-read-on、lm-read-off。決めていなければ作品の ui.text.readColor のまま）
    this.host.stage.classList.toggle("lm-read-on", this.prefs.readColor === "on");
    this.host.stage.classList.toggle("lm-read-off", this.prefs.readColor === "off");
    applyColorVision(this.host.stage, this.prefs.colorVision);
    this.host.captions = this.prefs.captions;
    this.input?.setPadMap(this.prefs.pad);
    this.applyContentFilter();
    this.a11y?.set({ voice: this.prefs.selfVoicing, language: this.language || "ja" });
    // 枠の濃さ・文字の大きさ・書体は CSS の変数で（作品の CSS からも読める）
    const style = this.host.stage.style;
    style.setProperty("--window-opacity", String(this.prefs.windowOpacity / 100));
    style.setProperty("--text-scale", String(this.prefs.textScale / 100));
    // 名前欄・バックログ・システム画面の文字（ui.screen.textScale が message なら、本文と選択肢だけにする）
    const uiTextScale = this.env.project.ui?.screen?.textScale === "message" ? 1 : this.prefs.textScale / 100;
    style.setProperty("--lm-text-scale", String(uiTextScale));
    // 大きな文字では、システム画面の並べ方を詰める（default.css の lm-text-large）
    this.host.stage.classList.toggle("lm-text-large", uiTextScale > 1.05);
    if (this.prefs.font && PLAYER_FONTS[this.prefs.font]) style.setProperty("--player-font", `${PLAYER_FONTS[this.prefs.font]}, var(--font-fallback)`);
    else style.removeProperty("--player-font");
    // 本文の行間（作品の行間に掛ける）と文字の縁（作品の影と縁取りの代わり）
    if (this.prefs.lineSpacing !== 100) style.setProperty("--player-line-spacing", String(this.prefs.lineSpacing / 100));
    else style.removeProperty("--player-line-spacing");
    const edge = playerTextEdge(this.prefs.textEdge);
    if (edge) {
      style.setProperty("--player-text-shadow", edge);
      style.setProperty("--player-text-stroke", "0 transparent");
    } else {
      style.removeProperty("--player-text-shadow");
      style.removeProperty("--player-text-stroke");
    }
  }

  // ---- 保存 ----

  private scheduleReadSave(): void {
    if (this.readSaveTimer !== undefined) return;
    this.readSaveTimer = setTimeout(() => {
      this.readSaveTimer = undefined;
      this.storage.saveReadSet(this.read);
    }, 1000);
  }

  /** 全セーブ共通のもの（システム変数・既読）を書き出す。 */
  private flush(): void {
    clearTimeout(this.readSaveTimer);
    this.readSaveTimer = undefined;
    this.storage.saveSystemVariables(this.system);
    if (this.read.dirty) this.storage.saveReadSet(this.read);
  }

  // ---- 入力の振り分け ----

  /** ミュートのキーか（遊ぶ人と作品の割り当てで、ほかの操作に使っているキーは除く。入力欄で打っているときは見ない）。 */
  private isMuteKey(e: KeyboardEvent): boolean {
    const target = e.target as HTMLElement | null;
    if (target?.isContentEditable || (target instanceof HTMLInputElement && target.type !== "range") || target instanceof HTMLTextAreaElement) return false;
    if (this.mode === "game" && !this.host.shortcuts) return false;
    // 遊んでいる最中は、同じキーを割り当てた常駐のボタンなど（[data-lm-key]）が先
    if (this.mode === "game" && !this.screen && !this.hidden && this.keyedControl(e.key)) return false;
    const keys = this.keyMap();
    if (!keys.mute.includes(e.key)) return false;
    return !UI_KEY_ACTIONS.some((a) => a !== "mute" && keys[a].includes(e.key));
  }

  /** キーを割り当てた操作の部品（[data-lm-key]。std の @hud-button key= など）のうち、見えていてそのキーのもの（無ければ null）。 */
  private keyedControl(key: string): HTMLElement | null {
    return [...this.host.stage.querySelectorAll<HTMLElement>(KEYED)].find((el) => keyMatches(el.dataset.lmKey, key) && shown(el)) ?? null;
  }

  /** 遊んでいる最中に矢印キーとパッドで選んでいる常駐のボタンなど（[data-lm-play-nav] の中。無ければ null）。 */
  private playFocused(): HTMLElement | null {
    const a = document.activeElement;
    return a instanceof HTMLElement && this.host.stage.contains(a) && a.closest(PLAY_NAV) ? a : null;
  }

  /** 操作ごとのキー（遊ぶ人の割り当て → 作品の ui.keys → 既定。既定のキーは、ほかの操作に割り当てたものを除く）。 */
  private keyMap(): Record<UiKeyAction, readonly string[]> {
    return resolveKeys(this.env.project.ui, this.prefs.keys);
  }

  /** 数字のキー（1〜9）で、出している選択肢のその番目を選ぶ（ui.input.numberKeys が false なら選ばない）。選んだら true。 */
  private chooseByNumber(key: string): boolean {
    if (!this.choosing || this.env.project.ui?.input?.numberKeys === false || !/^[1-9]$/.test(key)) return false;
    const options = [...this.host.stage.querySelectorAll<HTMLElement>(CHOICE_BUTTONS)].filter((b) => b.offsetParent !== null);
    const target = options[Number(key) - 1];
    if (!target) return false;
    target.click();
    return true;
  }

  /** ミュートを切り替えて保存し、知らせる。 */
  private toggleMute(): void {
    const muted = !this.prefs.mute;
    this.updateSettings({ mute: muted });
    toast(this.layer, muted ? TEXT.toast.muted : TEXT.toast.unmuted);
  }

  /** ゲームパッドのクイックロード（十字キーの左。押し間違えで進行を失わないように、確認のメッセージを出す）。 */
  private async padQuickLoad(): Promise<void> {
    const slot = this.storage.latestQuick(this.quickCount);
    if (!slot) return toast(this.layer, TEXT.toast.noQuickSave);
    if (await this.ask(TEXT.confirm.load(slotName(slot)), "load")) await this.act("quick-load");
  }

  /** 送り（Enter・Space・パッドの A）。オート・スキップ中は止めるだけ、枠を隠していれば戻すだけ。 */
  private pressAdvance(): void {
    if (this.hidden) {
      this.setHidden(false);
    } else if (this.auto || this.skip) {
      this.setAuto(false);
      this.setSkip(false);
    } else {
      this.host.advance();
    }
  }

  /** 開いている画面の中だけを Tab で回る（端から反対の端へ。画面の外へは出さない）。 */
  private trapTab(e: KeyboardEvent): void {
    // 画面が自分で Tab を扱ったもの（作品の画面）は任せる
    if (e.defaultPrevented) return;
    const top = this.screens.at(-1)!.el;
    const items = focusables(top);
    const active = document.activeElement as HTMLElement | null;
    if (items.length === 0) {
      e.preventDefault();
      top.focus({ preventScroll: true });
      return;
    }
    // ブラウザに任せず自分で回す（WebKit は Tab でボタンへ移らないため、画面の外へ出てしまう）
    e.preventDefault();
    const i = active ? items.indexOf(active) : -1;
    const next = i < 0 ? (e.shiftKey ? items.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    items[next]!.focus();
  }

  /** Esc・右クリック・パッドの B で、いちばん上の画面に戻る操作を渡す（効果音は ui.sound.ui.cancel）。 */
  private backScreen(): void {
    const top = this.screens.at(-1);
    if (!top) return;
    // 遊ぶ人の操作を待つ画面だけを出していて、その画面が戻るを扱わなければ（調べる画面・地図など）、メニューを開く
    if (this.overScreen && top.back) {
      if (top.back()) playSound("cancel");
      else this.openMenu();
      return;
    }
    playSound("cancel");
    top.close();
  }

  /**
   * 遊ぶ人の操作を待つ画面を出している間のショートカット（メニュー・セーブ・ロード・履歴・コンフィグ・スクリーンショット）。
   * ほかの操作（送り・オート・スキップ・巻き戻しなど）と、文字の欄で打っている字は渡さない。扱ったら true。
   */
  private screenShortcut(e: KeyboardEvent): boolean {
    if (e.altKey || e.metaKey || e.ctrlKey || e.repeat || !this.host.shortcuts) return false;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable)) return false;
    const map = this.keyMap();
    const hit = OVER_SCREEN_KEYS.find(([action]) => map[action].includes(e.key));
    if (!hit) return false;
    e.preventDefault();
    void this.act(hit[1]);
    return true;
  }

  private bindInput(): void {
    const stage = this.host.stage;
    // キーはすべてここで受ける（DomHost の既定のキー操作は使わない）
    this.host.keyboard = false;
    // 文字の入力や確認の枠（@text-input・@dialog）を出している間は、その枠のボタンを選び、遊んでいる最中の操作はしない
    const panel = () => stage.querySelector<HTMLElement>(".lm-panel");
    const playing = () => this.mode === "game" && !this.screen && !this.choosing && !panel();
    this.input = bindPlayerInput({
      stage,
      ignore: (target) => this.layer.contains(target),
      ...(this.env.project.ui?.menuBar?.touchButton === false ? {} : { touchMenu: { parent: this.layer, label: TEXT.menu.heading } }),
      // 横長の作品を縦に持ったとき。小さい画面は覆って止め（裏へ回したときと同じ）、収まる画面は知らせだけにして「このまま遊ぶ」を付ける
      ...(this.env.project.screen.width > this.env.project.screen.height ? { rotateHint: { text: TEXT.rotate, keep: TEXT.rotateKeep, onCover: (covering: boolean) => this.setPaused("rotate", covering) } } : {}),
      // 横になぞると一ページ戻る・進め直す（ui.input.swipeSide が none なら何もしない）
      swipeSide: () => this.env.project.ui?.input?.swipeSide !== "none",
      // 標準の配置でないゲームパッドは、ボタンが合わないことがあるので入れ替えられることを知らせる
      onNonstandardPad: () => toast(this.layer, TEXT.toast.padNotStandard, 5000),
      controls: {
        playing,
        key: (e) => this.screenKey?.(e) ?? false,
        choosing: () => this.mode === "game" && this.choosing && !this.screen,
        navRoot: () => (this.screen ? this.screens.at(-1)!.el : (panel() ?? (this.mode === "title" && this.titleEl ? this.titleEl : this.choosing ? (stage.querySelector<HTMLElement>(".choice-inline") ?? stage.querySelector<HTMLElement>(".choices")) : null))),
        // ゲームの操作に割り当てた矢印キーは、常駐のボタンを選ぶのに使わない
        reserved: (key) => {
          const map = this.keyMap();
          return UI_KEY_ACTIONS.some((a) => map[a].includes(key));
        },
        screen: () => this.screen,
        // 遊ぶ人の操作を待つ画面か、文字の入力や確認の枠を出している（パッドの START・Y・SELECT でメニュー・履歴・コンフィグを開ける）
        overScreen: () => (this.overScreen || (this.mode === "game" && this.screen === null && this.panelShown)) && !this.hidden,
        hidden: () => this.hidden,
        advance: () => this.mode === "game" && this.pressAdvance(),
        back: () => {
          if (!this.screen) return false;
          this.backScreen();
          return true;
        },
        menu: () => this.openMenu(),
        backlog: () => this.openBacklog(),
        setHidden: (hidden) => this.setHidden(hidden),
        config: () => this.openConfig(),
        rollback: () => void this.act("rollback"),
        rollforward: () => void this.act("rollforward"),
        mute: () => this.toggleMute(),
        auto: () => void this.act("auto"),
        skip: () => void this.act("skip"),
        quickSave: () => void this.act("quick-save"),
        quickLoad: () => void this.padQuickLoad(),
        skipHeld: (held) => {
          // 押している間スキップ（Ctrl と同じ）
          if (!this.host.shortcuts) return;
          this.ctrlHeld = held;
          this.updateSkipping();
        },
      },
    });
    this.sync();

    // 本文送りのクリック（DomHost は舞台の click で送る）より先に見る
    stage.addEventListener(
      "click",
      (e) => {
        if (this.mode !== "game" || this.screen || this.layer.contains(e.target as Node)) return;
        // ボタンや入力欄など操作の部品（@dialog の OK、選択肢、常駐のボタン、プラグインの画面）への押しは止めない
        // （止めるとオートを切るだけで押しが捨てられ、二度押すことになる）
        if (e.target instanceof Element && e.target.closest(CONTROL_SELECTOR)) return;
        if (this.hidden) {
          e.stopImmediatePropagation();
          this.setHidden(false);
        } else if (this.auto || this.skip) {
          e.stopImmediatePropagation();
          this.setAuto(false);
          this.setSkip(false);
        }
      },
      true,
    );

    stage.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.screen) this.backScreen();
      else if (this.mode !== "game") return;
      else if (this.hidden) this.setHidden(false);
      // ui.input.rightClick が hide なら、右クリックは文字の枠を隠す（選択肢を出している間はしない）
      else if ((this.prefs.rightClick || this.env.project.ui?.input?.rightClick) === "hide") {
        if (!this.choosing) this.setHidden(true);
      } else this.openMenu();
    });

    // ホイールを押すとウィンドウを消す・戻す（ui.input.middleClick が none なら何もしない）。押したときの自動スクロールは出さない。
    // 舞台の外（余白）で押しても同じ（WebKit は押した先が文書になることがある）
    const middle = (e: MouseEvent) => e.button === 1 && this.mode === "game" && !this.screen && this.env.project.ui?.input?.middleClick !== "none" && !this.layer.contains(e.target as Node);
    window.addEventListener("mousedown", (e) => {
      if (middle(e)) e.preventDefault();
    });
    window.addEventListener("auxclick", (e) => {
      if (!middle(e)) return;
      e.preventDefault();
      if (this.hidden) this.setHidden(false);
      else if (!this.choosing) this.setHidden(true);
    });

    let wheelAt = 0;
    stage.addEventListener(
      "wheel",
      (e) => {
        if (this.mode !== "game" || this.screen) return;
        // 枠の中でスクロールする本文（ui.message.scroll）の上では、読み返せるうちはスクロールに使う
        const text = (e.target as Element | null)?.closest?.(".message.scroll .text");
        if (text && (e.deltaY < 0 ? text.scrollTop > 0 : text.scrollTop + text.clientHeight < text.scrollHeight - 1)) return;
        const now = performance.now();
        if (now - wheelAt < WHEEL_INTERVAL) return;
        wheelAt = now;
        if (this.hidden) this.setHidden(false);
        // 上: 履歴か一ページ戻る（ui.input.wheelUp）。下: 戻ったところからは進め直し、そうでなければ読み進める
        else if (e.deltaY < 0) {
          if (this.env.project.ui?.input?.wheelUp === "rollback") void this.rollback();
          else this.openBacklog();
        } else if (e.deltaY > 0 && this.future.length > 0 && this.rollbackOn) void this.rollforward();
        else if (e.deltaY > 0 && !this.choosing && !this.auto && !this.skip) this.host.advance();
      },
      { passive: true },
    );

    window.addEventListener("keydown", (e) => {
      // 開いている作品の画面がキーを受ける（ExtraScreenApi.onKey。矢印キーは input.ts が先に渡している）
      if (!(e.key in NAV_ARROWS) && this.screenKey?.(e)) {
        e.preventDefault();
        return;
      }
      // Alt+Enter で全画面を切り替える（デスクトップ版はアプリの側で受ける）
      if (e.key === "Enter" && e.altKey && !e.repeat && fullscreen.supported() && !window.liminaliaDesktop) {
        e.preventDefault();
        this.prefs = { ...this.prefs, fullscreen: !this.fullscreenNow };
        this.storeSettings(this.prefs);
        this.applySettings();
        return;
      }
      if (e.key === "Control") {
        if (!this.host.shortcuts) return;
        this.ctrlHeld = true;
        this.updateSkipping();
        return;
      }
      // Ctrl+C・Cmd+C: 文字を選んでいればブラウザのコピーのまま、選んでいなければゲーム中は今のページの本文をコピーする
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "c" || e.key === "C")) {
        const selected = window.getSelection?.()?.toString() ?? "";
        const target = e.target as HTMLElement | null;
        const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
        if (!selected && !typing && this.mode === "game" && !this.screen) {
          e.preventDefault();
          void this.copyPage();
        }
        return;
      }
      // ミュート（タイトル・画面を開いている間も。入力欄で打っているときと、ほかの操作に割り当てたキーは除く）
      if (!e.repeat && !e.altKey && !e.metaKey && !e.ctrlKey && this.isMuteKey(e)) {
        e.preventDefault();
        this.toggleMute();
        return;
      }
      if (this.screen) {
        if (e.key === "Escape") {
          e.preventDefault();
          this.backScreen();
        } else if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) this.trapTab(e);
        // 遊ぶ人の操作を待つ画面（調べる画面・地図など）を出している間も、メニュー・セーブ・ロード・履歴・コンフィグのキーは効く
        else if (this.overScreen) this.screenShortcut(e);
        return;
      }
      if (this.mode !== "game" || e.altKey || e.metaKey || e.ctrlKey) return;
      // 文字の入力や確認の枠（@text-input・@dialog）を出している間も同じ（送り・オートなどは効かない）。
      // 枠の外を押してフォーカスが外れていても、Esc は枠の戻る（キャンセル。無ければメニュー）にする
      if (panel()) {
        if (e.key === "Escape" && !e.altKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          runBackHandler();
          return;
        }
        this.screenShortcut(e);
        return;
      }
      // キーの割り当ては liminalia.json の ui.keys（書いていない操作は既定）
      // 遊ぶ人の割り当て（コンフィグの「操作」）が作品の割り当ての上に重なる
      const map = this.keyMap();
      const is = (action: UiKeyAction) => map[action].includes(e.key);
      const advanceKey = is("advance");
      if (this.hidden) {
        if (advanceKey || is("menu") || is("hide")) {
          e.preventDefault();
          this.setHidden(false);
        }
        return;
      }
      // キーを割り当てた部品（std の @hud-button key= など。[data-lm-key]）は、ほかの操作のキーより先に押す
      const keyed = this.keyedControl(e.key);
      if (keyed && this.host.shortcuts) {
        e.preventDefault();
        if (!e.repeat) keyed.click();
        return;
      }
      // 矢印キーとパッドで選んだ常駐のボタン（[data-lm-play-nav]）は、本文を送るキーで押し、Esc で選ぶのをやめる
      const picked = this.playFocused();
      if (picked && (advanceKey || e.key === "Escape")) {
        e.preventDefault();
        if (e.key === "Escape") picked.blur();
        else if (!e.repeat) picked.click();
        return;
      }
      if (advanceKey) {
        // 選択肢はフォーカスしたボタンを Enter・Space で選ぶ
        if (this.choosing) return;
        // 帯のボタンにフォーカスが残っていても、ボタンは押さず本文を送る
        e.preventDefault();
        this.pressAdvance();
        return;
      }
      if (e.repeat || !this.host.shortcuts) return;
      // 選択肢を出している間: 数字のキーでその番目を選ぶ（ほかの操作に割り当てたキーは、その操作が先）。Tab はボタンの間を動く
      if (this.choosing) {
        if (e.key === "Tab") return;
        if (!UI_KEY_ACTIONS.some((a) => is(a)) && this.chooseByNumber(e.key)) {
          e.preventDefault();
          return;
        }
      }
      const actions: [UiKeyAction, () => void][] = [
        ["menu", () => this.openMenu()],
        ["quickSave", () => void this.act("quick-save")],
        ["quickLoad", () => void this.act("quick-load")],
        ["backlog", () => this.openBacklog()],
        ["hide", () => void this.act("hide")],
        ["auto", () => void this.act("auto")],
        ["skip", () => void this.act("skip")],
        ["save", () => void this.act("save")],
        ["load", () => void this.act("load")],
        ["config", () => void this.act("config")],
        ["rollback", () => void this.act("rollback")],
        ["rollforward", () => void this.act("rollforward")],
        ["prevChoice", () => void this.act("prev-choice")],
        ["nextUnread", () => void this.act("next-unread")],
        ["screenshot", () => void this.act("screenshot")],
        ["nextChoice", () => void this.act("next-choice")],
        ["replayVoice", () => void this.act("replay-voice")],
        ["copyText", () => void this.copyPage()],
      ];
      const hit = actions.find(([action]) => is(action));
      if (hit) {
        e.preventDefault();
        hit[1]();
      }
    });
    const releaseCtrl = () => {
      if (!this.ctrlHeld) return;
      this.ctrlHeld = false;
      this.updateSkipping();
    };
    window.addEventListener("keyup", (e) => {
      if (e.key === "Control") releaseCtrl();
    });
    window.addEventListener("blur", releaseCtrl);
  }
}
