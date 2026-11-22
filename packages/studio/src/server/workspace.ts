import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import {
  shownImages,
  CORE_COMMANDS,
  createRegistry,
  parse,
  type Cast,
  type CommandSpec,
  type Diagnostic,
  type Registry,
  type ProjectFileCheckCache,
  type Script,
  type UiConfig,
  notUtf8StopMessage,
  projectMacros,
  uiParamNames,
  withCommandDefaults,
  type DataDeclaration,
  type DataText,
  autoLayoutRules,
  type AutoLayoutRules,
  type VoiceLock,
  castSides,
} from "@liminalia/lang";
import { containedPath, within } from "@liminalia/project/contained-path";
import { assetHeads, assetNames, projectFileReader, engineVersionDiagnostics, listPackSources, listScenarioFiles, loadCommandPlugins, pluginLoadMessage, readCast, readVoiceLock, scenarioFileEncoding, type CastFile, type PluginLoadError, type Project, type ProjectConfig, configSchema } from "@liminalia/project";
import { pluginScreens } from "@liminalia/project/screen-templates";
import { screenTemplateRules } from "./screens.ts";
import { coverage, DEFAULT_COVERAGE_RUNS, projectRuntimeOptions, type CommandImpl, type ProgramCache, type ProjectRuntimeOptions, type Value } from "@liminalia/runtime";
import { combinePlugins, dataDeclarations, dataKeys, projectDataTexts, projectDiagnostics, type CommandDefinition, type CommandPlugin } from "@liminalia/plugin-host";
import { buildStoryMap, promisedTargets, type StoryMapInput, type TargetHook } from "./story-map.ts";
import { sceneMarkers } from "../scene-markers.ts";
import { scriptSpeakerCounts } from "../scene-speakers.ts";
import {
  ASSET_FOLDERS,
  type AssetIndex,
  type CheckCategory,
  type CheckedDiagnostic,
  type CheckResult,
  type CoverageResult,
  type StoryMap,
  type FileInfo,
  type FileText,
  type HistoryEntry,
  type ProjectInfo,
  type StageTrack,
  type StudioEvent,
  type Sweep,
  type SweepReach,
  type WriteConflict,
  type WriteResult,
} from "../protocol.ts";
import { routeGuide, stageTrack, Sweeper, type RouteGuide, type SweepSignal, type SweepSource } from "../sweep.ts";
import { Journals } from "./file-undo.ts";
import { keepVersion, listVersions, writeAtomic } from "./versions.ts";
import studioPackage from "../../package.json" with { type: "json" };

export { HISTORY_KEEP, writeAtomic } from "./versions.ts";

/**
 * 制作画面の開発サーバーの中身（Node 側）。HTTP の口（index.ts）から呼ぶ。Vite に依存しないので、テストから直接使える。
 *
 * - 正本はプロジェクトの .lim だけ。読む口は毎回ディスクから読み（内容の hash で解析を使い回す）、書く口は write の一つ
 * - write は、ディスクの内容が画面の base と違えば書かない（409）。前の版を .liminalia/history/<ファイル>/ に残し
 *   （直近は細かく、古いほど粗く間引く。./versions.ts）、一時ファイルから rename して書く
 * - 外の変更（ほかのエディタ・AI・取り込み）は changed で受け、知らせ（StudioEvent）にする。自分の書き込みは見張りでは知らせず、
 *   announce で書いた画面の id（as）を添えて送る（同じ作品を開いているほかの画面が読み直す）
 * - 現在地（sweep）と持続の帯（stageTrack）は、どれかの .lim が変わるまで覚えておく
 * - 素材の一覧は、素材のフォルダが変わるまで覚えておく（assetsChanged）
 */

/** 現在地を作る・道筋を探す間、続けて動かす長さ（ミリ秒）。過ぎたら一度手を離し、保存などほかの要求を先に通す。 */
const SWEEP_SLICE_MS = 30;
let sliceStart = Date.now();
/** 待っているほかの要求へ手を離す（Node は setImmediate、ほかは setTimeout）。 */
const yieldNow = (): Promise<void> => new Promise((r) => (typeof setImmediate === "function" ? setImmediate(r) : setTimeout(r, 0)));

/**
 * 現在地の道筋を探す間に、ほかの頼みを先に通す合図。現在地を作る実行器が、描画側へ送るたび（walk の pause）と
 * ファイルを読むたびに呼ぶ。既定は SWEEP_SLICE_MS ごとに一度手を離す（探している間も保存・素材・ほかの要求が止まらない）。
 * @liminalia/studio-mobile（Service Worker）は自分の手の離し方に差し替えてよい。
 */
let pauseSweep: () => void | Promise<void> = () => {
  if (Date.now() - sliceStart < SWEEP_SLICE_MS) return;
  return yieldNow().then(() => {
    sliceStart = Date.now();
  });
};

export function setSweepPause(fn: () => void | Promise<void>): void {
  pauseSweep = fn;
}
export const HISTORY_DIR = join(".liminalia", "history");
const gzipAsync = promisify(gzip);

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * エンジンの版（エンジンのパッケージはすべて同じ版。docs/versioning.md）。全ルートテストの結果に添え、版を入れ替えたあとに
 * 前の版の結果を今の結果として出さないために使う。
 */
export const ENGINE_VERSION: string = studioPackage.version;

/** 作品のデータのフォルダの .json（データのフォルダからの / 区切りのパス、名前順）。. で始まるものは見ない。 */
function dataFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // データのフォルダが無ければ、データは無い
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
      else if (e.name.endsWith(".json")) out.push(`${prefix}${e.name}`);
    }
  };
  walk(root, "");
  return out.sort();
}

/** 画面がファイルを指す名前（paths.scenario からの相対パス、拡張子なし）として使えるか。 */
export function isFileName(file: string): boolean {
  if (file === "" || file.includes("\\") || file.includes("\0") || isAbsolute(file)) return false;
  return file.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith("."));
}

export class StudioError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Parsed {
  hash: string;
  text: string;
  script: Script;
}

/**
 * 覚えておく現在地のファイルの数。一つの長いファイルで JSON が十数 MB になるので、地図を引きで見て全ファイルを頼まれても
 * サーバーのメモリが膨らまないよう、古く使ったものから捨てる（捨てたものは頼まれたら作り直す）。
 */
const SWEEP_CACHE_FILES = 8;

/** 控えに入れる（入れたものを一番新しくし、数を超えたら一番古く使ったものを捨てる）。 */
function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > SWEEP_CACHE_FILES) cache.delete(cache.keys().next().value!);
}

