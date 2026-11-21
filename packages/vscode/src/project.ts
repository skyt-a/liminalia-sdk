import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assetNameResolver, CORE_COMMANDS, createRegistry, LFS_HEAD_BYTES, withCommandDefaults, type CommandDefaults, type DataDeclaration, type JsonSchema, type Registry } from "@liminalia/lang";
import { listPackSources, listScenarioFiles as listProjectScenarioFiles, scenarioFileEncoding } from "@liminalia/project/scenario-files";
import { pluginScreens } from "@liminalia/project/screen-templates";
import { screenTemplateRules } from "@liminalia/screens/rules";
import { combinePlugins, dataDeclarations, type CommandPlugin } from "@liminalia/sdk";
import std from "@liminalia/std/commands";
import type { CommandImpl } from "@liminalia/runtime";
import { URI } from "vscode-uri";
import type { ProjectInput, ProjectWork, ScenarioFile } from "./model.ts";

/**
 * プロジェクトのフォルダを読む部分（Node のファイル操作）。
 * @liminalia/project と同じ規則だが、拡張機能は一つのファイルに束ねて配るので、
 * 標準の命令（@liminalia/std）は束ねたものを使い、パッケージの場所を探さない。
 */

export const CONFIG_FILE = "liminalia.json";

export interface ProjectInfo {
  root: string;
  configFile: string;
  config: {
    entry?: unknown;
    variables?: unknown;
    languages?: string[];
    extra?: unknown;
    afterLoad?: unknown;
    ui?: unknown;
    items?: unknown;
    allowScript?: unknown;
    check?: { punctuation?: unknown; severity?: unknown; sound?: unknown };
    fmt?: { indent?: unknown; expressions?: unknown };
    commandDefaults?: unknown;
    plugins?: string[];
    paths?: Partial<Record<"scenario" | "assets" | "data" | "cast" | "lang" | "voiceLock", string>>;
    [key: string]: unknown;
  };
  paths: { scenario: string; assets: string; data: string; cast: string; lang: string; voiceLock: string };
  /** プロジェクトのプラグインのフォルダ（標準の命令は含まない）。 */
  plugins: string[];
}

/** file のあるフォルダから上へたどって liminalia.json のあるフォルダを探す。無ければ null。 */
export function findProjectRoot(file: string): string | null {
  let dir = dirname(resolve(file));
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readProjectInfo(root: string): ProjectInfo {
  const configFile = join(root, CONFIG_FILE);
  const config = JSON.parse(readFileSync(configFile, "utf8")) as ProjectInfo["config"];
  const p = config.paths ?? {};
  const at = (v: string | undefined, d: string) => resolve(root, v ?? d);
  return {
    root,
    configFile,
    config,
    paths: { scenario: at(p.scenario, "scenario"), assets: at(p.assets, "assets"), data: at(p.data, "data"), cast: at(p.cast, "cast.json"), lang: at(p.lang, "lang"), voiceLock: at(p.voiceLock, "voice-lock.json") },
    plugins: (config.plugins ?? []).map((spec) => resolvePackageDir(root, spec)),
  };
}

/** "./plugins/x" ならプロジェクトからの相対、それ以外はプロジェクトから見たパッケージ名として探す。 */
function resolvePackageDir(root: string, spec: string): string {
  if (spec.startsWith(".") || isAbsolute(spec)) return resolve(root, spec);
  const require = createRequire(join(root, "package.json"));
  return dirname(require.resolve(`${spec}/package.json`));
}

/** プラグインのパッケージの exports から "./commands" の入口のファイルを求める。無ければ null。 */
export function commandsEntry(pluginDir: string): string | null {
  const pkgFile = join(pluginDir, "package.json");
  if (!existsSync(pkgFile)) throw new Error(`プラグイン ${pluginDir} に package.json がありません`);
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { exports?: Record<string, string | { import?: string; default?: string }> };
  const target = pkg.exports?.["./commands"];
  const path = typeof target === "string" ? target : (target?.import ?? target?.default);
  return path ? resolve(pluginDir, path) : null;
}

export function readCastFile(path: string): { speakers: string[]; cast: Record<string, unknown> } {
  if (!existsSync(path)) return { speakers: [], cast: {} };
  const json = JSON.parse(readFileSync(path, "utf8")) as { speakers?: unknown; cast?: unknown };
  const speakers = Array.isArray(json.speakers) ? json.speakers.filter((s): s is string => typeof s === "string" && s !== "") : [];
  const cast = json.cast && typeof json.cast === "object" && !Array.isArray(json.cast) ? (json.cast as Record<string, unknown>) : {};
  return { speakers, cast };
}

/**
 * シナリオのフォルダの .lim（lim check と同じく、サブフォルダの台本も。. で始まるファイルとフォルダは見ない）。
 * 名前（"start"、"part1/chapter2"）→ パス。名前の順。一覧は lim check、制作画面と同じ @liminalia/project の listScenarioFiles で作る。
 */
export function listScenarioFiles(dir: string): Map<string, string> {
  return new Map(listProjectScenarioFiles(dir).map((f) => [f.name, f.path]));
}

/** シナリオのフォルダの中の .lim なら、その台本の名前（"part1/chapter2"）。フォルダの外か、. で始まる場所なら null。 */
export function scenarioName(dir: string, path: string): string | null {
  const rel = relative(resolve(dir), resolve(path));
  if (rel === "" || isAbsolute(rel) || !rel.endsWith(".lim")) return null;
  const parts = rel.slice(0, -".lim".length).split(/[\\/]/);
  if (parts.some((p) => p === "" || p === ".." || p.startsWith("."))) return null;
  return parts.join("/");
}

/** 素材のフォルダの中のファイル（フォルダからのパス、区切りは /）。隠しファイルは除き、多すぎるときは打ち切る。 */
export function listAssets(dir: string, limit = 5000): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (out.length >= limit) return;
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) visit(full);
      else out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  visit(dir);
  return out;
}

