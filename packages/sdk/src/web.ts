import { forwardClass, forwardFunction, forwardValue } from "./host.ts";
import type * as Web from "@liminalia/web";
import type * as StdWeb from "@liminalia/std/web";

/**
 * 描画のプラグイン（作品のプラグインの "./web"）の約束。定義の関数と型はここにあり、描画の部品（ui、systemText など）は
 * 遊ぶ画面（書き出したゲームと開発サーバー）の実装を呼ぶ。
 */

/** 描画のプラグインを定義する（型を付けるだけ）。 */
export function defineWebPlugin(plugin: Web.WebPlugin): Web.WebPlugin {
  return plugin;
}

/** 外の JavaScript を読み込む（同じものは一度だけ）。 */
export const loadScript = forwardFunction<typeof Web.loadScript>("web", "loadScript");
/** システム画面の文言（遊ぶ人の言語に合わせたもの）。 */
export const systemText = forwardFunction<typeof Web.systemText>("web", "systemText");
/** 作品のデータの中の、遊ぶ人に見せる文（訳があれば訳）。 */
export const dataText = forwardFunction<typeof Web.dataText>("web", "dataText");
/** 画面の部品（ボタン、選択肢、スライダーなど。システム画面と同じ見た目と操作）。 */
export const ui = forwardValue<typeof Web.ui>("web", "ui");
/** レイヤーの項目（@free-image で消えるもの）の、ロード時の組み立て方を登録する。 */
export const registerLayerItem = forwardFunction<typeof StdWeb.registerLayerItem>("std-web", "registerLayerItem");
export const keepAwake = forwardFunction<typeof Web.keepAwake>("web", "keepAwake");
export const openExternal = forwardFunction<typeof Web.openExternal>("web", "openExternal");
export const vibrate = forwardFunction<typeof Web.vibrate>("web", "vibrate");
export const bindPlayerInput = forwardFunction<typeof Web.bindPlayerInput>("web", "bindPlayerInput");
export const padLabel = forwardFunction<typeof Web.padLabel>("web", "padLabel");
export const findChoiceAhead = forwardFunction<typeof Web.findChoiceAhead>("web", "findChoiceAhead");
export const renderSystem = forwardFunction<typeof Web.renderSystem>("web", "renderSystem");
export const screenActionName = forwardFunction<typeof Web.screenActionName>("web", "screenActionName");
export const ChoiceHistory = forwardClass<typeof Web.ChoiceHistory>("web", "ChoiceHistory");
/** システムの操作の名前（メニューやキーに割り当てられるもの）。 */
export const SYSTEM_ACTIONS = forwardValue<typeof Web.SYSTEM_ACTIONS>("web", "SYSTEM_ACTIONS", "array");
export const SYSTEM_REQUESTS = forwardValue<typeof Web.SYSTEM_REQUESTS>("web", "SYSTEM_REQUESTS", "array");
/** 設定の幅（作品の liminalia.json の ui.settings を当てたもの）。 */
export const SETTING_RANGES = forwardValue<typeof Web.SETTING_RANGES>("web", "SETTING_RANGES");

export type {
  BacklogEntry,
  BacklogScreenApi,
  ButtonHandle,
  ButtonOptions,
  ChoiceAheadOptions,
  ChoiceHandle,
  ChoiceJump,
  ChoiceOptions,
  ChoiceScreenApi,
  ChoiceScreenOption,
  CodexScreenApi,
  CodexScreenCategory,
  CodexScreenEntry,
  Completion,
  CompletionCount,
  ConfigScreenApi,
  ConfirmScreenApi,
  Curtain,
  DefineScreenOptions,
  DialogScreenApi,
  EffectScope,
  EffectScopeOptions,
  EndingScreenApi,
  ExtraScreenApi,
  HelpScreenApi,
  HitArea,
  ImportData,
  IndicatorApi,
  ItemsScreenApi,
  LoadFrom,
  MenuBarApi,
  MenuScreenApi,
  NameScreenApi,
  NameShown,
  NoticeOptions,
  PlayerControls,
  PlayerInput,
  PlayerInputOptions,
  PlayerProject,
  PluginTheme,
  RenderContext,
  RenderEvent,
  RenderEventOf,
  RenderEventType,
  RenderSystem,
  SaveLoadScreenApi,
  ScreenAction,
  ScreenContent,
  ScreenHandle,
  ScreenLifecycle,
  ScreenOptions,
  ScreenScript,
  ScreenScriptApi,
  ScrollbarHandle,
  ScrollbarOptions,
  SeedSave,
  SettingBinding,
  Settings,
  SettingsPatch,
  SliderHandle,
  SliderOptions,
  SlotInfo,
  SlotRef,
  SpritePart,
  SpritePartContext,
  SpritePartFactory,
  SpritePartVariant,
  StandardScreens,
  SystemAction,
  SystemController,
  SystemEnv,
  SystemEvent,
  SystemFactory,
  SystemRequest,
  SystemStatus,
  SystemText,
  TitleApi,
  TitleFactory,
  ToastApi,
  ToggleHandle,
  ToggleOptions,
  Transitions,
  WebPlugin,
} from "@liminalia/web";
