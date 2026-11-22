import { forwardClass, forwardFunction } from "./host.ts";
import type * as Plugin from "@liminalia/studio/plugin";

/**
 * 制作画面のプラグイン（作品のプラグインの "./studio"）の約束。定義の関数と型はここにあり、画面の部品（区切り線、データの読み書き、
 * 素材の欄、確かめの窓）は制作画面の実装を呼ぶ。
 */

/** 制作画面のプラグインの口の版。 */
export const STUDIO_PLUGIN_API_VERSION = 4;

/** 制作画面のプラグインを定義する（型を付けるだけ）。 */
export function defineStudioPlugin(plugin: Plugin.StudioPlugin): Plugin.StudioPlugin {
  return plugin;
}

/** 欄の境目をドラッグして幅を変えるつまみ（制作画面の目次・右の欄と同じもの）。 */
export const Splitter = forwardClass<typeof Plugin.Splitter>("studio", "Splitter");
/** 作品のデータを一つの文書として編集する部品（自動で保存・ほかの変更と重ねる・⌘Z）。 */
export const dataDocument = forwardFunction<typeof Plugin.dataDocument>("studio", "dataDocument");
export const mergeJson = forwardFunction<typeof Plugin.mergeJson>("studio", "mergeJson");
/** 素材を選ぶ欄（作品の素材の一覧から候補を出し、画像なら見本を添える）。 */
export const assetField = forwardFunction<typeof Plugin.assetField>("studio", "assetField");
/** 確かめの窓（はい・キャンセル）。 */
export const askConfirm = forwardFunction<typeof Plugin.askConfirm>("studio", "askConfirm");
/** 文字を尋ねる窓。 */
export const askText = forwardFunction<typeof Plugin.askText>("studio", "askText");

export type {
  AssetField,
  AssetFieldOptions,
  AssetSuggestion,
  AssetSuggestRequest,
  DataChangeSource,
  DataDocument,
  DataDocumentOptions,
  ScriptApplyResult,
  ScriptEdit,
  ScriptPosition,
  SplitterOptions,
  StudioCommand,
  StudioContext,
  StudioPane,
  StudioPlugin,
  StudioProject,
  StudioScript,
  StudioServerInit,
  StudioView,
  StudioViewInstance,
} from "@liminalia/studio/plugin";
