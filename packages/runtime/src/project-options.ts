import { achievementGoals, autoLayoutRules, cgMatcher, chatDialogueOption, endingAchievements, uiForLanguage, type CastEntry, type ChapterInfo, type CommandDefaults, type ExtraConfig, type UiConfig, type VoiceLock } from "@liminalia/lang";
import type { CommandImpl, RuntimeOptions, Translator } from "./runtime.ts";
import type { Value } from "./value.ts";

/**
 * 作品の設定から実行器の設定（RuntimeOptions）を作る。遊ぶ側（packages/web）と、画面なしで流すもの（lim trace、lim test、lim coverage、
 * lim reach、lim build --seed、lim voice-lock、制作画面の現在地と全ルートテスト、VS Code の「ここからテストプレイ」）は、どれもこれで作り、
 * 流し方で変えるもの（RUNTIME_OPTION_OWNERS で caller にしたもの）だけを呼ぶ側が足す。片方にだけ作品の設定を渡して、
 * 同じ台本を流した結果が食い違う（自動配置が外れる、言語や章や版で分かれる先が違う、台詞の括弧やボイスの番号が違う）ことを防ぐ。
 */

/**
 * 実行器の設定の一つ一つを、だれが決めるか。
 * - "project": projectRuntimeOptions が作品の設定から埋める
 * - { caller }: 呼ぶ側が決める（その理由）
 * 実行器の設定を足したら、ここで分けるまで型の確かめが通らない（project-options.test.ts は、関数が埋める項目がここの "project" と
 * ちょうど同じことを見る）。
 */
export const RUNTIME_OPTION_OWNERS = {
  speakers: "project",
  commands: "project",
  commandDefaults: "project",
  variables: "project",
  afterLoad: "project",
  gameVersion: "project",
  chapters: "project",
  achievementGoals: "project",
  endingAchievements: "project",
  endingKinds: "project",
  cast: "project",
  autoLayout: "project",
  voiceLock: "project",
  cg: "project",
  chatDialogue: "project",
  stripQuotes: "project",
  language: "project",
  translator: "project",
  loadData: "project",
  seed: { caller: "乱数の種。遊ぶ側は決めず、台本のテストと網羅は回ごとに決める" },
  maxSteps: { caller: "命令の数の上限。流し方ごとに、終わらない繰り返しで止める所が違う" },
  onError: { caller: "実行時のエラーで止めるか。遊ぶ側と画面なしの流しは続けて知らせる（continue）が、実行器の既定は止める" },
  returnWithoutCall: { caller: "呼ばれていない @return の扱い。網羅のファイルごとの流しだけが、@call で呼ぶだけのファイルを先頭から流すので続ける" },
  onAssign: { caller: "変数を入れたときの知らせ。制作画面が値を決めた行を控えるためのもので、流し方が使う" },
  onStep: { caller: "命令の前の知らせ。網羅と台本のテストが通った行を数えるためのもので、流し方が使う" },
  beforeStep: { caller: "命令の前で待つ。遊ぶ側の作品の画面とブレークポイントだけが使う" },
  programCache: { caller: "読んだ台本の控え。遊ぶ側が一回のプレイを作り直しても読み解き直さないためのもので、流し方が持つ" },
  platform: { caller: "遊んでいる機種。遊ぶ側は調べて入れ、画面なしの流しは省いてパソコンのブラウザとする" },
} as const satisfies { readonly [K in keyof Required<RuntimeOptions>]: "project" | { readonly caller: string } };

type ProjectKey = { [K in keyof typeof RUNTIME_OPTION_OWNERS]: (typeof RUNTIME_OPTION_OWNERS)[K] extends "project" ? K : never }[keyof typeof RUNTIME_OPTION_OWNERS];

/** projectRuntimeOptions が埋める実行器の設定。 */
export type ProjectRuntimeOptions = Pick<RuntimeOptions, ProjectKey>;

