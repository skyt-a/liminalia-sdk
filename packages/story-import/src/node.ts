// Node 専用（ファイルを読み書きする）。ブラウザで動く変換は @liminalia/story-import から。
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { collectTranslatable, mediaKindOf, parse, parseInline, plainText, translationKeyKind, updateTranslation, type Registry, type TranslationFile } from "@liminalia/lang";
import { CONFIG_FILE, listScenarioFiles, loadProject, notUtf8Scenarios, readCast, readScenarioFile, type ProjectConfig } from "@liminalia/project";
import { assetCopyReport, copyAssets, type AssetCopyResult } from "@liminalia/project/asset-copy";
import type { CommandMap } from "./commands.ts";
import type { EndMode } from "./ir.ts";
import { importInk } from "./ink.ts";
import { importRenpy, renpyLanguageCode, type RenpyResult, type RenpyTranslation } from "./renpy.ts";
import { importTwine } from "./twine.ts";
import { recheck, storyReport } from "./report.ts";
import { limFileName, type StoryImportResult } from "./session.ts";
import { importYarn } from "./yarn.ts";

export * from "./index.ts";

export type StoryKind = "ink" | "yarn" | "renpy" | "twine";

export interface StoryProjectOptions {
  /** 書き出す .lim の名前（Ink と、Yarn のファイルが一つのとき）。 */
  name?: string;
  end?: EndMode;
  /** 前に取り込んだもの以外の .lim も上書きする。 */
  force?: boolean;
  /** 読み直しの検査に使う命令の仕様（組み込み＋プラグイン）。 */
  registry: Registry;
  /** Ren'Py の台本が使う素材（game/images と game/audio など）を、作品の素材のフォルダへ写すか。既定は写す（lim import-renpy --no-assets で写さない）。 */
  assets?: boolean;
}

export interface StoryProjectResult {
  result: StoryImportResult;
  report: string;
  reportPath: string;
  written: string[];
  /** 上書きしなかった .lim（前の取り込みで作ったものではないため）。 */
  refused: string[];
  /** 写した素材（Ren'Py。写さなかったときは null）。 */
  assets: AssetCopyResult | null;
  /** Ren'Py の translate から作った訳のファイル（言語、ファイル、訳を入れた項目の数、項目の数）。 */
  translations: { language: string; file: string; filled: number; total: number }[];
  /** 未対応・手作業・構文エラー・検査エラーが 0 か。 */
  ok: boolean;
}

/** 報告に出す形式の名前。 */
export const STORY_LABELS: Record<StoryKind, string> = { ink: "Ink", yarn: "Yarn Spinner", renpy: "Ren'Py", twine: "Twine" };

/** フォルダから読むファイルの拡張子。 */
const SOURCE_EXTENSIONS: Record<Exclude<StoryKind, "ink">, readonly string[]> = { yarn: [".yarn"], renpy: [".rpy"], twine: [".twee", ".tw"] };

/** 取り込みで書いた .lim の先頭の行（session.ts の convertedHeader。日本語と英語）。上書きしてよいかの目印。 */
const MARK = /^\/\/ (?:.* から lim import-(ink|yarn|renpy|twine) で変換|Converted from .* with lim import-(ink|yarn|renpy|twine))$/;

/** 対応表（liminalia.json の import.ink.commands / import.yarn.commands）。 */
function commandsOf(config: ProjectConfig, kind: StoryKind): CommandMap {
  return kind === "ink" || kind === "yarn" ? (config.import?.[kind]?.commands ?? {}) : {};
}

/** ファイル（フォルダなら中の ext のファイルをすべて）。name は報告に出す名前（フォルダからのパスか、ファイル名）。 */
function sourceFiles(inputs: readonly string[], ext: readonly string[]): { path: string; name: string }[] {
  const out: { path: string; name: string }[] = [];
  const walk = (p: string, root: string) => {
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) walk(join(p, f), root);
    } else if (ext.some((e) => p.endsWith(e))) out.push({ path: p, name: relative(root, p).split(sep).join("/") });
  };
  for (const i of inputs) {
    if (!existsSync(i)) throw new Error(`${i} がありません`);
    if (statSync(i).isDirectory()) walk(i, i);
    else out.push({ path: i, name: basename(i) });
  }
  return out;
}

