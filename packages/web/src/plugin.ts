import type { ChapterInfo, CommandDefaults, UiHelpPage, Diagnostic, ExtraAchievement, ExtraCg, ExtraChapter, ExtraConfig, ExtraGlossary, ExtraMovie, ExtraMusic, ExtraReplay, Flow, FlowScene, ItemsConfig, TranslationFile, UiConfig, VoiceLock } from "@liminalia/lang";
import { PLUGIN_API_VERSION } from "@liminalia/lang";

export { PLUGIN_API_VERSION };
import type { AudioPlayer } from "./audio.ts";
import type { ChoiceLook, CommandImpl, RunResult, Runtime, SaveData, Value, VoiceCue } from "@liminalia/runtime";
import type { LogPart } from "./system/backlog.ts";
import type { Completion, CompletionCount } from "./system/extra.ts";

export type { Completion, CompletionCount };
import type { Settings, SettingsPatch } from "./system/settings.ts";
import type { DesktopUpdate } from "./system/update.ts";
import type { StoreBridge, StoreProducts } from "./store.ts";
import type { DomHost, Extensions, RenderContext, TextTheme } from "./dom-host.ts";
import type { ToastApi } from "./notices.ts";

/**
 * プラグインの見た目の側。プロジェクト設定の plugins に書いたパッケージの "./web" がこれを default export する。
 * 命令の側（"./commands"、@liminalia/sdk の CommandPlugin）と対で使う。
 */
export interface WebPlugin {
  name: string;
  /**
   * このプラグインを書いたときのプラグインの口の版（PLUGIN_API_VERSION）。エンジンの版より新しければ、遊ぶ画面の開発者ツールに知らせる
   * （命令の側の CommandPlugin.apiVersion は lim check が確かめる）。書かなければ確かめない。
   */
  apiVersion?: number;
  /** 命令の描画・ロード時の組み立て直し・本文の見た目。 */
  extensions?: Partial<Extensions>;
  /** システム画面（タイトル・セーブ／ロード・設定など）を丸ごと差し替える。複数あれば後のものが勝つ。 */
  system?: SystemFactory;
  /**
   * タイトル画面だけを差し替える（ほかのシステム画面は標準のまま）。複数あれば後のものが勝つ。
   * 標準のシステム画面のときだけ効く（system で丸ごと差し替えたら、そちらがタイトルも作る）。
   */
  title?: TitleFactory;
  /** 描画側を組み立てた直後に一度だけ呼ぶ（書体の読み込みなど）。 */
  setup?(host: DomHost): void | Promise<void>;
  /**
   * 起動の演出（ロゴ・注意書きなど）。「クリックで開始」のあと、タイトルを出す前に一度だけ流し、済んだら解決する。
   * 標準のシステム画面のときだけ効く。複数あれば後のものが勝つ。
   */
  splash?(ctx: RenderContext): Promise<void>;
  /** シナリオが終わってタイトルへ戻るたびに、タイトルの前に流す演出（済んだら解決する Promise）。 */
  endSplash?(ctx: RenderContext): Promise<void>;
  /**
   * システム画面を作った直後に一度だけ呼ぶ。作品のボタンから標準の操作（system.perform("auto") など）を呼ぶときに、
   * system を取っておく。
   */
  ready?(api: { host: DomHost; system: SystemController }): void | Promise<void>;
  /**
   * 標準のシステム画面（設定・セーブとロード・履歴）の見た目だけを差し替える。要素を作る関数を渡すと、開く・閉じる・
   * 入力を止める・重なりはシステムが受け持ち、中身はその関数が作る（動きは api の関数を呼ぶ）。CSS だけで変えるなら要らない。
   * 複数のプラグインが同じ画面を差し替えたら後のものが勝つ。
   */
  screens?: StandardScreens;
  /**
   * テーマごとの画面と演出。ui.system.preset がこの鍵のときだけ、上の title・splash・endSplash・screens・texts と
   * extensions.text に重ねる（ほかのテーマを選ぶと、標準の画面に戻る）。CSS は rootClass の下に閉じると、切り替えで一緒に外れる。
   */
  themes?: Readonly<Record<string, PluginTheme>>;
  /**
   * セーブするたびに呼び、一覧に出す作品のメタ情報（章・作中の日付など）を返す。標準のセーブ画面からのセーブにも付く。
   * 複数のプラグインが返したものは重ねる。
   */
  slotMeta?(api: { runtime: Runtime; host: DomHost }): Record<string, Value> | undefined;
  /**
   * セーブの一覧に出す章の名前を決める（セーブするたびに呼ぶ）。label は今いるファイルとラベル。名前を返せばそれを使い（"" なら出さない）、
   * null か undefined なら標準の決め方（liminalia.json の ui.chapterNames、おまけの章、ファイルの名前）。複数のプラグインが返したら後のものが勝つ。
   */
  slotChapter?(api: { runtime: Runtime; host: DomHost; label: { file: string; label: string | null } | null }): string | null | undefined;
  /**
   * 標準のシステム画面の文言を替える（"confirm.title" のような鍵 → 文字列。鍵は system/strings.ts の TEXT の入れ子）。
   * 言語の訳（lang/<言語>.json の ui）より後に重ねる。複数のプラグインが同じ鍵を替えたら後のものが勝つ。
   */
  texts?: Readonly<Record<string, string>>;
  /**
   * 画面の切り替えの幕。load はロード（スロット・履歴・前の選択肢・章・フローチャート）のとき、今のプレイを捨てる前に cover を待ち、
   * 組み立て直したら reveal を呼ぶ（待たない）。screen はシステムの画面を開いた・閉じた直後に呼ぶ（待たない。画面より上に描くなら
   * ctx.systemLayer に置く）。標準のシステム画面のときだけ効く。同じ項目は後のプラグインが勝つ。
   */
  transitions?: Transitions;
}

/** 画面の切り替えの幕（WebPlugin.transitions）。 */
export interface Transitions {
  load?: Curtain;
  screen?(ctx: RenderContext, info: { name: string; open: boolean }): void | Promise<void>;
}

/** ロードの幕。cover は下り切ったら解決し、reveal は上げ始める（待たない）。from は SystemEvent の load-start と同じ。 */
export interface Curtain {
  cover(ctx: RenderContext, info: { from: LoadFrom }): void | Promise<void>;
  reveal(ctx: RenderContext, info: { from: LoadFrom }): void | Promise<void>;
}

/** ロードの始まり（SystemEvent の load-start・load-end の from）。 */
export type LoadFrom = "slot" | "backlog" | "choice" | "flowchart" | "chapter";

/** プラグインが持つテーマの画面と演出（WebPlugin.themes）。 */
export type PluginTheme = Pick<WebPlugin, "title" | "splash" | "screens" | "texts" | "transitions"> & {
  /** 本文の見た目（extensions.text と同じ）。 */
  text?: TextTheme;
  /** テーマを選んでいる間、舞台に付けるクラス。 */
  rootClass?: string;
};

/** ui.system.preset に合うテーマを、プラグインの項目に重ねる。合うものが無ければそのまま。 */
export function withActiveTheme(plugin: WebPlugin, preset: string | undefined): WebPlugin {
  const theme = preset === undefined ? undefined : plugin.themes?.[preset];
  if (!theme) return plugin;
  const { text, rootClass: _rootClass, ...parts } = theme;
  return {
    ...plugin,
    ...parts,
    ...(theme.screens ? { screens: { ...plugin.screens, ...theme.screens } } : {}),
    ...(theme.texts ? { texts: { ...plugin.texts, ...theme.texts } } : {}),
    ...(text ? { extensions: { ...plugin.extensions, text } } : {}),
  };
}

/** テーマを選んでいる間、舞台に付けるクラス。 */
export function themeRootClasses(plugins: readonly WebPlugin[], preset: string | undefined): string[] {
  if (preset === undefined) return [];
  return plugins.flatMap((p) => p.themes?.[preset]?.rootClass ?? []);
}

/**
 * 遊んでいる最中の標準の操作（ゲーム中の帯・メニューのボタンと同じもの）。SystemController.perform で呼ぶ。
 * title と exit は確かめてから行う。check-update はアップデートを確かめる（デスクトップ版で build.update があるときだけメニューに出る）。
 */
/**
 * 名前で開く作品の画面（system.defineScreen で登録したもの）を、操作として書く形（"screen:demo.map"）。
 * クイックメニュー（ui.menuBar.items）・perform・RenderContext.system.perform で使える。
 */
export type ScreenAction = `screen:${string}`;

/** 操作が作品の画面を開くもの（"screen:<名前>"）なら、その名前。 */
export function screenActionName(action: string): string | null {
  return action.startsWith("screen:") && action.length > "screen:".length ? action.slice("screen:".length) : null;
}

/** fullscreen は全画面とウィンドウを切り替える（標準のメニューには並ばない。ui.menuBar.items か perform で使う）。 */
export const SYSTEM_ACTIONS = ["quick-save", "quick-load", "save", "load", "auto", "skip", "rollback", "rollforward", "prev-choice", "next-choice", "next-unread", "backlog", "replay-voice", "items", "config", "help", "flowchart", "screenshot", "hide", "menu", "title", "exit", "check-update", "fullscreen"] as const;
export type SystemAction = (typeof SYSTEM_ACTIONS)[number];

