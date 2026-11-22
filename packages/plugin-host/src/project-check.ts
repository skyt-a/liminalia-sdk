import {
  castModelProblems,
  castProblems,
  castWarnings,
  checkAfterLoad,
  castSideProblems,
  checkAutoLayout,
  checkChapters,
  checkCommandDefaults,
  checkDraftStarts,
  checkEndings,
  checkExtra,
  checkFormat,
  checkItems,
  checkProject,
  checkProjectRules,
  checkScreenTemplates,
  checkSeverityConfig,
  checkSound,
  checkTones,
  checkNvlStyles,
  checkTranslation,
  dataTranslatables,
  checkUnusedSpeakersConfig,
  checkUi,
  checkUiCss,
  checkVerticalFont,
  checkVoiceLock,
  configTargets,
  configValueProblems,
  encodingDiagnostic,
  missingAssets,
  parse,
  placeConfigLines,
  projectMacros,
  promisedTargets,
  readConfigJson,
  soundStarts,
  suppressDiagnostics,
  targetCandidates,
  unusedSpeakersConfig,
  VARIABLE_KEY,
  type Cast,
  type ChapterInfo,
  type Diagnostic,
  type ExtraConfig,
  type JsonSchema,
  type PluginScreens,
  type ProjectTextSource,
  type ProjectFiles,
  type ScreenTemplateRules,
  type PunctuationConfig,
  type ProjectFileCheckCache,
  type Registry,
  type Script,
  type TargetHook,
  type UiConfig,
  type VoiceLock,
} from "@liminalia/lang";
import { declaredData, pluginDataCg } from "./data.ts";
import { pluginWrittenVariables, runPluginChecks, type CommandPlugin } from "./plugin.ts";

/**
 * パック（packs/<フォルダ>/）の台本と訳の中身（@liminalia/project の listPackSources が読むもの）。
 * dir は作品のフォルダからのパス、speakers はパックの cast.json の話者、scripts は台本の名前 → 中身、translations は言語 → 訳のファイルの中身。
 */
export interface PackCheckSource {
  dir: string;
  /** 遊ぶ側の並び（pack.json の order、id）。渡す並びもこの順にする（listPackSources の順）。 */
  id?: string;
  order?: number;
  speakers: readonly string[];
  scripts: ReadonlyMap<string, string>;
  translations: ReadonlyMap<string, string>;
}

/** 読み解いたパック（台本は、本体の話者にパックの cast.json の話者を足して読む。遊ぶ側はパックの cast.json で本体のものを差し替える）。 */
export interface ParsedPack {
  dir: string;
  scripts: Map<string, Script>;
  translations: ReadonlyMap<string, string>;
}

/**
 * その言語の訳のファイル（owner が無ければ本体の lang、あればそのパックの lang）と一緒に遊ばれるパックの台本。遊ぶ側は、入っているパックのうち
 * 並びの最後でその言語の訳を持つもの（無ければ本体）の訳を、すべての台本に使う。遊ぶ人はパックのどの組み合わせでも入れうるので、
 * その訳が使われる組み合わせ（owner を入れ、owner より後ろで訳を持つパックを入れない組）のどれかで出る台本を shown にする
 * （組み合わせを並べずに、台本の持ち主と owner だけを入れた組で決める。パックの数によらずすべての組み合わせと同じ結果）。
 * - shown: この訳で出るパックの台本（訳し漏れにも数える）。本体の訳なら、その言語の訳を持たないパック。パックの訳なら、訳を持たないパックと、
 *   並びがそのパックより前で訳を持つパック。どちらも、並びがそのパックより前のパックの台本は、そのパックが同じ名前の台本で差し替えるものを除く
 * - used: この訳では出ないが、使われているに数えるパックの台本（どの組み合わせで入っても訳を消さないよう、広めに数える）
 */
