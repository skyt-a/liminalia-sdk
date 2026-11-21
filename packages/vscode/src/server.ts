import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { translateDiagnosticText, type DataDeclaration, type Registry } from "@liminalia/lang";
import type { CommandImpl } from "@liminalia/runtime";
import type { CommandPlugin } from "@liminalia/sdk";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createConnection, DidChangeConfigurationNotification, ErrorCodes, ProposedFeatures, ResponseError, TextDocuments, TextDocumentSyncKind, type Diagnostic } from "vscode-languageserver/node";
import { URI } from "vscode-uri";
import { formatEdits, playTarget, quickFixes, type Lang } from "./actions.ts";
import { diagnosticFilePath } from "./diagnostic-files.ts";
import { completions, definition, documentSymbols, foldingRanges, hover, toLspDiagnostic } from "./features.ts";
import { assetLeftMessage, prepareRename, references, renameEdit, workspaceSymbols } from "./rename.ts";
import { renameFiles } from "./rename-files.ts";
import { LimProject, type ProjectInput } from "./model.ts";
import { buildPlayFrom, localSweeps, readVoiceLockFile, remoteSweeps } from "./play-from.ts";
import type { PlaySweeps } from "@liminalia/editor/play-from";
import { baseRegistry, buildInput, findProjectRoot, listAssets, loadCommands, readCastFile, readProjectInfo, scenarioName, type ProjectInfo } from "./project.ts";

/**
 * 言語サーバー。開いている .lim のプロジェクト（liminalia.json のあるフォルダ）を読み、
 * lim check と同じ検査の結果を出し、補完・説明・定義へ移動・目次に答える。
 * 開いているファイルは保存前の中身を、ほかのファイルはディスクの中身を使う。
 */

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let trusted = true;
/** ワークスペースのフォルダ（パス）。プラグインは、この中のプロジェクトのものだけを読む。 */
let workspaceFolders: string[] = [];
/** プラグインを別のプロセスで読むときの Node.js。既定はこの言語サーバーを動かしているもの（VS Code の中の Node.js）。 */
let nodePath = process.execPath;
let hasConfiguration = false;
let hasWorkspaceFolders = false;
/** 名前の変更と Quick Fix の言葉（VS Code の表示の言語）。 */
let lang: Lang = "ja";

/** ワークスペースのフォルダの URI をパスにする（file: でないものは除く）。 */
function folderPaths(folders: readonly { uri: string }[]): string[] {
  return folders.map((f) => URI.parse(f.uri)).filter((u) => u.scheme === "file").map((u) => u.fsPath);
}

const log = (message: string) => connection.console.log(message);

/** 一つのプロジェクトの読み込んだもの。 */
class ProjectState {
  root: string;
  /** liminalia.json の外のファイル（root はファイルのパス）。 */
  standalone: boolean;
  info: ProjectInfo | null = null;
  /** 設定が読めないなどの理由。 */
  error: string | null = null;
  registry: Registry = baseRegistry();
  failures: string[] = [];
  data: DataDeclaration[] = [];
  implementations: CommandImpl[] = [];
  plugins: CommandPlugin[] = [];
  speakers: string[] = [];
  cast: Record<string, unknown> = {};
  /** ディスクから読んだシナリオ（パス → 中身）。 */
  disk = new Map<string, string | null>();
  assets = new Map<string, readonly string[]>();
  model: LimProject;
  /** シナリオのフォルダの外の .lim は、それぞれ一ファイルだけのプロジェクトとして見る。 */
  loose = new Map<string, LimProject>();
  published = new Set<string>();
  ready: Promise<void>;

  constructor(root: string, standalone: boolean) {
    this.root = root;
    this.standalone = standalone;
    this.model = new LimProject({ registry: this.registry, speakers: [], cast: {}, files: new Map() });
    this.ready = this.reload();
  }

