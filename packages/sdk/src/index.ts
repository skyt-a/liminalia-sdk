/**
 * Liminalia のプラグインを書くための約束（MIT）。命令のプラグイン（"./commands"）はここ、描画（"./web"）は @liminalia/sdk/web、
 * 制作画面（"./studio"、"./studio-server"）は @liminalia/sdk/studio と @liminalia/sdk/studio-server、取り込み（"./import"）は
 * @liminalia/sdk/import、標準の命令の部品は @liminalia/sdk/std から読む。
 * 実装は lim と Liminalia Studio の側にあり、プラグインはその中で動く。テストは @liminalia/cli/testing で台本を読んで動かせる。
 */
export { t, type CommandDefinition, type CommandDiagnostic, type CommandValidateContext, type ParamDefinition } from "./command.ts";
export { d } from "./data.ts";
export { PLUGIN_API_VERSION, RULE_PARAMS, RULE_PATTERNS, SKIP_PARAM, withCommandEnglish, withEnglish, type CommandEnglish, type EnglishTarget } from "./lang.ts";
export { defineCommandPlugin, type CommandPlugin, type PluginCheckProject, type PluginDiagnostic, type PluginFunction } from "./plugin.ts";
export { defineState, type PluginState } from "./state.ts";

import { forwardFunction } from "./host.ts";
import type * as Runtime from "@liminalia/runtime";
/** 訳した文字を引数で受けた命令が、その原文の元（訳のファイルの鍵）を受け取る（言語を替えたときに訳し直すため）。実行器の実装を呼ぶ。 */
export const argOrigin = forwardFunction<typeof Runtime.argOrigin>("runtime", "argOrigin");
/** 原文の元を、stage.extra に置く値の i18n の欄にまとめる。実行器の実装を呼ぶ。 */
export const textOrigins = forwardFunction<typeof Runtime.textOrigins>("runtime", "textOrigins");

// 命令の定義と実行に出てくる型（@liminalia/lang と @liminalia/runtime のもの）
export type {
  Argument,
  Cast,
  CastAppearance,
  CastEntry,
  CastFrame,
  CastModel,
  CastVariant,
  CommandSpec,
  DataDeclaration,
  DataField,
  Diagnostic,
  DiagnosticFix,
  ParamSpec,
  ParamType,
  Registry,
  Script,
  Statement,
} from "@liminalia/lang";
export type { Args, CommandContext, StageState, TextOrigin, Value } from "@liminalia/runtime";