export function packTranslationScope(packs: readonly ParsedPack[], language: string, owner?: ParsedPack): { alsoShown: Map<string, Script>[]; alsoUsedBy: Map<string, Script>[] } {
  const at = owner ? packs.indexOf(owner) : -1;
  const alsoShown: Map<string, Script>[] = [];
  const alsoUsedBy: Map<string, Script>[] = [];
  packs.forEach((p, i) => {
    if (p === owner) return;
    const own = p.translations.has(language);
    if (owner && i < at) {
      // owner より前のパックの台本は、owner を一緒に入れたときにだけこの訳で出る。owner が同じ名前の台本を持てば、いつも差し替えられて出ない
      const hidden = new Map([...p.scripts].filter(([name]) => owner.scripts.has(name)));
      const shown = new Map([...p.scripts].filter(([name]) => !owner.scripts.has(name)));
      if (shown.size > 0) alsoShown.push(shown);
      if (hidden.size > 0) alsoUsedBy.push(hidden);
    } else if (!own) alsoShown.push(p.scripts);
    else alsoUsedBy.push(p.scripts);
  });
  return { alsoShown, alsoUsedBy };
}

/** パックの台本を読み解く（検査、lim voice-lock と制作画面の「番号を固定」、lim i18n が同じ読み方をする）。 */
export function parsePacks(packs: readonly PackCheckSource[], speakers: readonly string[]): ParsedPack[] {
  return packs.map((p) => {
    const said = [...new Set([...speakers, ...p.speakers])];
    return { dir: p.dir, scripts: new Map([...p.scripts].map(([name, text]) => [name, parse(text, name, { speakers: said })])), translations: p.translations };
  });
}

/**
 * 作品全体の検査（lim check、制作画面のチェック、VS Code の拡張、MCP の check_text が同じ入力から同じ一覧を作る）。
 * ファイルは読まない。読んだもの（台本、設定の字面、訳のファイル、素材の有無など）と読む口を呼ぶ側が渡す。
 * checkProject などに渡す入力（台本の外から指すジャンプ先、commandDefaults で使うマクロ、変数、プラグインが値を入れる変数）も、
 * 訳の検査と書式の版の検査も、ここで一度だけ組み立てる。呼ぶ側で足したり省いたりすると、同じ作品に違う結果が出る。
 */

/** 検査に使う liminalia.json の項目（読み解いたもの。@liminalia/project の ProjectConfig をそのまま渡せる）。 */
export interface ProjectCheckConfig {
  entry?: unknown;
  afterLoad?: unknown;
  extra?: unknown;
  variables?: unknown;
  commandDefaults?: unknown;
  chapters?: unknown;
  ui?: unknown;
  items?: unknown;
  scenes?: unknown;
  languages?: unknown;
  allowScript?: unknown;
  format?: unknown;
  title?: unknown;
  endingKinds?: unknown;
  autoLayout?: unknown;
  playtest?: unknown;
  /** プロジェクトのプラグイン（cast.json の model を描くものがあるかの見分けに使う）。 */
  plugins?: unknown;
  check?: { punctuation?: unknown; severity?: unknown; variables?: unknown; rules?: unknown; sound?: unknown; unusedSpeakers?: unknown } | undefined;
}