export interface ScreenOptions<S extends Value = Value> {
  /** system.screen に出す名前（既定は key か "custom"）。 */
  name?: string;
  /** 開いている間、シナリオの次の命令を実行しない（既定 true）。 */
  pauseScenario?: boolean;
  /** 右クリック・Esc・ゲームパッドの B で閉じる（結果は null。既定 false）。 */
  closeOnBack?: boolean;
  /**
   * 遊ぶ人の操作を待つゲームの中の画面（調べる画面・地図・図鑑など）。開いている間も、遊ぶ人がメニュー・セーブ・ロード・履歴・コンフィグを
   * 開け（ショートカットのキー、スマホのメニューのボタン、パッドの START も）、閉じるとこの画面に戻る。右クリック・Esc・パッドの B は、
   * この画面の戻る（onBack・closeOnBack）が扱わなければメニューを開く。既定 false（タイトルやメニューから開くおまけの画面など）。
   * シナリオの命令が開いて結果を待つ画面なら、セーブはその命令の所に残り、ロードすると命令がもう一度開く。
   */
  allowMenu?: boolean;
  /** 状態をセーブに入れる名前（作品の中で重ならないように、プラグインの名前を付ける: "demo.map"）。 */
  key?: string;
  /** 初めの状態（key があり、セーブに状態が残っていればそちら）。 */
  state?: S;
}

/** defineScreen の開き方（openScreen の options に、メニューに並べるときの文字を足したもの）。 */
export type DefineScreenOptions<S extends Value = Value> = Omit<ScreenOptions<S>, "key" | "state"> & {
  /** メニュー・クイックメニューに出す文字（言語ごとに { ja, en } のようにも書ける）。無ければ名前。 */
  label?: string | Readonly<Record<string, string>>;
  /** 右クリック・Esc のメニューに並べる（タイトルへの前）。 */
  menu?: boolean;
  /**
   * おまけの画面のタブの並びにも、この画面を開くボタンを置く。関数なら、真を返すときだけ置く（何か解放しているときだけ、など）。
   * 置くときは、ほかに何も解放していなくてもタイトルに「おまけ」を出す。おまけから開いたときは遊んでいない（system.runtime が null）。
   */
  extra?: boolean | (() => boolean);
  /** 初めの状態（セーブに状態が無いとき）。 */
  state?: S;
};

/**
 * 描画側（命令の描画・restorer・作品の画面）から system に届く口（RenderContext.system）。システム画面を作ったあとに置かれる
 * （setup の間は null）。システム画面を丸ごと差し替えた作品では、そのシステム画面が持つものだけが効く。
 */
export interface RenderSystem {
  /** システム画面そのもの（ready で受け取るものと同じ）。 */
  readonly controller: SystemController;
  /** 今の様子（オート・スキップ・画面を開いているか・選択肢を出しているかなど）。持たないシステム画面なら null。 */
  readonly status: SystemStatus | null;
  /** 様子が変わったら呼ぶ（変わったときだけ）。返す関数で外す。 */
  onStatusChange(listener: (status: SystemStatus) => void): () => void;
  /** 選んでいるテーマ（liminalia.json の ui.system.preset。標準のテーマなら null）。 */
  readonly theme: string | null;
  /** 標準の操作（セーブ・ロード・バックログ・オートなど。SYSTEM_ACTIONS）か、作品の画面を開く（"screen:<名前>"）。 */
  perform(action: SystemAction | ScreenAction): Promise<void>;
  /** 名前で画面を開き、閉じるまで待つ（標準の画面か、defineScreen で登録した作品の画面）。開けなければ false。 */
  openScreen(name: string): Promise<boolean>;
  /** 作品の画面を開く（SystemController.openScreen と同じ）。 */
  openScreen<T = unknown, S extends Value = Value>(content: ScreenContent<T, S>, options?: ScreenOptions<S>): ScreenHandle<T, S>;
  /** 作品の画面の作り方を名前で登録する（SystemController.defineScreen と同じ）。 */
  defineScreen<T = unknown, S extends Value = Value>(key: string, build: ScreenContent<T, S>, options?: DefineScreenOptions<S>): void;
  /** 全セーブ共通の変数（system.○○）。読み書きでき、書いたらすぐ残すなら saveSystemVariables を呼ぶ。 */
  readonly systemVariables: Record<string, Value>;
  saveSystemVariables(): void;
  /**
   * 読んでいるページから場面（`#ラベル`・`ファイル#ラベル`）を呼ぶ（常駐のボタンの call=）。呼んだ場面が @return か次のラベルで戻ったら、
   * そのページを出し直す。ページでクリックを待っているときと選択肢を出しているとき（戻ったら選択肢を出し直す）に呼べ、呼んだら true。
   * 持たないシステム画面なら false。
   */
  callScene(target: string): Promise<boolean>;
  /**
   * 本文の外で出したもの（章の扉の題など）を、すぐにスクリーンリーダーとテキスト読み上げに渡す（読み上げは遊ぶ人が「テキスト読み上げ」を選んでいるときだけ）。
   * 飛ばしている間は渡さない。持たないシステム画面なら何もしない。
   */
  announce(text: string): void;
  /**
   * はい／いいえを尋ねる（標準の確かめの枠。作品が screens.confirm で差し替えていればその見た目）。kind は ConfirmScreenApi.kind に渡る。
   * 遊ぶ人がコンフィグで確認を省いていれば尋ねずに true。持たないシステム画面なら尋ねずに true。
   */
  ask(message: string, kind?: string): Promise<boolean>;
}

/** SystemController を描画側の口にする（プレイヤーが DomHost.system に置く）。 */
export function renderSystem(controller: SystemController): RenderSystem {
  function openScreen(name: string): Promise<boolean>;
  function openScreen<T = unknown, S extends Value = Value>(content: ScreenContent<T, S>, options?: ScreenOptions<S>): ScreenHandle<T, S>;
  function openScreen<T = unknown, S extends Value = Value>(content: string | ScreenContent<T, S>, options?: ScreenOptions<S>): Promise<boolean> | ScreenHandle<T, S> {
    if (typeof content === "string") return controller.openScreenByName ? controller.openScreenByName(content) : Promise.resolve(false);
    if (!controller.openScreen) throw new Error("このシステム画面は作品の画面を開けません（openScreen がありません）");
    return controller.openScreen(content, options);
  }
  return {
    controller,
    get status() {
      return controller.status ?? null;
    },
    onStatusChange: (listener) => controller.onStatusChange?.(listener) ?? (() => undefined),
    get theme() {
      return controller.theme ?? null;
    },
    perform: async (action) => {
      const name = screenActionName(action);
      if (name !== null) {
        if (!controller.perform && controller.openScreenByName) await controller.openScreenByName(name);
        else await controller.perform?.(action);
        return;
      }
      await controller.perform?.(action);
    },
    openScreen,
    defineScreen: (key, build, options) => controller.defineScreen?.(key, build, options),
    get systemVariables() {
      return controller.systemVariables ?? {};
    },
    saveSystemVariables: () => controller.persist?.(),
    callScene: (target) => controller.callScene?.(target) ?? Promise.resolve(false),
    announce: (text) => controller.announce?.(text),
    ask: (message, kind) => controller.ask?.(message, kind) ?? Promise.resolve(true),
  };
}

/**
 * どの画面の口にもあるもの（WebPlugin.screens の関数に渡す api と、作品の画面の ScreenHandle）。閉じたときの知らせと、閉じる演出。
 */
export interface ScreenLifecycle {
  /** 画面が閉じたら呼ぶ（閉じるボタン・Esc・右クリック・ロードやタイトルへ戻るときにまとめて捨てたときも）。返す関数で外す。 */
  onClose(listener: () => void): () => void;
  /**
   * 閉じる演出。画面を作る関数の中で `api.leave = (el) => el.animate([...], 200).finished` のように入れると、閉じるときに
   * 画面の要素を渡して呼び、済むまで待ってから外す（その間は押せない）。2 秒で打ち切る。早送り中と、ロードやタイトルへ戻るときに
   * まとめて捨てるときは待たない。入れなければすぐ外す。
   */
  leave?: (el: HTMLElement) => Promise<void> | void;
}

export interface ScreenHandle<T = unknown, S extends Value = Value> extends ScreenLifecycle {
  /** 画面の枠（舞台いっぱい。content はこの中に置く）。 */
  readonly el: HTMLElement;
  /** 閉じたときの結果（close の値。戻る・捨てたときは null）。 */
  readonly result: Promise<T | null>;
  readonly state: S;
  /** 状態を変える（key があればセーブに入る）。 */
  setState(state: S): void;
  close(value?: T): void;
  /**
   * 戻る（Esc・右クリック・ゲームパッドの B）で呼ぶ。true を返せば閉じない（大きく見ている絵だけを閉じるなど）。
   * false なら、closeOnBack のときだけ閉じる。
   */
  onBack(handler: () => boolean): void;
}

export type ScreenContent<T = unknown, S extends Value = Value> = HTMLElement | ((handle: ScreenHandle<T, S>) => HTMLElement);

