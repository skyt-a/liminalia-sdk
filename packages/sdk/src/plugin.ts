import { CORE_COMMANDS, CORE_FUNCTIONS, dataFlagsSet, normalizeBooleanArgs, PLUGIN_API_VERSION, scriptLabels, setPluginFunctions, type Argument, type Cast, type CommandSpec, type DataDeclaration, type Diagnostic, type Registry, type Script, type Statement } from "@liminalia/lang";
import { setPluginFunctionImpls, type Value } from "@liminalia/runtime";
import { toImplementation, toSpec, type CommandDefinition, type CommandDiagnostic } from "./command.ts";
import { checkDeclaredData, declaredData } from "./data.ts";

export { PLUGIN_API_VERSION };

/**
 * プラグインが足す式の関数（CommandPlugin.functions）。台本の式（@if・@set・{…}・条件の式）から `名前(引数…)` で呼べる。
 * 引数は評価した値の写し（書き換えても台本の変数は変わらない）、返すのは値（数・文字・真偽・null・配列・オブジェクト）。
 * 乱数は env.random()（作品の乱数のシードに従うので、ロードしても同じ値になる）。同期の関数で、状態を持たない（同じ引数なら同じ値）ように書く。
 */
export interface PluginFunction {
  /** 引数の数（数一つならちょうどその数、[最小, 最大]。最大は Infinity も書ける）。lim check と実行器が確かめる。 */
  args: number | readonly [min: number, max: number];
  /** 説明（lim reference の式の関数の表に出す）。 */
  doc: string;
  docEn?: string;
  /** 書き方の例（`rank(game.score)` など。無ければ `名前()`）。 */
  usage?: readonly string[];
  run(args: Value[], env: { random(): number }): Value;
}

/**
 * プラグインの命令側（Node でも読める部分）。プロジェクト設定の plugins に書いたパッケージの
 * "./commands" がこれを default export する。検査・画面なしの実行・書き出し・プレイヤーが読む。
 * 見た目（描画・システム画面）は同じパッケージの "./web" が担う（@liminalia/web の WebPlugin）。
 * TyranoScript の .ks からの取り込み（タグの変換表・[iscript] の置き換え・扱わないタグ）は "./import" が担う
 * （@liminalia/ks-import の TyranoImportProfile）。書き出すゲームには入らない。
 */
export interface CommandPlugin {
  name: string;
  commands: readonly CommandDefinition[];
  /**
   * 作品全体を読んで診断を返す（lim check・lim build・制作画面のチェックが呼ぶ。保存のたびにも呼ぶので重い処理は避ける。同期の関数で書く）。
   * 分類は「プラグイン」に入る。投げても全体のチェックは止まらず、そのプラグインの診断として出る。
   */
  check?(project: PluginCheckProject): readonly PluginDiagnostic[];
  /**
   * 作品のデータ（paths.data の .json）の形の宣言（@liminalia/sdk の d で書く）。この宣言から、lim check と制作画面のチェックが形・素材・
   * キャスト・飛び先・式を確かめ、データの中のフラグと台本の @set を突き合わせ、制作画面が自動のフォームを作り、シーン・ファイル・素材・
   * 変数・キャストの名前を変えたらデータも書き換える。CG の印（d.asset(…, { cg: true })）の素材は、どこからも出ない CG の検査が出ているものと数える。
   */
  data?: readonly DataDeclaration[];
  /**
   * このプラグインの命令が値を入れる変数（"game.x"。末尾を .* にすると、その下の名前すべて。"game.codex.*" など）。
   * lim check と制作画面のチェックは、どこでも値を入れずに読むだけの変数を綴り違いとして知らせるので、プラグインが ctx.runtime.setVariable などで
   * 値を入れる変数はここに書く。
   */
  variables?: readonly string[];
  /**
   * 式の関数（名前 → 定義）。台本の式から呼べる（lim check の unknown-function にならない）。組み込みの関数と同じ名前は使えない
   * （lim check が plugin-function-clash を出し、組み込みのほうを使う）。
   */
  functions?: Readonly<Record<string, PluginFunction>>;
  /**
   * このプラグインを書いたときのプラグインの口の版（PLUGIN_API_VERSION）。エンジンの版より新しければ、lim check と制作画面のチェックが
   * 「新しいエンジンが要る」と知らせる（plugin-api-version）。書かなければ確かめない。
   */
  apiVersion?: number;
}