/**
 * プロジェクトの入力（シナリオ・訳のファイル・命令・話者・キャスト）を作る。
 * textOf はファイルの中身（開いているファイルは保存前のもの。無ければ null）。diskText はディスクの中身（UTF-8 として読んだもの。既定は textOf）。
 */
export function buildInput(
  info: ProjectInfo,
  loaded: { commands: LoadedCommands; speakers: readonly string[]; cast: Readonly<Record<string, unknown>> },
  textOf: (path: string) => string | null,
  assets: (folder: string) => readonly string[],
  diskText: (path: string) => string | null = textOf,
): ProjectInput {
  const files = new Map<string, ScenarioFile>();
  // UTF-8 で読めない台本（Shift_JIS など）は、lim check、制作画面と同じく bad-encoding だけにする（ディスクの中身で見る。化けた字が無ければ読み直さない）
  const encodings = new Map<string, string>();
  for (const [name, path] of listScenarioFiles(info.paths.scenario)) {
    files.set(name, { uri: URI.file(path).toString(), text: textOf(path) ?? "" });
    const encoding = scenarioFileEncoding(path, diskText(path));
    if (encoding) encodings.set(name, encoding);
  }
  const config = info.config;
  const translations = (config.languages ?? []).slice(1).map((language) => ({ language, text: textOf(join(info.paths.lang, `${language}.json`)) }));
  const dataPath = (name: string) => {
    const path = join(info.paths.data, ...(name.endsWith(".json") ? name : `${name}.json`).split("/"));
    return path.startsWith(info.paths.data + sep) ? path : null;
  };
  const dataText = (name: string) => {
    const path = dataPath(name);
    return path === null ? undefined : (textOf(path) ?? undefined);
  };
  const work: ProjectWork = {
    root: info.root,
    config,
    configText: textOf(info.configFile),
    castText: textOf(info.paths.cast),
    castFile: relative(info.root, info.paths.cast).split(sep).join("/") || "cast.json",
    plugins: loaded.commands.plugins,
    data: (name) => {
      // 開いているデータは保存前の中身で（読めなければ無いものとする。データの形の誤りは検査が知らせる）
      const text = dataText(name);
      if (text === undefined) return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // 読めないデータは無いものとして渡す（データの形の誤りはプラグインの検査が知らせる）
        return undefined;
      }
    },
    dataText,
    dataFolder: relative(info.root, info.paths.data).split(sep).join("/") || "data",
    voiceLockText: textOf(info.paths.voiceLock),
    // パックの台本と訳（lim check と同じ。開いているファイルは保存前の中身）
    packs: listPackSources(info.root, textOf),
    // 作品の CSS（ui.css）と、その中の url() の素材（lim check と同じ。開いている CSS は保存前の中身）
    projectFiles: {
      text: (path) => {
        const file = join(info.root, ...path.split("/"));
        return existsSync(file) && statSync(file).isFile() ? textOf(file) : null;
      },
      exists: (path) => {
        const file = join(info.root, ...path.split("/"));
        return existsSync(file) && statSync(file).isFile();
      },
    },
    readFont: (file) => {
      const path = join(info.paths.assets, "others", file);
      try {
        return readFileSync(path);
      } catch {
        // 無いフォントは調べない（縦書きの検査は、読めたフォントだけを見る）
        return null;
      }
    },
    langSchema: langSchema(),
    encodings,
    // 作品の画面のテンプレート（ui.templates。ファイルは projectFiles で読む。画面ごとの決まりは @liminalia/screens の標準の画面の定義から）
    screenTemplates: { rules: screenTemplateRules(), plugins: pluginScreens(info.root, config.plugins) },
  };
  return {
    // プロジェクトのコマンドの既定値（commandDefaults）を重ねる（補完と説明に出し、検査も省いたパラメータをこの値として見る）
    registry: withCommandDefaults(loaded.commands.registry, config.commandDefaults as CommandDefaults | undefined),
    speakers: loaded.speakers,
    cast: loaded.cast,
    files,
    config: { extra: config.extra, afterLoad: config.afterLoad, ui: config.ui, items: config.items, variables: config.variables, allowScript: config.allowScript, punctuation: config.check?.punctuation, severity: config.check?.severity, indent: config.fmt?.indent, formatExpressions: config.fmt?.expressions, sourceLanguage: config.languages?.[0], commandDefaults: config.commandDefaults, baseRegistry: loaded.commands.registry, languages: config.languages, entry: config.entry, sound: config.check?.sound },
    translations,
    assets,
    assetExists: (folder, path) => existsSync(join(info.paths.assets, folder, path)),
    // 大文字と小文字の違い（asset-case-mismatch）も lim check と同じに見る（フォルダの中身を一度の検査のあいだ覚える）
    assetActual: () =>
      assetNameResolver((segments) => {
        try {
          return readdirSync(join(info.paths.assets, ...segments));
        } catch {
          return null;
        }
      }),
    // Git LFS のポインタのままの素材（lfs-pointer）も lim check と同じに見る（ポインタは 1024 バイトより小さいので、大きいファイルは読まない）
    assetHead: (folder, path) => {
      const file = join(info.paths.assets, folder, path);
      try {
        return statSync(file).size >= 1024 ? null : readFileSync(file).subarray(0, LFS_HEAD_BYTES);
      } catch {
        // 読めない素材は、ポインタかどうかを見ない（無いことは missing-asset が知らせる）
        return null;
      }
    },
    pluginFailures: loaded.commands.failures,
    work,
  };
}