/** 標準のシステム画面の見た目を差し替える関数（WebPlugin.screens）。返した要素を、標準の画面と同じ枠に置く。 */
export interface StandardScreens {
  config?(api: ConfigScreenApi): HTMLElement;
  saveload?(api: SaveLoadScreenApi): HTMLElement;
  backlog?(api: BacklogScreenApi): HTMLElement;
  /**
   * ゲーム中の操作の帯（メッセージ枠の下のボタンの並び）。一度だけ作り、システムが置いて、出す場面（status.menuBar）だけ見せる。
   * ボタンの押された見た目（オート・スキップ）は api.onStatusChange で合わせる。
   */
  menuBar?(api: MenuBarApi): HTMLElement;
  /** 右クリック・Esc・ゲームパッドの START で開くメニュー（開くたびに作る）。 */
  menu?(api: MenuScreenApi): HTMLElement;
  /** はい／いいえの確かめ（タイトルへ戻る・前の選択肢へ・上書きなど。開くたびに作る）。 */
  confirm?(api: ConfirmScreenApi): HTMLElement;
  /**
   * 結末の名前（@title-screen ending= でプレイを終えたとき、タイトルへ戻る前に出す。開くたびに作る）。
   * api.close を呼ぶとタイトルへ進む（Esc・右クリックでも進む）。オートの間はシステムがしばらく見せてから進める。
   */
  ending?(api: EndingScreenApi): HTMLElement;
  /** おまけ（CG・回想・音楽・実績。開くたびに作る）。中身は liminalia.json の extra と、解放の記録。 */
  extra?(api: ExtraScreenApi): HTMLElement;
  /** フローチャートとエンディングの一覧（liminalia.json の extra.flowchart。開くたびに作る）。 */
  flowchart?(api: FlowchartScreenApi): HTMLElement;
  /**
   * オート中・スキップ中の表示（一度だけ作る）。システムが置き、オートかスキップの間だけ見せ（hidden）、data-state に auto・skip を書く。
   * 位置は liminalia.json の ui.indicator（class の lm-indicator-at-<位置>）。中身の文字を替えるなら api.onStatusChange で合わせる。
   */
  indicator?(api: IndicatorApi): HTMLElement;
  /**
   * 図鑑（@codex・メニュー・おまけから開く。data/codex.json がある作品だけ。開くたびに作る）。中身は標準の命令（@liminalia/std）が
   * 条件と記録から決め、api に渡す（開いている項目・段・相関図の線、新しい印）。区分の見せ方（list・timeline・relations・map）も api の data にある。
   */
  codex?(api: CodexScreenApi): HTMLElement;
  /**
   * 積み上げる通知（@notify・RenderContext.notify）の一枚の見た目（出すたびに作る）。積み方・上限・同じ文をまとめる・出し入れの時間は
   * システムが受け持ち、要素に class の lm-notice と lm-notice--<種類>、data-kind、data-lm-state（enter・in・out）、data-lm-count を付ける。
   * 動きは data-lm-state に合わせて作品の CSS で書く。
   */
  toast?(api: ToastApi): HTMLElement;
  /**
   * 選択肢（@choice・選択肢のブロック。出すたびに作る）。返した要素を選択肢の層（.choices）に置き、標準のボタンは作らない。
   * api.choose(番号) で選ぶ。制限時間のバー（.choice-timer）、数字のキー（選択肢の層の押せる button を上から数える）、録画への知らせ、
   * チャットの画面への受け渡しはシステムが受け持つ。置き方（ui.choice.position）は使わないので、位置は要素の CSS で決める。
   */
  choice?(api: ChoiceScreenApi): HTMLElement;
  /**
   * 名前欄（メッセージ枠の .name の中身。一度だけ作る）。返した要素を .name に置き（.name に class の lm-name-custom が付き、枠の地と線と余白を外す）、
   * 話者が替わるたびに api.onChange の受け手を呼ぶ。名前が空のページ（地の文）は .name に is-empty が付いて隠れる。位置は ui.name の x・y のまま。
   * NVL・吹き出しのチャットの画面では使わない。
   */
  name?(api: NameScreenApi): HTMLElement;
  /**
   * 確かめと文字の入力の枠（@dialog・@text-input。システム画面の外で、ゲームの中に出すもの。出すたびに作る）。返した要素を枠の幕（.lm-panel）の中に置く。
   * api.ok(入力した文字) で決め、api.cancel() でやめる。戻る（Esc・右クリック・B）は cancel（alert は OK）。キーを本文の送りへ渡さないこと、
   * 録画への知らせ、ロードしたときに片付けることはシステムが受け持つ。
   */
  dialog?(api: DialogScreenApi): HTMLElement;
  /** 操作説明（メニューの「操作説明」と @open-screen help。開くたびに作る）。操作の表は今の割り当てから作ったもの。 */
  help?(api: HelpScreenApi): HTMLElement;
  /** 持ち物（メニューの「持ち物」、@open-screen items、@item-select で選ばせるとき。開くたびに作る）。 */
  items?(api: ItemsScreenApi): HTMLElement;
}

/** 操作説明を作る関数に渡すもの（StandardScreens.help）。 */
export interface HelpScreenApi extends ScreenLifecycle {
  /** 操作の表（一行ごとに操作の名前と、キーボードとマウス・タッチ・ゲームパッドの割り当て。無い操作は ""）。 */
  rows: readonly { label: string; keyboard: string; touch: string; pad: string }[];
  /** 作品が足すページ（liminalia.json の ui.help.pages）。 */
  pages: readonly UiHelpPage[];
  asset(kind: "image", path: string): string;
  close(): void;
}

/** 持ち物を作る関数に渡すもの（StandardScreens.items）。 */
export interface ItemsScreenApi extends ScreenLifecycle {
  /** 持ち物の定義（liminalia.json の items）。 */
  items: ItemsConfig;
  /** 持っている数（持ち物の名前 → 数）。 */
  held: Readonly<Record<string, number>>;
  asset(kind: "image", path: string): string;
  /** 選ばせるとき（@item-select）は見出しと、選んだものを渡す pick。見るだけなら無い。 */
  select?: { title?: string; pick(key: string): void };
  /** 閉じる（選ばせるときは選ばなかったことになる）。 */
  close(): void;
}

/** 選択肢の一つ（ChoiceScreenApi.options）。 */
export interface ChoiceScreenOption {
  /** 選ぶときに choose に渡す番号（0 から。並びのまま）。 */
  index: number;
  /** 選択肢の文（遊んでいる言語の訳）。 */
  text: string;
  /** 押せない（locked= が真のもの、巻き戻しで戻ったときに前に選んだもの以外）。 */
  locked: boolean;
  /** 選んだ先を読んだことがある。 */
  read: boolean;
  /** 見た目の引数（image・hover・x・y・width・height・tip・cursor）。書いていなければ null。 */
  look: ChoiceLook | null;
}

/** 選択肢を作る関数に渡すもの（StandardScreens.choice）。 */
export interface ChoiceScreenApi {
  options: readonly ChoiceScreenOption[];
  /** 制限時間（ミリ秒。@choice timeout=。無ければ 0）。残り時間のバーはシステムが選択肢の層の先頭に置く。 */
  time: number;
  /** その番号を選ぶ（押せないものは選ばない）。選んだ効果音も鳴らす。 */
  choose(index: number): void;
  /** 素材の URL（選択肢の画像など。RenderContext.asset と同じ）。 */
  asset(kind: "image", path: string): string;
}

/** 名前欄に出す話者（NameScreenApi）。 */
export interface NameShown {
  /** 話者（台本に書いた名前かキャラクター ID）。地の文では null。 */
  speaker: string | null;
  /** 名前欄に出す文字（多言語の訳。二人が同時に話すページは二人の名前をつないだもの）。地の文では ""。 */
  label: string;
  /** 名前の色（cast.json の color。無ければ ""）。 */
  color: string;
}

/** 名前欄を作る関数に渡すもの（StandardScreens.name）。 */
export interface NameScreenApi {
  readonly current: NameShown;
  /** 話者が替わったら呼ぶ（ページの頭、ロードしたとき、本文を消したとき）。返す関数で外す。 */
  onChange(listener: (name: NameShown) => void): () => void;
}

/** 確かめと文字の入力の枠を作る関数に渡すもの（StandardScreens.dialog）。 */
export interface DialogScreenApi {
  /** 枠の種類: alert・confirm・input（@dialog type=）、text（@text-input）。 */
  kind: "alert" | "confirm" | "input" | "text";
  /** 文（@dialog の text、@text-input の prompt）。 */
  message: string;
  /** 文字の入力欄（input と text のとき。ほかは null）。 */
  input: { initial: string; placeholder: string; max: number | null; mode: "text" | "number" | "password"; required: boolean } | null;
  /** ボタンの文言（ok-label・cancel-label、無ければ標準の文言 dialog.ok・dialog.cancel）。やめるボタンの無い枠（alert と text）は cancelLabel が null。 */
  okLabel: string;
  cancelLabel: string | null;
  /** その文字で決められるか（@text-input の required= と pattern=）。 */
  accepts(value: string): boolean;
  /** 決める（入力のある枠は文字を渡す。accepts が false なら何もしない）。 */
  ok(value?: string): void;
  /** やめる（alert は OK と同じ。text はやめられないので何もしない）。 */
  cancel(): void;
}

/** 図鑑の区分（data/codex.json の categories）。type は見せ方（list 一覧・timeline 年表・relations 相関図・map 地図。既定 list）。 */
export interface CodexScreenCategory {
  id: string;
  label: string;
  labelEn?: string;
  sort?: "order" | "reading";
  type?: "list" | "timeline" | "relations" | "map";
  /** 地図の絵（map と relations の背景）。bgimage からのパス（前の版の作品は image に置いたものもある。標準の画面は bgimage、無ければ image から読む）。 */
  map?: string;
}

/** 図鑑の画面に出す項目（開いているもの）。sections と links は開いているものだけ。fresh はまだ読んでいない印。 */
export interface CodexScreenEntry {
  id: string;
  category: string;
  title: string;
  titleEn?: string;
  reading?: string;
  image?: string;
  summary?: string;
  summaryEn?: string;
  related: readonly string[];
  /** 年表の日付と順（order が無ければ書いた順の番号）。 */
  date?: string;
  dateEn?: string;
  order: number;
  /** 相関図と地図の位置（図の左上からの割合。0〜100。書いていなければ無い）。 */
  x?: number;
  y?: number;
  sections: readonly { key: string; id?: string; title?: string; titleEn?: string; text: string; textEn?: string; fresh: boolean }[];
  /** 相関図の線（両端が開いているもの）。 */
  links: readonly { key: string; to: string; label?: string; labelEn?: string; tone: "positive" | "negative" | "neutral" }[];
  /** 項目か、開いている段を、まだ読んでいない。 */
  fresh: boolean;
}

