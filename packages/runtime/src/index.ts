export { Runtime, type Args, type CommandContext, type CommandImpl, type PickOutcome, type Platform, type ProgramCache, type RunResult, type RuntimeOptions, type StartOptions, type Translator } from "./runtime.ts";
export type { ChoiceLook, CoSpeaker, Host, PresentEvent, TextStyle } from "./host.ts";
export { buildProgram, type Instruction, type Program, type Unit } from "./program.ts";
export { createState, initialStage, toSaveData, voiceFile, type NvlPage, type NvlPart, type VoiceAuto, type VoiceCue, type GameState, type Position, type SaveData, type Snapshot, type Sprite, type StageState, type Balloon, type SceneWait, type SoundOptions, type SoundFilterState } from "./state.ts";
export { CHAT_KEEP, CHAT_KEY, chatDialogueActive, chatPartsText, chatQuoteStripper, clearChatMessages, pushChatMessage, readChat, type Chat, type ChatDialogue, type ChatMessage } from "./chat.ts";
export { argOrigin, textOrigins, I18N_FIELD, type TextOrigin } from "./retranslate.ts";
export { display, equals, evaluate, EvalError, setPluginFunctionImpls, truthy, type Scope, type Value } from "./value.ts";
export { CORE_IMPLEMENTATIONS } from "./commands.ts";
export { HeadlessHost, type HeadlessOptions, type TraceEntry } from "./headless.ts";
export { collectPrefetch, type PrefetchItem } from "./prefetch.ts";
export { capture, explore, findRoute, walk, type Assignments, type ChoiceMade, type Exploration, type ExploreOptions, type FindRouteOptions, type Reached, type Walk, type WalkOptions } from "./route.ts";
export { coverage, DEFAULT_COVERAGE_RUNS, routeCoverage, type CoverageOptions, type CoverageReport, type RouteCoverageOptions, type RouteCoverageReport } from "./coverage.ts";
export { observeVoiceNumbers } from "./voice-observe.ts";
export { projectRuntimeOptions, RUNTIME_OPTION_OWNERS, type ProjectRuntimeConfig, type ProjectRuntimeOptions, type ProjectRuntimeSource } from "./project-options.ts";
export { DEFAULT_TEST_LIMIT, runScenarioTest, type ScenarioTestOptions, type ScenarioTestResult, type TestFailure } from "./scenario-test.ts";
export { migrateSave, migrateWith, saveProblem, SAVE_VERSION, SaveVersionError, type SaveProblem } from "./save.ts";

// プラグインの約束（@liminalia/sdk の argOrigin、textOrigins）が呼ぶ実装を登録する
import { provide as provideToSdk } from "@liminalia/sdk/host";
import { argOrigin as argOriginForSdk, textOrigins as textOriginsForSdk } from "./retranslate.ts";
provideToSdk("runtime", { argOrigin: argOriginForSdk, textOrigins: textOriginsForSdk });