/**
 * Ink・Yarn Spinner のファイルを読み、プロジェクトのシナリオのフォルダに .lim を書く。台詞の話者を cast.json の speakers に、
 * 変数の初期値を liminalia.json の variables に足し（あるものは変えない）、報告を <シナリオの一つ上>/<ink|yarn>-import-report.md に書く。
 */
export function importStoryProject(dir: string, kind: StoryKind, inputs: readonly string[], o: StoryProjectOptions): StoryProjectResult {
  const project = loadProject(dir);
  const cast = readCast(project);
  const base = { speakers: cast.speakers, commands: commandsOf(project.config, kind), ...(o.end ? { end: o.end } : {}), ...(o.name ? { name: o.name } : {}) };
  let result: StoryImportResult;
  /** Ren'Py の game/ のフォルダ（素材と訳の元）。 */
  let game: string | null = null;
  if (kind === "ink") {
    if (inputs.length !== 1) throw new Error("Ink は始まりのファイルを一つ指定します（INCLUDE のファイルは自動で読み込みます）");
    const main = resolve(inputs[0]!);
    if (!existsSync(main)) throw new Error(`${inputs[0]} がありません`);
    const root = realpathSync(dirname(main));
    result = importInk(readFileSync(main, "utf8"), {
      ...base,
      file: basename(main),
      include: (path) => {
        // INCLUDE は始まりのファイルのフォルダの中だけ読む
        const full = resolve(dirname(main), path);
        if (!existsSync(full)) return null;
        const real = realpathSync(full);
        if (real !== root && !real.startsWith(root + sep)) return null;
        return readFileSync(real, "utf8");
      },
    });
  } else {
    const ext = SOURCE_EXTENSIONS[kind];
    const files = sourceFiles(inputs, ext);
    if (files.length === 0) throw new Error(`${ext.join("・")} のファイルがありません`);
    const sources = files.map((f) => ({ file: f.name, text: readFileSync(f.path, "utf8") }));
    if (kind === "twine") {
      // Twee のファイルが分かれていても、パッセージは一つの物語として読み、一つの .lim にする
      if (sources.length > 1) base.name ??= limFileName(sources[0]!.file);
      result = importTwine(sources.map((x) => x.text).join("\n"), { ...base, file: sources[0]!.file });
    } else if (kind === "yarn") result = importYarn(sources, base);
    else {
      // Ren'Py が自動で名前を決める画像（game/images）と音（game/audio）の本当のファイル名を渡す
      game = renpyGameDir(inputs);
      result = importRenpy(sources, { ...base, ...(game ? { imageFiles: renpyFiles(join(game, "images"), (f) => f.toLowerCase()), audioFiles: renpyFiles(join(game, "audio"), audioName) } : {}) });
    }
  }
  /** 変換で作ったキャスト（Ren'Py の立ち絵）。 */
  const newCast = "cast" in result ? (result.cast as Record<string, unknown>) : {};

  const written: string[] = [];
  const refused: string[] = [];
  for (const f of result.files) {
    const path = join(project.paths.scenario, `${f.name}.lim`);
    if (existsSync(path) && !o.force && !MARK.test(readFileSync(path, "utf8").split("\n")[0] ?? "")) {
      refused.push(`${f.name}.lim`);
      continue;
    }
    writeFileSync(path, f.text);
    written.push(`${f.name}.lim`);
  }
  // 話者と変数とキャスト（すでにある人物は変えない）
  const castNames = Object.keys(newCast).filter((n) => !(n in cast.cast));
  if (result.newSpeakers.length > 0 || castNames.length > 0) {
    const raw = existsSync(project.paths.cast) ? (JSON.parse(readFileSync(project.paths.cast, "utf8")) as Record<string, unknown>) : { cast: {} };
    raw.speakers = [...cast.speakers, ...result.newSpeakers];
    raw.cast = { ...((raw.cast as Record<string, unknown> | undefined) ?? {}), ...Object.fromEntries(castNames.map((n) => [n, newCast[n]])) };
    writeFileSync(project.paths.cast, `${JSON.stringify(raw, null, 2)}\n`);
  }
  const configPath = join(project.root, CONFIG_FILE);
  const config = JSON.parse(readFileSync(configPath, "utf8")) as ProjectConfig;
  const vars = { ...(config.variables ?? {}) };
  let added = 0;
  for (const [k, v] of Object.entries(result.variables)) {
    if (k in vars) continue;
    vars[k] = v;
    added++;
  }
  if (added > 0) writeFileSync(configPath, `${JSON.stringify({ ...config, variables: vars }, null, 2)}\n`);

  const speakers = [...cast.speakers, ...result.newSpeakers];
  const check = recheck(result, o.registry, speakers);
  const label = STORY_LABELS[kind];
  let report = storyReport(label, result, check);
  if (refused.length > 0) report += `\n## 上書きしなかったファイル\n\n${refused.map((f) => `- ${f}（lim import-${kind} で作ったものではありません。--force で上書きします）`).join("\n")}\n`;

  // Ren'Py の素材と訳
  let assets: AssetCopyResult | null = null;
  const translations: StoryProjectResult["translations"] = [];
  if (kind === "renpy") {
    const r = result as RenpyResult;
    const names = r.assets.map((a) => ({ name: a.name, to: `${a.folder}/${a.path}` }));
    if (o.assets !== false && game) {
      const root = game;
      assets = copyAssets(
        root,
        project.paths.assets,
        r.assets.map((a) => ({ from: renpySourcePath(root, a.from ?? a.path, a.folder), to: `${a.folder}/${a.path}` })),
      );
      report += assetCopyReport(assets, names);
    } else if (r.assets.length > 0) report += `\n## 素材\n\n- 素材はコピーしていません（${o.assets === false ? "--no-assets" : "game/ のフォルダが分からないため"}）。台本は次の名前で素材を使います\n\n${names.map((n) => `- ${n.name} → ${n.to}`).join("\n")}\n`;
    if (r.translations.length > 0) {
      const lines: string[] = ["", "## 訳（translate）", ""];
      for (const t of r.translations) {
        const made = writeRenpyTranslation(project.root, t, o.registry, speakers);
        if (typeof made === "string") lines.push(`- ${t.language}: ${made}`);
        else {
          translations.push(made);
          lines.push(`- ${t.language} → ${made.file}: ${made.total} 項目のうち ${made.filled} 項目に訳を入れました`);
        }
      }
      report += `${lines.join("\n")}\n`;
    }
  }

  const reportPath = join(project.paths.scenario, "..", `${kind}-import-report.md`);
  writeFileSync(reportPath, report);
  const ok = result.totals.generic === 0 && result.totals.manual === 0 && check.syntaxErrors.length === 0 && check.checkErrors.length === 0 && refused.length === 0;
  return { result, report, reportPath, written, refused, assets, translations, ok };
}