/** 図鑑の画面を作る関数に渡すもの（StandardScreens.codex）。 */
export interface CodexScreenApi extends ScreenLifecycle {
  /** 画面の見出しと区分（data/codex.json の title・categories）。 */
  data: { title?: string; titleEn?: string; categories: readonly CodexScreenCategory[] };
  /** 開いている項目（data/codex.json の並び）。 */
  entries: readonly CodexScreenEntry[];
  /** 最初に出す項目（@codex <id> で開いたとき）。 */
  entry?: string;
  /** 遊んでいる最中か（おまけから開いたときは false。新しい印は遊んでいる間だけ）。 */
  playing: boolean;
  /** 読んだ印を付ける（項目の id・段の key）。新しい印が消える。 */
  markSeen(keys: readonly string[]): void;
  /** 遊んでいる言語の文字（英語なら en、無ければ ja）。 */
  text(ja: string | undefined, en?: string): string;
  asset(kind: "bgimage" | "fgimage" | "image", path: string): string;
  close(): void;
  /** Esc・右クリック・パッドの B で呼ぶ。true を返せば閉じない（渡さなければ閉じる）。 */
  onBack(handler: () => boolean): void;
}

/** オート中・スキップ中の表示を作る関数に渡すもの。 */
export interface IndicatorApi {
  readonly status: SystemStatus;
  onStatusChange(listener: (status: SystemStatus) => void): () => void;
  /** 標準の文言（オート・スキップ。言語に合わせたもの）。 */
  label(state: "auto" | "skip"): string;
}

/** フローチャートを作る関数に渡すもの。場面のつながりは台本から作る（@liminalia/lang の buildFlow）。 */
export interface FlowchartScreenApi extends ScreenLifecycle {
  flow: Flow;
  /** 場面に出す題（extra.flowchart.titles か、場面の最初の本文）。 */
  title(scene: FlowScene): string;
  /** 場面を読んだことがあるか（まだなら題も選択肢の文も伏せる）。 */
  reached(scene: FlowScene): boolean;
  /** その場面から読み直せるか（はじめて着いたときの控えがある）。 */
  canJump(scene: FlowScene): boolean;
  /** その場面から読み直す（確かめてから。今の進行は捨てる）。 */
  jump(scene: FlowScene): void;
  /** 既読率（0〜1。本文のページのうち読んだもの）。 */
  readRate: number;
  /**
   * エンディング（プレイが終わる場面）。kind は種類（ending= の bad など。無ければ ""）、label は種類の文言（BAD END など）、title は title= の名前
   * （どれも遊んでいる言語の訳）。name は一覧に出す一行（種類の文言と名前。前の書き方は書いた文言。どれも無ければ「エンディング n」）。
   */
  endings: { scene: FlowScene; name: string; reached: boolean; kind: string; label: string; title: string }[];
  close(): void;
  onBack(handler: () => boolean): void;
}

/** おまけを作る関数に渡すもの。 */
export interface ExtraScreenApi extends ScreenLifecycle {
  extra: ExtraConfig;
  /** 開くタブ（タイトル・メニューから開いたときは無い。回想から戻ったときは replay）。 */
  tab?: "cg" | "replay" | "music" | "movies" | "characters" | "chapters" | "glossary" | "achievements" | "endings";
  /** CG のうち解放した画像（images の並びのまま）。空なら見られない。 */
  cgImages(cg: ExtraCg): string[];
  replayUnlocked(replay: ExtraReplay): boolean;
  musicUnlocked(music: ExtraMusic): boolean;
  /** ムービーを見たことがあるか（@movie で再生した）。 */
  movieUnlocked(movie: ExtraMovie): boolean;
  /** 実績を解放した日時（ISO 8601。日時が無ければ ""）。解放していなければ null。 */
  achievement(achievement: ExtraAchievement): string | null;
  /** 数を数える実績の今の数（goal のある実績。数えていなければ 0）。 */
  achievementProgress(achievement: ExtraAchievement): number;
  /** コンプリート率（SystemController.completion と同じ）。 */
  completion(): Promise<Completion>;
  /** 用語を解放したか（本文に出たか @glossary-unlock）。 */
  glossaryUnlocked(entry: ExtraGlossary): boolean;
  /** 章を解放したか（章の始まりに着いたことがある）。 */
  chapterUnlocked(entry: ExtraChapter): boolean;
  /** 作品の章の情報（liminalia.json の chapters。題・番号・副題は遊んでいる言語の訳）。章が無ければ空。 */
  chapters: readonly ChapterInfo[];
  /** 章から読み直す（確かめてから。おまけを閉じる）。 */
  startChapter(entry: ExtraChapter): void;
  asset(kind: "bgimage" | "fgimage" | "bgm" | "image", path: string): string;
  audio: AudioPlayer;
  /** 回想を再生する（おまけを閉じてから。終わったらおまけの回想のタブへ戻る）。 */
  replay(entry: ExtraReplay): void;
  close(): void;
  /**
   * Esc・右クリック・パッドの B で呼ぶ。true を返せば閉じない（CG を大きく見ていればそれだけ閉じるなど）。
   * 渡さなければおまけを閉じる。
   */
  onBack(handler: () => boolean): void;
  /**
   * 開いている間のキー（矢印・Enter など。KeyboardEvent の key）を受ける。true を返せば、そのキーの標準の動き（ボタンを選んで移る・押す）をしない。
   * ゲームパッドの十字キーと A も、同じ名前（ArrowUp・Enter など）で届く。返す関数で外す。
   */
  onKey(handler: (key: string, e: KeyboardEvent | null) => boolean): () => void;
}

/** 操作の帯を作る関数に渡すもの。 */
export interface MenuBarApi {
  /** 置く操作と並び（liminalia.json の ui.menuBar.items。書いていなければ既定の並び。作品の画面は "screen:<名前>"）。 */
  items: readonly (SystemAction | ScreenAction)[];
  /** 標準の文言（言語に合わせたもの。作品の画面は defineScreen の label）。 */
  label(action: SystemAction | ScreenAction): string;
  perform(action: SystemAction | ScreenAction): void;
  readonly status: SystemStatus;
  onStatusChange(listener: (status: SystemStatus) => void): () => void;
}

/** メニューを作る関数に渡すもの。 */
export interface MenuScreenApi extends Partial<ScreenLifecycle> {
  /** 並べる操作（回想の間はセーブとロードを除く。終了はデスクトップ版だけ）。 */
  items: readonly (SystemAction | ScreenAction)[];
  label(action: SystemAction | ScreenAction): string;
  /** メニューを閉じてから、その操作をする。 */
  perform(action: SystemAction | ScreenAction): void;
  readonly status: SystemStatus;
  close(): void;
  /** メニューが閉じたら呼ぶ（閉じるボタン・操作・ロードで捨てたとき）。返す関数で外す。 */
  onClose?(listener: () => void): () => void;
}

/** エンディングの名前を作る関数に渡すもの。 */
export interface EndingScreenApi extends ScreenLifecycle {
  /**
   * 大きく出す名前（遊んでいる言語の訳）。@title-screen の title= か、無ければ種類の文言（label）。前の書き方（ending= に文言を書いた、
   * 移していない作品）は、書いた文言。
   */
  name: string;
  /** エンディングの種類（ending= の bad、normal、good、true、other と作品の endingKinds。前の書き方は文言から読んだ種類）。 */
  kind: string;
  /** 種類の文言（BAD END など。作品の endingKinds が先。other と前の書き方は ""）。 */
  label: string;
  /** このエンディングだけの名前（title=。遊んでいる言語の訳。無ければ ""）。 */
  title: string;
  /** 終わりの表記（@title-screen の text。省けば標準の文言。日本語は「終」、英語は The End）。 */
  text: string;
  /** 進む操作の文言（読み上げ用。標準は「タイトルへ戻る」）。 */
  proceed: string;
  /** タイトルへ進む。 */
  close(): void;
}

/** 確かめを作る関数に渡すもの。 */
export interface ConfirmScreenApi extends ScreenLifecycle {
  /**
   * 何の確かめか: title・exit・end-replay・backlog-jump・prev-choice・import・delete・overwrite・load、
   * investigate-finish（調べる画面の「調べ終える」を、調べていない場所が残ったまま押したとき）、
   * 作品の画面から api.ask で尋ねたものは、そのとき渡した名前（無ければ confirm）。
   */
  kind: string;
  /** 文（標準の文言。WebPlugin.texts で替えたもの）。 */
  message: string;
  /** 標準のボタンの文言（はい・いいえ）。 */
  yes: string;
  no: string;
  /** 答える（いいえ・Esc・右クリックは false）。 */
  answer(ok: boolean): void;
}

export interface ConfigScreenApi extends ScreenLifecycle {
  /** 設定は system.settings・updateSettings・onSettingsChange（ui.slider などの setting に結び付けられる）。 */
  system: SystemController;
  /** 選べる言語（先頭が原文の言語。一つなら言語の欄は要らない）。 */
  languages: readonly string[];
  /** 「初期設定に戻す」で戻す値（作品の初期値。liminalia.json の ui.defaults。無ければエンジンの既定値）。 */
  defaults: Readonly<Settings>;
  /**
   * 初期設定に戻す（標準の設定画面の「初期設定に戻す」と同じ。言語・全画面・話者ごとのボイスの並び・動きを減らす・読み上げ・
   * 見やすい色・選択肢の制限時間は遊ぶ人が決めたまま残す）。戻したあとの設定を返す。
   */
  reset(): Readonly<Settings>;
  close(): void;
  /** セーブを丸ごと書き出す・読み込む（標準の設定画面の下のボタン）。 */
  exportSaves(): void;
  importSaves(): void;
}