/** プラグインが値を入れる変数（宣言 variables）と、作品のデータが立てるフラグ。変数の綴り違いの検査に渡す。 */
export function pluginWrittenVariables(plugins: readonly CommandPlugin[], read: (name: string) => unknown): string[] {
  return [...plugins.flatMap((p) => p.variables ?? []), ...dataFlagsSet(declaredData(plugins, read))];
}

/** プラグインの check が読む作品。 */
export interface PluginCheckProject {
  /** 作品のフォルダ。 */
  root: string;
  /** liminalia.json の中身。 */
  config: Readonly<Record<string, unknown>>;
  /** ファイル（拡張子なし）→ 構文木。 */
  scripts: ReadonlyMap<string, Script>;
  /** 台本の文字（拡張子なし）。 */
  text(file: string): string;
  cast: Readonly<Cast>;
  speakers: readonly string[];
  /** 命令の仕様（組み込み・標準・プラグイン）。 */
  registry: Registry;
  /** 作品のデータ（paths.data の .json。無ければ undefined）。 */
  data(name: string): unknown;
  /** 素材のフォルダ（image・bgimage など）の中にあるか。 */
  assetExists(folder: string, path: string): boolean;
  /** 作品のデータの文字（診断の行を求めるのに使う。無ければ 1 行目に出す）。 */
  dataText?(name: string): string | undefined;
  /** 診断に書くデータのフォルダの名前（作品のフォルダからのパス。既定 data）。 */
  dataFolder?: string;
}

/**
 * プラグインの check が返す診断。file を省くと liminalia.json、line を省くと 1。訳があれば messageEn・hintEn に書く（無ければ英語の表示でも原文のまま）。
 * fix・fixes に直し方（行の置き換え・行の削除・話者に足す・シーンを作る）を書くと、制作画面のチェックとエディタに「修正」が出る。
 */
export type PluginDiagnostic = Pick<Diagnostic, "severity" | "code" | "message"> & Partial<Pick<Diagnostic, "messageEn" | "file" | "line" | "column" | "hint" | "hintEn" | "fix" | "fixes">>;

const SEVERITIES: ReadonlySet<string> = new Set(["error", "warning", "info"]);

/** プラグインの返したものを診断の形にする（形の合わないものは null）。 */
function pluginDiagnostic(name: string, d: PluginDiagnostic): Diagnostic | null {
  if (!d || typeof d !== "object" || typeof d.message !== "string" || !SEVERITIES.has(d.severity) || typeof d.code !== "string") return null;
  const { file, line, fix, fixes, ...rest } = d;
  const out: Diagnostic = { ...rest, file: typeof file === "string" && file !== "" ? file : "liminalia.json", line: typeof line === "number" && line >= 1 ? line : 1, plugin: name };
  // 直し方は形の合うものだけ（制作画面がそのまま当てる）
  if (fix && validFix(fix)) out.fix = fix;
  const list = Array.isArray(fixes) ? fixes.filter(validFix) : [];
  if (out.fix && !list.some((f) => JSON.stringify(f) === JSON.stringify(out.fix))) list.unshift(out.fix);
  if (list.length > 0) out.fixes = list;
  return out;
}

/** 直し方の形（DiagnosticFix・ProjectFix）か。 */
function validFix(f: unknown): f is NonNullable<Diagnostic["fixes"]>[number] {
  if (!f || typeof f !== "object") return false;
  const x = f as Record<string, unknown>;
  switch (x.kind) {
    case "delete-line":
      return typeof x.text === "string";
    case "replace":
      return typeof x.find === "string" && x.find !== "" && typeof x.with === "string";
    case "add-speaker":
      return typeof x.name === "string" && x.name !== "";
    case "add-label":
      return typeof x.file === "string" && typeof x.label === "string" && x.label !== "";
    default:
      return false;
  }
}

/** 台本の命令の行（@if・@define・@with の中も）。 */
function* commandsIn(body: readonly Statement[]): Generator<{ name: string; args: readonly Argument[]; line: number }> {
  for (const s of body) {
    if (s.kind === "command") yield { name: s.name, args: s.args, line: s.line };
    else if (s.kind === "if") {
      if (s.with) yield { name: s.with.name, args: s.with.args, line: s.line };
      for (const b of s.branches) yield* commandsIn(b.body);
    } else if (s.kind === "define") yield* commandsIn(s.body);
  }
}

