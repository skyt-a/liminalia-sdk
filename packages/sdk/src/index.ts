export { t, toImplementation, toSpec, type CommandDefinition, type CommandDiagnostic, type CommandValidateContext, type ParamDefinition } from "./command.ts";
export { checkDeclaredData, d, dataDeclarations, declaredData, pluginDataCg, projectDataTexts } from "./data.ts";
export { apiSatisfies, checkPluginManifest, combinePlugins, commandArgs, dataKeys, defineCommandPlugin, engineMismatches, PLUGIN_API_VERSION, pluginWrittenVariables, runPluginChecks, undeclaredOverrides, type CommandPlugin, type PluginCheckProject, type PluginDiagnostic, type PluginFunction } from "./plugin.ts";
export { defineState, type PluginState } from "./state.ts";
// 作品全体の検査（lim check、制作画面、VS Code、MCP が同じ入力から同じ一覧を作る）
export { packTranslationScope, parsePacks, pluginTargetHooks, projectDiagnostics, type PackCheckSource, type ParsedPack, type ProjectCheckConfig, type ProjectCheckInput } from "./project-check.ts";
// ルール画像の切り替え（rule・pattern・vague）の引数。作品の命令でも同じ書き方で受けられる
export { RULE_PARAMS, RULE_PATTERNS } from "@liminalia/lang";
// 命令の定義に英語を重ねる（名前 → { summary, params, keywords, example } の表から summaryEn、docEn、keywordsEn、exampleEn を付ける）
export { withEnglish, type CommandEnglish } from "@liminalia/lang";
