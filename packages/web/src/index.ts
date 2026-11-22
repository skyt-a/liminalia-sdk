export {
  DomHost,
  type AssetKind,
  type CastEntry,
  type CastVariant,
  type DialogueView,
  type DomHostOptions,
  type Extensions,
  type RenderContext,
  type Renderer,
  type Restorer,
  type SpriteTheme,
  type TextTheme,
} from "./dom-host.ts";
export { AudioPlayer } from "./audio.ts";
export { offerLabel, type InputOffer, type OfferByButtons, type OfferByChoice, type OfferedInput } from "./input-offer.ts";
export { createFace, hasFace, type SpritePart, type SpritePartContext, type SpritePartFactory, type SpritePartVariant } from "./sprite-face.ts";
export { loadScript } from "./load-script.ts";
export { cameraTransform } from "./camera.ts";
export { TRANSITION_METHODS, transitionKeyframes, ruleFromImage, ruleFromPattern, ruleTransition, type RuleLevels, type RulePattern } from "./transitions.ts";
export {
  defineWebPlugin,
  PLUGIN_API_VERSION,
  type ScreenLifecycle,
  type PlayerProject,
  SYSTEM_ACTIONS,
  SYSTEM_REQUESTS,
  type SeedSave,
  type SystemAction,
  type ScreenAction,
  type DefineScreenOptions,
  type RenderSystem,
  renderSystem,
  screenActionName,
  type StandardScreens,
  type ConfigScreenApi,
  type SaveLoadScreenApi,
  type BacklogScreenApi,
  type MenuBarApi,
  type IndicatorApi,
  type MenuScreenApi,
  type ConfirmScreenApi,
  type EndingScreenApi,
  type ChoiceScreenApi,
  type ChoiceScreenOption,
  type NameScreenApi,
  type NameShown,
  type DialogScreenApi,
  type HelpScreenApi,
  type ItemsScreenApi,
  type ExtraScreenApi,
  type CodexScreenApi,
  type CodexScreenCategory,
  type CodexScreenEntry,
  type Completion,
  type CompletionCount,
  type SystemStatus,
  type SystemEvent,
  type ImportData,
  type ScreenContent,
  type ScreenHandle,
  type ScreenOptions,
  type BacklogEntry,
  type SlotInfo,
  type SlotRef,
  type SystemController,
  type SystemRequest,
  type SystemEnv,
  type SystemFactory,
  type TitleApi,
  type TitleFactory,
  type WebPlugin,
  type PluginTheme,
  type Transitions,
  type Curtain,
  type LoadFrom,
} from "./plugin.ts";
export { createDefaultSystem } from "./system/default.ts";
export { loadScreenTemplates } from "./system/standard-templates.ts";
export { systemText, type UiText as SystemText } from "./system/strings.ts";
export { dataText } from "./system/translation.ts";
export { keepAwake, openExternal, vibrate } from "./native.ts";
export { ChoiceHistory, findChoiceAhead, hasChoiceAhead, type ChoiceAheadOptions, type ChoiceJump } from "./system/choice-history.ts";
export type { ChoicePoint } from "./system/storage.ts";
export type { ScreenScript, ScreenScriptApi } from "./system/screen-script.ts";
export * as ui from "./ui-parts.ts";
export type { ButtonHandle, ButtonOptions, ChoiceHandle, ChoiceOptions, HitArea, ScrollbarHandle, ScrollbarOptions, SettingBinding, SliderHandle, SliderOptions, ToggleHandle, ToggleOptions } from "./ui-parts.ts";
export type { EffectScope, EffectScopeOptions } from "./render-scope.ts";
export type { RenderEvent, RenderEventOf, RenderEventType } from "./render-events.ts";
export type { HostFonts } from "./host-fonts.ts";
export type { NoticeOptions, ToastApi } from "./notices.ts";
export { DEFAULT_SETTINGS, SETTING_RANGES, type Settings, type SettingsPatch } from "./system/settings.ts";
export type { LogPart } from "./system/backlog.ts";
export { bindPlayerInput, type PlayerControls, type PlayerInput, type PlayerInputOptions } from "./system/input.ts";
export { detectPadStyle, padLabel, PAD_STYLES, type PadStyle } from "./system/pad-names.ts";
export { focusables, GamepadInput, KEYED, keyMatches, navigate, navigateAmong, PLAY_NAV, type Direction, type PadButton } from "./system/navigation.ts";

// プラグインの約束（@liminalia/sdk/web）が呼ぶ描画の実装を登録する（sdk-host.ts。遊ぶ画面の入口 main.ts も読む）
import "./sdk-host.ts";
