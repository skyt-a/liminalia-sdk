import {
  castProblems,
  defineSpec,
  englishDiagnostic,
  parse,
  type Cast,
  type CastEntry,
  type CommandSpec,
  type Diagnostic,
  type JsonSchema,
  type Registry,
  type Script,
  type Statement,
} from "@liminalia/lang";
import { projectDiagnostics, type CommandPlugin, type ProjectCheckConfig, type ProjectCheckInput } from "@liminalia/plugin-host";

/**
 * 拡張機能が見る一つのプロジェクト（シナリオの本文・命令の仕様・話者・キャスト）。
 * ファイルや VS Code には触らず、渡された中身だけから検査・補完・説明・定義の位置を求める。
 */

/** シナリオの一ファイル。名前は拡張子を除いたもの（飛び先の `ファイル` と同じ）。 */
export interface ScenarioFile {
  uri: string;
  text: string;
}

export interface ProjectInput {
  registry: Registry;
  speakers: readonly string[];
  /** cast.json の cast（形が崩れていてもよい）。 */
  cast: Readonly<Record<string, unknown>>;
  files: ReadonlyMap<string, ScenarioFile>;
  /** liminalia.json の検査に使う項目。 */
  config?: { extra?: unknown; afterLoad?: unknown; ui?: unknown; items?: unknown; variables?: unknown; allowScript?: unknown; punctuation?: unknown; severity?: unknown; indent?: unknown; formatExpressions?: unknown; sourceLanguage?: string | undefined; commandDefaults?: unknown; chapters?: unknown; baseRegistry?: Registry; languages?: unknown; entry?: unknown; sound?: unknown };
  /** 原文以外の言語の訳のファイルの中身（無ければ null）。 */
  translations?: readonly { language: string; text: string | null }[];
  /** 素材のフォルダ（bgimage など）の中のファイルの一覧（フォルダからのパス）。 */
  assets?: (folder: string) => readonly string[];
  /** 素材のフォルダの中にそのパスがあるか（素材の実在の確認。無ければ確かめない）。 */
  assetExists?: (folder: string, path: string) => boolean;
  /** 素材の本当の名前を引く関数を作る（検査のたびに作り直す。大文字と小文字の違いを見る。@liminalia/lang の assetNameResolver）。 */
  assetActual?: () => (folder: string, path: string) => string | null | undefined;
  /** 素材のファイルの頭（Git LFS のポインタのままの素材を見分ける。@liminalia/project の assetHeads と同じ）。 */
  assetHead?: (folder: string, path: string) => Uint8Array | null;
  /** 読み込めなかったプラグイン（理由つき）。あれば命令がないという指摘を警告にする。 */
  pluginFailures?: readonly string[];
  /**
   * lim check と同じ検査に使う作品の中身（@liminalia/plugin-host の projectDiagnostics に渡す。project.ts の buildInput が作る）。
   * 無ければ台本、キャスト、上の config だけで検査する（プロジェクトの外のファイル）。
   */
  work?: ProjectWork;
}

/** lim check と同じ検査に使う、作品のフォルダから読んだもの。 */
export interface ProjectWork {
  root: string;
  /** liminalia.json の中身（読み解いたもの）と字面。 */
  config: ProjectCheckConfig;
  configText: string | null;
  /** cast.json の字面と、診断に書くその名前（作品のフォルダからのパス）。 */
  castText: string | null;
  castFile: string;
  /** 読み込んだプラグイン（標準の命令も。別の Node.js で読んだものは命令の表だけ）。 */
  plugins: readonly CommandPlugin[];
  data: (name: string) => unknown;
  dataText: (name: string) => string | undefined;
  dataFolder: string;
  voiceLockText: string | null;
  /** パックの台本と訳（@liminalia/project の listPackSources。lim check と同じ）。 */
  packs?: ProjectCheckInput["packs"];
  /** 作品のフォルダの中のファイル（作品の CSS ui.css と、その中の url() の素材。開いているファイルは保存前の中身）。 */
  projectFiles?: { text(path: string): string | null; exists(path: string): boolean };
  readFont: (file: string) => Uint8Array | null;
  /**
   * 訳のファイルの JSON Schema（読めなければ null）。liminalia.json と cast.json の型はエディタの JSON の検証
   * （package.json の jsonValidation）が同じ Schema で見るので、ここでは JSON として読めない所だけを知らせる。
   */
  langSchema: JsonSchema | null;
  /** UTF-8 で読めない台本（名前 → 文字コードの名前）。そのファイルは bad-encoding だけにする。 */
  encodings?: ReadonlyMap<string, string>;
  /** 作品の画面のテンプレート（ui.templates）の検査に使うもの（@liminalia/plugin-host の ProjectCheckInput の screenTemplates）。 */
  screenTemplates?: ProjectCheckInput["screenTemplates"];
}

/** 一つのファイルの中の @define。 */
export interface DefineInfo {
  name: string;
  file: string;
  line: number;
  spec: CommandSpec;
  node: Extract<Statement, { kind: "define" }>;
}

export class LimProject {
  input: ProjectInput;
  private parsed = new Map<string, { text: string; speakers: string; script: Script }>();

  constructor(input: ProjectInput) {
    this.input = input;
  }

  update(input: ProjectInput): void {
    this.input = input;
    for (const name of [...this.parsed.keys()]) if (!input.files.has(name)) this.parsed.delete(name);
  }

  get registry(): Registry {
    return this.input.registry;
  }

  /** 構文木（本文が変わっていなければ前に読んだものを使う）。 */
  script(name: string): Script | null {
    const file = this.input.files.get(name);
    if (!file) return null;
    const speakers = this.input.speakers.join("\n");
    const cached = this.parsed.get(name);
    if (cached && cached.text === file.text && cached.speakers === speakers) return cached.script;
    const script = parse(file.text, name, { speakers: this.input.speakers });
    this.parsed.set(name, { text: file.text, speakers, script });
    return script;
  }