export class StudioWorkspace {
  private cast: CastFile;
  /** 組み込みとプラグインのコマンドの仕様（作品の既定値を重ねる前）。 */
  private readonly baseRegistry: Registry;
  /** baseRegistry に作品の既定値（liminalia.json の commandDefaults）を重ねたもの。補完・フォーム・検査が使う。 */
  private registry: Registry;
  /** registry に重ねた既定値（変わったかを見る）。 */
  private defaultsKey: string;
  private readonly implementations: CommandImpl[];
  /** ファイル → 最後に知っている内容の hash（外の変更かどうかの判定に使う）。 */
  private readonly known = new Map<string, string>();
  /**
   * 台本のファイルを書いた・消したことを画面へ知らせる口（開発サーバーが Vite の WebSocket で送る）。ファイルの見張りは自分で書いた内容を
   * 知らせないので、同じ作品を開いているほかの画面には、ここから届ける。
   */
  announce: ((e: StudioEvent) => void) | null = null;
  /** 今書いている画面の id（as の間だけ）。 */
  private writer: string | undefined;
  private readonly parsed = new Map<string, Parsed>();
  private readonly fileChecks: ProjectFileCheckCache = new WeakMap();
  /** 現在地と全ルートテストで使う、読み解いた台本の控え。 */
  private readonly programCache: ProgramCache = new Map();
  private readonly sweeper: Sweeper;
  private readonly sweepSource: SweepSource;
  /** 現在地を作る実行器が作品のデータを読む口（ファイルが変わったら読み直す）。 */
  private readonly sweepData: (name: string) => unknown;
  /** ファイル → 作った現在地（JSON と gzip したもの）と、そこから抜き出した持続の帯。 */
  private readonly sweeps = new Map<string, { hash: string; sweep: Sweep; json: string; gz: Buffer | null; track: StageTrack | null }>();
  /** 届かない行のために探した道筋で作った現在地（ファイル → 現在地。reach）。ふつうの現在地より先に使う。 */
  private readonly pinned = new Map<string, { hash: string; sweep: Sweep; json: string; gz: Buffer | null; track: StageTrack | null }>();
  /** 素材の一覧（素材のフォルダが変わったら捨てる）。 */
  private assetIndex: AssetIndex | null = null;
  /** 現在地は一度に一つずつ作る（同じファイルの要求が重なったら、先のものを待つ）。 */
  private queue: Promise<unknown> = Promise.resolve();
  /** .lim が変わるたびに増える（作っている途中で変わった現在地を覚えないため）。 */
  private generation = 0;
  /** 届かない行の探索を、ほかの行について頼まれた回数と、最後に頼まれた行（ほかの行を頼まれたら、前の探索をやめる）。 */
  private reachToken = 0;
  private reachKey = "";
  /** プラグインの命令が教える飛び先（地図）。 */
  private readonly targetHooks = new Map<string, TargetHook>();
  /** 最後に読んだ liminalia.json の字面と、読み解いたもの（readConfig）。 */
  private config: { text: string; value: ProjectConfig } | null = null;

  private constructor(
    readonly project: Project,
    plugins: { specs: CommandSpec[]; implementations: CommandImpl[]; commands?: CommandDefinition[] },
    /** 命令名 → 出どころ（"core" かプラグインの名前。あとのプラグインが同じ名前を定義したら、あとのもの）。 */
    private readonly sources: Record<string, string> = {},
    /** check を読むプラグイン（lim check と同じ）。 */
    private readonly commandPlugins: readonly CommandPlugin[] = [],
  ) {
    this.cast = readCast(project);
    this.baseRegistry = createRegistry(CORE_COMMANDS, plugins.specs);
    const defaults = this.readConfig().commandDefaults;
    this.registry = withCommandDefaults(this.baseRegistry, defaults);
    this.defaultsKey = JSON.stringify(defaults ?? {});
    this.implementations = plugins.implementations;
    this.sweepData = this.liveDataReader();
    for (const c of plugins.commands ?? []) if (c.targets) this.targetHooks.set(c.name, c.targets.bind(c));
    this.sweepSource = {
      loadSource: async (file) => {
        await pauseSweep();
        return this.read(file).text;
      },
      // 作品のデータ（命令の ctx.data）も読めるようにする。読めないと、データで行き先を決める命令（調べる場所など）の先へ進めず、
      // それより後のファイルに道筋が見つからない。制作画面で直したデータが効くよう、ファイルが変わったら読み直す
      runtime: this.runtimeOptions(this.sweepData),
      entry: project.config.entry,
      pause: () => pauseSweep(),
    };
    this.sweeper = new Sweeper(this.sweepSource);
    for (const file of this.files()) this.known.set(file, hashText(readFileSync(this.path(file), "utf8")));
  }

  static async open(project: Project): Promise<StudioWorkspace> {
    const started = Date.now();
    // 読み込めないプラグインは抜いて開く（上の帯とチェックの「プラグイン」の分類に出す）
    const plugins = await loadCommandPlugins(project, { skipBroken: true });
    const loaded = Date.now();
    const sources: Record<string, string> = Object.fromEntries(CORE_COMMANDS.map((c) => [c.name, "core"]));
    for (const p of plugins) for (const c of p.commands) sources[c.name] = p.name;
    const ws = new StudioWorkspace(project, combinePlugins(plugins), sources, plugins);
    ws.openTimes = { plugins: loaded - started, files: Date.now() - loaded };
    return ws;
  }

  private journalStore: Journals | null = null;
  /** ⌘Z で戻せる、ファイルを動かす・書き換える操作の控え（./file-undo.ts）。初めて使うときに作る（前の控えの置き場を片付ける）。 */
  get journals(): Journals {
    return (this.journalStore ??= new Journals(this.project.root));
  }

  /** 開いたときにかかった時間（ミリ秒。プラグインの読み込みと、作品のファイルを読むこと）。開発サーバーが長くかかったときに記録へ出す。 */
  openTimes: { plugins: number; files: number } = { plugins: 0, files: 0 };

  // ---- 読む ----

  /** シナリオのフォルダの .lim（名前順。サブフォルダは "part1/chapter2"）。. で始まるファイル・フォルダは見ない。lim check・lim build と同じ一覧（@liminalia/project）。 */
  files(): string[] {
    return listScenarioFiles(this.project.paths.scenario).map((f) => f.name);
  }

  path(file: string): string {
    if (!isFileName(file)) throw new StudioError(400, `ファイル名として使えません: ${file}`);
    const path = join(this.project.paths.scenario, `${file}.lim`);
    // 台本のフォルダ（と下のフォルダ）がリンクで作品の外を指していたら、その先へ書かない（配られた作品にリンクを仕込まれても）。
    // paths.scenario に作品の外の場所をそのまま書いた作品は、作者の設定なのでそのまま使う
    const scenario = this.project.paths.scenario;
    const inRoot = within(this.project.root, scenario);
    if (inRoot ? !containedPath(this.project.root, path) : !containedPath(scenario, path)) throw new StudioError(400, `台本のフォルダの外を指すリンクの先には書けません: ${file}.lim`);
    return path;
  }

  /** ディスクから読み、解析する（内容が同じなら前の解析を使う）。 */
  /** シナリオが出す画像（物語の順。おまけの CG の自動の登録 extra.cgAuto を広げるのに使う）。 */
  shownImages(): string[] {
    return shownImages(this.files().map((f) => [f, this.read(f).script] as const), this.registry);
  }

  private read(file: string): Parsed {
    const path = this.path(file);
    if (!existsSync(path)) throw new StudioError(404, `${file}.lim がありません`);
    const text = readFileSync(path, "utf8");
    const hash = hashText(text);
    const cached = this.parsed.get(file);
    if (cached?.hash === hash) return cached;
    const parsed = { hash, text, script: parse(text, file, { speakers: this.cast.speakers }) };
    this.parsed.set(file, parsed);
    return parsed;
  }