/**
 * 命令の行の、書いたままの文字の引数（位置引数も名前で引ける。式で書いた引数は入らない）。
 * spec を渡すと、検査と実行器と同じ読み方（normalizeBooleanArgs）にする（名前なしの値を bare の引数に、真偽値の省略形をその名前に当てる）。
 */
export function commandArgs(args: readonly Argument[], positional: readonly string[], spec?: CommandSpec): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  for (const a of spec ? normalizeBooleanArgs(spec, args) : args) {
    const key = a.key ?? positional[pos++];
    if (!key) continue;
    if (a.value.kind === "string") out[key] = a.value.value;
    else if (a.value.kind === "number" || a.value.kind === "bool") out[key] = String(a.value.value);
  }
  return out;
}

/** 作品のデータの path（/ で区切る）の下の名前（辞書なら鍵、並びなら項目の id）。道が無ければ null。 */
export function dataKeys(data: unknown, path: string): string[] | null {
  let v = data;
  for (const part of path.split("/").filter((p) => p !== "")) {
    if (Array.isArray(v)) v = v.find((x) => x && typeof x === "object" && (x as Record<string, unknown>).id === part);
    else if (v && typeof v === "object") v = (v as Record<string, unknown>)[part];
    else return null;
  }
  if (Array.isArray(v)) return v.flatMap((x) => (x && typeof x === "object" && typeof (x as Record<string, unknown>).id === "string" ? [(x as Record<string, unknown>).id as string] : []));
  if (v && typeof v === "object") return Object.keys(v);
  return null;
}

/** 命令ごとの検査（validate）と、データの名前の引数（t.dataKey）の実在。 */
function checkCommandLines(plugins: readonly CommandPlugin[], project: PluginCheckProject, out: Diagnostic[]): void {
  const defs = new Map<string, { plugin: string; def: CommandDefinition }>();
  for (const p of plugins) for (const c of p.commands) defs.set(c.name, { plugin: p.name, def: c });
  const keyed = [...defs.values()].filter(({ def }) => def.validate || Object.values(def.params).some((p) => p.type.kind === "string" && p.type.data));
  if (keyed.length === 0) return;
  const folder = project.dataFolder ?? "data";
  let labels: Map<string, Set<string>> | null = null;
  const targetExists = (file: string, target: string) => {
    labels ??= scriptLabels(project.scripts);
    const [f, l] = target.startsWith("#") ? [file, target.slice(1)] : (target.split("#") as [string, string | undefined]);
    const names = labels.get(f);
    return !!names && (l === undefined || l === "" || names.has(l));
  };
  for (const [file, script] of project.scripts) {
    for (const c of commandsIn(script.body)) {
      const found = defs.get(c.name);
      if (!found) continue;
      const { plugin, def } = found;
      const args = commandArgs(c.args, def.positional ?? [], toSpec(def));
      // データの名前（t.dataKey）
      for (const [param, p] of Object.entries(def.params)) {
        const where = p.type.kind === "string" ? p.type.data : undefined;
        const value = args[param];
        if (!where || value === undefined) continue;
        const data = project.data(where.file);
        const keys = dataKeys(data, where.path);
        const at = `${folder}/${where.file}`;
        if (data === undefined)
          out.push({ severity: "error", code: "unknown-data-key", message: `@${c.name} ${value} の ${at} がありません`, messageEn: `${at} for @${c.name} ${value} doesn't exist`, file, line: c.line, plugin, hint: `${at} を作り、${where.path} に ${value} を書きます（形の宣言のあるデータは、制作画面の「プラグイン」のタブで作れます）`, hintEn: `Create ${at} and add ${value} to ${where.path} (Studio's Plugins tab can create data with a declared shape)` });
        else if (keys === null)
          out.push({ severity: "error", code: "unknown-data-key", message: `@${c.name} の ${param} が読む ${at} の ${where.path} がありません`, messageEn: `${where.path} in ${at}, read by ${param} of @${c.name}, doesn't exist`, file, line: c.line, plugin });
        else if (!keys.includes(value))
          out.push({ severity: "error", code: "unknown-data-key", message: `@${c.name} の ${param} の ${value} が ${at} の ${where.path} にありません`, messageEn: `${value} (${param} of @${c.name}) isn't in ${where.path} of ${at}`, file, line: c.line, plugin, ...(keys.length > 0 ? { hint: `書ける名前: ${keys.slice(0, 8).join("、")}${keys.length > 8 ? " …" : ""}`, hintEn: `Names you can use: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? " …" : ""}` } : {}) });
      }
      if (!def.validate) continue;
      try {
        const result: unknown = def.validate(args, {
          file,
          line: c.line,
          data: (name) => project.data(name),
          assetExists: (f, path) => project.assetExists(f, path),
          isCast: (name) => Object.hasOwn(project.cast, name),
          targetExists: (target) => targetExists(file, target),
        });
        if (result === undefined) continue;
        if (!Array.isArray(result)) throw new Error("validate が診断の配列を返しませんでした");
        for (const item of result as CommandDiagnostic[]) {
          const d = pluginDiagnostic(plugin, { ...item, file: item.file ?? file, line: item.line ?? c.line });
          if (d) out.push(d);
          else out.push({ severity: "error", code: "plugin-check-invalid", message: `@${c.name} の validate が形の合わない診断を返しました: ${JSON.stringify(item)}`, messageEn: `validate of @${c.name} returned a malformed diagnostic: ${JSON.stringify(item)}`, file, line: c.line, hint: "診断には severity（error、warning、info）、code、message を書きます", hintEn: "A diagnostic needs severity (error, warning or info), code and message", plugin });
        }
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        out.push({ severity: "error", code: "plugin-check-failed", message: `@${c.name} の validate が失敗しました: ${text}`, messageEn: `validate of @${c.name} failed: ${text}`, file, line: c.line, hint: "プラグインの validate を直します（ほかの検査は最後まで行いました）", hintEn: "Fix the plugin's validate (all other checks still ran)", plugin });
      }
    }
  }
}