export interface SaveLoadScreenApi extends ScreenLifecycle {
  mode: "save" | "load";
  /** スロットは system.slots・slot・deleteSlot。オートセーブは system.autoSlots。 */
  system: SystemController;
  /** 番号つきのスロットの数（liminalia.json の ui.saveSlots）。 */
  slotCount: number;
  /** オートセーブの枠の数（liminalia.json の ui.autosave.slots。0 なら持たない）。 */
  autoSlotCount: number;
  /** クイックセーブの枠の数（liminalia.json の ui.quickSave.slots。枠は "quick"・"quick:1"…。system.quickSlots で並べられる）。 */
  quickSlotCount?: number;
  /** 最後にセーブした番号つきのスロット（一覧を開くページを決める）。無ければ null。 */
  lastSlot: number | null;
  /** いちばん新しいセーブ（番号つき・オート・クイックのうち、日時のいちばん新しいもの。「続きから」の印など）。無ければ null。 */
  latestSlot: SlotRef | null;
  /** 標準のセーブ画面の一ページの枠の数（ページを分けるときに合わせる）。 */
  pageSize: number;
  /** 今遊んでいる章（liminalia.json の chapters の id。章の無い作品・遊んでいないときは null）。スロットの章は SlotInfo.chapterId。 */
  chapterId: string | null;
  /** ゲーム中か（ロードで今の進行が失われるので、確かめるならこのとき）。 */
  inGame: boolean;
  /** そのスロットにセーブする（書けたら true。上書きの確かめは画面の側で）。 */
  save(slot: number): boolean;
  /** そのスロットから再開する（画面は閉じる）。 */
  load(slot: SlotRef): void;
  /** はい／いいえを尋ねる。kind は確かめの種類（ConfirmScreenApi.kind。delete・overwrite・load など）。 */
  ask(message: string, kind?: string): Promise<boolean>;
  /** 短い知らせ。 */
  notify(message: string): void;
  close(): void;
}

export interface BacklogScreenApi extends ScreenLifecycle {
  entries: readonly BacklogEntry[];
  playVoice(index: number): void;
  /** その項目から読み直す（確かめてから。canJump の項目だけ）。 */
  jump(index: number): Promise<void>;
  /** 話者の名前の色（キャストの color）。 */
  color(speaker: string): string;
  /** 話者の台詞の文字の見た目（cast.json の text: color、font、italic）。無ければ null。 */
  textStyle(speaker: string): { color?: string; font?: string; italic?: boolean } | null;
  /** 素材の URL（顔の絵・本文の中の画像など。RenderContext.asset と同じ）。 */
  asset(kind: "bgimage" | "fgimage" | "image", path: string): string;
  close(): void;
}

/** 履歴の一項目（一ページ）。parts は本文の一片（文字とルビ・装飾、改行）。 */
export interface BacklogEntry {
  speaker: string | null;
  /** 名前の欄に出した名前（多言語の訳。無ければ speaker。二人が同時に話したページは名前欄と同じに二人の名前をつないだもの）。 */
  label: string | null;
  /** 同時に話したほかの話者（二つ目のボイスの who。話者名のまま）。いなければ省く。 */
  with?: readonly string[];
  parts: readonly LogPart[];
  /** そのページで鳴らしたボイス。 */
  voice: VoiceCue | null;
  at: { file: string; line: number };
  /** そこから読み直せるか（jumpToBacklog）。 */
  canJump: boolean;
  /** 選んだ選択肢（parts はその文。ui.backlogChoices が false なら入らない）。 */
  choice?: boolean;
}

/**
 * セーブの枠の名前。0 からの番号・クイックセーブ（"quick" と "quick:1" から。ui.quickSave.slots 個）・オートセーブ（"auto:0" から）。
 * クイックセーブとオートセーブは、新しいもので古いものを置き換えて回す。
 */
export type SlotRef = "quick" | `quick:${number}` | number | `auto:${number}`;

/** セーブの枠。 */
export interface SlotInfo {
  slot: SlotRef;
  empty: boolean;
  /** 保存した日時（ISO 8601）。 */
  date?: string;
  /** 一覧に出す文（そのとき表示していたページの頭）。 */
  title?: string;
  /** 舞台の縮小画像（data URL）。 */
  thumb?: string;
  /** 作品のメタ情報（WebPlugin.slotMeta と saveTo の meta）。 */
  meta?: Record<string, Value>;
  /** 章の名前（WebPlugin.slotChapter か、ui.chapterNames、おまけの章、ファイルの名前）。前の版のセーブには無い。 */
  chapter?: string;
  /** セーブした位置の章（liminalia.json の chapters の id。章の無い作品・どの章にも入らない位置なら無い）。 */
  chapterId?: string;
  /** プレイ時間（ミリ秒。はじめから、またはロードしたセーブのプレイ時間から数える）。前の版のセーブには無い。 */
  playTime?: number;
}

/** SystemController.importData に渡すもの。 */
export interface ImportData {
  slots?: { slot: SlotRef; save: SaveData; date?: string; title?: string; thumb?: string; meta?: Record<string, Value> }[];
  system?: Record<string, Value>;
  /** 既読（ファイル → ページの鍵。前のバージョンの行の番号も読める）。 */
  read?: Record<string, readonly (string | number)[]>;
  settings?: SettingsPatch;
}

/** システムの今の様子（SystemController.status）。 */
export interface SystemStatus {
  /** boot（起動中）・title・game。 */
  mode: string;
  /** 一番上に開いている画面の名前（無ければ null）。 */
  screen: string | null;
  /** 選択肢を出しているか。 */
  choosing: boolean;
  /** 遊ぶ人が文字の枠を隠しているか（右クリック・Space など）。 */
  hidden: boolean;
  /** シナリオがメッセージ枠を出しているか（@window）。 */
  window: boolean;
  /** クリックを待っているか（選択肢を出しているときは false）。 */
  waiting: boolean;
  auto: boolean;
  skip: boolean;
  /** 回想を再生しているか。 */
  replay: boolean;
  /** 標準の操作の帯を出す場面か（遊んでいて、画面を開いておらず、枠を隠しておらず、メッセージ枠が出ていて、選択肢を出していない）。 */
  menuBar: boolean;
  /** 前の選択肢へ戻れるか。 */
  canPrevChoice: boolean;
  /** 一ページ戻れるか（巻き戻し）。 */
  canRollback: boolean;
  /** 戻ったところから進め直せるか。 */
  canRollforward: boolean;
  /** 今のページにボイスがあり、もう一度鳴らせるか（"replay-voice"）。 */
  canReplayVoice?: boolean;
}

/**
 * システムの出来事（SystemController.onEvent）。
 * - start: 「はじめから」でプレイを作った直後、タイトルを外して始める前（runtime の変数を入れる・舞台を整えるなど）
 * - load-start: ロード（スロット・履歴・前の選択肢）で今のプレイを捨てる直前（制作画面の舞台からの loadSave では来ない）
 * - load-end: load-start のロードで、状態から画面を組み立て直したあと（restorers を呼び終えたあと。幕を上げるなど）
 * - rollback: 巻き戻し（一ページ戻る・進め直す）で組み立て直す直前。ロードの演出は出さない前提で、load-start は来ない
 * - screen-open / screen-close: 画面を開いた・閉じた（from は開いたときの mode）
 * - title: タイトルを出した
 */
export type SystemEvent =
  | { type: "start"; runtime: Runtime }
  | { type: "load-start"; from: LoadFrom }
  | { type: "load-end"; from: LoadFrom }
  | { type: "rollback"; direction: "back" | "forward" }
  | { type: "screen-open"; name: string; from: string }
  | { type: "screen-close"; name: string; from: string }
  | { type: "title" };

/** タイトル画面だけを差し替えるときに渡すもの（標準のタイトルのボタンと同じ動き）。 */
export interface TitleApi {
  project: PlayerProject;
  host: DomHost;
  /** はじめから。 */
  start(): void;
  /** セーブの一覧を開いて選んで再開する（「つづきから」）。 */
  load(): void;
  /** 一番新しいセーブから、一覧を開かずに再開する。 */
  loadLatest(): Promise<void>;
  /** セーブがあるか（「つづきから」を押せるか）。 */
  hasSave(): boolean;
  config(): void;
  /** おまけを開く。 */
  extra(): void;
  /** おまけに解放したものがあるか（「おまけ」を出すか）。 */
  hasExtra(): boolean;
  /** フローチャートを開く（extra.flowchart があるとき）。 */
  flowchart(): void;
  /** フローチャートを出すか（extra.flowchart があり、何か一つでも読んだ）。 */
  hasFlowchart(): boolean;
  /** 終える（デスクトップ版だけ。canExit が false なら何もしない）。 */
  exit(): void;
  canExit(): boolean;
  /** はい／いいえを尋ねる（標準の確かめ。作品が差し替えていればその見た目）。kind は ConfirmScreenApi.kind に渡る。 */
  ask(message: string, kind?: string): Promise<boolean>;
  /** 起動して最初のタイトルか（導入の演出を出すとき。ゲーム・おまけ・設定から戻ったとき・言語を替えたときは false）。 */
  intro: boolean;
}

/**
 * タイトル画面を作る。返した要素を舞台いっぱいに置く（タイトルを出すたびに呼ぶ。言語を替えたときも作り直す）。
 * 背景と BGM は liminalia.json の ui.title のものを標準どおりに出す（要らなければ書かない）。
 */
export type TitleFactory = (api: TitleApi) => HTMLElement;

export function defineWebPlugin(plugin: WebPlugin): WebPlugin {
  return plugin;
}

