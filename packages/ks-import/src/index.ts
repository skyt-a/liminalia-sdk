export type { Command, Diagnostic, LexOptions, Params, RawCommand, ScenarioIR, Severity } from "./types.ts";
export { lex, parseTag } from "./lexer.ts";
export type { LexResult } from "./lexer.ts";
export { compile } from "./compile.ts";
export { convert, ms, bool, color, str, type TagConversion, type TagProfile, type ConvertOptions, type ConvertResult, type ConvertStats, type LineKind, type LineOrigin, type Outcome } from "./convert.ts";
export {
  applyCharaConfig,
  castEntry,
  collectCharaConfig,
  collectCharas,
  speakerName,
  DEFAULT_CHARA_CONFIG,
  type CharaConfig,
  type CharaDef,
  type CharaDefs,
  type KsSource,
} from "./chara.ts";
export { ksValue, mechanicalConversion, tagsByCommand, toProfile, type TagMapping, type TagMappingContext } from "./mapping.ts";
export { combineImportProfiles, resolveImportProfile } from "./profile.ts";
export { STD_IMPORT, STD_MAPPINGS, STD_UNSUPPORTED_TAGS } from "./std-tags/index.ts";
export { applyCastToTatieSettings, castFromTatieSettings, mergeCast, type TatieSettings } from "./tatie.ts";
export { imageSize } from "./image-size.ts";
export { convertJsAssignments, convertJsExpression } from "./js-expr.ts";
export { hasInlineRuby, inlineRubyPlain, splitInlineRuby, type InlineRubyPart } from "./inline-ruby.ts";
// 取り込み（ファイルを読み書きする）は Node 専用の入口 @liminalia/ks-import/node から。ここでは型だけ出す
export type { AfterImportContext, AfterImportResult, ImportOptions, ImportReport, TyranoImportProfile, WriteCastContext } from "./import.ts";

// プラグインの約束（@liminalia/sdk/import）が呼ぶ実装を登録する
import { provide as provideToSdk } from "@liminalia/sdk/host";
import { castFromTatieSettings as castFromTatieSettingsForSdk } from "./tatie.ts";
provideToSdk("import", { castFromTatieSettings: castFromTatieSettingsForSdk });