/** プラグインの口の版（apiVersion）と式の関数の名前。 */
function checkPluginApi(plugins: readonly CommandPlugin[], out: Diagnostic[]): void {
  const builtIn = CORE_FUNCTIONS;
  for (const p of plugins) {
    if (typeof p.apiVersion === "number" && p.apiVersion > PLUGIN_API_VERSION) {
      out.push({
        severity: "warning",
        code: "plugin-api-version",
        message: `プラグイン ${p.name} はプラグインの口の版 ${p.apiVersion} 向けで、このエンジン（版 ${PLUGIN_API_VERSION}）より新しい口を使います`,
        messageEn: `The plugin ${p.name} targets plugin API version ${p.apiVersion}, newer than this engine's (${PLUGIN_API_VERSION})`,
        file: "liminalia.json",
        line: 1,
        hint: "Liminalia を新しい版にするか、このエンジンに合う版のプラグインを入れます",
        hintEn: "Update Liminalia, or install a version of the plugin made for this engine",
        plugin: p.name,
      });
    }
    for (const name of Object.keys(p.functions ?? {})) {
      if (!builtIn.has(name)) continue;
      out.push({ severity: "warning", code: "plugin-function-clash", message: `プラグイン ${p.name} の式の関数 ${name}() は組み込みの関数と同じ名前なので使われません`, messageEn: `The plugin ${p.name}'s expression function ${name}() has the same name as a built-in function, so it isn't used`, file: "liminalia.json", line: 1, hint: "関数の名前を変えます", hintEn: "Rename the function", plugin: p.name });
    }
  }
}


/**
 * 合うエンジンの宣言（liminalia.api: 要る口の版、engines.liminalia: 合う口の版の範囲）のうち、このエンジンの口の版（PLUGIN_API_VERSION）に
 * 合わないもの（"3"、">=3" など、書いたままの形）。合えば、宣言が無ければ、読めなければ空。
 * プラグインの package.json、テーマの theme.json、作品とひな形の liminalia.json で同じ形を読む。
 */
export function engineMismatches(manifest: unknown, version: number = PLUGIN_API_VERSION): string[] {
  if (!manifest || typeof manifest !== "object") return [];
  const m = manifest as { liminalia?: { api?: unknown }; engines?: Record<string, unknown> };
  const out: string[] = [];
  const api = m.liminalia?.api;
  if (typeof api === "number" && api > version) out.push(String(api));
  const range = m.engines?.liminalia;
  if (typeof range === "string" && range.trim() !== "" && !apiSatisfies(version, range)) out.push(range.trim());
  return out;
}