  /** ディスクに書く前の字面を、ディスクのファイルと同じ決まりで解析する。 */
  parseText(file: string, text: string): Script {
    return parse(text, file, { speakers: this.cast.speakers });
  }

  /** 解析したファイル（素材・キャストの参照を集めるとき）。 */
  script(file: string): { text: string; hash: string; script: Script } {
    return this.read(file);
  }

  /** 命令名 → 出どころ（"core"・"std"・プラグインの名前）。 */
  get commandSources(): Readonly<Record<string, string>> {
    return this.sources;
  }

  /** 命令の仕様（作品の既定値を重ねたもの）。 */
  get commands(): Registry {
    return this.registry;
  }

  /** 命令の仕様（作品の既定値を重ねる前。既定値の検査に使う）。 */
  get baseCommands(): Registry {
    return this.baseRegistry;
  }

  /** cast.json（最後に読んだもの）。 */
  get castFile(): CastFile {
    return this.cast;
  }

  /**
   * liminalia.json の中身（書き換えられるので毎回読む。読めなければ起動したときのもの）。
   * 字面が前に読んだときと同じなら、読み解いたものを使い回す（呼ぶ側は書き換えない）。
   */
  readConfig(): ProjectConfig {
    let text: string;
    try {
      text = readFileSync(join(this.project.root, "liminalia.json"), "utf8");
    } catch {
      // 読めなければ、開いたときの設定で続ける（liminalia.json の誤りはチェックが位置つきで知らせる）
      return this.project.config;
    }
    if (this.config?.text === text) return this.config.value;
    try {
      const value = JSON.parse(text) as ProjectConfig;
      this.config = { text, value };
      return value;
    } catch {
      // JSON として読めなければ、開いたときの設定で続ける（チェックが位置つきで知らせる）
      return this.project.config;
    }
  }

  /** 変数の初期値（liminalia.json の variables。書き換えられるので毎回読む）。 */
  readVariables(): Record<string, Value> {
    return (this.readConfig().variables as Record<string, Value> | undefined) ?? {};
  }

  /** 見た目と操作の設定（liminalia.json の ui。書き換えられるので毎回読む）。 */
  readUi(): UiConfig | undefined {
    return this.readConfig().ui;
  }

  /** 立ち絵の登場順の自動配置の並べ方（liminalia.json の autoLayout。持続の帯とシーンの情報の立ち位置も、プレイヤーと同じ規則で出す）。 */
  private autoLayoutOption(): { autoLayout?: AutoLayoutRules } {
    const rules = autoLayoutRules(this.readConfig().autoLayout);
    return rules ? { autoLayout: rules } : {};
  }

  /**
   * liminalia.json（か voice-lock.json）が変わったかもしれない。実行器の設定を今の設定で作り直し、現在地の流れ方が変わる項目
   * （変数の初期値、言語、章、版、ui.chat の台詞の出し方、台詞の括弧、コマンドの既定値、自動配置、実績、エンディングの種類、
   * ロードの後に呼ぶ所、ボイスの番号の固定）が変わっていれば現在地を作り直させ（既定値ならコマンドの仕様も重ね直し）、true を返す。
   */
  variablesChanged(): boolean {
    const next = this.runtimeOptions(this.sweepData);
    const defaultsKey = JSON.stringify(next.commandDefaults ?? {});
    const defaultsChanged = defaultsKey !== this.defaultsKey;
    if (defaultsChanged) {
      this.defaultsKey = defaultsKey;
      this.registry = withCommandDefaults(this.baseRegistry, next.commandDefaults);
    }
    const changed = defaultsChanged || sweepKey(next) !== sweepKey(this.sweepSource.runtime);
    this.sweepSource.runtime = next;
    if (!changed) return false;
    this.project.config.variables = next.variables ?? {};
    this.invalidate();
    return true;
  }

  /** liminalia.json の entry・afterLoad を書き換えた（シーンの名前の変更）。現在地と地図が、起動し直さなくても新しい行き先から流せるようにする。 */
  targetsChanged(): void {
    const { entry, afterLoad } = this.readConfig();
    this.project.config.entry = entry;
    if (afterLoad) this.project.config.afterLoad = afterLoad;
    this.sweepSource.entry = entry;
    this.sweepSource.runtime = this.runtimeOptions(this.sweepData);
    this.invalidate();
  }

  /** プラグインの命令が教える行き先（"ファイル:行" → 行き先）。 */
  promised(): Map<string, string[]> {
    return promisedTargets(this.mapInput());
  }

  /** 素材の一覧を作り直させる（素材を動かした・消したとき。見張りの知らせを待たない）。 */
  forgetAssets(): void {
    this.assetIndex = null;
  }

  fileText(file: string): FileText {
    const { text, hash } = this.read(file);
    return { file, text, hash };
  }

  projectInfo(): ProjectInfo {
    const files: FileInfo[] = this.files().map((file) => {
      const { text, hash, script } = this.read(file);
      const labels: FileInfo["labels"] = [];
      const defines: NonNullable<FileInfo["defines"]> = [];
      for (const s of script.body) {
        if (s.kind === "label") labels.push({ name: s.name, line: s.line });
        else if (s.kind === "define" && s.name !== "") defines.push({ name: s.name, line: s.line });
      }
      const markers = sceneMarkers(text);
      const speakerCounts = scriptSpeakerCounts(script);
      return { file, lines: text.split("\n").length, hash, labels, speakerCounts, ...(markers.length > 0 ? { markers } : {}), ...(defines.length > 0 ? { defines } : {}), ...(script.draft ? { draft: true as const } : {}) };
    });
    const { config, screen } = this.project;
    // 検査の設定は起動し直さなくても効くよう、今の liminalia.json から読む
    const check = this.readConfig().check;
    return {
      id: config.id,
      title: config.title,
      entry: config.entry,
      screen,
      files,
      speakers: this.cast.speakers,
      ...(config.languages?.[0] ? { language: config.languages[0] } : {}),
      cast: this.cast.cast as Cast,
      commands: this.commandsWithDataKeys(),
      commandSources: this.sources,
      // 人物の引数が表示中の人物に効くか（型の shown）も、本文から決めて送る（補完が表示中の人物を上に並べる）
      macros: [...projectMacros(this.files().map((f) => [f, this.read(f).script] as const), (name) => this.commands.get(name)).values()],
      assets: this.assets(),
      importManaged: config.import?.tyrano !== undefined,
      ...(config.allowScript ? { allowScript: true } : {}),
      ...this.autoLayoutOption(),
      ...(check?.punctuation !== undefined ? { punctuation: check.punctuation } : {}),
      ...(check?.severity !== undefined ? { severity: check.severity } : {}),
      ...(this.readConfig().fmt?.indent !== undefined ? { formatIndent: this.readConfig().fmt!.indent! } : {}),
      ...(this.readConfig().fmt?.expressions === false ? { formatExpressions: false as const } : {}),
      ...(config.languages?.length ? { languages: config.languages } : {}),
      data: this.dataOwners(),
      ...(this.brokenPlugins().length > 0 ? { pluginErrors: this.brokenPlugins().map((e) => ({ spec: e.spec, message: e.message })) } : {}),
      ...(this.project.restricted ? { restricted: true as const } : {}),
    };
  }