let langSchemaCache: JsonSchema | null | undefined;

/** 訳のファイルの JSON Schema（拡張機能に同梱する schemas/lang.schema.json。読めなければ null）。 */
function langSchema(): JsonSchema | null {
  if (langSchemaCache === undefined) {
    try {
      langSchemaCache = JSON.parse(readFileSync(new URL("../schemas/lang.schema.json", import.meta.url), "utf8")) as JsonSchema;
    } catch {
      // 読めなければ、訳のファイルは JSON として読めない所だけを知らせる
      langSchemaCache = null;
    }
  }
  return langSchemaCache;
}

/** 組み込みと標準の命令だけのレジストリ（プロジェクトの外のファイル用）。 */
export function baseRegistry(): Registry {
  return createRegistry(CORE_COMMANDS, combinePlugins([std]).specs);
}

export interface LoadedCommands {
  registry: Registry;
  /** プラグインが形を宣言した作品のデータ（名前の変更で中の飛び先も書き換える）。 */
  data: DataDeclaration[];
  /** 画面なしで動かせる命令（標準の命令と、このプロセスで読めたプラグインの命令。「ここからテストプレイ」の現在地に使う）。 */
  implementations: CommandImpl[];
  /** 読み込めなかったプラグイン（理由つき）。 */
  failures: string[];
  /** 読み込んだプラグイン（標準の命令も。別の Node.js で読んだものは命令の表とデータの宣言だけ）。検査に使う。 */
  plugins: CommandPlugin[];
}

export interface LoadOptions {
  /** 信頼していないフォルダではプラグインのコードを動かさない。 */
  trusted: boolean;
  /**
   * ワークスペースのフォルダ。ワークスペースの信頼はウィンドウ全体で一つなので、プロジェクトの root がこのどれかの中にあるときだけ
   * プラグインを読む（ワークスペースの外で開いた .lim のプロジェクトは、信頼していないときと同じ扱い）。
   */
  workspaceFolders: readonly string[];
  /** 代わりに使う Node.js の実行ファイル。 */
  node: string;
  /** false ならこのプロセスでは import せず、はじめから別の Node.js で読む（テスト用）。 */
  inProcess?: boolean;
  log?: (message: string) => void;
}