/** 作品の設定（liminalia.json）の、実行器に効く項目。読んだ JSON のままでよい（形の違う値は使わない。lim check が知らせる）。 */
export interface ProjectRuntimeConfig {
  version?: unknown;
  variables?: unknown;
  afterLoad?: unknown;
  commandDefaults?: unknown;
  chapters?: unknown;
  extra?: unknown;
  endingKinds?: unknown;
  autoLayout?: unknown;
  ui?: unknown;
  languages?: unknown;
}

/** 実行器の設定を作る元。ファイルを読むのは呼ぶ側（ブラウザでも Node でも使うため）。 */
export interface ProjectRuntimeSource {
  config: ProjectRuntimeConfig;
  /** 話者（cast.json の speakers）。 */
  speakers: Iterable<string>;
  /** 組み込みの外の命令（標準の命令と、作品のプラグインの命令）。 */
  commands: readonly CommandImpl[];
  /** キャストの定義（cast.json の cast）。 */
  cast: Readonly<Record<string, CastEntry>> | Readonly<Record<string, unknown>>;
  /** 連番のボイスの番号の固定（voice-lock.json。無い・読めなければ null）。 */
  voiceLock?: VoiceLock | null;
  /** 作品のデータを読む（画面なしで流すとき。遊ぶ側は描画側が読むので渡さない）。 */
  loadData?(name: string): unknown;
  /** 遊ぶ言語。省けば原文の言語（languages の先頭。無ければ ""。遊ぶ側が言語を選ばないときと同じ）。 */
  language?: string;
  /** その言語の訳。省けば訳さない（原文の言語で流すとき）。 */
  translator?: Translator | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 作品の設定から実行器の設定を作る（RUNTIME_OPTION_OWNERS で "project" にしたもの）。 */
export function projectRuntimeOptions(src: ProjectRuntimeSource): ProjectRuntimeOptions {
  const c = src.config;
  const extra = isRecord(c.extra) ? (c.extra as ExtraConfig) : undefined;
  const ui = isRecord(c.ui) ? (c.ui as UiConfig) : undefined;
  const languages = Array.isArray(c.languages) ? c.languages : [];
  const language = src.language ?? (typeof languages[0] === "string" ? languages[0] : "");
  const autoLayout = autoLayoutRules(c.autoLayout);
  const cg = cgMatcher(extra);
  const chatDialogue = chatDialogueOption(ui);
  const strip = uiForLanguage(ui, language)?.text?.quotes === "strip";
  return {
    speakers: [...src.speakers],
    commands: [...src.commands],
    cast: src.cast as Readonly<Record<string, CastEntry>>,
    ...(isRecord(c.variables) ? { variables: c.variables as Record<string, Value> } : {}),
    ...(typeof c.afterLoad === "string" && c.afterLoad !== "" ? { afterLoad: c.afterLoad } : {}),
    // 作品の版（セーブに入り、式の save.version で読める。書き出したゲームは project/build.json の版）
    ...(typeof c.version === "string" && c.version !== "" ? { gameVersion: c.version } : {}),
    ...(isRecord(c.commandDefaults) ? { commandDefaults: c.commandDefaults as CommandDefaults } : {}),
    ...(Array.isArray(c.chapters) ? { chapters: c.chapters as ChapterInfo[] } : {}),
    achievementGoals: achievementGoals(extra),
    endingAchievements: endingAchievements(extra),
    ...(isRecord(c.endingKinds) ? { endingKinds: c.endingKinds } : {}),
    ...(autoLayout ? { autoLayout } : {}),
    voiceLock: src.voiceLock ?? null,
    ...(cg ? { cg } : {}),
    ...(chatDialogue ? { chatDialogue } : {}),
    // 台詞の外側の括弧（ui.text.quotes。遊ぶ言語の ui.languages を重ねたもの）
    stripQuotes: () => strip,
    language,
    translator: src.translator ?? null,
    ...(src.loadData ? { loadData: src.loadData } : {}),
  };
}