  scripts(): Map<string, Script> {
    const out = new Map<string, Script>();
    for (const name of [...this.input.files.keys()].sort()) out.set(name, this.script(name)!);
    return out;
  }

  lines(name: string): string[] {
    return (this.input.files.get(name)?.text ?? "").split("\n").map((l) => l.replace(/\r$/, ""));
  }

  /** 形の崩れていないキャストの定義。 */
  castEntries(): Record<string, CastEntry> {
    const broken = new Set(castProblems(this.input.cast).map((p) => p.who));
    return Object.fromEntries(Object.entries(this.input.cast as Cast).filter(([who]) => !broken.has(who)));
  }

  /** ファイルのラベル（@if の中のものも）。 */
  labels(name: string): { name: string; line: number }[] {
    const script = this.script(name);
    if (!script) return [];
    const out: { name: string; line: number }[] = [];
    walk(script.body, (s) => {
      if (s.kind === "label") out.push({ name: s.name, line: s.line });
    });
    return out;
  }

  /** ファイルの @define。 */
  defines(name: string): DefineInfo[] {
    const script = this.script(name);
    if (!script) return [];
    const out: DefineInfo[] = [];
    walk(script.body, (s) => {
      if (s.kind !== "define" || s.name === "") return;
      const spec = defineSpec(s);
      if (spec) out.push({ name: s.name, file: name, line: s.line, spec, node: s });
    });
    return out;
  }

  /** ファイルの一番外側の @use。 */
  uses(name: string): string[] {
    return (this.script(name)?.body ?? []).flatMap((s) => (s.kind === "use" ? [s.file] : []));
  }

  /** このファイルで呼べる @define（自分のファイルと @use したファイルのもの）。 */
  visibleDefines(name: string): Map<string, DefineInfo> {
    const out = new Map<string, DefineInfo>();
    for (const used of this.uses(name)) for (const d of this.defines(used)) out.set(d.name, d);
    for (const d of this.defines(name)) out.set(d.name, d);
    return out;
  }

  /** プロジェクトのどこかにある @define（@use し忘れの案内に使う）。 */
  findDefine(defineName: string): DefineInfo | null {
    for (const file of this.input.files.keys()) {
      const d = this.defines(file).find((x) => x.name === defineName);
      if (d) return d;
    }
    return null;
  }

  /**
   * lim check と同じ検査（@liminalia/plugin-host の projectDiagnostics。lim check、制作画面、MCP と同じ一覧）。
   * file は診断の file（シナリオ名、cast.json、liminalia.json、lang/<言語>.json）。
   */
  diagnostics(): Diagnostic[] {
    const config = this.input.config ?? {};
    const work = this.input.work;
    const files = new Map<string, { script: Script; text: string }>();
    for (const [name, file] of [...this.input.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) files.set(name, { script: this.script(name)!, text: file.text });
    // 作品のフォルダの外のファイルは、渡された項目だけで lim check と同じ形の設定を作る
    const projectConfig: ProjectCheckConfig = work?.config ?? {
      entry: config.entry,
      afterLoad: config.afterLoad,
      extra: config.extra,
      variables: config.variables,
      commandDefaults: config.commandDefaults,
      chapters: config.chapters,
      ui: config.ui,
      items: config.items,
      languages: config.languages,
      allowScript: config.allowScript,
      check: { punctuation: config.punctuation, severity: config.severity, sound: config.sound },
    };
    const out = projectDiagnostics({
      root: work?.root ?? "",
      files,
      config: projectConfig,
      configText: work?.configText ?? null,
      cast: this.input.cast,
      speakers: this.input.speakers,
      castText: work?.castText ?? null,
      castFile: work?.castFile ?? "cast.json",
      schemas: { liminalia: null, cast: null, lang: work?.langSchema ?? null },
      registry: this.registry,
      baseRegistry: config.baseRegistry ?? this.registry,
      plugins: work?.plugins ?? [],
      data: work?.data ?? (() => undefined),
      ...(work
        ? {
            dataText: work.dataText,
            dataFolder: work.dataFolder,
            voiceLockText: work.voiceLockText,
            ...(work.packs ? { packs: work.packs } : {}),
            ...(work.projectFiles ? { projectFiles: work.projectFiles } : {}),
            readFont: work.readFont,
            ...(work.encodings ? { encodings: work.encodings } : {}),
            ...(work.screenTemplates ? { screenTemplates: work.screenTemplates } : {}),
          }
        : {}),
      translations: this.input.translations ?? [],
      assets: this.input.assetExists ? { exists: this.input.assetExists, ...(this.input.assets ? { files: this.input.assets } : {}), ...(this.input.assetActual ? { actual: this.input.assetActual() } : {}), ...(this.input.assetHead ? { head: this.input.assetHead } : {}) } : null,
    });
    const failures = this.input.pluginFailures ?? [];
    if (failures.length === 0) return out;
    // プラグインを読めなかったときは、そのプラグインの命令がないと言うのは確かではないので警告にする
    return out.map((d) =>
      d.code === "unknown-command"
        ? { ...d, severity: "warning", message: `${d.message}（読み込めなかったプラグインのコマンドの可能性があります）`, messageEn: `${englishDiagnostic(d).message} (it may be a command of a plugin that couldn't be loaded)` }
        : d,
    );
  }
}

export function walk(body: readonly Statement[], fn: (s: Statement) => void): void {
  for (const s of body) {
    fn(s);
    if (s.kind === "if") for (const b of s.branches) walk(b.body, fn);
    if (s.kind === "define") walk(s.body, fn);
  }
}