/** プラグインの口の版がこのエンジンより新しい描画のプラグイン（遊ぶ画面が開発者ツールに知らせる）。 */
export function newerWebPlugins(plugins: readonly WebPlugin[]): WebPlugin[] {
  return plugins.filter((p) => typeof p.apiVersion === "number" && p.apiVersion > PLUGIN_API_VERSION);
}

/** プレイヤーが知っている作品の情報（liminalia.json から）。 */
export interface PlayerProject {
  id: string;
  title: string;
  /** 版（liminalia.json の version。パックの requires と比べる）。 */
  version?: string;
  /** 「はじめから」の開始位置。 */
  entry: string;
  /** タイトル画面を出すか。 */
  titleScreen: boolean;
  screen: { width: number; height: number };
  /** おまけ（CG・回想・音楽・実績）の一覧。 */
  extra?: ExtraConfig;
  /** 章の情報（liminalia.json の chapters）。実行器の chapter と式の chapter()、セーブスロットの見出し（@liminalia/lang の chapterOf）が読む。 */
  chapters?: ChapterInfo[];
  /** 持ち物（liminalia.json の items）。 */
  items?: ItemsConfig;
  /** 言語ごとの素材（言語 → 差し替える素材の "種類/パス"。assets/<種類>/@<言語>/<パス> にあるもの）。 */
  localizedAssets?: Record<string, string[]>;
  /** 遊べる言語（二つ以上のときだけ）。先頭が原文の言語。 */
  languages?: string[];
  /** 作品が足したエンディングの種類と文言（liminalia.json の endingKinds。種類 → 文言）。 */
  endingKinds?: Record<string, string>;
  /** 立ち絵の登場順の自動配置の並べ方（liminalia.json の autoLayout。読み解くのは @liminalia/lang の autoLayoutRules）。 */
  autoLayout?: unknown;
  /** 変数の初期値（liminalia.json の variables。"game.x"・"system.x" → 値）。システム画面は Runtime の options.variables に渡す。 */
  variables?: Record<string, Value>;
  /**
   * ゲームの見た目と操作の設定（liminalia.json の ui）。見た目（文字・枠・選択肢・カーソル）はプレイヤーが DomHost.setUi で当てる。
   * システム画面は、セーブの枠の数・履歴の件数・初期の設定・キー・タイトル画面をここから読む（開発中は書き換わることがある）。
   */
  ui?: UiConfig;
  /**
   * 作品の画面の型（画面の名前 → 型の HTML の文字）。liminalia.json の ui.templates に書いたファイルを、開発サーバーと書き出しが読んで入れる。
   * 標準の型に部品ごとに重ねる。同じ画面をプラグインの screens.* が差し替えていれば、そちらが先（docs/design/screen-templates.md）。
   */
  templates?: Record<string, string>;
  /**
   * セーブの扱い（liminalia.json の saves のうちプレイヤーが使うもの）。protect なら読めない形で書き、書き換えたものを読まない。
   * carryFrom は引き継げる作品（体験版など）の id → デスクトップ版の題名。
   */
  saves?: { protect?: boolean; carryFrom?: Record<string, string> };
  /** ロードの直後に呼び出す位置（liminalia.json の afterLoad）。システム画面は Runtime の options.afterLoad に渡す。 */
  afterLoad?: string;
  /** 作品ごとのコマンドの既定値（liminalia.json の commandDefaults）。システム画面は Runtime の options.commandDefaults に渡す。 */
  commandDefaults?: CommandDefaults;
  /** 止まったときの記録を送る先（liminalia.json の build.crashReport）。 */
  crashReport?: { url: string };
  /** 遊ばれ方の統計を送る先（liminalia.json の build.analytics。書き出したゲームだけ。遊ぶ人が送ると答えたときだけ送る）。 */
  analytics?: { url: string };
  /** テスト版の指摘の口（lim build --feedback のときだけ。url は liminalia.json の build.feedback.url）。 */
  feedback?: { url?: string };
  /** 書き出しの版（lim build --variant。台本からは system.variant）。contentFilter なら表現を控えめにしたまま変えさせない。 */
  variant?: { name: string; contentFilter?: boolean };
  /** 連番のボイスの番号の固定（voice-lock.json）。システム画面は Runtime の options.voiceLock に渡す。 */
  voiceLock?: VoiceLock;
  /** 店で買える商品（liminalia.json の build.store.products。名前 → 店ごとの商品 ID。store.ts）。 */
  store?: { products: StoreProducts };
  /** 作品のデータ（paths.data の .json）の一覧。ここに無いデータは取りに行かずに読めないことにする（パックのデータは別）。 */
  dataFiles?: string[];
  /** 訳のファイル（lang/<言語>.json）がある言語。書き出したゲームでは、ここに無い言語の訳を取りに行かない。 */
  translations?: string[];
}

/** システム画面に渡すもの。 */
export interface SystemEnv {
  host: DomHost;
  project: PlayerProject;
  /** すべてのプラグインの描画をまとめたもの。 */
  extensions: Extensions;
  /** 組み込みとプラグインの命令の実装。 */
  commands: CommandImpl[];
  speakers: string[];
  onDiagnostic(d: Diagnostic): void;
  /** 一文字あたりの既定のミリ秒を変える（設定画面の文字速度）。 */
  setTextSpeed(ms: number): void;
  /** 遊んでいる言語を素材の読み先に伝える（assets/<種類>/@<言語>/ の差し替え。原文の言語なら ""）。 */
  setAssetLanguage?(language: string): void;
  /** 決められた言語（URL の ?lang=。制作画面のプレビューで言語を選んだときも）。作品の languages にあれば、コンフィグの言語と端末の言語より先に使う。 */
  language?: string;
  /** タイトル画面だけを差し替えるもの（WebPlugin.title）。 */
  title?: TitleFactory;
  /** 標準のシステム画面の見た目の差し替え（WebPlugin.screens を重ねたもの）。 */
  screens?: StandardScreens;
  /** 起動の演出（WebPlugin.splash）。 */
  splash?(ctx: RenderContext): Promise<void>;
  /** シナリオが終わってタイトルへ戻る前の演出（WebPlugin.endSplash）。 */
  endSplash?(ctx: RenderContext): Promise<void>;
  /** 標準のシステム画面の文言の差し替え（WebPlugin.texts を重ねたもの）。 */
  texts?: Readonly<Record<string, string>>;
  /** 画面の切り替えの幕（WebPlugin.transitions を重ねたもの）。 */
  transitions?: Transitions;
  /** セーブに付ける作品のメタ情報（WebPlugin.slotMeta を重ねたもの）。 */
  slotMeta?(runtime: Runtime): Record<string, Value>;
  /** セーブの一覧に出す章の名前（WebPlugin.slotChapter）。null なら標準の決め方。 */
  slotChapter?(runtime: Runtime, label: { file: string; label: string | null } | null): string | null;
  /** 一回のプレイが終わったとき（開発用の表示・撮影の合図）。 */
  onEnd?(result: RunResult): void;
  /** 言語の訳（project/lang/<言語>.json）を読む。無ければ null。 */
  loadTranslation?(language: string): Promise<TranslationFile | null>;
  /** フローチャート（project/flow.json。台本から作ったもの）を読む。無ければ null。 */
  loadFlow?(): Promise<Flow | null>;
  /** 実績を解放したとき（@achieve。はじめての解放だけ）。デスクトップ版はここから Steam の実績へ、スマホ版は Game Center・Google Play Games へ送る。 */
  onAchievement?(id: string): void;
  /** 数を数える実績を進めたとき（@achieve-progress。value は今の数、goal は目標。目標の無い実績は 0）。店の実績の進み具合へ送る。 */
  onAchievementProgress?(id: string, value: number, goal: number): void;
  /**
   * 実行器が変数に値を入れたとき。システム画面は、作る Runtime の options.onAssign にそのまま渡す。
   * 制作画面の舞台が、遊んで決まった値の出どころ（その行）を事実の欄に出すのに使う。渡さなくても動くが、そのときは行が出ない。
   */
  onAssign?(path: string, value: Value, at: { file: string; line: number }): void;
  /**
   * 命令を実行する直前（Runtime の options.beforeStep にそのまま渡す）。Promise を返したら、その命令の前で待つ。
   * 制作画面の舞台がブレークポイントで止めるのに使う。渡さなくても動くが、そのときはブレークポイントで止まらない。
   */
  beforeStep?(at: { file: string; line: number }): Promise<void> | void;
}

/** 書き出し時に同梱するテスト用セーブ。 */
export interface SeedSave {
  id: string;
  slot: number;
  title: string;
  overwrite: boolean;
  save: SaveData;
}

/**
 * システム画面の役目。プレイヤー・撮影・自動確認はこの形だけを使う。
 * mode は "boot"（開始前）/ "title" / "game"。screen は開いているシステム画面の名前（無ければ null）。
 * 既定のシステム画面の screen は "save" / "load" / "backlog" / "config" / "menu" / "confirm"（重なっていれば一番上）。
 * キー操作（送り・スキップ・クイックセーブなど）もシステム画面が受け持つ。プレイヤーはキーを見ない。
 * 自分でキーを振り分けるなら host.keyboard を false にして、DomHost の既定のキー操作（Enter・Space で送る、Ctrl でスキップ）を止める。
 */