export interface ProjectCheckInput {
  /** 作品のフォルダ（プラグインの check に渡す）。 */
  root: string;
  /** 台本（ファイル名 → 構文木と字面。名前の順）。 */
  files: ReadonlyMap<string, { script: Script; text: string }>;
  /** liminalia.json（読み解いたもの）と、その字面（無い・読めないなら null。JSON の誤りの位置、型に無い項目、項目の行に使う）。 */
  config: ProjectCheckConfig;
  configText: string | null;
  /** cast.json の cast と speakers、その字面（無ければ null）。 */
  cast: Readonly<Record<string, unknown>>;
  speakers: readonly string[];
  castText: string | null;
  /** 診断に書く cast.json の名前（作品のフォルダからのパス。既定 cast.json）。 */
  castFile?: string;
  /**
   * 設定の JSON Schema（読めない環境では null。型に無い項目を見ない）。null の項目は、JSON として読めない所だけを知らせる
   * （VS Code は liminalia.json と cast.json の型をエディタの JSON の検証に任せる）。
   */
  schemas?: { liminalia?: JsonSchema | null; cast?: JsonSchema | null; lang?: JsonSchema | null };
  /** 命令の仕様（作品の既定値 commandDefaults を重ねたもの）と、重ねる前のもの（既定値そのものの検査に使う）。 */
  registry: Registry;
  baseRegistry?: Registry;
  /** 読み込んだプラグイン（標準の命令も）。命令の教えるジャンプ先、値を入れる変数、データの CG、プラグインの check に使う。 */
  plugins: readonly CommandPlugin[];
  /** 作品のデータ（paths.data の .json）を名前で読む口と、その字面（診断の行）。 */
  data: (name: string) => unknown;
  dataText?: (name: string) => string | undefined;
  /** 診断に書くデータのフォルダの名前（作品のフォルダからのパス。既定 data）。 */
  dataFolder?: string;
  /** 原文以外の言語の訳のファイルの字面（無ければ null）。liminalia.json の languages の 2 番目からの順。 */
  translations: readonly { language: string; text: string | null }[];
  /**
   * 素材の有無（無ければ素材の実在を見ない）。actual は大文字と小文字の違いを見る（@liminalia/lang の assetNameResolver）。
   * head は素材のファイルの頭（Git LFS のポインタのままの素材を見分ける。@liminalia/project の assetHeads）。
   */
  assets?: {
    exists: (folder: string, path: string) => boolean;
    files?: (folder: string) => readonly string[] | undefined;
    actual?: (folder: string, path: string) => string | null | undefined;
    head?: (folder: string, path: string) => Uint8Array | null | undefined;
  } | null;
  /** voice-lock.json の字面（無ければ null）。 */
  voiceLockText?: string | null;
  /**
   * パック（packs/<フォルダ>/。@liminalia/project の listPackSources）。パックの台本だけが使う訳の鍵とボイスの番号の固定を「使われていない」にせず、
   * パックの訳（packs/<フォルダ>/lang/<言語>.json）を、本体にパックを重ねた台本で確かめる。無ければパックを見ない。
   */
  packs?: readonly PackCheckSource[];
  /**
   * 作品のフォルダの中のファイルを読む口（作品の CSS ui.css と、その中の url() と @import の検査。パスは作品のフォルダからの / 区切り）。
   * 無ければ作品の CSS を見ない。
   */
  projectFiles?: ProjectFiles | null;
  /** 素材の others のフォントを読む口（縦書きの字送り幅の検査。無ければ見ない）。 */
  readFont?: (file: string) => Uint8Array | null;
  /** UTF-8 で読めない台本（ファイル → 文字コードの名前）。そのファイルは bad-encoding だけにする。 */
  encodings?: ReadonlyMap<string, string>;
  /**
   * 作品の画面のテンプレート（liminalia.json の ui.templates）の検査に使うもの（これか projectFiles が無ければ見ない）。rules は標準の画面の決まり
   * （@liminalia/web/screen-rules の screenTemplateRules）、plugins はプラグインの "./web" が差し替える画面
   * （@liminalia/project/screen-templates の pluginScreens）。テンプレートのファイルは projectFiles で読む（作品の CSS と同じ読み方）。
   */
  screenTemplates?: { rules: ScreenTemplateRules; plugins?: readonly PluginScreens[] } | null;
  /** 呼ぶ側だけが分かる診断（プラグインの package.json の合うエンジンの宣言など）。 */
  more?: readonly Diagnostic[];
  /**
   * 黙らせる（// lim-ignore と check.severity）前に一覧を整える口。syntax は構文の診断（台本の解析が出したもの）。
   * 制作画面が分類を付け、読み込めなかったプラグインの命令の指摘をまとめるのに使う。
   */
  adjust?: (diagnostics: Diagnostic[], syntax: ReadonlySet<Diagnostic>) => Diagnostic[];
}

