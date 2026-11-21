export type * from "./ast.ts";
export { TEXT_EFFECTS, TEXT_VARIANTS } from "./ast.ts";
export { GUARD_PARAM } from "./registry.ts";
export { parseScenarioTests, renameInScenarioTests, SCENARIO_TEST_EXTENSION, type ScenarioTest, type ScenarioTestRename, type TestExpectation } from "./scenario-test.ts";
export { checkFormat, migrateCommandDefaults, migrateSource, RENAMED_COMMANDS, RENAMED_PARAMS, renamedParam, SCRIPT_FORMAT, type MigrationChange } from "./migrate.ts";
export {
  checkEndings,
  countEndings,
  ENDING_KIND_LABELS,
  ENDING_KIND_NAME,
  ENDING_KINDS,
  endingAchievements,
  endingKindLabel,
  endingKindOfText,
  endingKinds,
  endingLabel,
  endingMatches,
  endingRecordKey,
  endingRef,
  ENDINGS_KEY,
  endingSitesIn,
  endingValueText,
  legacyEndingText,
  migrateEndingSource,
  migrateEndingValue,
  OTHER_ENDING,
  queryKind,
  type EndingChange,
  type EndingCheckInput,
  type EndingKinds,
  type EndingMigration,
  type EndingRef,
  type EndingSite,
} from "./endings.ts";
export { applyFix, applyLinesFix, commandShape, squeezeLine } from "./fix.ts";
export { sceneChangeCandidates } from "./scene-change.ts";
export { aozoraToRuby, applyProse, proseDocument, proseEntries, proseLineHash, readProseDocument, rubyToAozora, scriptExportHtml, scriptExportLines, scriptExportText, type ProseApplyResult, type ProseEntry, type ProseRuby, type ScriptExportFormat, type ScriptExportLine } from "./proofread.ts";
export { parse, NAME_PATTERN, speakerWithName, takeGuard, isDraftSource, setDraftSource, DRAFT_LINE, type ParseOptions } from "./parser.ts";
export { isSpeechOpener, isSpeechQuote, SPEECH_BRACKETS, SPEECH_CLOSE, SPEECH_OPENERS, SPEECH_QUOTES, speechLine, speechOpenAt, stripSpeechQuotes, unquoteSpeech } from "./speech.ts";
export { booleanShorthandConflicts, normalizeBooleanArgs, parseArgs, parseLiteral, parseTargetText, printLiteral, replaceArgumentValue, paramLocalName, VARIABLE_PATH, type ArgError } from "./args.ts";
export { childExprs, formatExpr, parseExpr, rootNames, ExprError, FORBIDDEN_PROPERTIES, forbiddenProperties } from "./expr.ts";
export { checkVariableNames, ENGINE_VARIABLES, isVariablePath, renameVariableInLine, variablePaths, variableUses, VARIABLE_SCOPES, type VariableCheckOptions, type VariableScope, type VariableUse } from "./variables.ts";
export { parseInline, printInline, plainText, type InlineError } from "./inline.ts";
export { opensBody, parseCredits, type CreditLine } from "./credits.ts";
export { chapterHeading, chapterOf, checkChapters, checkChapterUse, extraWithChapters, type ChapterInfo, type ChapterUseInput } from "./chapters.ts";
export { callsIn, checkStoryCalls, expressionsIn, optionTexts, storyCalls } from "./story.ts";
export { check, defineSpec, markedSpeech, nearName, runtimeDiagnostic, typoDistance, type CheckContext } from "./check.ts";
export { RUNTIME_QUIET, RUNTIME_REPORTED } from "./runtime-codes.ts";
export { applyCommandDefaults, checkCommandDefaults, projectMacros, withCommandDefaults, type CommandDefaults } from "./command-defaults.ts";
export { markShownCast } from "./macro-shown.ts";
export { DIAGNOSTIC_CODES_EN, englishDiagnostic, translateDiagnosticText } from "./diagnostics-en.ts";
export { UI_THEMES, applyUiTheme, themeFitsScreen, themesForScreen, uiThemeLook, uiThemeValues, type UiThemeLook, type UiThemePreset, type UiThemeValues } from "./themes/index.ts";
export { COMMAND_CATEGORIES, COMMAND_GROUPS, COMMAND_META, commandCategory, previewLine, type CommandCategory, type CommandMeta, type CommandPreview } from "./command-meta.ts";
export { checkProject, targetCandidates, type ProjectFileCheckCache } from "./project.ts";
export { resolveTargetText, targetSiteAt, targetSitesOf, type TargetFiles, type TargetPlace, type TargetSite } from "./goto.ts";
export { formatLim, indentUnit, type FormatOptions, type FormatResult } from "./format.ts";
export { checkVoiceLock, PACK_COMBINATION_LIMIT, packCombinations, playSets, skippedPlaySets, updateVoiceLock, voiceAutoSettings, voiceFile, voiceLines, type PackScripts, type VoiceLine, type VoiceLock, type VoiceLockEntry, type VoiceLockUpdate } from "./voice-lock.ts";
export { assetReferences, castAssetReferences, dynamicAssetReferences, inlineAssetSites, SCRIPT_ASSET_FORMS, type AssetReference, type DynamicAssetReference, type InlineAssetSite, type ScriptAssetForm } from "./assets.ts";
export { checkDraftStarts, checkFlow, checkUnusedSpeakersConfig, configTargets, unusedSpeakersConfig, type FlowCheckInput } from "./flow-check.ts";
export { checkCommandLints, FILTER_ONLY_EFFECTS, FLASH_LIMIT } from "./command-lint.ts";
export { checkSpriteFlicker, FLICKER_CHAIN, FLICKER_CHAIN_LINES, FLICKER_RESHOW_LINES } from "./sprite-flicker.ts";
export { isSuggestion, SUGGESTION_CODES } from "./suggestions.ts";
export { BOM, encodingDiagnostic, notUtf8StopMessage, scenarioEncoding, splitBom, stripBom } from "./encoding.ts";
export { configValueProblems, jsonSyntaxError, lineColumn, placeConfigLines, readConfigJson, unknownConfigKeys, VARIABLE_KEY, type JsonSchema } from "./config-check.ts";
export { assetNameResolver, dynamicAssetUses, isLfsPointer, LFS_HEAD_BYTES, missingAssets, referencedAssetKeys, unexportedAssets, type AssetSources, type MissingAssetSources, missingAssetHint, nearestAsset } from "./missing-assets.ts";
export { extensionOf, MEDIA_EXTENSIONS, MEDIA_TYPES, mediaKindOf, type MediaKind } from "./media.ts";
export { escapeHtml, fillHtml, htmlPosition, HTML_ATTRIBUTES, HTML_TAGS, HTML_VOID_TAGS, scanHtml, type HtmlIssue, type HtmlJump, type HtmlScan, type HtmlSource, type HtmlValue } from "./html.ts";
export {
  checkTranslation,
  collectAllTranslatable,
  collectProjectTexts,
  collectTranslatable,
  contextAt,
  displayNames,
  LANGUAGE_NAMES,
  lineIdKey,
  lineIdOfKey,
  listsUiTexts,
  PROJECT_TEXT_FILE,
  projectTextKey,
  dataTextKey,
  DATA_TEXT_PREFIX,
  translatableOccurrences,
  translationKey,
  translationKeyKind,
  translatableSetValue,
  uiTranslationText,
  updateTranslation,
  type Translatable,
  type TranslatableKind,
  type TranslatableOccurrence,
  type TranslationEntry,
  type TranslationFile,
  type TranslationSources,
  type TranslationUpdate,
  type UiSourceText,
  type UiTranslation,
} from "./i18n.ts";
export { LINE_ID_PATTERN, lineIdsOf, linesWithoutId, moveTranslationKeys, moveVoiceLockKeys, splitLineId, stampLineIds, translationKeyMoves, voiceKeyMoves, type KeyMove } from "./line-ids.ts";
export { mapProjectTexts, projectTexts, type ProjectTextSource } from "./project-texts.ts";
export {
  autosaveSlotCount,
  autosaveTimings,
  UI_SOUND_KINDS,
  type UiAutosaveOn,
  type UiSoundKind,
  type UiSounds,
  quickSlotCount,
  QUICK_SLOTS,
  backlogPages,
  checkUi,
  keysFor,
  resolveKeys,
  saveSlotCount,
  uiAssetReferences,
  uiForLanguage,
  UI_LANGUAGE_GROUPS,
  type UiLanguageOverride,
  systemVoiceEntries,
  BACKLOG_PAGES,
  DEFAULT_KEYS,
  SAVE_SLOTS,
  AUTOSAVE_SLOTS,
  UI_KEY_ACTIONS,
  MENU_BAR_ITEMS,
  isScreenMenuItem,
  DEFAULT_MENU_BAR_ITEMS,
  MENU_BAR_POSITIONS,
  INDICATOR_POSITIONS,
  SYSTEM_IMAGE_KEYS,
  type MenuBarItem,
  type UiMenuBar,
  type UiFont,
  type UiImageSlice,
  type UiTitleMenu,
  type UiChoice,
  type UiConfig,
  type UiAutosave,
  type UiDefaults,
  type UiRollback,
  type UiSettings,
  type UiGlyph,
  type UiKeyAction,
  type UiMessage,
  type UiName,
  type UiSystem,
  type UiSystemImages,
  type UiText,
  type UiFace,
  type UiChara,
  type SpriteFocusMode,
  SPRITE_FOCUS_MODES,
  type UiHelpPage,
  type UiTone,
  type UiTitleVariant,
  resolveTitle,
  chatDialogueOption,
  CHAT_NAME_MODES,
  CHOICE_POSITIONS,
  type UiChat,
  type UiEnding,
  type UiChapter,
  type UiNvl,
  NVL_VALIGNS,
  ENDING_MARK_PLACES,
  type UiTitle,
  type UiSystemVoice,
  type UiSplash,
  type UiVoiceEntry,
} from "./ui.ts";
export { checkScreenTemplates, readScreenTemplate, SCREEN_SCRIPT_API, screenScriptFile, screenTemplateFile, type PluginScreens, type ScreenTemplateCheckInput, type ScreenTemplateRules, type StandardScreen } from "./screen-templates.ts";
export {
  checkData,
  checkDataFlags,
  dataCgImages,
  dataPointer,
  dataTranslatables,
  type DataText,
  dataReferences,
  flagPath,
  jsonLines,
  mergeJson,
  renameInData,
  sceneOf,
  scriptLabels,
  walkData,
  type DataCheckEnv,
  type DataDeclaration,
  type DataField,
  type DataFieldKind,
  type DataPath,
  type DataReferences,
  type DataRename,
  type DataVisit,
  type DeclaredData,
  dataFlagsSet,
} from "./data-schema.ts";
export { checkProjectRules, PROJECT_RULES, type ProjectRule, type RuleSeverity, type SceneInfo } from "./rules.ts";
export { checkSeverityConfig, ignoreLineEdit, severityConfig, SEVERITY_LEVELS, suppressDiagnostics, type SeverityConfig, type SeverityLevel, type SuppressOptions } from "./suppress.ts";
export { checkSound, DEFAULT_SILENCE_LINES, SOUND_CHECKS, soundStarts, type SoundCheckConfig, type SoundCheckInput } from "./sound-check.ts";
export { cgMatcher, cgParams, cgReferences, cgShown, commandText, redundantCgUnlocks, unlockOf, unshownCg, type CgImage, type CgMatcher } from "./cg.ts";
export { achievementGoals, checkAfterLoad, checkExtra, expandExtra, extraAssetReferences, shownImages, type ExtraAchievement, type ExtraCg, type ExtraCgAuto, type ExtraConfig, type ExtraChapter, type ExtraFlowchart, type ExtraGlossary, type ExtraMusic, type ExtraReplay, type ExtraCharacter, type ExtraMovie } from "./extra.ts";
export { DEFAULT_SCREEN, PORTRAIT_SCREEN, isPortrait, uiBaseSize, uiScale, uiSpace, screenAspect, positionCenters, portraitSpriteScale, type ScreenSize } from "./screen.ts";
export {
  appearanceKey,
  castProblems,
  castWarnings,
  castModelProblems,
  BUILTIN_MODEL_TYPES,
  OFFICIAL_MODEL_TYPES,
  baseVariant,
  spriteProblem,
  flipAxisRatio,
  framePosition,
  frameSize,
  positionNames,
  resolveVariant,
  variantLayers,
  variantPreview,
  variantFace,
  castForSpeaker,
  AUTO_POSITION,
  DEFAULT_APPEARANCE,
  DEFAULT_FRAME_SIZE,
  FRAME_POSITIONS,
  type Cast,
  type CastAppearance,
  type CastEntry,
  type CastFrame,
  type CastLayer,
  type CastModel,
  type CastPosition,
  type CastVariant,
  type FaceRect,
} from "./cast.ts";
export {
  assignAutoSlots,
  autoLayoutKeepsSlots,
  autoLayoutName,
  autoLayoutPosition,
  autoLayoutPositionNames,
  autoLayoutRules,
  autoLayoutSlots,
  byCountPosition,
  byCountTarget,
  castSideProblems,
  castSides,
  checkAutoLayout,
  layoutPercent,
  shownPositions,
  castPositionCheck,
  type AutoLayoutContext,
  type AutoLayoutEnter,
  type AutoLayoutExit,
  type AutoLayoutRules,
  type AutoLayoutSide,
  type AutoSlot,
} from "./auto-layout.ts";
export {
  addAppearance,
  addCharacter,
  applyLayers,
  addPosition,
  cloneFrame,
  ensureFrame,
  folderOf,
  frameFromNatural,
  framePositionNames,
  imageExtension,
  imageFileName,
  initialFrameAlone,
  initialFrameFromReference,
  normalizeKey,
  opaqueBounds,
  positionOf,
  referenceVariantKey,
  removeAppearance,
  sanitizeFileBase,
  SPRITE_IMAGE_EXTENSIONS,
  uniqueKey,
  type Bounds,
  type FullFrame,
  type ImageInfo,
  type Size,
} from "./cast-edit.ts";
export { estimateFace } from "./face-fit.ts";
export { applyHeadFrames, estimateHead, fitFrameToHead, headImage, headImages, headReference, imageContentHash, planHeadAlign, savedHeadMark, validHeadMark, type HeadAlignResult, type HeadMark, type HeadSkipReason } from "./head-fit.ts";
export {
  CHOICE_OPTION,
  CHOICE_BLOCK,
  CORE_COMMANDS,
  CORE_FUNCTIONS,
  FUNCTION_ARITY,
  functionArity,
  knownFunctions,
  setPluginFunctions,
  PLUGIN_API_VERSION,
  STORY_FUNCTIONS,
  TARGET_FUNCTIONS,
  READ_KEY,
  FUNCTION_DOCS,
  FUNCTION_USAGE,
  CAMERA_EASINGS,
  RULE_PARAMS,
  RULE_PATTERNS,
  SKIP_PARAM,
  arityText,
  createRegistry,
  paramTypeFromName,
  DEFINE_TYPE_NAMES,
  type CommandSpec,
  type ParamSpec,
  type ParamType,
  type Registry,
} from "./registry.ts";
export { CHOICE_EN, CORE_COMMANDS_EN, FUNCTION_DOCS_EN, FUNCTION_USAGE_EN, commandExample, commandSummary, englishGaps, paramDoc, withCommandEnglish, withEnglish, type CommandEnglish } from "./registry-en.ts";
export { checkVerticalFont, fontTables } from "./font-tables.ts";
export { buildStoryMap, clip as clipStoryText, promisedTargets, type MapEdge, type MapNode, type StoryMap, type StoryMapInput, type TargetHook } from "./story-map.ts";
export { buildFlow, type Flow, type FlowLink, type FlowScene } from "./flow.ts";
export { pageKeys } from "./page-keys.ts";
export { autoVoicedLines } from "./voice-lock.ts";
export { noteStart, parseCsv, toCsv, voiceRowKey, voiceScript, voiceScriptRows, type VoiceNoteStyle, type VoiceScriptInput, type VoiceScriptRow } from "./voice-script.ts";
export { imageSize } from "./image-size.ts";
export { readLoopTags } from "./loop-tags.ts";
export {
  applyTranslationEntries,
  applyTranslationTable,
  exchangeContext,
  translationCount,
  translationToCsv,
  translationToXliff,
  type ExchangeAt,
  type ExchangeContext,
  type ExchangeOptions,
  type ExchangeRejected,
  type ExchangeResult,
} from "./i18n-exchange.ts";
export { mergePackExtra, sortPacks, type PackManifest } from "./pack.ts";
export { countChars, textStats, textUnits, type FileStats, type SceneStats, type SpeakerStats, type StatsRow, type TextCount, type TextStats, type TextUnit } from "./text-stats.ts";
export { checkPunctuation, PUNCTUATION_CODES, punctuationCodes, punctuationProblems, type PunctuationCode, type PunctuationConfig } from "./punctuation.ts";
export { BUILTIN_VARIANTS, findVariants, mergeVariantDictionaries, normalizeName, VARIANT_KINDS, type VariantDictionary, type VariantForm, type VariantGroup, type VariantKind, type VariantOccurrence, type VariantReplace } from "./text-variants.ts";
export { checkNvlStyles, uiParamNames } from "./nvl-style.ts";
export { checkUiCss, cssRuleValue, resolveCssReference, rewriteCssReferences, scanCss, setCssRule, setCssRules, uiCssFiles, uiCssPathProblem, UI_CSS_DEFAULT, type CssReference, type CssRuleEdit, type CssSyntaxProblem, type ProjectFiles } from "./ui-css.ts";
export { BUILTIN_TONES, IDENTITY_MATRIX, backgroundToneName, checkTones, findTone, mixMatrix, spriteToneName, toneMatrix, type GivenBackgroundTone } from "./tone.ts";
export { checkItems, itemAssetReferences, ITEMS_KEY, type ItemDef, type ItemsConfig } from "./items.ts";
export { hash as textHash, similarity as textSimilarity } from "./text-hash.ts";