  async reload(): Promise<void> {
    this.disk.clear();
    this.assets.clear();
    if (this.standalone) return;
    try {
      this.info = readProjectInfo(this.root);
      this.error = null;
    } catch (e) {
      this.info = null;
      this.error = e instanceof Error ? e.message : String(e);
      log(`${this.root}: ${this.error}`);
      return;
    }
    try {
      const cast = readCastFile(this.info.paths.cast);
      this.speakers = cast.speakers;
      this.cast = cast.cast;
    } catch (e) {
      this.speakers = [];
      this.cast = {};
      log(`${this.info.paths.cast}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const loaded = await loadCommands(this.info, { trusted, workspaceFolders, node: nodePath, log });
    this.registry = loaded.registry;
    this.failures = loaded.failures;
    this.data = loaded.data;
    this.implementations = loaded.implementations;
    this.plugins = loaded.plugins;
    for (const f of loaded.failures) log(f);
  }

  /** ディスクの中身（読んだものは覚えておき、ファイルが変わったと知らされたら忘れる）。無ければ null。 */
  readDisk(path: string): string | null {
    if (!this.disk.has(path)) {
      let text: string | null = null;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        // 無いファイル
      }
      this.disk.set(path, text);
    }
    return this.disk.get(path) ?? null;
  }

  assetsOf(folder: string): readonly string[] {
    if (!this.info) return [];
    let list = this.assets.get(folder);
    if (!list) {
      list = listAssets(join(this.info.paths.assets, folder));
      this.assets.set(folder, list);
    }
    return list;
  }

  /** 開いているファイルは保存前の中身で、プロジェクトの入力を作る。 */
  input(): ProjectInput {
    if (!this.info) return { registry: this.registry, speakers: [], cast: {}, files: new Map() };
    const commands = { registry: this.registry, data: this.data, implementations: this.implementations, failures: this.failures, plugins: this.plugins };
    return buildInput(this.info, { commands, speakers: this.speakers, cast: this.cast }, (path) => openText(path) ?? this.readDisk(path), (folder) => this.assetsOf(folder), (path) => this.readDisk(path));
  }

  /** シナリオのフォルダの中（サブフォルダも）のファイルか（lim check が見るファイル）。 */
  inScenario(path: string): boolean {
    return this.info !== null && scenarioName(this.info.paths.scenario, path) !== null && existsSync(path);
  }

  /** パスのファイルを見るモデルと、その中での名前（シナリオのフォルダの中なら "part1/chapter2" の形）。 */
  modelFor(path: string): { model: LimProject; name: string } {
    const name = (this.info ? scenarioName(this.info.paths.scenario, path) : null) ?? basename(path, ".lim");
    const base = this.input();
    if (this.inScenario(path) && base.files.has(name)) {
      this.model.update(base);
      return { model: this.model, name };
    }
    // まだ保存していないファイルとシナリオのフォルダの外のファイル。プロジェクトのシナリオも飛び先として見えるようにし、
    // このファイルを同じ名前のものより優先する
    const files = new Map(base.files);
    files.set(name, { uri: URI.file(path).toString(), text: openText(path) ?? this.readDisk(path) ?? "" });
    const input: ProjectInput = { ...base, files };
    let model = this.loose.get(path);
    if (model) model.update(input);
    else this.loose.set(path, (model = new LimProject(input)));
    return { model, name };
  }
}

/** プロジェクトのフォルダ（liminalia.json のないファイルはファイルのパス）→ 状態。 */
const projects = new Map<string, ProjectState>();

/** 開いているファイルのパス → URI（VS Code の URI の書き方が URI.file と違うこともあるので、パスで引く）。 */
const openPaths = new Map<string, string>();

function openText(path: string): string | undefined {
  return documents.get(openPaths.get(path) ?? URI.file(path).toString())?.getText();
}

function stateFor(path: string): ProjectState {
  const found = findProjectRoot(path);
  const root = found ?? path;
  let state = projects.get(root);
  if (!state) projects.set(root, (state = new ProjectState(root, found === null)));
  return state;
}

async function modelForUri(uri: string): Promise<{ model: LimProject; name: string } | null> {
  const parsed = URI.parse(uri);
  if (parsed.scheme !== "file") return null;
  const state = stateFor(parsed.fsPath);
  await state.ready;
  return state.modelFor(parsed.fsPath);
}

// ---- 診断 ----

const timers = new Map<ProjectState, ReturnType<typeof setTimeout>>();

function scheduleValidate(state: ProjectState, delay = 250): void {
  clearTimeout(timers.get(state));
  timers.set(
    state,
    setTimeout(() => {
      timers.delete(state);
      void validate(state);
    }, delay),
  );
}

async function validate(state: ProjectState): Promise<void> {
  await state.ready;
  const byUri = new Map<string, Diagnostic[]>();
  const add = (uri: string, d: Diagnostic) => byUri.set(uri, [...(byUri.get(uri) ?? []), d]);
  const linesOf = (path: string) => (openText(path) ?? (existsSync(path) ? readFileSync(path, "utf8") : "")).split("\n").map((l) => l.replace(/\r$/, ""));

  if (state.error !== null) {
    add(URI.file(join(state.root, "liminalia.json")).toString(), { severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, message: lang === "en" ? (translateDiagnosticText(state.error) ?? state.error) : state.error, source: "lim" });
  } else if (state.info) {
    const info = state.info;
    state.model.update(state.input());
    const files = state.model.input.files;
    for (const d of state.model.diagnostics()) {
      const scenario = files.get(d.file);
      if (scenario) {
        add(scenario.uri, toLspDiagnostic(d, state.model.lines(d.file), lang));
        continue;
      }
      // 設定のファイル、訳のファイル、ボイスの番号の固定、作品のデータ（プラグインの検査）、作品の CSS、画面のテンプレートと JS
      const path = diagnosticFilePath(d.file, info, state.model.input.work ?? {});
      if (path) add(URI.file(path).toString(), toLspDiagnostic(d, linesOf(path), lang));
    }
  }

  // シナリオのフォルダの外で開いているファイル
  for (const doc of documents.all()) {
    const path = URI.parse(doc.uri).fsPath;
    if (!doc.uri.startsWith("file:") || !path.endsWith(".lim") || stateFor(path) !== state) continue;
    if (state.inScenario(path)) continue;
    const { model, name } = state.modelFor(path);
    const own = model.diagnostics().filter((d) => d.file === name);
    for (const d of own) add(doc.uri, toLspDiagnostic(d, model.lines(name), lang));
    if (own.length === 0) byUri.set(doc.uri, byUri.get(doc.uri) ?? []);
  }

  for (const uri of state.published) if (!byUri.has(uri)) byUri.set(uri, []);
  state.published = new Set([...byUri].filter(([, list]) => list.length > 0).map(([uri]) => uri));
  for (const [uri, diagnostics] of byUri) void connection.sendDiagnostics({ uri, diagnostics });
}

// ---- 接続 ----

connection.onInitialize((params) => {
  const options = (params.initializationOptions ?? {}) as { trusted?: boolean };
  trusted = options.trusted ?? true;
  hasConfiguration = params.capabilities.workspace?.configuration === true;
  hasWorkspaceFolders = params.capabilities.workspace?.workspaceFolders === true;
  // フォルダを開いていないウィンドウ（null）では、どのプロジェクトのプラグインも読まない
  const folders = params.workspaceFolders !== undefined ? params.workspaceFolders : params.rootUri ? [{ uri: params.rootUri, name: "" }] : null;
  workspaceFolders = folderPaths(folders ?? []);
  lang = (params.locale ?? "ja").startsWith("ja") ? "ja" : "en";
  return {
    capabilities: {
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ["@", "#", "=", " ", "{", "/"] },
      hoverProvider: true,
      definitionProvider: true,
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      codeActionProvider: { codeActionKinds: ["quickfix"] },
      renameProvider: { prepareProvider: true },
      referencesProvider: true,
      workspaceSymbolProvider: true,
      foldingRangeProvider: true,
    },
  };
});

connection.onInitialized(async () => {
  if (hasWorkspaceFolders) {
    connection.workspace.onDidChangeWorkspaceFolders((e) => {
      const removed = new Set(folderPaths(e.removed));
      workspaceFolders = [...workspaceFolders.filter((f) => !removed.has(f)), ...folderPaths(e.added).filter((f) => !workspaceFolders.includes(f))];
      reloadAll();
    });
  }
  if (hasConfiguration) {
    void connection.client.register(DidChangeConfigurationNotification.type, { section: "liminalia" });
    await readSettings();
  }
});

async function readSettings(): Promise<void> {
  if (!hasConfiguration) return;
  const settings = (await connection.workspace.getConfiguration("liminalia")) as { node?: string } | null;
  const next = typeof settings?.node === "string" && settings.node !== "" ? settings.node : process.execPath;
  if (next !== nodePath) {
    nodePath = next;
    reloadAll();
  }
}

function reloadAll(): void {
  for (const state of projects.values()) {
    state.ready = state.reload();
    scheduleValidate(state, 0);
  }
}

connection.onDidChangeConfiguration(() => void readSettings());

/** 信頼していなかったフォルダを信頼したら、プラグインを読み直す。 */
connection.onNotification("liminalia/trusted", () => {
  trusted = true;
  reloadAll();
});

documents.onDidOpen((e) => {
  if (!e.document.uri.startsWith("file:")) return;
  const path = URI.parse(e.document.uri).fsPath;
  openPaths.set(path, e.document.uri);
  scheduleValidate(stateFor(path), 0);
});
documents.onDidChangeContent((e) => {
  if (e.document.uri.startsWith("file:")) scheduleValidate(stateFor(URI.parse(e.document.uri).fsPath));
});
documents.onDidClose((e) => {
  if (!e.document.uri.startsWith("file:")) return;
  const path = URI.parse(e.document.uri).fsPath;
  openPaths.delete(path);
  const state = stateFor(path);
  state.disk.delete(path);
  state.loose.delete(path);
  // プロジェクトに入らないファイルは、閉じたら指摘も消す
  if (!state.inScenario(path)) void connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  scheduleValidate(state);
});

connection.onDidChangeWatchedFiles((params) => {
  const touched = new Set<ProjectState>();
  for (const change of params.changes) {
    const path = URI.parse(change.uri).fsPath;
    for (const state of projects.values()) {
      if (path !== state.root && !path.startsWith(state.root + "/") && !path.startsWith(state.root + "\\")) continue;
      const info = state.info;
      const name = basename(path);
      if (name === "liminalia.json" || (info && (path === info.paths.cast || info.plugins.some((p) => path.startsWith(p))))) {
        state.ready = state.reload();
      } else if (info && path.startsWith(info.paths.assets)) {
        state.assets.clear();
      } else {
        state.disk.delete(path);
      }
      touched.add(state);
    }
  }
  for (const state of touched) scheduleValidate(state);
});

connection.onCompletion(async (params) => {
  const m = await modelForUri(params.textDocument.uri);
  return m ? completions(m.model, m.name, params.position, lang) : [];
});

connection.onHover(async (params) => {
  const m = await modelForUri(params.textDocument.uri);
  return m ? hover(m.model, m.name, params.position, lang) : null;
});

connection.onDefinition(async (params) => {
  const m = await modelForUri(params.textDocument.uri);
  return m ? definition(m.model, m.name, params.position) : null;
});

connection.onDocumentSymbol(async (params) => {
  const m = await modelForUri(params.textDocument.uri);
  return m ? documentSymbols(m.model, m.name) : [];
});

// 整形（lim fmt と同じ）。構文エラーがあれば整えずに理由を出す
connection.onDocumentFormatting(async (params) => {
  const m = await modelForUri(params.textDocument.uri);
  const doc = documents.get(params.textDocument.uri);
  if (!m || !doc) return [];
  const r = formatEdits(m.model, m.name, doc.getText());
  if ("error" in r) {
    void connection.window.showWarningMessage(r.error);
    return [];
  }
  return r.edits;
});

// Quick Fix（診断の直し方）
connection.onCodeAction(async (params) => {
  const m = await modelForUri(params.textDocument.uri);
  return m ? quickFixes(m.model, m.name, params.textDocument.uri, params.context.diagnostics, lang) : [];
});

// 名前の変更（シーン、ファイル、マクロ、変数、キャラクター、話者、素材）。名前の上か、名前を指すところで
connection.onPrepareRename(async (params) => {
  const m = await modelForUri(params.textDocument.uri);
  return m ? prepareRename(m.model, m.name, params.position) : null;
});

connection.onRenameRequest(async (params) => {
  const m = await modelForUri(params.textDocument.uri);
  if (!m) return null;
  const state = stateFor(URI.parse(params.textDocument.uri).fsPath);
  const r = renameEdit(m.model, m.name, params.position, params.newName, lang, state.info ? renameFiles(state.info, state.data, openText) : {});
  if ("error" in r) throw new ResponseError(ErrorCodes.InvalidRequest, r.error);
  // 素材の名前の変更で書き換えられなかった所（手で直す所）。知らせには先の 10 か所、出力にはすべて
  if (r.left && r.left.length > 0) {
    void connection.window.showWarningMessage(assetLeftMessage(r.left, lang));
    log(assetLeftMessage(r.left, lang, Infinity));
  }
  return r.edit;
});

// 参照の一覧（シーン、ファイル、マクロ、変数、キャラクター、話者、素材）
connection.onReferences(async (params) => {
  const m = await modelForUri(params.textDocument.uri);
  return m ? references(m.model, m.name, params.position, params.context.includeDeclaration) : [];
});

// ワークスペースの記号（すべての作品のシーンと @define）
connection.onWorkspaceSymbol(async (params) => {
  // ワークスペースのフォルダの直下の作品は、.lim を開いていなくても読む
  for (const folder of workspaceFolders) if (existsSync(join(folder, "liminalia.json"))) stateFor(join(folder, "liminalia.json"));
  const out = [];
  for (const state of projects.values()) {
    await state.ready;
    if (!state.info) continue;
    state.model.update(state.input());
    out.push(...workspaceSymbols(state.model, params.query));
  }
  return out;
});

// 折りたたみ（構文解析から）
connection.onFoldingRanges(async (params) => {
  const m = await modelForUri(params.textDocument.uri);
  return m ? foldingRanges(m.model, m.name) : [];
});

// ここからテストプレイ（extension.ts の liminalia.playFromHere）: 作品のフォルダと、始めるシーンとページの数
connection.onRequest("liminalia/playTarget", async (params: { uri: string; line: number }) => {
  const m = await modelForUri(params.uri);
  const state = stateFor(URI.parse(params.uri).fsPath);
  if (!m || !state.info) return null;
  const at = playTarget(m.model, m.name, params.line);
  return at ? { root: state.root, file: m.name, ...at } : null;
});

// ここからテストプレイ: カーソルの行（0 から）を実行する直前の状態から始めるセーブ。studio（開発サーバーの URL）があればその現在地を使う。
// シナリオのフォルダの外のファイルと、始められない行は null
connection.onRequest("liminalia/playFrom", async (params: { uri: string; line: number; studio?: string }) => {
  const path = URI.parse(params.uri).fsPath;
  const m = await modelForUri(params.uri);
  const state = stateFor(path);
  const info = state.info;
  if (!m || !info || !state.inScenario(path)) return null;
  const project = m.model;
  const text = project.input.files.get(m.name)?.text;
  if (text === undefined) return null;
  const local = (): PlaySweeps => {
    const scripts = new Map([...project.scripts()].map(([name, script]) => [name, { script, text: project.input.files.get(name)!.text }] as const));
    return localSweeps({ scripts, registry: project.registry, speakers: project.input.speakers, cast: project.input.cast, implementations: state.implementations, config: info.config, data: (name) => readData(info, name), voiceLock: readVoiceLockFile(info.paths.voiceLock) });
  };
  return buildPlayFrom({ file: m.name, text, speakers: project.input.speakers, line: params.line + 1, ...(params.studio ? { studio: remoteSweeps(params.studio) } : {}), local, log });
});

/** 作品のデータ（paths.data の .json。.json は省ける）。無い・読めない・フォルダの外なら undefined。 */
function readData(info: ProjectInfo, name: string): unknown {
  const path = resolve(info.paths.data, ...(name.endsWith(".json") ? name : `${name}.json`).split("/"));
  if (!path.startsWith(info.paths.data + sep)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

documents.listen(connection);
connection.listen();