export interface SystemController {
  readonly mode: string;
  readonly screen: string | null;
  readonly runtime: Runtime | null;
  /** このプレイで表示したページ数。 */
  readonly pages: number;
  /** 開発用の早送り。このページ数まで既読に関係なく瞬時に進める。startAt で始めるプレイにだけ効く（巻き戻し、ロード、タイトルからの開始では 0 に戻す）。 */
  devSkipUntil: number;
  /** 「クリックで開始」を出す（音の再生にはユーザー操作が要るため）。 */
  showGate(): void;
  /** 開始の演出からタイトルまで（デスクトップ版はクリックを挟まずこれを呼ぶ）。 */
  boot(): Promise<void>;
  showTitle(skipIntro: boolean): Promise<void>;
  /** タイトルを通さず、指定の位置から始める（開発用）。 */
  startAt(target: string): void;
  /**
   * スロットにセーブする。スロットは 0 からの番号か "quick"。meta は一覧に出す作品のメタ情報（章・作中の日付など）で、
   * WebPlugin.slotMeta が返すものに重ねて SlotInfo.meta に入る。
   */
  saveTo(slot: "quick" | number, meta?: Record<string, Value>): boolean;
  /** スロットから再開する（オートセーブの "auto:0" なども）。 */
  loadFrom(slot: SlotRef): Promise<void>;
  /** 遊んでいる最中の標準の操作（オート・スキップ・履歴・タイトルへ戻るなど）。遊んでいないときは何もしない。 */
  perform?(action: SystemAction | ScreenAction): Promise<void>;
  /** オート・スキップ・文字の枠を隠しているか（作品のボタンの見た目を合わせる）。 */
  readonly toggles?: { auto: boolean; skip: boolean; hidden: boolean };
  /**
   * 作品の章の情報（liminalia.json の chapters。題・番号・副題は遊んでいる言語の訳）。runtime がまだ null の、
   * 遊びはじめる前（ready の時点・タイトル・おまけ）でも読める。章が無ければ空。遊んでいる最中の今の章は runtime.chapter。
   */
  readonly chapters?: readonly ChapterInfo[];
  /**
   * そのシナリオファイル（拡張子なし）を含む章（chapters に @liminalia/lang の chapterOf を当てたもの。runtime.chapter と同じ決め方）。
   * 無ければ null。遊びはじめる前でも使える（セーブの枠の位置のファイルから章を出すなど）。
   */
  chapterOf?(file: string): ChapterInfo | null;
  /** 今の様子（作品が自分で置く操作の帯・ボタンの出し入れを、標準の帯と同じ決まりで行うため）。 */
  readonly status?: SystemStatus;
  /** 選んでいるテーマ（liminalia.json の ui.system.preset。標準のテーマなら null）。テーマごとに見た目を変える作品の画面が読む。 */
  readonly theme?: string | null;
  /** 標準の画面の見た目の差し替え（WebPlugin.screens を重ね、テーマの screens も重ねたもの）。標準の命令の画面（図鑑など）が読む。 */
  readonly standardScreens?: Readonly<StandardScreens> | undefined;
  /** 様子が変わったら呼ぶ（変わったときだけ）。返す関数で外す。 */
  onStatusChange?(listener: (status: SystemStatus) => void): () => void;
  /**
   * システムの出来事（はじめから・ロードの始まり・画面の開け閉て・タイトル）を受ける。返す関数で外す。
   * start と load-start は、受け手が返した Promise が済むまで次へ進まない（幕を下ろしてから組み立て直す演出など）。
   */
  onEvent?(listener: (event: SystemEvent) => void | Promise<void>): () => void;
  /** 設定画面の値（読むだけ。変えるのは updateSettings）。 */
  readonly settings?: Readonly<Settings>;
  /** 設定を変えて保存し、すぐ反映する（音量・文字の速さ・全画面など）。作品独自の値は custom に入れる。変えたあとの設定を返す。 */
  updateSettings?(patch: SettingsPatch): Readonly<Settings>;
  /** 設定が変わったら呼ぶ（設定画面・updateSettings・シナリオの @config・全画面の切り替え）。返す関数で外す。 */
  onSettingsChange?(listener: (settings: Readonly<Settings>) => void): () => void;
  /** このプレイの履歴（古い順。読むだけ）。 */
  readonly backlog?: readonly BacklogEntry[];
  /** 履歴のその項目のボイスを鳴らし直す（無ければ何もしない）。 */
  playBacklogVoice?(index: number): void;
  /** 履歴のその項目から読み直す（確かめてから。それより後の進み具合は捨てる）。読み直せない項目なら何もしない。 */
  jumpToBacklog?(index: number): Promise<void>;
  /** 番号つきのスロットの一覧（from から to まで。空の枠も）。 */
  slots?(range?: { from: number; to: number }): SlotInfo[];
  /** 一つのスロット（"quick"・"auto:0" なども）。 */
  slot?(slot: SlotRef): SlotInfo;
  /** オートセーブの枠（新しい順。空の枠は後ろ）。 */
  autoSlots?(): SlotInfo[];
  /** クイックセーブの枠（新しい順。空の枠は後ろ）。 */
  quickSlots?(): SlotInfo[];
  /** スロットを消す。 */
  deleteSlot?(slot: SlotRef): void;
  /**
   * オートセーブする（@autosave と同じ。枠を持たない作品・遊んでいないとき・回想の間は何もしない）。書いた枠を返す。
   * 同じ位置のオートセーブがいちばん新しければ、その枠に書き直す。
   */
  autosave?(meta?: Record<string, Value>): SlotRef | null;
  /**
   * 裏へ回したときのオートセーブから続ける（スマホのアプリが、落ちた描画のプロセスを作り直して ?resume=1 で読み直したとき）。
   * 裏へ回したまま戻っていなければ、そのときのオートセーブを読み込んで true。無ければ false（プレイヤーはふつうに起動する）。
   */
  resumeLeft?(): Promise<boolean>;
  /**
   * 戻る（Android のアプリの戻るボタンとなぞり、スマホのブラウザの戻る）。扱ったら true。扱わなければ、アプリは裏へ回り、ブラウザは前のページへ戻る。
   * 既定のシステム画面は、開いている画面を閉じる（Esc と同じ）→ 隠した枠を戻す → ゲーム中はメニュー →
   * タイトルでは、アプリを閉じられる（Android のアプリ・デスクトップ版）なら終わるかを尋ね、閉じられなければ扱わない。
   */
  back?(): boolean;
  /**
   * 終了する前・裏へ回る前に呼ぶ（タブを切り替えた・スマホでホームへ戻った・デスクトップ版のウィンドウを閉じる）。
   * 全セーブ共通のもの（system 変数・既読・設定）を書き、作品の設定（ui.autosave.leave）に従ってオートセーブする。
   */
  leave?(): void;
  /**
   * 作品の画面を開く（捜査・地図・原作のセーブ画面など）。見た目は content（要素か、扱いを受け取って要素を返す関数）に任せ、
   * システムが次のことを受け持つ:
   * - 標準のシステム画面と同じ層・同じ重なりの並びに置く（後に開いたものが上）
   * - 下にある入力を止める: 本文送りのクリック・ホイール（履歴と送り）は画面の中で止め、右クリック・Esc・ゲームパッドの B は
   *   この画面の「戻る」にする（closeOnBack なら閉じる。そうでなければ何もしない。allowMenu ならメニューを開く）。オート・スキップは閉じるまで止まる
   * - pauseScenario（既定 true）なら、開いている間シナリオの次の命令を実行しない
   * - key を書けば、状態（handle.state・setState）をセーブに入れ、ロードで同じ状態に戻す（同じ key で開き直すと、
   *   セーブの状態から始まる。defineScreen で作り方を登録しておけば、ロードしたときにシステムが開き直す）
   * 閉じたら handle.result が close(value) の値（戻る・捨てたときは null）になる。同じ key の画面が開いていればそれを返す。
   */
  openScreen?<T = unknown, S extends Value = Value>(content: ScreenContent<T, S>, options?: ScreenOptions<S>): ScreenHandle<T, S>;
  /**
   * 作品の画面の作り方を名前（key）で登録する。ロードしたときに同じ状態で開き直すほか、名前で開ける
   * （@open-screen <名前>・perform("screen:<名前>")・クイックメニューの "screen:<名前>"・RenderContext.system.openScreen("<名前>")）。
   * menu なら右クリック・Esc のメニューにも並べる（文字は label）。
   */
  defineScreen?<T = unknown, S extends Value = Value>(key: string, build: ScreenContent<T, S>, options?: DefineScreenOptions<S>): void;
  /**
   * 名前で画面を開き、閉じるまで待つ。名前は標準の画面（save・load・log・menu・config・extra・items・help・flowchart）か、
   * defineScreen で登録した作品の画面。開けなければ false（知らない名前・開けない場面）。
   */
  openScreenByName?(name: string): Promise<boolean>;
  /** 全セーブ共通のもの（system 変数・既読）を今すぐ保存する（ふだんはページを出すたび・セーブ・裏へ回るときに書く）。 */
  persist?(): void;
  /**
   * コンプリート率（既読、エンディング、CG、回想、音楽、ムービー、実績の、解放したもの / 全体と、全体の割合）。
   * 既読とエンディングは台本から作ったフローチャート（project/flow.json）を読んで数える（読めなければ null）。作品の画面やプラグインが読む。
   */
  completion?(): Promise<Completion>;
  /** テスト用セーブをスロットに入れる。 */
  installSeedSaves(seeds: SeedSave[]): void;
  /**
   * 全セーブ共通の変数（system.○○。CG・回想の解放など）。タイトルでも読み書きでき、システムがセーブと一緒に保存する。
   * 書き換えたらすぐ残したいときは importData({ system }) を使う。
   */
  readonly systemVariables?: Record<string, Value>;
  /**
   * 前の形式（作品が以前使っていた保存の形・別のエンジン）のデータを引き継ぐ。slots はスロットに書き（同じ番号は上書き）、
   * system は全セーブ共通の変数に重ね、read は既読のページ（ファイル → ページの鍵か行）に足し、settings は設定に重ねる。書けなかったスロットの数を返す。
   */
  importData?(data: ImportData): number;
  /**
   * セーブデータから始める（制作画面の舞台が、ある行の本番どおりの状態を出すのに使う。開発時だけ呼ばれる）。
   * タイトルや開いている画面を閉じ、その位置のページ（か選択肢）を出し始めたら解決する（着く前にプレイが終わったときも）。
   * そのあとはふつうのプレイと同じくクリックを待つ。終わってもタイトルへは戻らない。省略すると制作画面の舞台は使えない。
   */
  loadSave?(save: SaveData): Promise<void>;
  /**
   * 開発中に、今の状態を控えて台本を読み直し、同じ場所（今のページ）から続ける（テストプレイの「この場所から読み直す」と ⇧R）。
   * 履歴と選択肢の控えとプレイ時間は引き継ぐ。遊んでいないとき（タイトルなど）は何もせず false。開発時だけ呼ばれる。
   * 省略すると、テストプレイは今のページのセーブを loadSave で読み直す（履歴は引き継がない）。
   */
  reloadHere?(): Promise<boolean>;
  /**
   * 読んでいるページから場面を呼ぶ（RenderSystem.callScene。常駐のボタンの call=）。ページでクリックを待っているときと、選択肢を
   * 出しているとき（戻ったら選択肢を出し直す）に呼べ、呼んだら true。同じプレイの続きとして、履歴、選択肢の控え、temp の変数は残す。
   */
  callScene?(target: string): Promise<boolean>;
  /** 本文の外で出したもの（章の扉の題など）を、すぐにスクリーンリーダーとテキスト読み上げに渡す（RenderSystem.announce）。 */
  announce?(text: string): void;
  /** はい／いいえを尋ねる（RenderSystem.ask。標準の命令の画面が使う）。 */
  ask?(message: string, kind?: string): Promise<boolean>;
  /** 開発中に liminalia.json の ui が変わった（project.ui は書き換え済み）。タイトル画面などを描き直す。 */
  uiChanged?(): void;
  /**
   * シナリオからの要求（@auto・@skip・@open-screen など）を受ける。処理したら true。
   * 画面を開く要求なら、閉じるまで解決しない（シナリオはそれまで止まる）。省略すると描画側の既定の動きになる。
   */
  request?(req: SystemRequest): boolean | Promise<boolean>;
}

