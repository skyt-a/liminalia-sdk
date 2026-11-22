import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CORE_COMMANDS, createRegistry, englishDiagnostic, parse, type Diagnostic, type Script } from "@liminalia/lang";
import { assetHeads, assetNames, CONFIG_FILE, ConfigError, configSchema, engineVersionDiagnostics, listPackSources, listScenarioFiles, projectDataReader, projectFileReader, readScenarioFile } from "@liminalia/project";
import { pluginScreens } from "@liminalia/project/screen-templates";
import { projectDiagnostics } from "@liminalia/plugin-host";
import { screenTemplateRules } from "@liminalia/web/screen-rules";
import { loadContext, type Context } from "../context.ts";
import { countEn } from "../english.ts";
import { applyFixesToFiles, printFixed } from "../apply-fixes.ts";

export function formatDiagnostic(d: Diagnostic): string {
  const where = `${d.file}:${d.line}${d.column ? `:${d.column}` : ""}`;
  return `${where} ${d.severity} [${d.code}] ${d.message}${d.hint ? `\n    → ${d.hint}` : ""}`;
}

function readAsset(ctx: Context, folder: string, file: string): Uint8Array | null {
  const path = join(ctx.project.paths.assets, folder, file);
  return existsSync(path) ? readFileSync(path) : null;
}

/** --lang en の診断（文と直し方を英語にする）。 */
export function inEnglish(d: Diagnostic): Diagnostic {
  const { messageEn: _messageEn, hintEn: _hintEn, hint: _hint, ...rest } = d;
  return { ...rest, ...englishDiagnostic(d) };
}

/** GitHub Actions の注釈の値の書き方（%・改行を逃がす。プロパティでは : と , も）。 */
function escapeAnnotation(text: string, property = false): string {
  const s = text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return property ? s.replace(/:/g, "%3A").replace(/,/g, "%2C") : s;
}

/**
 * 診断を GitHub Actions の注釈（::error file=…,line=…::…）にする。file は今のフォルダ（Actions ではリポジトリの直下）からのパス。
 * エラーは error、警告は warning、情報は notice。
 */
export function githubAnnotation(d: Diagnostic, file: string, title = `lim check ${d.code}`): string {
  const level = d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "notice";
  const props = [`file=${escapeAnnotation(file, true)}`, `line=${d.line}`, ...(d.column ? [`col=${d.column}`] : []), `title=${escapeAnnotation(title, true)}`];
  return `::${level} ${props.join(",")}::${escapeAnnotation(`${d.message}${d.hint ? `\n→ ${d.hint}` : ""}`)}`;
}

/** 診断の並び（ファイルの名前、行、桁。桁の無いものはその行の先）。 */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return a.file.localeCompare(b.file, "en", { numeric: true }) || a.line - b.line || (a.column ?? 0) - (b.column ?? 0);
}

export interface CheckOptions {
  /** GitHub Actions の注釈（::error 形式）でも出す。 */
  github?: boolean;
  /** 警告も失敗にする（終了の値が 1 になる）。 */
  strict?: boolean;
  /**
   * 書き出しの前の検査（lim build）。下書き（// lim: draft）のファイルは書き出さないので、その中の診断を数えず、
   * 下書きへ移る行（draft-target）は、書き出したゲームで行き先が無くなるのでエラーにする。
   */
  build?: boolean;
  /**
   * 診断に付いた直し方（fix）を、この code のものだけ作品の全体に当ててから検査する（lim check --fix chara-solo,same-as-default）。
   * UTF-8 で読めない台本と下書きでない台本の区別はせず、UTF-8 で読めるものすべてに当てる。
   */
  fix?: readonly string[];
  /** 当てた直し方（--fix のあとの検査で、--json に出す）。left は同じ所に重なって当てなかった直し方の数。 */
  fixed?: { file: string; line: number; code: string }[] & { left?: number };
}

/**
 * 作品全体の診断（lim check と同じ一覧。出さずに返す）。hide に当たる素材は無いものとして検査する
 * （書き出しの「使っている素材だけ」が、外す素材を使う所が残っていないかを確かめるのに使う）。
 */