// ---- Ren'Py の素材と訳 ----

/**
 * Ren'Py の game/ のフォルダ。渡したフォルダ（かファイルのフォルダ）とその上を三つまで見て、名前が game のものか、
 * images か audio を持つものを選ぶ。作品のフォルダ（game/ を持つ）を渡したときはその game/。分からなければ null。
 */
function renpyGameDir(inputs: readonly string[]): string | null {
  for (const input of inputs) {
    let dir = resolve(input);
    if (existsSync(dir) && !statSync(dir).isDirectory()) dir = dirname(dir);
    if (existsSync(join(dir, "game")) && statSync(join(dir, "game")).isDirectory()) return join(dir, "game");
    for (let up = 0; up < 4; up++) {
      if (basename(dir) === "game" || existsSync(join(dir, "images")) || existsSync(join(dir, "audio"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** Ren'Py の audio. の名前（拡張子を除き、小文字にして、名前に使えない文字を _ に）。 */
const audioName = (stem: string) => stem.toLowerCase().replace(/[^a-z0-9_]/g, "_");

/** フォルダの中の素材のファイル（名前 → フォルダからのパス）。名前は拡張子とフォルダを除いたものを name で整えたもの。重なれば先のもの。 */
function renpyFiles(dir: string, name: (stem: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const rel of (readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[]).sort()) {
    const path = rel.split(sep).join("/");
    if (!mediaKindOf(path) || path.split("/").some((p) => p.startsWith("."))) continue;
    const key = name(basename(path).replace(/\.[^.]+$/, ""));
    if (!out.has(key)) out.set(key, path);
  }
  return out;
}

/** 台本に書いた名前の、game/ からのパス（game/ に無ければ images/ か audio/ の下を探す）。 */
function renpySourcePath(game: string, from: string, folder: string): string {
  const candidates = [from, ...(folder === "bgimage" || folder === "fgimage" ? [`images/${from}`] : [`audio/${from}`, `${folder === "bgm" ? "music" : folder}/${from}`])];
  return candidates.find((c) => existsSync(join(game, c))) ?? from;
}

/**
 * translate のブロックの訳を lang/<言語>.json にする。今のシナリオの訳すもの（lim i18n と同じ updateTranslation）を作り、訳が空の項目に、
 * 原文が同じ台詞と地の文、選択肢（strings の old）の訳を入れる。話者の名前も strings にあれば入れる。liminalia.json の languages に言語を足す。
 * 言語のコードにできなければ、理由の文を返す。
 */
function writeRenpyTranslation(root: string, t: RenpyTranslation, registry: Registry, speakers: readonly string[]): { language: string; file: string; filled: number; total: number } | string {
  const project = loadProject(root);
  const code = renpyLanguageCode(t.language);
  if (!code) return `言語のコードにできないので取り込みませんでした（${t.language}。lang/<言語>.json の名前にする言語のコードが分かりません）`;
  const sourceLanguage = project.config.languages?.[0] ?? "ja";
  if (code === sourceLanguage) return `原文の言語（${code}）と同じなので取り込みませんでした`;
  const one = (text: string) => collectTranslatable(parse(text, "renpy-tl", { speakers }))[0];
  const lineMap = new Map<string, string>();
  for (const l of t.lines) {
    const a = one(l.source);
    const b = one(l.text);
    if (a && b) lineMap.set(`${a.speaker ?? ""}\u0000${a.source}`, b.source);
  }
  const option = (text: string) => one(`@choice\n  - ${text} -> #renpy_tl\n@end\n# renpy_tl\n`)?.source;
  const optionMap = new Map<string, string>();
  const speakerNames = new Map<string, string>();
  for (const st of t.strings) {
    const a = option(st.source);
    const b = option(st.text);
    if (a && b) optionMap.set(a, b);
    const plain = plainText(parseInline(st.source).content);
    if (speakers.includes(plain)) speakerNames.set(plain, plainText(parseInline(st.text).content));
  }
  // UTF-8 で読めない台本があれば、化けた原文で訳のファイルを書かない（lim i18n と同じ）
  const bad = notUtf8Scenarios(project.paths.scenario);
  if (bad.length > 0) return `UTF-8 で読めないシナリオファイルがあるので、訳を取り込みませんでした（${bad.map((f) => `${f.name}.lim`).join("、")}）。エディタで UTF-8 で保存し直してから、もう一度取り込みます`;
  const scripts = new Map(listScenarioFiles(project.paths.scenario).map((f) => [f.name, parse(readScenarioFile(f.path).text, f.name, { speakers })] as const));
  const path = join(project.paths.lang, `${code}.json`);
  const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as TranslationFile) : null;
  const { file } = updateTranslation(existing, code, scripts, speakers, { registry, project: project.config });
  let filled = 0;
  let total = 0;
  for (const [key, e] of Object.entries(file.lines ?? {})) {
    const kind = translationKeyKind(key);
    if (kind !== "line" && kind !== "option") continue;
    total++;
    if (e.text !== "") continue;
    // 選択肢の問いかけの台詞は、行の終わりに {noclick} が付いている（訳にも付ける）
    const tail = kind === "line" && e.source.endsWith("{noclick}") ? "{noclick}" : "";
    const source = tail ? e.source.slice(0, -tail.length) : e.source;
    const text = kind === "line" ? lineMap.get(`${e.speaker ?? ""}\u0000${source}`) : optionMap.get(e.source);
    if (text === undefined) continue;
    e.text = text + tail;
    filled++;
  }
  if (speakerNames.size > 0) file.speakers = { ...(file.speakers ?? {}), ...Object.fromEntries([...speakerNames].filter(([k]) => !file.speakers?.[k])) };
  mkdirSync(project.paths.lang, { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  // 遊べる言語に足す（先頭は原文の言語）
  const configPath = join(project.root, CONFIG_FILE);
  const config = JSON.parse(readFileSync(configPath, "utf8")) as ProjectConfig;
  const languages = config.languages ?? [sourceLanguage];
  if (!languages.includes(code)) writeFileSync(configPath, `${JSON.stringify({ ...config, languages: [...languages, code] }, null, 2)}\n`);
  return { language: code, file: relative(project.root, path).split(sep).join("/"), filled, total };
}
