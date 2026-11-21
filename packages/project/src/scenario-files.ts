import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { encodingDiagnostic, notUtf8StopMessage, SCENARIO_TEST_EXTENSION, scenarioEncoding } from "@liminalia/lang";

/**
 * シナリオのファイル。name は台本の名前（paths.scenario からの相対パスで、区切りは /、拡張子 .lim を除いたもの。
 * 例: "start"、"part1/chapter2"）。@jump の飛び先、診断の file、書き出しの project/scenario/<name>.lim と同じもの。
 */
export interface ScenarioFile {
  name: string;
  /** ファイルの実際のパス。 */
  path: string;
}

/**
 * シナリオのフォルダの .lim を、サブフォルダまでたどって集める（. で始まるファイルとフォルダは見ない）。名前の順（文字の順）に並べる。
 * lim check・lim build などの道具と制作画面が同じ名前で台本を指すように、台本の一覧はここで作る。
 */
export function listScenarioFiles(dir: string): ScenarioFile[] {
  const out: ScenarioFile[] = [];
  const walk = (folder: string, prefix: string) => {
    for (const e of readdirSync(folder, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const path = join(folder, e.name);
      if (e.isDirectory()) walk(path, `${prefix}${e.name}/`);
      else if (e.name.endsWith(".lim")) out.push({ name: `${prefix}${e.name.slice(0, -".lim".length)}`, path });
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 台本のテスト（lim test の .limtest）を置くフォルダ（プロジェクトの直下）。 */
export const SCENARIO_TESTS_FOLDER = "tests";

/**
 * フォルダ（かファイル）の下の台本のテスト（.limtest。. で始まるものは見ない）。名前の数を数として並べる。無いか .limtest でなければ空。
 * lim test と名前の変更が同じ一覧を使う。
 */
export function listScenarioTestFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return path.endsWith(SCENARIO_TEST_EXTENSION) ? [path] : [];
  const out: string[] = [];
  for (const e of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
    if (e.name.startsWith(".")) continue;
    const p = join(path, e.name);
    if (e.isDirectory()) out.push(...listScenarioTestFiles(p));
    else if (e.name.endsWith(SCENARIO_TEST_EXTENSION)) out.push(p);
  }
  return out;
}

/** 作品の台本のテストのすべて（tests/ の下の .limtest）。 */
export function projectTestFiles(root: string): string[] {
  return listScenarioTestFiles(join(root, SCENARIO_TESTS_FOLDER));
}

/** シナリオファイルの中身。encoding は UTF-8 で読めないときの文字コードの見当（@liminalia/lang の scenarioEncoding。UTF-8 なら null）。 */
export interface ScenarioSource {
  text: string;
  encoding: string | null;
}

/**
 * シナリオファイルを読む（台本を読む処理はここを通す）。UTF-8 で読めなければ encoding に文字コードの見当を入れる（text は化けたまま）。
 * 読むだけの命令は encoding を見て飛ばすか診断にし、書き換える命令は先に assertScenariosUtf8 で止める。
 */
export function readScenarioFile(path: string): ScenarioSource {
  const bytes = readFileSync(path);
  return { text: bytes.toString("utf8"), encoding: scenarioEncoding(bytes) };
}

/**
 * シナリオファイルが UTF-8 で読めないときの文字コードの見当（readScenarioFile の encoding。UTF-8 で読めるか、無いファイルなら null）。
 * text に UTF-8 として読んだ中身を渡すと、化けた字（U+FFFD）が無ければファイルを読み直さない（UTF-8 で読めないバイト列は、読むと必ず U+FFFD になる）。
 * 中身を UTF-8 として読んで持っている所（制作画面、VS Code の拡張）が、書く前と検査の前に使う。
 */
export function scenarioFileEncoding(path: string, text?: string | null): string | null {
  if (text !== undefined && !text?.includes("\uFFFD")) return null;
  if (!existsSync(path)) return null;
  return readScenarioFile(path).encoding;
}

/**
 * 名前（拡張子なし）のシナリオファイルを、流すために読む（lim test、reach、trace、voice-lock の loadSource）。
 * 無いか、UTF-8 で読めなければ例外（化けたまま流さない）。
 */
export function loadScenarioSource(scenarioDir: string, name: string): string {
  const path = join(scenarioDir, `${name}.lim`);
  if (!existsSync(path)) throw new Error(`ファイル ${name}.lim が見つかりません`);
  const { text, encoding } = readScenarioFile(path);
  if (encoding) throw new Error(`${name}.lim: ${encodingDiagnostic(name, encoding).message}`);
  return text;
}

/** シナリオのフォルダのうち、UTF-8 で読めないファイル（名前の順）。 */
export function notUtf8Scenarios(scenarioDir: string): { name: string; encoding: string }[] {
  const out: { name: string; encoding: string }[] = [];
  for (const { name, path } of listScenarioFiles(scenarioDir)) {
    const encoding = scenarioEncoding(readFileSync(path));
    if (encoding) out.push({ name, encoding });
  }
  return out;
}

/** UTF-8 で読めないシナリオファイルがあるので、書き換える命令を止めた（何も書いていない）。 */
export class ScenarioEncodingError extends Error {
  constructor(
    readonly files: readonly { name: string; encoding: string }[],
    language: "ja" | "en" = "ja",
  ) {
    super(notUtf8StopMessage(files.map((f) => f.name), language));
  }
}

/**
 * 作品を書き換える命令（名前の変更、整形、lim migrate、lim i18n、lim prose など）の前に呼ぶ。
 * UTF-8 で読めないシナリオファイル（Shift_JIS など）があれば、何も書かずに止める（ScenarioEncodingError）。
 * 化けた字面（U+FFFD）を書き戻すと元の文字に戻せないため、その一つを飛ばすのでなく、作品の書き換えをまるごと止める
 * （飛ばすと、そのファイルの中の参照だけ古い名前のまま残る）。
 */
export function assertScenariosUtf8(scenarioDir: string, language: "ja" | "en" = "ja"): void {
  const bad = notUtf8Scenarios(scenarioDir);
  if (bad.length > 0) throw new ScenarioEncodingError(bad, language);
}

/** 作品の追加の中身（パック）を置くフォルダ（作品のフォルダの直下。packs/<フォルダ>/pack.json のあるもの）。 */
export const PACKS_FOLDER = "packs";

/**
 * パック（packs/<フォルダ>/）の台本と訳の中身。遊ぶ側は、パックの同じ名前の台本で本体の台本を差し替え、パックに訳が無ければ本体の訳を、
 * ボイスの番号はいつも本体の voice-lock.json を使う。検査（訳とボイスの鍵が使われているか、パックの訳）と lim voice-lock、lim i18n が読む。
 */
export interface PackSource {
  /** 作品のフォルダからのパス（packs/<フォルダ>。区切りは /）。パックの訳の診断のファイルの名前に使う。 */
  dir: string;
  /** pack.json の id（読めなければフォルダの名前）と order（無ければ 0）。遊ぶ側はこの順に重ねる（後ろのパックが勝つ）。 */
  id: string;
  order: number;
  /** パックの cast.json の話者（無い・読めなければ空。遊ぶ側はパックの cast.json で本体の cast.json を差し替える）。 */
  speakers: string[];
  /** 台本（名前 → 中身。scenario の下の .lim。UTF-8 で読めない台本は入れない）。 */
  scripts: Map<string, string>;
  /** 訳（言語 → 中身。lang の直下の <言語>.json。lim pack が写すものと同じ）。 */
  translations: Map<string, string>;
}

/** パックのフォルダ（packs の下の、pack.json のあるもの）。並びは遊ぶ側と同じ（pack.json の order、id の順）。 */
interface PackFolder {
  /** 作品のフォルダからのパス（packs/<フォルダ>）。 */
  dir: string;
  /** フォルダの実際のパス。 */
  path: string;
  id: string;
  order: number;
  /** パックの cast.json の話者。 */
  speakers: string[];
}

function packFolders(root: string, read: (path: string) => string | null): PackFolder[] {
  const base = join(root, PACKS_FOLDER);
  if (!existsSync(base)) return [];
  const out: PackFolder[] = [];
  for (const e of readdirSync(base, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const path = join(base, e.name);
    if (!existsSync(join(path, "pack.json"))) continue;
    let speakers: string[] = [];
    const cast = read(join(path, "cast.json"));
    if (cast !== null) {
      try {
        const list = (JSON.parse(cast) as { speakers?: unknown }).speakers;
        if (Array.isArray(list)) speakers = list.filter((s): s is string => typeof s === "string");
      } catch {
        // 読めないパックの cast.json は、本体の話者で読む（lim pack もパックの台本を本体の話者で確かめる）
      }
    }
    let id = e.name;
    let order = 0;
    try {
      const manifest = JSON.parse(read(join(path, "pack.json")) ?? "{}") as { id?: unknown; order?: unknown };
      if (typeof manifest.id === "string" && manifest.id !== "") id = manifest.id;
      if (typeof manifest.order === "number" && Number.isFinite(manifest.order)) order = manifest.order;
    } catch {
      // 読めない pack.json はフォルダの名前で並べる（lim pack が知らせる）
    }
    out.push({ dir: `${PACKS_FOLDER}/${e.name}`, path, id, order, speakers });
  }
  return out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

const diskText = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

/**
 * 作品のパックの台本と訳を読む（packs の下の、pack.json のあるフォルダ）。並びは遊ぶ側と同じ（pack.json の order、id の順。@liminalia/lang の sortPacks）。
 * text はファイルの中身を読む口（開いているファイルは保存前の中身を渡せる。無ければディスクから読む）。
 */
export function listPackSources(root: string, text?: (path: string) => string | null): PackSource[] {
  const read = (path: string): string | null => {
    const given = text?.(path);
    if (given !== undefined && given !== null) return given;
    return diskText(path);
  };
  return packFolders(root, read).map((f) => {
    const scripts = new Map<string, string>();
    for (const { name, path } of listScenarioFiles(join(f.path, "scenario"))) {
      const body = read(path);
      if (body !== null && scenarioFileEncoding(path, body) === null) scripts.set(name, body);
    }
    const translations = new Map<string, string>();
    const lang = join(f.path, "lang");
    if (existsSync(lang)) {
      for (const e of readdirSync(lang, { withFileTypes: true })) {
        if (!e.isFile() || !e.name.endsWith(".json") || e.name.startsWith(".")) continue;
        const body = read(join(lang, e.name));
        if (body !== null) translations.set(e.name.slice(0, -".json".length), body);
      }
    }
    return { dir: f.dir, id: f.id, order: f.order, speakers: f.speakers, scripts, translations };
  });
}

/** パックの台本の、出力に出す位置（packs/<フォルダ>/scenario/<台本の名前>。拡張子なし）。本体の台本と見分けるため、パックの台本はどの道具もこの形で出す。 */
export function packScenarioPlace(pack: string, name: string): string {
  return `${pack}/scenario/${name}`;
}

/** パックの台本のファイル。name はパックの scenario からの台本の名前（遊ぶ側が本体の同じ名前の台本と差し替える名前。鍵もこの名前で作る）。 */
export interface PackScenarioFile extends ScenarioFile {
  /** パックのフォルダ（packs/<フォルダ>）。 */
  pack: string;
  /** 出力に出す位置（packScenarioPlace）。 */
  place: string;
  /** パックの cast.json の話者（台本は本体の話者にこれを足して読む。遊ぶ側はパックの cast.json で本体のものを差し替える）。 */
  speakers: string[];
}

/**
 * パック（packs/<フォルダ>/scenario）の台本のファイル（遊ぶ側の並びのパックごとに、名前の順）。台本を整える、数える、書き出す、探す道具が、
 * 本体の台本（listScenarioFiles）に続けて読む。UTF-8 で読めないファイルも入れる（書き換える命令は assertPackScenariosUtf8 で止める）。
 */
export function listPackScenarioFiles(root: string): PackScenarioFile[] {
  return packFolders(root, diskText).flatMap((f) => listScenarioFiles(join(f.path, "scenario")).map((x) => ({ ...x, pack: f.dir, place: packScenarioPlace(f.dir, x.name), speakers: f.speakers })));
}

/** 本体（scenarioDir）とパックの台本のどれかが UTF-8 で読めなければ、何も書かずに止める（assertScenariosUtf8 のパックも読む形。パックの台本は位置で知らせる）。 */
export function assertProjectScenariosUtf8(root: string, scenarioDir: string, language: "ja" | "en" = "ja"): void {
  const bad = [...notUtf8Scenarios(scenarioDir)];
  for (const f of listPackScenarioFiles(root)) {
    const encoding = scenarioEncoding(readFileSync(f.path));
    if (encoding) bad.push({ name: f.place, encoding });
  }
  if (bad.length > 0) throw new ScenarioEncodingError(bad, language);
}