/**
 * プラグインの package.json の宣言（liminalia.api: 要るプラグインの口の版、engines.liminalia: 合うプラグインの口の版の範囲）を、このエンジンと比べる。
 * spec は liminalia.json の plugins に書いた形（診断に出す）。合わなければ警告（plugin-engine-version）。
 */
export function checkPluginManifest(spec: string, manifest: unknown): Diagnostic[] {
  return engineMismatches(manifest).map((need) => ({
    severity: "warning",
    code: "plugin-engine-version",
    message: `プラグイン ${spec} はプラグインの口の版 ${need} 向けで、このエンジン（版 ${PLUGIN_API_VERSION}）では動かないことがあります`,
    messageEn: `The plugin ${spec} needs plugin API version ${need}, but this engine provides version ${PLUGIN_API_VERSION}; it may not work`,
    file: "liminalia.json",
    line: 1,
    hint: "Liminalia を新しい版にするか、このエンジンに合う版のプラグインを入れます",
    hintEn: "Update Liminalia, or install a version of the plugin made for this engine",
    plugin: spec,
  }));
}

/**
 * プラグインの口の版 version が範囲 range に入るか。`2`、`>=2`、`>2`、`<=3`、`<3`、`^2`（2 以上 3 未満）、`2 - 4`、`*`、
 * 空白区切り（すべて満たす）と `||`（どれか）を読む。読めない範囲は入るとみなす（知らない書き方で止めない）。
 */
export function apiSatisfies(version: number, range: string): boolean {
  return range.split("||").some((alt) => {
    const part = alt.trim();
    if (part === "" || part === "*" || part === "x") return true;
    const hyphen = /^(\d+)(?:\.[\dx*]+)*\s+-\s+(\d+)(?:\.[\dx*]+)*$/.exec(part);
    if (hyphen) return version >= Number(hyphen[1]) && version <= Number(hyphen[2]);
    return part.split(/\s+/).every((c) => {
      const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.[\dx*]+)*$/.exec(c);
      if (!m) return true;
      const n = Number(m[2]);
      switch (m[1]) {
        case ">=":
          return version >= n;
        case "<=":
          return version <= n;
        case ">":
          return version > n;
        case "<":
          return version < n;
        case "^":
        case "~":
        case "=":
        case undefined:
          return version === n;
        default:
          return true;
      }
    });
  });
}

/**
 * 組み込みの命令か、先に読んだプラグインの同じ名前の命令を、宣言（replaces: true）なしに上書きしている命令。後に読んだプラグインの命令が使われる
 * （combinePlugins と実行器）。over は上書きされた側（組み込みならエンジン、そうでなければそのプラグインの名前）。
 */
export function undeclaredOverrides(plugins: readonly CommandPlugin[], builtIn: Iterable<string> = CORE_COMMANDS.map((c) => c.name)): { plugin: string; name: string; over: string | null }[] {
  const owner = new Map<string, string | null>();
  for (const name of builtIn) owner.set(name, null);
  const out: { plugin: string; name: string; over: string | null }[] = [];
  for (const p of plugins) {
    for (const c of p.commands) {
      if (owner.has(c.name) && !c.replaces && owner.get(c.name) !== p.name) out.push({ plugin: p.name, name: c.name, over: owner.get(c.name)! });
      owner.set(c.name, p.name);
    }
  }
  return out;
}