/**
 * 組み込み・標準・プロジェクトのプラグインの命令を集める。プラグインはまずこのプロセスで import し、
 * 読めなければ（TypeScript のままなど）別の Node.js で読んで、命令の表だけを JSON で受け取る。
 */
export async function loadCommands(info: ProjectInfo, options: LoadOptions): Promise<LoadedCommands> {
  const plugins: CommandPlugin[] = [std];
  /** このプロセスで読めたもの（別の Node.js で読んだものは命令の表だけで、動かせない）。 */
  const runnable: CommandPlugin[] = [std];
  const failures: string[] = [];
  const refusal = !options.trusted
    ? "信頼されていないフォルダのため、プラグインを読み込みません"
    : !insideWorkspace(info.root, options.workspaceFolders)
      ? "ワークスペースのフォルダの外にあるため、プラグインを読み込みません"
      : null;
  const pending: { dir: string; entry: string }[] = [];
  for (const dir of info.plugins) {
    let entry: string | null;
    try {
      entry = commandsEntry(dir);
    } catch (e) {
      failures.push(message(e));
      continue;
    }
    if (!entry) continue;
    if (refusal !== null) {
      failures.push(`${relative(info.root, dir) || dir}: ${refusal}`);
      continue;
    }
    if (options.inProcess === false) {
      pending.push({ dir, entry });
      continue;
    }
    try {
      const mtime = statSync(entry).mtimeMs;
      const mod = (await import(`${pathToFileURL(entry).href}?v=${mtime}`)) as { default?: CommandPlugin };
      if (!mod.default) throw new Error(`${entry} が CommandPlugin を default export していません`);
      plugins.push(mod.default);
      runnable.push(mod.default);
    } catch (e) {
      options.log?.(`プラグイン ${entry} をこのプロセスで読み込めませんでした（${message(e)}）。別の Node.js で読み込みます`);
      pending.push({ dir, entry });
    }
  }
  if (pending.length > 0) {
    try {
      plugins.push(...(await importWithNode(options.node, info.root, pending.map((p) => p.entry))));
    } catch (e) {
      for (const p of pending) failures.push(`${relative(info.root, p.dir) || p.dir}: ${message(e)}`);
    }
  }
  return { registry: createRegistry(CORE_COMMANDS, combinePlugins(plugins).specs), data: dataDeclarations(plugins), implementations: combinePlugins(runnable).implementations, failures, plugins };
}

/** 別の Node.js でプラグインを読み、命令の表を JSON で受け取る（関数は落ちるが、仕様には要らない）。tsx があれば使う。 */
const CHILD_SCRIPT = `
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const entries = JSON.parse(process.argv[1]);
try {
  const api = await import(pathToFileURL(createRequire(entries[0]).resolve("tsx/esm/api")).href);
  api.register();
} catch {}
const out = [];
for (const entry of entries) {
  const mod = await import(pathToFileURL(entry).href);
  if (!mod.default) throw new Error(entry + " が CommandPlugin を default export していません");
  out.push({ name: mod.default.name, commands: mod.default.commands, data: mod.default.data, variables: mod.default.variables });
}
process.stdout.write(JSON.stringify(out));
`;

function importWithNode(node: string, cwd: string, entries: string[]): Promise<CommandPlugin[]> {
  return new Promise((done, fail) => {
    execFile(node, ["--input-type=module", "-e", CHILD_SCRIPT, JSON.stringify(entries)], { cwd, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const last = stderr.trim().split("\n").filter((l) => l.trim() !== "").slice(-3).join(" / ");
        fail(new Error(`プラグインを読み込めません（${node}）: ${last || error.message}`));
        return;
      }
      try {
        done(JSON.parse(stdout) as CommandPlugin[]);
      } catch (e) {
        fail(e);
      }
    });
  });
}

/**
 * root がワークスペースのフォルダのどれかの中（フォルダそのものを含む）にあるか。シンボリックリンクは実体で比べる
 * （ワークスペースの中のリンクから外のプロジェクトを開いたときも外とみなす）。Windows は大文字と小文字を区別しない。
 */
export function insideWorkspace(root: string, folders: readonly string[]): boolean {
  const canonical = (path: string) => {
    let p: string;
    try {
      p = realpathSync.native(path);
    } catch {
      p = resolve(path);
    }
    return process.platform === "win32" ? p.toLowerCase() : p;
  };
  const target = canonical(root);
  return folders.some((folder) => {
    const r = relative(canonical(folder), target);
    return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`));
  });
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