export type SystemFactory = (env: SystemEnv) => SystemController;

/** シナリオからシステム画面への要求になる命令（引数は命令の仕様どおり。docs/commands.md）。 */
export const SYSTEM_REQUESTS = [
  "auto",
  "skip",
  "open-screen",
  "menu-button",
  "shortcuts",
  "config",
  "fullscreen",
  "quit",
  "title-screen",
  "window-title",
  "presence",
  "open-url",
  "autosave",
  "autoload",
  "backlog",
  "backlog-add",
  "replay-end",
  "achieve",
  "achieve-progress",
  "check-update",
  "purchase",
  "restore-purchases",
] as const;

/**
 * シナリオからシステム画面への要求（@auto start・@open-screen save など）。
 * SystemController.request が true を返せば処理したものとし、false なら描画側の最小の既定の動きになる
 * （skip は早送り、config は音量と文字の速さ、fullscreen・quit・window-title・open-url はブラウザの機能。
 * それ以外の画面を開く要求やオートセーブは、既定では何もしない）。
 */
export interface SystemRequest {
  name: (typeof SYSTEM_REQUESTS)[number];
  args: Record<string, Value>;
}

/** デスクトップ版のセーブの書き込みの結果（code は OS の誤りの名前。EPERM、ENOSPC など）。 */
export type DesktopWriteResult = { ok: true } | { ok: false; code: string; message: string };

declare global {
  interface Window {
    /** デスクトップ版の preload が置く。achievement は実績を Steam へ送る（Steam につながっていなければ何もしない）。 */
    liminaliaDesktop?: {
      platform: string;
      achievement?(id: string): void;
      /** 数を数える実績の進み具合を店へ送る（Steam は build.steam.stats で結んだ統計の値にする）。 */
      achievementProgress?(id: string, value: number, goal: number): void;
      setFullscreen?(on: boolean): void;
      /** 起動したときに全画面か（前に全画面で終えたとき、ウィンドウを出す前に全画面にする）。 */
      fullscreenAtStart?: boolean;
      /** ウィンドウの中（ゲーム画面）をゲームの大きさの scale 倍にする（0 ははじめの大きさ。画面に収まらなければ縮める）。 */
      setWindowScale?(scale: number): void;
      /** 前に終えたときのウィンドウの位置と大きさを当てて起動したか（そのときは、設定のウィンドウの大きさを起動したときに当て直さない）。 */
      windowRestored?: boolean;
      onFullscreen?(listener: (on: boolean) => void): void;
      /** 最小化した（false）・戻した（true）。 */
      onWindowVisible?(listener: (visible: boolean) => void): void;
      /** 最小化したときに描画と時計を絞るか（最小化しても鳴らし続けるときは絞らない）。 */
      setBackgroundThrottling?(on: boolean): void;
      /** 画面のスリープを止める（true）・戻す（false）。オート中と動画の再生中。 */
      keepAwake?(on: boolean): void;
      /** 遊ぶ言語を知らせる（Mac のメニューの文言を合わせる。作品が言語を決めていなければ空）。 */
      setLanguage?(language: string): void;
      packs?(): Promise<string[]>;
      /**
       * セーブのファイル（保存先の saves/。load は起動したときに全部を同期で読む）。書くのと消すのは後で行い、済んだら結果を返す
       * （書けなければ ok が false。前の版の殻は何も返さない）。
       */
      storage?: { load(): Record<string, string>; set(key: string, value: string): void | Promise<DesktopWriteResult>; remove(key: string): void | Promise<DesktopWriteResult> };
      /**
       * Steam の画面のキーボード（Steam Deck かゲームパッドで遊んでいるとき）で文字を打ってもらう。打った文字、やめたか使えなければ null。
       * 使えないとき（Steam につながっていない・キーボードとマウスで遊んでいる）は無い。
       */
      gamepadText?(o: { description: string; max: number; text: string }): Promise<string | null>;
      /** 画面写真を撮って、写真のフォルダの <題名>/ に置く（置いたパス）。 */
      screenshot?(): Promise<string>;
      /** 止まったときの記録を保存先の logs/ に書く。 */
      crash?(text: string): void;
      /** スリープを止める・戻す（オート中と動画の再生中。main の powerSaveBlocker。無ければブラウザの Screen Wake Lock）。 */
      keepAwake?(on: boolean): void;
      /** Steam の在席表示（Rich Presence）を出す。空なら消す。 */
      presence?(text: string): void;
      /** 別のアプリ（体験版など。題名 title・作品の id）のセーブを、書き出したものの形で読む（無ければ null）。 */
      carry?(from: { id: string; title: string }): Promise<{ project: string; entries: Record<string, string> } | null>;
      /** アップデートの確認と適用（liminalia.json の build.update があるときだけ。system/update.ts）。 */
      update?: DesktopUpdate;
      /** 店（Steam の DLC か、作品のプラグインの店）の購入（store.ts）。 */
      store?: StoreBridge;
      /** 店のコントローラーの操作（Steam Input のアクションを結んだもの。押したときと離したとき。store-input.ts）。 */
      onInputAction?(listener: (action: string, pressed: boolean) => void): void;
      /**
       * ウィンドウを閉じる前（終了・閉じるボタン・Cmd+Q）に呼ぶ。済んだら（Promise なら解決したら）閉じる。
       * 2 秒たっても済まなければそのまま閉じる。
       */
      onBeforeClose?(listener: () => void | Promise<void>): void;
    };
    /** スマホ版のアプリが置く店の口（iOS の StoreKit 2、Android の Google Play Billing。store.ts）。 */
    liminaliaStore?: StoreBridge;
    /** 撮影・自動確認が使う（プレイヤーが置く）。 */
    __liminalia?: {
      host: DomHost;
      system: SystemController;
      runtime: () => SystemController["runtime"];
      pages: () => number;
      screen: () => { mode: string; screen: string | null };
      /** 撮ってよいか（作品が host.holdShot() で止めていない）。 */
      shotReady: () => boolean;
      /**
       * 撮影（lim shot。?autoplay=shot で開いたとき）が撮ってよいか。skip は ?skip= と同じ（撮るページの番号）。
       * ready は撮れる所（page: skip ページ目のクリック待ち、choice: 選択肢、input: 操作待ちの画面、end: 終わった）。
       * blocked は撮る所より前の選択肢で止まっている（撮影は選ばない）。まだなら null。
       */
      shotState?: (skip: number) => { ready: "page" | "choice" | "input" | "end"; pages: number } | { blocked: "choice"; pages: number } | null;
      ended: boolean;
      /** 裏へ回る前に呼ぶ（スマホ版のアプリが onPause・sceneWillResignActive で。SystemController.leave）。保存先に入るまで待つ Promise を返す。 */
      leave?: () => void | Promise<void>;
      /** 書いたセーブが保存先（IndexedDB）に入るまで待つ。 */
      flushSaves?: () => Promise<void>;
      /** 戻る（Android のアプリの戻るボタンとなぞり、スマホのブラウザの戻る）。入力の枠、SystemController.back の順に渡す。扱ったら true。 */
      back?: () => boolean;
      /** セーブの置き場所を覗く・書き換える（撮影・自動確認と開発の道具。system/storage.ts の saveStoreTools）。 */
      saves?: ReturnType<typeof import("./system/storage.ts").saveStoreTools>;
      /** 新しい版が置かれていないか今すぐ確かめる（書き出したブラウザ版。build-watch.ts）。あれば知らせて true。 */
      checkBuild?: () => Promise<boolean>;
    };
  }
}