/** プラグインの命令が教える行き先（制作画面のフローチャートと同じ）。 */
export function pluginTargetHooks(plugins: readonly CommandPlugin[]): Map<string, TargetHook> {
  const hooks = new Map<string, TargetHook>();
  for (const p of plugins) for (const c of p.commands ?? []) if (typeof c.targets === "function") hooks.set(c.name, c.targets.bind(c));
  return hooks;
}

/** liminalia.json の variables のうち、使える名前のもの（configValueProblems が知らせたものは使わない。loadProject と同じ）。 */
function usableVariables(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || !raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([key]) => VARIABLE_KEY.test(key)));
}

/**
 * cast.json の model の種類を描くプラグインがあるか。読み込んだプラグインの名前が種類と同じか、liminalia.json の plugins に
 * その種類の公式のプラグイン（`plugins/live2d`、`liminalia-live2d` など。制作画面のキャラクターの画面と同じ見分け方）を書いたもの。
 */
function modelAvailable(plugins: readonly CommandPlugin[], configured: unknown): (type: string) => boolean {
  const names = new Set(plugins.map((p) => p.name));
  const specs = Array.isArray(configured) ? configured.filter((s): s is string => typeof s === "string").map((s) => s.replace(/\/+$/, "")) : [];
  return (type) => names.has(type) || specs.some((s) => s === type || s.endsWith(`/${type}`) || s === `liminalia-${type}` || s.endsWith(`/liminalia-${type}`));
}

/**
 * 多言語の訳のファイル（原文以外の言語）。無いものは警告（その言語では原文を出す）。
 * 本体の訳はパックに訳が無ければパックの台本にも使われるので、パックの台本だけが使う訳も使われているに数える（packTranslationScope）。
 * パックの訳（packs/<フォルダ>/lang/<言語>.json。あるものだけ）は、パックを入れると本体の訳と丸ごと入れ替わり本体の台本にも使われるので、
 * 本体にそのパックを重ねた台本（同じ名前の台本はパックのもの）で確かめる。訳を持たないパックの台本は、一緒に入れればこの訳で出るので訳し漏れにも数える。
 */