export function projectCheck(ctx: Context, o: { hide?: (folder: string, path: string) => boolean } = {}): {
  scripts: Map<string, Script>;
  files: Map<string, { script: Script; text: string }>;
  encodings: Map<string, string>;
  paths: Map<string, string>;
  diagnostics: Diagnostic[];
} {
  const scripts = new Map<string, Script>();
  const files = new Map<string, { script: Script; text: string }>();
  // UTF-8 で読めない台本（Shift_JIS など）は bad-encoding にし、化けた中身からの診断は出さない
  const encodings = new Map<string, string>();
  const paths = new Map<string, string>();
  for (const { name, path } of listScenarioFiles(ctx.project.paths.scenario)) {
    paths.set(name, path);
    const { text, encoding } = readScenarioFile(path);
    if (encoding) encodings.set(name, encoding);
    const script = parse(text, name, { speakers: ctx.cast.speakers });
    scripts.set(name, script);
    files.set(name, { script, text });
  }
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  const names = assetNames(ctx.project.paths.assets);
  const hide = o.hide ?? (() => false);
  const exists = (folder: string, path: string) => !hide(folder, path) && existsSync(join(ctx.project.paths.assets, folder, path));
  const actual = (folder: string, path: string) => {
    const found = names(folder, path);
    return typeof found === "string" && hide(folder, found) ? null : found;
  };
  const castFile = relative(ctx.project.root, ctx.project.paths.cast).split(sep).join("/") || "cast.json";
  // 制作画面、VS Code、MCP と同じ一覧（@liminalia/sdk の projectDiagnostics。入力を足すならそちらに足す）
  const diagnostics: Diagnostic[] = projectDiagnostics({
    root: ctx.project.root,
    files,
    config: ctx.project.config,
    configText: read(join(ctx.project.root, CONFIG_FILE)),
    cast: ctx.cast.cast,
    speakers: ctx.cast.speakers,
    castText: read(ctx.project.paths.cast),
    castFile,
    schemas: { liminalia: configSchema("liminalia"), cast: configSchema("cast"), lang: configSchema("lang") },
    registry: ctx.registry,
    baseRegistry: createRegistry(CORE_COMMANDS, ctx.combined.specs),
    plugins: ctx.plugins,
    data: projectDataReader(ctx.project),
    dataText: (name) => read(join(ctx.project.paths.data, ...name.split("/"))) ?? undefined,
    dataFolder: relative(ctx.project.root, ctx.project.paths.data).split(sep).join("/") || "data",
    translations: (ctx.project.config.languages ?? []).slice(1).map((language) => ({ language, text: read(join(ctx.project.paths.lang, `${language}.json`)) })),
    // 大文字と小文字の違い（asset-case-mismatch）も見る
    assets: { exists, actual, head: assetHeads(ctx.project.paths.assets) },
    voiceLockText: read(ctx.project.paths.voiceLock),
    // パックの台本と訳（パックだけが使う訳とボイスの鍵、パックの訳）
    packs: listPackSources(ctx.project.root),
    // 作品の CSS（ui.css）と、その中の url() の素材、画面のテンプレート（ui.templates）
    projectFiles: projectFileReader(ctx.project.root),
    readFont: (file) => readAsset(ctx, "others", file),
    encodings,
    // 作品の画面のテンプレート（ui.templates。画面ごとの決まりは @liminalia/web の標準の画面の定義から）
    screenTemplates: { rules: screenTemplateRules(), plugins: pluginScreens(ctx.project.root, ctx.project.config.plugins) },
    // プラグインの package.json の、合うエンジンの宣言
    more: engineVersionDiagnostics(ctx.project),
  });
  return { scripts, files, encodings, paths, diagnostics };
}

/**
 * lim check [プロジェクト] [--json] [--lang en] [--github] [--strict] [--fix code,…] — 全シナリオを検査する。エラーがあれば false（strict なら警告でも）。
 * --fix は、その code の診断に付いた直し方を全ファイルに当ててから検査し直す（一人ずつ見せる型を solo=true にまとめる chara-solo など）。
 * 既定の出力は日本語。
 */