  /**
   * 命令の仕様。作品のデータの名前の引数（t.dataKey）には、今のデータの名前を候補（suggest）に入れる（右の欄で一覧から選べる）。
   * 色調の名前の引数（@tone、@bg の tone= など）には作品の ui.tones、NVL の見た目の名前（@nvl の style=）には ui.nvlStyles で決めた名前も入れる（補完と右の欄）。
   */
  private commandsWithDataKeys(): CommandSpec[] {
    const read = this.dataReader();
    const ui = this.readConfig().ui;
    return [...this.registry.values()].map((spec) => {
      let params: Record<string, CommandSpec["params"][string]> | null = null;
      for (const [name, p] of Object.entries(spec.params)) {
        if (p.type.kind !== "string") continue;
        const keys = p.type.data ? (dataKeys(read(p.type.data.file), p.type.data.path) ?? []) : uiParamNames(p.type, ui);
        if (keys.length === 0 && !p.type.data) continue;
        params ??= { ...spec.params };
        params[name] = { ...p, type: { ...p.type, suggest: [...new Set([...(p.type.suggest ?? []), ...keys])] } };
      }
      return params ? { ...spec, params } : spec;
    });
  }

  /** 読み込めずに抜いたプラグイン（作品の外のフォルダが無いだけのものは除く。そのコンピューターに無い道具なので）。 */
  brokenPlugins(): PluginLoadError[] {
    return (this.project.pluginErrors ?? []).filter((e) => !e.outside);
  }

  /** 形を宣言した作品のデータと、宣言したプラグイン（同じファイルは後のプラグインが勝つ）。 */
  private dataOwners(): { plugin: string; decl: DataDeclaration }[] {
    const byFile = new Map<string, { plugin: string; decl: DataDeclaration }>();
    for (const p of this.commandPlugins) for (const decl of p.data ?? []) byFile.set(decl.file, { plugin: p.name, decl });
    return [...byFile.values()];
  }

  /** プラグイン（標準の命令を含む）が形を宣言した作品のデータ（制作画面の自動のフォームと、名前を変えたときの書き換え）。 */
  dataDeclarations(): DataDeclaration[] {
    return dataDeclarations(this.commandPlugins);
  }

  /** 作品のデータの訳す文（lim i18n と同じもの。訳の画面に並べる）。 */
  dataTexts(): DataText[] {
    return projectDataTexts(this.commandPlugins, this.dataReader());
  }

  /** 素材のフォルダ（決まったものと、命令の仕様が探し先に挙げるもの）。 */
  assetFolders(): string[] {
    const folders = new Set<string>(ASSET_FOLDERS);
    for (const spec of this.registry.values()) for (const p of Object.values(spec.params)) if (p.type.kind === "asset") folders.add(p.type.folder);
    return [...folders];
  }