function checkLanguages(input: ProjectCheckInput, scripts: ReadonlyMap<string, Script>, packs: readonly ParsedPack[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const sources = { registry: input.registry, project: input.config as ProjectTextSource, data: dataTranslatables(declaredData(input.plugins, (n) => input.data(n))) };
  const check = (text: string, name: string, own: ReadonlyMap<string, Script>, scope: ReturnType<typeof packTranslationScope>) => {
    // 読めない所は行と桁で、知らない項目は近い名前の案つきで知らせる
    const read = readConfigJson(text, name, input.schemas?.lang ?? null, "bad-translation");
    out.push(...read.diagnostics);
    if (read.value !== undefined) out.push(...checkTranslation(read.value, name, own, { ...sources, ...(scope.alsoShown.length > 0 ? { alsoShown: scope.alsoShown } : {}), ...(scope.alsoUsedBy.length > 0 ? { alsoUsedBy: scope.alsoUsedBy } : {}) }));
  };
  for (const { language, text } of input.translations) {
    const name = `lang/${language}.json`;
    if (text === null) {
      out.push({ severity: "warning", code: "missing-translation", message: `${language} の翻訳ファイルがありません（その言語では原文を表示します）`, file: name, line: 1, hint: `lim i18n ${language} で作成できます` });
      continue;
    }
    check(text, name, scripts, packTranslationScope(packs, language));
  }
  for (const pack of packs) {
    for (const { language } of input.translations) {
      const text = pack.translations.get(language);
      if (text === undefined) continue;
      check(text, `${pack.dir}/lang/${language}.json`, new Map([...scripts, ...pack.scripts]), packTranslationScope(packs, language, pack));
    }
  }
  return out;
}

/** 連番のボイスの番号の固定（voice-lock.json があるときだけ）。パックの台詞も本体の固定を使うので、パックの台本も数える。 */
function voiceLockDiagnostics(input: ProjectCheckInput, scripts: ReadonlyMap<string, Script>, packs: readonly ParsedPack[]): Diagnostic[] {
  if (input.voiceLockText === null || input.voiceLockText === undefined) return [];
  const read = readConfigJson(input.voiceLockText, "voice-lock.json", null, "bad-voice-lock");
  if (read.diagnostics.length > 0) return read.diagnostics.slice(0, 1);
  const assets = input.assets;
  // 大文字と小文字の違う名前のボイスも、無いものとして数える（Linux のサーバーやスマホでは鳴らない）
  const exists = (folder: string, path: string) => {
    if (!assets) return true;
    const real = assets.actual?.(folder, path);
    return real === undefined ? assets.exists(folder, path) : real === path;
  };
  const entry = typeof input.config.entry === "string" ? input.config.entry : undefined;
  return checkVoiceLock(read.value as VoiceLock, scripts, exists, { entry, packs: packs.map((p) => p.scripts) });
}

/**
 * 作品全体の診断（lim check が出すもの。並びは集めた順。呼ぶ側が並べる）。台本の // lim-ignore と liminalia.json の check.severity を当て、
 * 設定のファイルの診断は誤りのある項目の行に出す。
 */
export function projectDiagnostics(input: ProjectCheckInput, cache?: ProjectFileCheckCache): Diagnostic[] {
  const { config, registry, plugins } = input;
  const scripts = new Map<string, Script>();
  const syntax = new Set<Diagnostic>();
  for (const [file, { script }] of input.files) {
    scripts.set(file, script);
    for (const d of script.diagnostics) syntax.add(d);
  }
  const castFile = input.castFile ?? "cast.json";
  const castNames = new Set(Object.keys(input.cast));
  // cast.json の形が崩れていれば、そのキャラクターは名前だけ確かめる（立ち絵セット、差分、立ち位置は見ない）
  const problems = castProblems(input.cast);
  const broken = new Set(problems.map((p) => p.who));
  const castEntries = Object.fromEntries(Object.entries(input.cast as Cast).filter(([who]) => !broken.has(who)));
  const variables = usableVariables(config.variables);
  const check = config.check ?? {};
  const ui = config.ui as UiConfig | undefined;
  const extra = config.extra as ExtraConfig | undefined;
  // プラグインの命令が教える行き先（使われないラベルと、音の抜けの検査が流れをたどるのに使う）
  const promised = promisedTargets({ scripts: input.files, registry, hooks: pluginTargetHooks(plugins), data: input.data });
  const out: Diagnostic[] = [];
  // 設定の JSON: 読めない所の行と桁、型に無い項目（ui の知らない項目は checkUi が知らせる）、使わずに続けた項目の値
  if (input.configText !== null) {
    const read = readConfigJson(input.configText, "liminalia.json", input.schemas?.liminalia ?? null, "bad-config", ["ui"]);
    out.push(...read.diagnostics);
    if (read.value !== undefined) out.push(...configValueProblems(read.value, input.configText));
  }
  if (input.castText !== null) out.push(...readConfigJson(input.castText, castFile, input.schemas?.cast ?? null).diagnostics);
  // 台本の書式の版（format）がこのエンジンより新しいか
  out.push(...checkFormat(config.format));
  out.push(
    ...problems.map((p): Diagnostic => ({ severity: "error", code: "bad-cast", message: p.message, file: castFile, line: 1, ...(p.hint ? { hint: p.hint } : {}), cast: { who: p.who } })),
    // 自動配置の定位置（side）の誤り。立ち絵の検査は続ける（castProblems と違い、その人物を壊れたものとして外さない）
    ...castSideProblems(input.cast).map((p): Diagnostic => ({ severity: "error", code: "bad-cast", message: p.message, file: castFile, line: 1, hint: p.hint, cast: { who: p.who } })),
    ...castWarnings(castEntries).map(
      (w): Diagnostic => ({ severity: "warning", code: "cast-ambiguous", message: w.message, file: castFile, line: 1, hint: w.hint, cast: { who: w.who, ...(w.appearance ? { appearance: w.appearance } : {}), ...(w.kind ? { kind: w.kind } : {}) } }),
    ),
    // model（Live2D、Spine など）を描くプラグイン。読み込んだプラグインの名前か、liminalia.json の plugins に書いたもの（読み込めないときは plugin-load が知らせる）
    ...castModelProblems(castEntries, modelAvailable(plugins, config.plugins)).map(
      (p): Diagnostic => ({ severity: "warning", code: "model-plugin-missing", message: p.message, file: castFile, line: 1, hint: p.hint, cast: { who: p.who } }),
    ),
  );
  out.push(
    ...checkProject(scripts, {
      registry,
      cast: castNames,
      castEntries,
      speakers: input.speakers,
      allowScript: config.allowScript === true,
      punctuation: check.punctuation as PunctuationConfig | undefined,
      sourceLanguage: Array.isArray(config.languages) && typeof config.languages[0] === "string" ? config.languages[0] : undefined,
      ...(variables ? { variables } : {}),
      // プラグインが値を入れる変数とデータのフラグ（変数の綴り違いの検査で、値の入る変数に数える）
      writtenVariables: pluginWrittenVariables(plugins, input.data),
      // 台本の外から指すジャンプ先（entry、回想、プラグインのデータの行き先）と、commandDefaults で使うマクロ
      references: [...configTargets(config), ...[...promised.values()].flat()],
      usedMacros: config.commandDefaults && typeof config.commandDefaults === "object" ? Object.keys(config.commandDefaults) : [],
      ...(check.variables === "declared" ? { variableCheck: "declared" as const } : {}),
      // 章の扉に出すものが無い所と、章に入っていないシナリオ
      chapters: config.chapters,
      // 使われなくても知らせない話者（先の話で使う人物など）
      unusedSpeakers: unusedSpeakersConfig(check.unusedSpeakers),
    }, cache),
  );
  // 設定から始める位置が下書きのファイルを指していないか（書き出しに入らない）
  out.push(...checkDraftStarts(config, scripts));
  out.push(...checkCommandDefaults(config.commandDefaults, input.baseRegistry ?? registry, castNames, projectMacros(scripts)));
  out.push(...checkExtra(config.extra, scripts, registry, config.chapters as ChapterInfo[] | undefined, pluginDataCg(plugins, input.data)));
  out.push(...checkChapters(config.chapters, scripts.keys()));
  // 立ち絵の登場順の自動配置の並べ方（形と、立ち絵の枠に無い立ち位置の名前）
  out.push(...checkAutoLayout(config.autoLayout, input.cast));
  // エンディングの種類（ending= の種類、前の書き方の文言、endingKinds、避ける指定、実績の endings、式の endings()）
  out.push(...checkEndings({ scripts, registry, endingKinds: config.endingKinds, format: config.format, playtest: config.playtest, extra: config.extra }));
  out.push(...checkAfterLoad(config.afterLoad, scripts));
  // ゲームの設定（ui）の形と色調、持ち物
  out.push(...checkUi(ui), ...checkTones(scripts, ui), ...checkNvlStyles(scripts, ui), ...checkItems(config.items, scripts));
  // 作品の CSS（ui.css。無いファイル、読めない CSS、url() の無い素材と作品の外を指すもの）
  if (input.projectFiles) out.push(...checkUiCss(ui, input.projectFiles));
  // 作品の画面のテンプレート（無いファイル、知らない画面と部品と値、要る data-role、外されるもの、古い版、プラグインの screens.* に隠れたもの）
  const files = input.projectFiles;
  if (input.screenTemplates && files && ui && typeof ui === "object") {
    const preset = (ui as { system?: { preset?: unknown } }).system?.preset;
    out.push(
      ...checkScreenTemplates({
        templates: (ui as { templates?: unknown }).templates,
        rules: input.screenTemplates.rules,
        read: (file) => files.text(file),
        ...(input.screenTemplates.plugins ? { plugins: input.screenTemplates.plugins } : {}),
        ...(typeof preset === "string" ? { preset } : {}),
      }),
    );
  }
  // 作品の演出の決まり（check.rules）と場面の情報（scenes）
  out.push(...checkProjectRules({ rules: check.rules, scenes: config.scenes, scripts, registry, cast: castEntries, ...(extra ? { extra } : {}) }));
  out.push(...checkSeverityConfig(check.severity), ...checkUnusedSpeakersConfig(check.unusedSpeakers, input.speakers));
  // 音の抜け（無音の長い区間、空振りの停止、ファイルをまたぐループ。check.sound）
  out.push(...checkSound({ scripts, registry, config: check.sound, ...soundStarts(config), promised, candidates: targetCandidates(scripts, { registry, ...(variables ? { variables } : {}) }) }));
  // パック（訳とボイスの鍵が使われているかと、パックの訳）
  const packs = parsePacks(input.packs ?? [], input.speakers);
  out.push(...checkLanguages(input, scripts, packs));
  out.push(...voiceLockDiagnostics(input, scripts, packs));
  if (input.readFont) out.push(...checkVerticalFont(ui, [...input.files.values()].map((f) => f.text), input.readFont));
  const assets = input.assets;
  if (assets) {
    out.push(
      ...missingAssets({
        scripts,
        registry,
        cast: input.cast,
        castFile,
        extra,
        items: config.items,
        ui,
        exists: assets.exists,
        ...(assets.files ? { files: assets.files } : {}),
        ...(assets.actual ? { actual: assets.actual } : {}),
        ...(assets.head ? { head: assets.head } : {}),
      }),
    );
  }
  // プラグインの check（投げても止まらず、そのプラグインの診断になる。設定は呼ぶ側が使い回すことがあるので写しを渡す）
  out.push(
    ...runPluginChecks(plugins, {
      root: input.root,
      config: structuredClone(config) as Record<string, unknown>,
      scripts,
      text: (file) => input.files.get(file)?.text ?? "",
      cast: input.cast as Cast,
      speakers: input.speakers,
      registry,
      data: input.data,
      ...(input.dataText ? { dataText: input.dataText } : {}),
      dataFolder: input.dataFolder ?? "data",
      assetExists: assets ? assets.exists : () => true,
    }),
  );
  out.push(...(input.more ?? []));
  // UTF-8 で読めない台本（Shift_JIS など）は bad-encoding だけにし、化けた中身からの診断は出さない
  let list: Diagnostic[] = out;
  if (input.encodings && input.encodings.size > 0) {
    list = [...out.filter((d) => !input.encodings!.has(d.file)), ...[...input.encodings].map(([file, encoding]) => encodingDiagnostic(file, encoding))];
  }
  if (input.adjust) list = input.adjust(list, syntax);
  // 台本の // lim-ignore と check.severity（警告と情報だけ。何も黙らせない lim-ignore は情報で知らせる）
  let kept: Diagnostic[] = suppressDiagnostics(list, { scripts, severity: check.severity, reportUnused: true, externalCodes: new Set(["text-overflow"]) });
  // 設定の形の誤りは、1 行目でなく誤りのある項目の行に出す
  if (input.configText !== null) kept = placeConfigLines(kept, input.configText, "liminalia.json");
  if (input.castText !== null) kept = placeConfigLines(kept, input.castText, castFile);
  return kept;
}