/** プラグインの check を順に呼ぶ。投げたもの・形の合わないものは、チェック全体を止めずにそのプラグインの診断にする。 */
export function runPluginChecks(plugins: readonly CommandPlugin[], project: PluginCheckProject): Diagnostic[] {
  const out: Diagnostic[] = [];
  // 宣言なしの上書き（標準の命令が増えて、作品のプラグインの命令と名前がぶつかったときなど）
  for (const o of undeclaredOverrides(plugins)) {
    const over = o.over === null ? "組み込み" : o.over;
    const overEn = o.over === null ? "the built-in" : o.over;
    out.push({
      severity: "warning",
      code: "plugin-replaces-command",
      message: `プラグイン ${o.plugin} の @${o.name} が、${over} の @${o.name} を上書きしています（置き換えの宣言がありません）`,
      messageEn: `The plugin ${o.plugin}'s @${o.name} overrides ${overEn} @${o.name} (it doesn't declare that it replaces it)`,
      file: "liminalia.json",
      line: 1,
      hint: `置き換えるつもりなら、命令の定義に replaces: true を書きます。そうでなければ命令の名前を変えます`,
      hintEn: "If it's meant to replace it, add replaces: true to the command definition. Otherwise rename the command",
      plugin: o.plugin,
    });
  }
  const problem = (name: string, code: string, message: string, messageEn: string, hint: string, hintEn: string) => out.push({ severity: "error", code, message, messageEn, file: "liminalia.json", line: 1, hint, hintEn, plugin: name });
  // プラグインの口の版と、式の関数の名前
  checkPluginApi(plugins, out);
  // 命令ごとの検査（validate）とデータの名前の引数（t.dataKey）
  checkCommandLines(plugins, project, out);
  // データの形の宣言（data）の検査。投げても全体のチェックは止めない
  try {
    out.push(...checkDeclaredData(plugins, project));
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    problem("data", "plugin-check-failed", `データの形の検査が失敗しました: ${text}`, `Checking the declared data failed: ${text}`, "データの宣言を直します（ほかの検査は最後まで行いました）", "Fix the data declarations (all other checks still ran)");
  }
  for (const p of plugins) {
    if (!p.check) continue;
    try {
      const result: unknown = p.check(project);
      if (!Array.isArray(result)) {
        problem(p.name, "plugin-check-invalid", `プラグイン ${p.name} の check が診断の配列を返しませんでした`, `The check of the plugin ${p.name} didn't return an array of diagnostics`, "check は同期の関数にして、診断の配列を返します", "Make check a synchronous function that returns an array of diagnostics");
        continue;
      }
      for (const item of result as PluginDiagnostic[]) {
        const d = pluginDiagnostic(p.name, item);
        if (d) out.push(d);
        else problem(p.name, "plugin-check-invalid", `プラグイン ${p.name} の check が形の合わない診断を返しました: ${JSON.stringify(item)}`, `The check of the plugin ${p.name} returned a malformed diagnostic: ${JSON.stringify(item)}`, "診断には severity（error、warning、info）、code、message を書きます", "A diagnostic needs severity (error, warning or info), code and message");
      }
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      problem(p.name, "plugin-check-failed", `プラグイン ${p.name} の check が失敗しました: ${text}`, `The check of the plugin ${p.name} failed: ${text}`, "プラグインの check を直します（ほかの検査は最後まで行いました）", "Fix the plugin's check (all other checks still ran)");
    }
  }
  return out;
}

export function defineCommandPlugin(plugin: CommandPlugin): CommandPlugin {
  return plugin;
}

/**
 * 複数のプラグインの命令をまとめて、仕様と実装にする。プラグインの式の関数（functions）も、検査（@liminalia/lang）と実行器（@liminalia/runtime）に
 * 入れる（前に入れたものと入れ替える。組み込みと同じ名前のものは入れない）。
 */
export function combinePlugins(plugins: readonly CommandPlugin[]) {
  const commands = plugins.flatMap((p) => p.commands);
  const functions: Record<string, PluginFunction> = {};
  for (const p of plugins) {
    const own = p.functions ?? {};
    Object.assign(functions, own);
    // プラグインごとに入れ替える（ほかの呼び出しで入れたプラグインの関数は残す）
    const clash = new Set(setPluginFunctions(p.name, Object.fromEntries(Object.entries(own).map(([name, f]) => [name, arityOf(f)]))));
    setPluginFunctionImpls(p.name, Object.fromEntries(Object.entries(own).filter(([name]) => !clash.has(name)).map(([name, f]) => [name, (args: Value[], env: { random(): number }) => f.run(args, env)])));
  }
  return {
    commands,
    specs: commands.map(toSpec),
    implementations: commands.map(toImplementation),
    functions,
  };
}

/** 関数の引数の数を [最小, 最大] にする。 */
function arityOf(f: PluginFunction): readonly [number, number] {
  if (typeof f.args === "number") return [f.args, f.args];
  return [f.args[0], f.args[1]];
}