  /** 素材の一覧。. で始まるファイル・フォルダは見ない。 */
  assets(): AssetIndex {
    if (this.assetIndex) return this.assetIndex;
    const index: AssetIndex = {};
    for (const folder of this.assetFolders()) {
      const root = join(this.project.paths.assets, folder);
      const out: string[] = [];
      const walk = (dir: string) => {
        if (!existsSync(dir)) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith(".")) continue;
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile()) out.push(relative(root, p).split(sep).join("/"));
        }
      };
      walk(root);
      index[folder] = out.sort();
    }
    return (this.assetIndex = index);
  }

  /**
   * 検査が作品のファイルを読む口（projectFiles。作品の CSS と @import の先、url() の指すもの、画面のテンプレートと画面の JS）で、
   * 前の検査が読んだか、あるかを確かめたファイル（絶対パス）。開発サーバーはこれを見張り、外で変わったら検査とゲームの画面のタブを
   * 取り直させる（screens-changed）。検査が読むものを足しても、見張りから漏れない。
   */
  private checkedFiles = new Set<string>();
  /** checkedFiles が増えたときに呼ぶ（開発サーバーの見張りが足す）。 */
  onCheckedFiles: ((files: readonly string[]) => void) | null = null;

  /** 前の検査が projectFiles で読んだファイル（絶対パス）。 */
  checkedProjectFiles(): string[] {
    return [...this.checkedFiles];
  }

  /** 外で変わったファイル（絶対パス）が、前の検査が projectFiles で読んだものなら知らせを返す。 */
  screenFileChanged(path: string): StudioEvent | null {
    return this.checkedFiles.has(path) ? { type: "screens-changed" } : null;
  }

  /** projectFiles の口。読んだファイルを覚え、検査が終わったら新しく読んだものを onCheckedFiles に渡す。 */
  private recordedProjectFiles(): ReturnType<typeof projectFileReader> {
    const reader = projectFileReader(this.project.root);
    const read = new Set<string>();
    const note = (path: string) => {
      const abs = join(this.project.root, ...path.split("/"));
      if (abs.startsWith(this.project.root + sep)) read.add(abs);
    };
    queueMicrotask(() => {
      const added = [...read].filter((f) => !this.checkedFiles.has(f));
      this.checkedFiles = read;
      if (added.length > 0) this.onCheckedFiles?.(added);
    });
    return {
      text: (path) => (note(path), reader.text(path)),
      exists: (path) => (note(path), reader.exists(path)),
    };
  }

  /** 素材のフォルダの見張りから呼ぶ（path は増えた・減ったファイルの絶対パス）。一覧に関わるなら知らせを返す。 */
  assetsChanged(path: string): StudioEvent | null {
    const rel = relative(this.project.paths.assets, path);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    const [folder, ...rest] = rel.split(sep);
    if (!folder || rest.length === 0 || !this.assetFolders().includes(folder) || rest.some((p) => p.startsWith("."))) return null;
    this.assetIndex = null;
    return { type: "assets-changed" };
  }

  // ---- 書く（書き込み口） ----

  /**
   * file を text にする。baseHash がディスクの内容の hash と違えば書かずに WriteConflict を返す（新しいファイルは null）。
   * 内容が変わるなら、前の版を履歴に残してから、一時ファイルから rename して書く。
   * 書いたあとはプロジェクト全体を一度だけ検査し、全体（check）とこのファイルの分（diagnostics）を返す（画面はこれを使い、検査をし直さない）。
   * check が false なら書いたあとの検査をしない（名前の変更や置換で多くのファイルを続けて書くとき。diagnostics は空）。
   */
  write(file: string, text: string, baseHash: string | null, check = true): { ok: true; result: WriteResult } | { ok: false; conflict: WriteConflict } {
    const path = this.path(file);
    const exists = existsSync(path);
    const current = exists ? readFileSync(path, "utf8") : null;
    const currentHash = current === null ? null : hashText(current);
    if (currentHash !== baseHash) {
      if (current === null) throw new StudioError(404, `${file}.lim がありません（ほかで削除されたか、名前が変更されました）`);
      return { ok: false, conflict: { file, current: { file, text: current, hash: currentHash! } } };
    }
    const hash = hashText(text);
    let history: string | null = null;
    if (current !== text) {
      // UTF-8 で読めない台本（Shift_JIS など）は、化けた字面で上書きしない（名前の変更、整形、置換、編集のどれも。元の文字に戻せなくなる）
      if (scenarioFileEncoding(path, current)) throw new StudioError(400, notUtf8StopMessage([file]));
      if (current !== null) history = this.keepHistory(file, current);
      writeAtomic(path, text);
      this.known.set(file, hash);
      this.invalidate();
      const by = this.writer === undefined ? {} : { by: this.writer };
      this.announce?.(current === null ? { type: "file-added", file, ...by } : { type: "file-changed", file, hash, ...by });
    }
    if (!check) return { ok: true, result: { file, hash, diagnostics: [], history } };
    const all = this.check();
    return { ok: true, result: { file, hash, diagnostics: all.diagnostics.filter((d) => d.file === file), history, check: all } };
  }

  private historyDir(file: string): string {
    this.path(file); // 名前を確かめる
    return join(this.project.root, HISTORY_DIR, ...file.split("/"));
  }

  /** 前の版を履歴に残し、そのファイルの古いものを間引く（./versions.ts）。履歴の id を返す。 */
  private keepHistory(file: string, text: string): string {
    return keepVersion(this.historyDir(file), ".lim", text);
  }

  history(file: string): HistoryEntry[] {
    return listVersions(this.historyDir(file), ".lim").map((v) => ({ id: v.id, time: new Date(v.time).toISOString(), bytes: v.bytes }));
  }

  historyItem(file: string, id: string): FileText {
    if (!/^[0-9]{8}-[0-9]{6}-[0-9]{3}(-[0-9]+)?$/.test(id)) throw new StudioError(400, `変更履歴の ID として使えません: ${id}`);
    const path = join(this.historyDir(file), `${id}.lim`);
    if (!existsSync(path)) throw new StudioError(404, `${file} の変更履歴 ${id} はありません`);
    const text = readFileSync(path, "utf8");
    return { file, text, hash: hashText(text) };
  }

  /**
   * 画面 by（STUDIO_WINDOW_HEADER）の頼みとして fn を動かす。fn の中で書いた・消した台本は by を添えて知らせ、書いた画面は読み飛ばす。
   * fn は待たずに終わるもの（書き込みはどれも同期）。
   */
  as<T>(by: string | undefined, fn: () => T): T {
    const before = this.writer;
    this.writer = by;
    try {
      return fn();
    } finally {
      this.writer = before;
    }
  }

  /** 開発サーバーが自分で消した・戻した台本のファイル（名前の変更・ごみ箱）を、知っている内容に反映して画面へ知らせる。 */
  touched(path: string): void {
    const e = this.changed(path);
    if (e?.type === "file-added" || e?.type === "file-changed" || e?.type === "file-removed") this.announce?.(this.writer === undefined ? e : { ...e, by: this.writer });
  }

  // ---- 外の変更 ----

  /**
   * ファイルの見張りから呼ぶ（path は変わったファイルの絶対パス）。知らせることがあれば返す。
   * 自分が書いた内容と同じなら知らせない。
   */
  changed(path: string): StudioEvent | null {
    if (path === this.project.paths.cast) {
      this.cast = readCast(this.project);
      // 話者が変わると本文の解析が変わる
      this.parsed.clear();
      this.programCache.clear();
      this.sweepSource.runtime = this.runtimeOptions(this.sweepData);
      this.invalidate();
      return { type: "cast-changed" };
    }
    const rel = relative(this.project.paths.scenario, path);
    if (rel.startsWith("..") || isAbsolute(rel) || !rel.endsWith(".lim")) return null;
    const file = rel.slice(0, -4).split(sep).join("/");
    if (!isFileName(file)) return null;
    const known = this.known.get(file);
    if (!existsSync(path)) {
      if (known === undefined) return null;
      this.known.delete(file);
      this.parsed.delete(file);
      this.programCache.delete(file);
      this.invalidate();
      return { type: "file-removed", file };
    }
    const hash = hashText(readFileSync(path, "utf8"));
    if (hash === known) return null;
    this.known.set(file, hash);
    this.invalidate();
    return known === undefined ? { type: "file-added", file } : { type: "file-changed", file, hash };
  }

  /** どれかの .lim（か話者）が変わった。覚えた道筋と現在地を捨てる。 */
  private invalidate(): void {
    this.generation++;
    this.sweeper.reset();
    this.sweeps.clear();
    this.pinned.clear();
  }

  // ---- 点検 ----

  /**
   * まだ書いていない台本の中身を、ほかのファイルと合わせて検査し、そのファイルの診断だけを返す（プラグインの ctx.check。
   * AI の案を反映する前に確かめるのに使う）。検査は check と同じ（lim check と同じ一覧）で、その台本だけをディスクの代わりに text で見る。
   * scope が "project" なら、ほかのファイルの診断も返す（書くとほかのファイルの誤りが増えるかを見る。lim mcp）。
   */
  checkText(file: string, text: string, scope: "file" | "project" = "file"): Diagnostic[] {
    // 制作画面の分類は外す（lim check の診断と同じ形で返す）
    const all = this.diagnose({ file, text }).map(({ category: _category, ...d }): Diagnostic => d);
    return scope === "project" ? all : all.filter((d) => d.file === file);
  }

  /**
   * 書いたものの検査（lim check と同じもの）を分類する。
   * 保存のたびに書き込み口から呼ぶので、ファイルの一覧と liminalia.json は一度だけ読む。
   */
  check(): CheckResult {
    const checked = this.diagnose();
    const counts: Record<CheckCategory, number> = { syntax: 0, command: 0, cast: 0, target: 0, asset: 0, plugin: 0 };
    for (const d of checked) counts[d.category]++;
    return { at: new Date().toISOString(), diagnostics: checked, counts };
  }

  /**
   * 作品全体の検査（lim check、VS Code、MCP と同じ一覧。@liminalia/sdk の projectDiagnostics に、制作画面の読み方で読んだものを渡す）。
   * override の台本は、ディスクの代わりにその字面で見る（まだ書いていない中身）。制作画面の分類（category）を付け、
   * 読み込めなかったプラグインの命令の指摘を一つにまとめる。
   */
  private diagnose(override?: { file: string; text: string }): CheckedDiagnostic[] {
    const config = this.readConfig();
    const names = this.files();
    if (override && !names.includes(override.file)) names.push(override.file);
    const files = new Map<string, { script: Script; text: string }>();
    // UTF-8 で読めない台本（Shift_JIS など）は bad-encoding だけにする（lim check と同じ）
    const encodings = new Map<string, string>();
    for (const file of names.sort()) {
      if (file === override?.file) {
        files.set(file, { script: parse(override.text, file, { speakers: this.cast.speakers }), text: override.text });
        continue;
      }
      const { script, text } = this.read(file);
      files.set(file, { script, text });
      const encoding = scenarioFileEncoding(this.path(file), text);
      if (encoding) encodings.set(file, encoding);
    }
    const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
    const schema = (name: "liminalia" | "cast" | "lang") => {
      try {
        return configSchema(name);
      } catch {
        // Schema を読めない環境（スマホ版の Service Worker など）では、JSON の書き方の誤りだけを見る
        return null;
      }
    };
    // 素材の実在（lim check、lim build と同じ参照の集め方。同じ素材は一度だけ確かめる）
    const exists = new Map<string, boolean>();
    const has = (folder: string, path: string) => {
      const key = `${folder}/${path}`;
      let found = exists.get(key);
      if (found === undefined) exists.set(key, (found = existsSync(join(this.project.paths.assets, folder, path))));
      return found;
    };
    const index = this.assets();
    const castFile = relative(this.project.root, this.project.paths.cast).split(sep).join("/");
    const templateRules = screenTemplateRules();
    const diagnostics = projectDiagnostics({
      root: this.project.root,
      files,
      config,
      configText: read(join(this.project.root, "liminalia.json")),
      cast: this.cast.cast,
      speakers: this.cast.speakers,
      castText: read(this.project.paths.cast),
      castFile,
      schemas: { liminalia: schema("liminalia"), cast: schema("cast"), lang: schema("lang") },
      registry: this.registry,
      baseRegistry: this.baseRegistry,
      plugins: this.commandPlugins,
      data: this.dataReader(),
      dataText: (name) => {
        const path = join(this.project.paths.data, ...name.split("/"));
        return path.startsWith(this.project.paths.data + sep) && existsSync(path) ? readFileSync(path, "utf8") : undefined;
      },
      dataFolder: relative(this.project.root, this.project.paths.data).split(sep).join("/") || "data",
      translations: (config.languages ?? []).slice(1).map((language) => ({ language, text: read(join(this.project.paths.lang, `${language}.json`)) })),
      // 大文字と小文字の違い（asset-case-mismatch）も lim check と同じに見る
      assets: { exists: has, files: (folder) => index[folder], actual: assetNames(this.project.paths.assets), head: assetHeads(this.project.paths.assets) },
      voiceLockText: read(this.project.paths.voiceLock),
      // パックの台本と訳（lim check と同じ）
      packs: listPackSources(this.project.root),
      // 作品の CSS（ui.css）と、その中の url() の素材
      projectFiles: this.recordedProjectFiles(),
      readFont: (file) => {
        const path = join(this.project.paths.assets, "others", file);
        return existsSync(path) ? readFileSync(path) : null;
      },
      encodings,
      // 作品の画面のテンプレート（ui.templates。標準の画面の決まりは開発サーバーを立てる側が setScreenTemplateRules で渡す）
      screenTemplates: templateRules ? { rules: templateRules, plugins: pluginScreens(this.project.root, config.plugins) } : null,
      // プラグインの package.json の、合うエンジンの宣言
      more: engineVersionDiagnostics(this.project),
      adjust: (list, syntax) => {
        const out = [...list];
        // 読み込めなかったプラグイン。そのプラグインのコマンドは「未定義のコマンド」になるので、それはこの診断にまとめる
        const brokenPlugins = this.brokenPlugins();
        if (brokenPlugins.length > 0) {
          const isUnknown = (d: Diagnostic) => d.code === "unknown-command" && /^コマンド @\S+ はありません$/.test(d.message);
          const unknown = out.filter(isUnknown);
          const names = [...new Set(unknown.map((d) => /@(\S+)/.exec(d.message)![1]!))];
          for (let i = out.length - 1; i >= 0; i--) if (isUnknown(out[i]!)) out.splice(i, 1);
          out.unshift(...pluginLoadDiagnostics(brokenPlugins, names, unknown.length));
        }
        // 分類を決めてから黙らせる（lim-ignore で黙らせても分類は変わらない）
        return out.map((d): CheckedDiagnostic => ({ ...d, category: syntax.has(d) ? "syntax" : categoryOf(d) }));
      },
    }, this.fileChecks);
    // 使われない lim-ignore の知らせは、黙らせたあとに足されるので分類が無い（台本の書き方として構文に入れる）
    return diagnostics.map((d): CheckedDiagnostic => ("category" in d ? (d as CheckedDiagnostic) : { ...d, category: "syntax" }));
  }

  /**
   * 画面なしで流すときの実行器の設定（現在地、全ルートテスト、ボイスの番号の固定）。遊ぶ側と同じく @liminalia/runtime の
   * projectRuntimeOptions で、今の liminalia.json と voice-lock.json から作る（言語は原文の言語、訳は無し）。
   */
  runtimeOptions(loadData: (name: string) => unknown = this.dataReader()): ProjectRuntimeOptions & { programCache: ProgramCache } {
    // 読み解いた台本は流すたびに作り直さない（本文と話者が同じときだけ使う。runtime の ProgramCache）
    return { ...projectRuntimeOptions({ config: this.readConfig(), speakers: this.cast.speakers, commands: this.implementations, cast: this.cast.cast, voiceLock: this.readVoiceLock(), loadData }), programCache: this.programCache };
  }


  /** 連番のボイスの番号の固定（voice-lock.json）。無い・読めなければ null（遊ぶ側と同じ。読めないことはチェックが知らせる）。 */
  private readVoiceLock(): VoiceLock | null {
    try {
      return readVoiceLock(this.project);
    } catch {
      // 読めない固定は無いものとして流す（遊ぶ側の player-info.ts と同じ。JSON の誤りはチェックが bad-voice-lock で知らせる）
      return null;
    }
  }

  /**
   * 画面なしで流して確かめる（lim coverage と同じもの）。結果は実行したときのファイルの hash を添えて .liminalia/coverage.json に覚える
   * （制作画面だけの覚え書き。止めたときは覚えない）。
   */
  async coverage(runs = DEFAULT_COVERAGE_RUNS, onProgress?: (p: { done: number; total: number; file: string }) => void, signal?: AbortSignal): Promise<CoverageResult> {
    // 下書き（// lim: draft）は流さないので、実行後に変わったかも見ない
    const hashes = Object.fromEntries(this.files().filter((f) => !this.read(f).script.draft).map((f) => [f, this.read(f).hash] as const));
    const inputs = this.coverageInputs();
    const report = await coverage({
      ...(onProgress ? { onProgress } : {}),
      ...(signal ? { signal } : {}),
      files: this.files(),
      loadSource: async (file) => this.read(file).text,
      runtime: this.runtimeOptions(),
      runs,
      promised: promisedTargets(this.mapInput()),
    });
    const result: CoverageResult = {
      at: new Date().toISOString(),
      files: report.files.map((f) => ({ file: f.file, lines: f.lines.length, reached: f.reached.size, unreached: f.lines.filter((l) => !f.reached.has(l)) })),
      diagnostics: report.diagnostics.map((d) => d.diagnostic),
      hashes,
      engine: ENGINE_VERSION,
      inputs,
    };
    if (!signal?.aborted) {
      try {
        writeAtomic(this.coveragePath(), `${JSON.stringify(result)}\n`);
      } catch (e) {
        // 覚えられなくても結果は返す
        console.error(e);
      }
    }
    return result;
  }

  private coveragePath(): string {
    return join(this.project.root, ".liminalia", "coverage.json");
  }

  /**
   * 前に覚えた全ルートテストの結果（無い・読めなければ null）。実行したエンジンの版が今と違う（版を覚えていない前の版の結果も）か、
   * 実行後に設定（coverageInputs）が変わっていれば outdated を付ける（画面は古い結果として出す）。
   */
  lastCoverage(): CoverageResult | null {
    let r: CoverageResult;
    try {
      const path = this.coveragePath();
      if (!existsSync(path)) return null;
      r = JSON.parse(readFileSync(path, "utf8")) as CoverageResult;
      if (!(typeof r.at === "string" && Array.isArray(r.files) && Array.isArray(r.diagnostics))) return null;
    } catch {
      // 網羅の結果が無い・読めなければ、まだ流していないものとする
      return null;
    }
    const { outdated: _, ...result } = r;
    if (result.engine !== ENGINE_VERSION) return { ...result, outdated: "engine" };
    if (result.inputs !== this.coverageInputs()) return { ...result, outdated: "settings" };
    return result;
  }

  /**
   * シナリオのほかで全ルートテストの流れ方を変えるものの hash（liminalia.json、cast.json、voice-lock.json、作品のデータの .json、プラグインのコマンドの出どころ）。
   * 結果に添え、あとで比べて古い結果かを見る。読めないファイルは無いものとして数える。
   */
  coverageInputs(): string {
    const hash = createHash("sha256");
    const add = (name: string, path: string) => {
      let text = "";
      try {
        text = readFileSync(path, "utf8");
      } catch {
        // 無い・読めないファイルは空として数える（増えたり直ったりすれば hash が変わる）
      }
      hash.update(`${name}\0${text}\0`);
    };
    add("liminalia.json", join(this.project.root, "liminalia.json"));
    add("cast.json", this.project.paths.cast);
    // ボイスの番号の固定も実行器に渡す（遊ぶ側と同じ）
    add("voice-lock.json", this.project.paths.voiceLock);
    for (const name of dataFiles(this.project.paths.data)) add(`data/${name}`, join(this.project.paths.data, ...name.split("/")));
    hash.update(JSON.stringify(Object.entries(this.sources).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
    return hash.digest("hex").slice(0, 16);
  }

  // ---- 地図 ----

  /** 台本から作る分岐の俯瞰。 */
  storyMap(): StoryMap {
    const endingKinds = this.readConfig().endingKinds;
    return buildStoryMap({ ...this.mapInput(), entry: this.project.config.entry, variables: this.readVariables(), ...(endingKinds ? { endingKinds } : {}) });
  }

  /** 地図と全ルートテストが読む、台本・命令の行き先・作品のデータ。 */
  private mapInput(): Pick<StoryMapInput, "scripts" | "registry" | "hooks" | "data"> {
    const scripts = new Map<string, { script: Script; text: string }>();
    for (const file of this.files()) {
      const { script, text } = this.read(file);
      scripts.set(file, { script, text });
    }
    return { scripts, registry: this.registry, hooks: this.targetHooks, data: this.dataReader() };
  }

  /** 作品のデータ（paths.data の .json）を名前で読む口。一度読んだものはその口の中で覚える。 */
  /** 作品のデータを読む。読んだときのファイルの更新時刻を覚え、変わっていれば読み直す（現在地を作る間ずっと使うもの）。 */
  private liveDataReader(): (name: string) => unknown {
    const cache = new Map<string, { mtime: number; value: unknown }>();
    return (raw: string): unknown => {
      const name = withJson(raw);
      const path = join(this.project.paths.data, ...name.split("/"));
      if (!path.startsWith(this.project.paths.data + sep)) return undefined;
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        // 消えたデータは無いものとする
        cache.delete(name);
        return undefined;
      }
      const known = cache.get(name);
      if (known && known.mtime === mtime) return known.value;
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        // 読めないデータは無いものとして渡す（データの形の誤りはチェックが知らせる）
        value = undefined;
      }
      cache.set(name, { mtime, value });
      return value;
    };
  }

  private dataReader(): (name: string) => unknown {
    const cache = new Map<string, unknown>();
    return (raw: string): unknown => {
      const name = withJson(raw);
      if (!cache.has(name)) {
        let value: unknown;
        try {
          const path = join(this.project.paths.data, ...name.split("/"));
          if (path.startsWith(this.project.paths.data + sep) && existsSync(path)) value = JSON.parse(readFileSync(path, "utf8"));
        } catch {
          // 読めないデータは無いものとして渡す（データの形の誤りはチェックが知らせる）
          value = undefined;
        }
        cache.set(name, value);
      }
      return cache.get(name);
    };
  }

  // ---- 現在地 ----

  /** そのファイルの現在地。覚えていればそれを返す。json は Sweep を JSON にしたもの、gz はそれを gzip したもの。 */
  sweep(file: string): Promise<{ sweep: Sweep; json: string; gz: () => Promise<Buffer> }> {
    const run = this.queue.then(async () => {
      const { hash } = this.read(file);
      // 届かない行のために探した道筋があれば、そちらを使う（reach）
      const pinned = this.pinned.get(file);
      let cached = pinned && pinned.hash === hash ? pinned : this.sweeps.get(file);
      if (cached && cached.hash === hash) remember(cached === pinned ? this.pinned : this.sweeps, file, cached);
      if (!cached || cached.hash !== hash) {
        const generation = this.generation;
        const sweep: Sweep = { ...(await this.sweeper.sweep(file)), hash };
        cached = { hash, sweep, json: JSON.stringify(sweep), gz: null, track: null };
        if (generation === this.generation) remember(this.sweeps, file, cached);
      }
      const entry = cached;
      return {
        sweep: entry.sweep,
        json: entry.json,
        gz: async () => (entry.gz ??= await gzipAsync(entry.json, { level: 6 })),
      };
    });
    // 失敗は呼んだ側が run で受ける。列は次へ進める
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * その行に届く現在地。今の現在地（ふつうの道筋か、前にほかの行のために探した道筋）がその行を通ればそれ、通らなければ
   * その行を通る道筋を探して作り直す（Sweeper.entryReaching）。見つかった道筋はそのファイルの現在地として、ファイルが変わるか
   * ほかの行のために探し直すまで使う（sweep が返す）。
   */
  reach(file: string, line: number, signal?: AbortSignal): Promise<SweepReach> {
    // ほかの行を頼まれたら、探している途中のものはやめる（同じ行なら、前の探索の結果を待って使う）。
    // 待っている間にどれかの .lim が変わったときと、頼みが切れたときもやめる
    const key = `${file}:${line}`;
    if (key !== this.reachKey) {
      this.reachKey = key;
      this.reachToken++;
    }
    const token = this.reachToken;
    const startGeneration = this.generation;
    const stopped = () => token !== this.reachToken || startGeneration !== this.generation || !!signal?.aborted;
    const stop: SweepSignal = {
      get aborted() {
        return stopped();
      },
    };
    const run = this.queue.then(async (): Promise<SweepReach> => {
      if (stop.aborted) return { sweep: null, reason: "cancelled" };
      const { hash } = this.read(file);
      const has = (s: Sweep) => line in s.lines || line in s.after;
      const pinned = this.pinned.get(file);
      if (pinned && pinned.hash === hash && has(pinned.sweep)) return { sweep: pinned.sweep };
      const normal = this.sweeps.get(file);
      if (normal && normal.hash === hash && has(normal.sweep)) {
        this.pinned.delete(file);
        return { sweep: normal.sweep };
      }
      const generation = this.generation;
      const found = await this.sweeper.entryReaching(file, line, this.routeGuide(file, line), stop);
      if (!found.entry) return { sweep: null, reason: found.reason };
      const sweep: Sweep = { ...(await this.sweeper.sweep(file, found.entry)), hash, target: line };
      if (generation === this.generation) remember(this.pinned, file, { hash, sweep, json: JSON.stringify(sweep), gz: null, track: null });
      return { sweep };
    });
    // 失敗は呼んだ側が run で受ける。列は次へ進める
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 届かない行へ届く道筋の探索の手がかり（../sweep.ts の routeGuide）。 */
  private routeGuide(file: string, line: number): RouteGuide {
    return routeGuide(this.storyMap(), new Map(this.files().map((f) => [f, this.read(f).script] as const)), file, line);
  }

  /** そのファイルの持続の帯（現在地から抜き出す。現在地と一緒に覚えておく）。 */
  async stageTrack(file: string): Promise<StageTrack> {
    const { sweep } = await this.sweep(file);
    const cached = this.pinned.get(file)?.sweep === sweep ? this.pinned.get(file) : this.sweeps.get(file);
    const layout = { rules: this.autoLayoutOption().autoLayout, side: castSides(this.cast.cast as Cast) };
    const cast = this.cast.cast as Cast;
    if (cached?.sweep === sweep) return (cached.track ??= stageTrack(sweep, layout, cast));
    return stageTrack(sweep, layout, cast);
  }
}

/** 読み込めないプラグインの理由の英語（@liminalia/project が書く決まった理由。ほかは例外の文のまま）。 */
/**
 * 実行器の設定のうち、現在地の流れ方を変えるもの（変わったら現在地を作り直す）。CG の一覧（cg）は現在地の中身を変えないので数えない。
 * 話者、命令、キャストは cast.json とプラグインの読み直しで作り直すので、ここでは見ない。
 */
function sweepKey(o: SweepSource["runtime"]): string {
  return JSON.stringify([o.variables ?? {}, o.language ?? "", o.chapters ?? [], o.gameVersion ?? "", o.chatDialogue ?? null, o.stripQuotes?.() ?? false, o.commandDefaults ?? {}, o.autoLayout ?? null, o.achievementGoals ?? {}, o.endingAchievements ?? {}, o.endingKinds ?? null, o.afterLoad ?? "", o.voiceLock ?? null]);
}

export const PLUGIN_REASONS_EN: Record<string, string> = {
  パッケージが見つかりません: "package not found",
  フォルダがありません: "folder not found",
  "package.json がありません": "no package.json",
  "読み込むモジュールが見つかりません（npm install で入れるか、import の書き方を確かめます）": "a module it imports wasn't found (install it with npm install or check the import)",
};

/** 読み込めないプラグインの理由の英語（決まった理由と、@liminalia/project の pluginErrorReason の形）。 */
export function pluginReasonEn(reason: string): string {
  const fixed = PLUGIN_REASONS_EN[reason];
  if (fixed) return fixed;
  let m = /^入口のファイル (.+) がありません$/.exec(reason);
  if (m) return `the entry file ${m[1]} doesn't exist`;
  m = /^読み込むモジュール (.+) が見つかりません（npm install で入れるか、import の書き方を確かめます）$/.exec(reason);
  if (m) return `the module ${m[1]} it imports wasn't found (install it with npm install or check the import)`;
  m = /^(.+) の書き方の誤り（(.*)）$/.exec(reason);
  if (m) return `a syntax error in ${m[1]} (${m[2]})`;
  return reason;
}

/**
 * 読み込めなかったプラグインの診断（チェックの「プラグイン」の分類）。そのプラグインのコマンドは「未定義のコマンド」になるので、
 * 呼ぶ側はそれを外して、名前と数（names、count）をここに渡す。一つ目の診断にだけ添える（どのプラグインのものかは読み込めないと分からない）。
 */
export function pluginLoadDiagnostics(broken: readonly Pick<PluginLoadError, "spec" | "message">[], names: readonly string[], count: number): Diagnostic[] {
  const shown = names.slice(0, 5).map((n) => `@${n}`);
  const more = names.length > 5;
  return broken.map((e, i): Diagnostic => ({
    severity: "error",
    code: "plugin-load",
    message: pluginLoadMessage(e),
    messageEn: `Can't load the plugin ${e.spec} (${pluginReasonEn(e.message)})`,
    file: "liminalia.json",
    line: 1,
    plugin: e.spec,
    ...(i === 0 && count > 0
      ? {
          hint: `未定義のコマンド ${[...shown, ...(more ? ["…"] : [])].join("、")}（${count} か所）は、このプラグインのものかもしれません。読み込めるように直すと消えます`,
          hintEn: `The unknown ${count === 1 ? "command" : "commands"} ${[...shown, ...(more ? ["…"] : [])].join(", ")} (${count} ${count === 1 ? "place" : "places"}) may belong to this plugin. They go away once it loads`,
        }
      : {}),
  }));
}

/** 検査の診断の分類（文法の誤りは呼ぶ側が解析の診断かどうかで分ける）。 */
export function categoryOf(d: Diagnostic): CheckCategory {
  if (d.plugin) return "plugin";
  switch (d.code) {
    case "bad-cast":
    case "cast-ambiguous":
    case "unknown-speaker":
    case "unused-speaker":
    case "unknown-cast":
    case "unknown-appearance":
    case "unknown-variant":
    case "unknown-position":
    case "model-plugin-missing":
      return "cast";
    case "unknown-file":
    case "unknown-label":
    case "duplicate-label":
    case "bad-target":
    case "unreachable-line":
    case "unused-label":
    case "call-without-return":
      return "target";
    case "missing-asset":
    case "asset-case-mismatch":
    case "missing-voice":
    case "unshown-cg":
    case "lfs-pointer":
    // 作品の CSS（ui.css）の無いファイルと、その中の url() の無い素材
    case "ui-css-missing":
    case "ui-css-asset":
      return "asset";
    // 約物の検査（本文の書き方）
    case "bracket-mismatch":
    case "doubled-punctuation":
    case "space-after-exclamation":
    case "single-ellipsis":
    case "aozora-ruby":
    case "tyrano-tag":
      return "syntax";
    case "bad-value":
      // キャラクター ID の誤り（キャスト型のパラメータ）はキャラクターへ（言語の検査の文言の新旧どちらでも）
      return /(キャラクター|キャスト) .* は登録されていません/.test(d.message) ? "cast" : "command";
    default:
      return "command";
  }
}

/** 作品のデータの名前に .json を付ける（省いたとき。名前に点があってもよい: code.en → code.en.json）。 */
function withJson(name: string): string {
  return name.endsWith(".json") ? name : `${name}.json`;
}