export async function runCheck(dir: string, json: boolean, language: "ja" | "en" = "ja", o: CheckOptions = {}): Promise<boolean> {
  let ctx: Context;
  try {
    ctx = await loadContext(dir);
  } catch (e) {
    // liminalia.json と cast.json を読めなければ、その位置の誤りだけを出して終える
    if (!(e instanceof ConfigError)) throw e;
    const d: Diagnostic = { severity: "error", code: "bad-config", message: e.reason, file: e.file, line: e.line, ...(e.column !== undefined ? { column: e.column } : {}) };
    const shown = language === "en" ? inEnglish(d) : d;
    if (json) console.log(JSON.stringify({ files: 0, errors: 1, warnings: 0, infos: 0, diagnostics: [shown] }, null, 2));
    else console.log(formatDiagnostic(shown));
    if (o.github) console.log(githubAnnotation(shown, relative(process.cwd(), join(dir, e.file)).split(sep).join("/")));
    return false;
  }
  const { scripts, files, encodings, paths, diagnostics } = projectCheck(ctx);
  if (o.build) {
    const drafts = new Set([...scripts].filter(([, s]) => s.draft).map(([f]) => f));
    if (drafts.size > 0) console.log(`  下書きの ${drafts.size} ファイル（${[...drafts].map((f) => `${f}.lim`).join("、")}）は書き出さないので、チェックの結果に数えません`);
    const kept = diagnostics.filter((d) => !drafts.has(d.file)).map((d): Diagnostic => (d.code === "draft-target" ? { ...d, severity: "error" } : d));
    diagnostics.splice(0, diagnostics.length, ...kept);
  }
  // ファイル、行、桁の順に並べる（--json も）。同じ場所なら集めた順のまま
  diagnostics.sort(compareDiagnostics);
  if (o.fix) {
    // 選んだ code の直し方を当てて書き、書いたあとの作品を検査し直す
    const fixed = applyFixesToFiles(files, paths, encodings, diagnostics, new Set(o.fix));
    if (!json) printFixed(fixed, o.fix, language);
    const { fix: _fix, ...rest } = o;
    return runCheck(dir, json, language, { ...rest, fixed });
  }
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;
  // 情報（要らない @cg-unlock など）は警告に数えない。あるときだけまとめの行に足す
  const infos = diagnostics.length - errors - warnings;
  const shown = language === "en" ? diagnostics.map(inEnglish) : diagnostics;
  if (json) {
    // fixedLeft は同じ所に重なって当てなかった直し方の数（並びの left は JSON に出ないので分けて書く）
    console.log(JSON.stringify({ files: scripts.size, errors, warnings, infos, ...(o.fixed ? { fixed: o.fixed } : {}), ...(o.fixed?.left ? { fixedLeft: o.fixed.left } : {}), diagnostics: shown }, null, 2));
  } else {
    for (const d of shown) console.log(formatDiagnostic(d));
    const byCode = new Map<string, number>();
    for (const d of diagnostics) byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
    console.log(
      language === "en"
        ? `\n${countEn(scripts.size, "file")}, ${countEn(errors, "error")}, ${countEn(warnings, "warning")}${infos > 0 ? `, ${countEn(infos, "note")}` : ""}`
        : `\n${scripts.size} ファイル、エラー ${errors} 件、警告 ${warnings} 件${infos > 0 ? `、情報 ${infos} 件` : ""}`,
    );
    for (const [code, n] of [...byCode].sort((a, b) => b[1] - a[1])) console.log(`  ${code}: ${n}`);
  }
  if (o.github) {
    // 診断の file はシナリオなら拡張子なしの名前、ほかはプロジェクトからのパス。注釈には今のフォルダからのパスを書く
    const pathOf = (file: string) => relative(process.cwd(), scripts.has(file) ? join(ctx.project.paths.scenario, `${file}.lim`) : join(ctx.project.root, file)).split(sep).join("/");
    for (const d of shown) console.log(githubAnnotation(d, pathOf(d.file)));
    if (o.strict && errors === 0 && warnings > 0) console.log(`::error title=lim check::${escapeAnnotation(language === "en" ? `${countEn(warnings, "warning")} (--strict treats warnings as failures)` : `警告が ${warnings} 件あります（--strict は警告も失敗にします）`)}`);
  } else if (o.strict && !json && errors === 0 && warnings > 0) {
    console.log(language === "en" ? "--strict: warnings count as failures" : "--strict のため、警告があるので失敗にします");
  }
  return errors === 0 && (!o.strict || warnings === 0);
}
