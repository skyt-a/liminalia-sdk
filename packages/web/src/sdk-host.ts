/**
 * プラグインの約束（@liminalia/sdk/web）が呼ぶ描画の実装を登録する。sdk は約束だけで、実装はここにある。
 * 遊ぶ画面の入口（main.ts）と、描画の入口（index.ts）が読む。プラグインが @liminalia/sdk/web を読んでも、@liminalia/web を読まないことがあるため。
 */
import { provide as provideToSdk } from "@liminalia/sdk/host";
import * as uiPartsForSdk from "./ui-parts.ts";
import { loadScript as loadScriptForSdk } from "./load-script.ts";
import { systemText as systemTextForSdk } from "./system/strings.ts";
import { dataText as dataTextForSdk } from "./system/translation.ts";
import { keepAwake as keepAwakeForSdk, openExternal as openExternalForSdk, vibrate as vibrateForSdk } from "./native.ts";
import { bindPlayerInput as bindPlayerInputForSdk } from "./system/input.ts";
import { padLabel as padLabelForSdk } from "./system/pad-names.ts";
import { ChoiceHistory as ChoiceHistoryForSdk, findChoiceAhead as findChoiceAheadForSdk } from "./system/choice-history.ts";
import { renderSystem as renderSystemForSdk, screenActionName as screenActionNameForSdk, SYSTEM_ACTIONS as SYSTEM_ACTIONS_FOR_SDK, SYSTEM_REQUESTS as SYSTEM_REQUESTS_FOR_SDK } from "./plugin.ts";
import { SETTING_RANGES as SETTING_RANGES_FOR_SDK } from "./system/settings.ts";
provideToSdk("web", {
  loadScript: loadScriptForSdk,
  systemText: systemTextForSdk,
  dataText: dataTextForSdk,
  ui: uiPartsForSdk,
  keepAwake: keepAwakeForSdk,
  openExternal: openExternalForSdk,
  vibrate: vibrateForSdk,
  bindPlayerInput: bindPlayerInputForSdk,
  padLabel: padLabelForSdk,
  findChoiceAhead: findChoiceAheadForSdk,
  renderSystem: renderSystemForSdk,
  screenActionName: screenActionNameForSdk,
  ChoiceHistory: ChoiceHistoryForSdk,
  SYSTEM_ACTIONS: SYSTEM_ACTIONS_FOR_SDK,
  SYSTEM_REQUESTS: SYSTEM_REQUESTS_FOR_SDK,
  SETTING_RANGES: SETTING_RANGES_FOR_SDK,
});
