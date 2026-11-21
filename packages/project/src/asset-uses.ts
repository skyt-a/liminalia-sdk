import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { screenScriptFile } from "@liminalia/lang";
import type { Project } from "./index.ts";

/**
 * 台本の構文（@liminalia/lang の assetReferences）のほかに、素材の名前を文字として探す所。lim unused、lim build --only-used、
 * 制作画面の素材の「未使用だけ」が、どれもこの一覧（assetTextFiles）と同じ探し方（assetTextUses）で数える。
 * 足したら packages/cli/test/asset-reference-forms.test.ts の表にも足す（足さないと型で落ちる）。
 * - scenario: 台本（マクロの引数、変数に入れる文字、条件式の文字など）
 * - data: data フォルダ（@flipbook の data= の JSON、プラグインが読むデータなど）
 * - cast: cast.json（Live2D と Spine のモデルの src など）
 * - config: liminalia.json（ui、おまけ、持ち物、書き出しのアイコンなど）
 * - voice-lock: voice-lock.json（連番のボイスの番号の固定）
 * - theme: 作品の中のテーマ（themes/<id>/）と、選んだテーマが写した素材（image/themes/<id>/。そのテーマが読むので、いつも使っているとみなす。assetAlwaysUsed）
 * - css: 作品の CSS（ui.css）とそのフォルダ（@import する CSS）
 * - template: 画面のテンプレート（ui.templates と、決まりの場所 ui/screens/）とそのフォルダ（画面の JS）
 * - pack: パック（packs/<id>/）
 * - translation: 訳（lang/）
 * - plugin: 作品のプラグインのコード（作品の外のフォルダや node_modules に入れたものも。その中の node_modules は見ない）
 * - model: 立ち絵のモデル（Live2D の .model3.json と Spine の .atlas）
 */
export const ASSET_TEXT_SOURCES = ["scenario", "data", "cast", "config", "voice-lock", "theme", "css", "template", "pack", "translation", "plugin", "model"] as const;
export type AssetTextSource = (typeof ASSET_TEXT_SOURCES)[number];

/** 素材の名前を書いていそうな文字のファイル。 */
const TEXT_FILE = /\.(lim|json|csv|tsv|txt|css|html?|m?[jt]s|cjs|atlas)$/i;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 読めないフォルダは飛ばす（ファイルを指していたときなど）
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * 素材の名前を文字として探すファイル（絶対パス）と、その種類。台本（scenario）は呼ぶ側が渡す（制作画面は作業場の中身を読む）。
 * 作品のフォルダ全体は見ない（下書きや控えの台本が、使わなくなった素材の名前を残していることがあるため）。
 */
export function assetTextFiles(project: Pick<Project, "root" | "paths" | "config" | "plugins">): { source: AssetTextSource; file: string }[] {
  // 先頭は組み込みの標準の命令
  return assetTextFilesIn({ root: project.root, paths: project.paths, ui: project.config.ui, plugins: project.plugins.slice(1) });
}

/** 素材の名前を文字として探す所を決めるもの（作品のフォルダ、置き場所、liminalia.json の ui、作品のプラグインのフォルダ。標準の命令は含まない）。 */
export interface AssetTextPlaces {
  root: string;
  paths: Pick<Project["paths"], "assets" | "data" | "cast" | "voiceLock" | "lang">;
  ui: unknown;
  plugins: readonly string[];
}

/** assetTextFiles と同じもの（VS Code の言語サーバーのように、作品を loadProject で読まない呼び手が使う）。 */
export function assetTextFilesIn(places: AssetTextPlaces): { source: AssetTextSource; file: string }[] {
  const out: { source: AssetTextSource; file: string }[] = [];
  const seen = new Set<string>();
  const add = (source: AssetTextSource, file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    out.push({ source, file });
  };
  const addDir = (source: AssetTextSource, dir: string, only = TEXT_FILE) => {
    for (const f of walk(dir)) if (only.test(f)) add(source, f);
  };
  const { root, paths } = places;
  addDir("data", paths.data);
  add("cast", paths.cast);
  add("config", join(root, "liminalia.json"));
  add("voice-lock", paths.voiceLock);
  addDir("theme", join(root, "themes"));
  const ui = (places.ui ?? {}) as { css?: unknown; templates?: unknown };
  // 作品の CSS とテンプレート。作品の直下に置いたものは、そのファイルだけ（直下のフォルダ全体は見ない）
  const nextTo = (source: AssetTextSource, rel: string) => {
    const file = join(root, rel);
    add(source, file);
    const dir = dirname(file);
    if (dir !== root) addDir(source, dir);
  };
  for (const f of Array.isArray(ui.css) ? ui.css : []) if (typeof f === "string") nextTo("css", f);
  const templates = ui.templates && typeof ui.templates === "object" && !Array.isArray(ui.templates) ? (ui.templates as Record<string, unknown>) : {};
  for (const [screen, f] of Object.entries(templates)) {
    if (typeof f !== "string") continue;
    nextTo("template", f);
    // 作品の直下に置いたテンプレートの、同じ名前の画面の JS
    add("template", join(root, screenScriptFile(templates, screen)));
  }
  // 登録していない画面のテンプレート（決まりの場所 ui/screens/<画面>/<画面>.html）
  addDir("template", join(root, "ui", "screens"));
  const packs = join(root, "packs");
  if (existsSync(packs)) for (const e of readdirSync(packs, { withFileTypes: true })) if (e.isDirectory() && existsSync(join(packs, e.name, "pack.json"))) addDir("pack", join(packs, e.name));
  addDir("translation", paths.lang);
  // 作品のプラグイン。作品の外のフォルダや、作品の node_modules に入れたものも読む（その中の node_modules は walk が見ない）
  for (const dir of places.plugins) addDir("plugin", dir, /\.(m?[jt]s|cjs|json|css|html?)$/i);
  addDir("model", join(paths.assets, "fgimage"), /\.(model3\.json|atlas)$/i);
  return out.filter((f) => existsSync(f.file));
}

/**
 * 素材のうち、名前が出てこなくても使っているとみなすもの。選んだテーマ（ui.system.preset）が写した素材 image/themes/<id>/ は、
 * そのテーマが読む。前に選んだテーマの素材は、ほかの素材と同じく参照と名前で数える（制作画面はテーマを替えたときに、使っていないものをごみ箱へ入れる）。
 */
export function assetAlwaysUsed(folder: string, path: string, ui: unknown): boolean {
  if (folder !== "image" || !path.startsWith("themes/")) return false;
  type Look = { system?: { preset?: unknown }; languages?: Record<string, unknown> } | undefined;
  const look = ui as Look;
  // 言語ごとの見た目（ui.languages.<言語>）で別のテーマを選んでいれば、そのテーマも
  const presets = [look?.system?.preset, ...Object.values(look?.languages ?? {}).map((o) => (o as Look)?.system?.preset)];
  return presets.some((p) => typeof p === "string" && p !== "" && path.startsWith(`themes/${p}/`));
}

// ---- 文字としての一致 ----

/** 名前の一部になる文字か（前後がこれなら語の途中とみなす）。UTF-16 の単位ごとに一度だけ調べて覚える（0: 未調査、1: なる、2: ならない）。 */
const nameChars = new Uint8Array(0x10000);
function isNameChar(code: number): boolean {
  let known = nameChars[code]!;
  if (known === 0) {
    known = /[\p{L}\p{N}\p{M}_-]/u.test(String.fromCharCode(code)) ? 1 : 2;
    nameChars[code] = known;
  }
  return known === 1;
}

/**
 * 語の途中でなければ一致とする。前は名前の文字でも `.` でもない（`/` や `\` のあとはパスの区切りなので一致する。game.bg の bg は一致しない）。
 * 後ろは名前の文字でなく、`.` に名前の文字が続くのでもない（x.png は素材 x.jpg の拡張子なしの x には一致しない）。
 */
const startsWord = (text: string, at: number) => at === 0 || (text[at - 1] !== "." && !isNameChar(text.charCodeAt(at - 1)));
const endsWord = (text: string, at: number) => at >= text.length || (!isNameChar(text.charCodeAt(at)) && !(text[at] === "." && at + 1 < text.length && isNameChar(text.charCodeAt(at + 1))));

/** 名前の比べ方（大文字と小文字、Unicode の合成の違いでは見落とさない）。 */
export const assetNameKey = (text: string) => text.normalize("NFC").toLowerCase();

/** 素材の名前（拡張子つきと拡張子なし）の木。文字ごとに次の節へ進む。辺は一つの Map に「節の番号 × 0x10000 + 文字」で持つ（節ごとに Map を作らない）。 */
class NameTree<T> {
  private readonly edges = new Map<number, number>();
  private readonly ends = new Map<number, T[]>();
  private nodes = 1;

  add(name: string, value: T): void {
    let node = 0;
    for (let i = 0; i < name.length; i++) {
      const key = node * 0x10000 + name.charCodeAt(i);
      let next = this.edges.get(key);
      if (next === undefined) {
        next = this.nodes++;
        this.edges.set(key, next);
      }
      node = next;
    }
    const list = this.ends.get(node);
    if (list) list.push(value);
    else this.ends.set(node, [value]);
  }

  /** 本文を一度だけなめて、語の頭から木をたどり、語の切れ目で終わる名前を見つけるたびに知らせる（line は 1 から）。 */
  scan(text: string, found: (value: T, line: number) => void): void {
    let line = 1;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) line++;
      if (!startsWord(text, i)) continue;
      let node = 0;
      for (let j = i; j < text.length; j++) {
        const next = this.edges.get(node * 0x10000 + text.charCodeAt(j));
        if (next === undefined) break;
        node = next;
        const list = this.ends.get(node);
        if (list && endsWord(text, j + 1)) for (const value of list) found(value, line);
      }
    }
  }
}

/**
 * 素材の名前が文字に出てくる所。how は出方:
 * - name: 名前（拡張子つきか拡張子なし）がそのまま出てくる
 * - pattern: 連番の型（@flipbook の `slash_{nn}.png`。{n}、{nn}、{nnn} が番号）に当たる
 * - fragment: 名前の頭か終わりの一部が、式でつなぐ文字（`"radio_" + n`、`` `cg_${n}` ``、`n + "_smile.png"`）として出てくる。
 *   名前を式で組み立てると、どの素材かは分からないので、使っているとみなす（書き出しの「使っている素材だけ」で落とさない側に倒す）
 */
export interface AssetTextUse {
  where: string;
  line: number;
  how: "name" | "pattern" | "fragment";
}

/** 一つの素材に出す一致の数の上限（ありふれた名前で一覧と応答が膨らまないように）。 */
const USES_LIMIT = 20;

/** 連番の型の語を区切る文字。 */
const PATTERN_STOP = /[\s"'`<>()[\],;:=|]/;

/**
 * 連番の型（{n}、{nn}、{nnn} を含む語）と、その頭の位置。{n を探してから前後に広げる（区切りの無い長い文字でも、文字の長さに比例する時間で済む）。
 */
function* patternTokens(text: string): Generator<{ token: string; index: number }> {
  for (let at = text.indexOf("{n"); at >= 0; ) {
    const m = /^\{n{1,3}\}/.exec(text.slice(at, at + 5));
    if (!m) {
      at = text.indexOf("{n", at + 2);
      continue;
    }
    let start = at;
    while (start > 0 && !PATTERN_STOP.test(text[start - 1]!)) start--;
    let end = at + m[0].length;
    while (end < text.length && !PATTERN_STOP.test(text[end]!)) end++;
    yield { token: text.slice(start, end), index: start };
    at = text.indexOf("{n", end);
  }
}
/** 文字の値（"…"、'…'、`…` の ${ の前まで）。 */
const LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`\\\n$]*)(?=\$\{|`)/g;
/** 名前の区切り（ここで終わる文字は、名前の頭として式でつなぐものとみなす）。 */
const SEPARATOR_END = /[_\-/]$/;
const SEPARATOR_START = /^[_-]/;

/** 並べた名前のうち、prefix で始まるもの（二分探索）。 */
function withPrefix<T>(sorted: readonly { key: string; value: T }[], prefix: string): T[] {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.key < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out: T[] = [];
  for (let i = lo; i < sorted.length && sorted[i]!.key.startsWith(prefix); i++) out.push(sorted[i]!.value);
  return out;
}

/** 位置から行（1 から）を出す。位置は前から順に聞く（前に聞いた位置から数え足す）。 */
function lineCounter(text: string): (index: number) => number {
  let at = 0;
  let line = 1;
  return (index) => {
    for (; at < index; at++) if (text.charCodeAt(at) === 10) line++;
    return line;
  };
}

/** 位置の前（back）か後ろ（forward）の、空白でない最初の文字。 */
function neighbor(text: string, index: number, step: 1 | -1): string {
  let i = index;
  while (i >= 0 && i < text.length && (text[i] === " " || text[i] === "\t")) i += step;
  return text[i] ?? "";
}

/**
 * 素材（folder とその中の path）の名前が、文字（texts。where は場所の名前）に出てくる所（"フォルダ/パス" → 出てくる所）。
 * 全部の素材の名前を一つの木にして文字を一度だけなめる（素材ごとに文字を探さない）ので、素材が多くても文字の長さの分しかかからない。
 */
export function assetTextUses(texts: Iterable<{ where: string; text: string }>, assets: readonly { folder: string; path: string }[]): Map<string, AssetTextUse[]> {
  const out = new Map<string, AssetTextUse[]>();
  if (assets.length === 0) return out;
  const entries = assets.map((a) => ({ id: `${a.folder}/${a.path}`, rel: assetNameKey(`${a.folder}/${a.path}`), path: assetNameKey(a.path), name: assetNameKey(basename(a.path)), uses: [] as AssetTextUse[] }));
  const tree = new NameTree<(typeof entries)[number]>();
  for (const entry of entries) {
    const stem = entry.name.slice(0, entry.name.length - extname(entry.name).length);
    tree.add(entry.name, entry);
    if (stem !== entry.name && stem !== "") tree.add(stem, entry);
  }
  const byName = entries.map((e) => ({ key: e.name, value: e })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const byPath = entries.flatMap((e) => [{ key: e.rel, value: e }, { key: e.path, value: e }]).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const byReversedName = entries.map((e) => ({ key: [...e.name].reverse().join(""), value: e })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const note = (entry: (typeof entries)[number], use: AssetTextUse) => {
    if (entry.uses.length >= USES_LIMIT) return;
    const last = entry.uses.at(-1);
    if (last && last.where === use.where && last.line === use.line) return;
    entry.uses.push(use);
  };
  for (const { where, text: raw } of texts) {
    const text = assetNameKey(raw);
    tree.scan(text, (entry, line) => note(entry, { where, line, how: "name" }));
    // 連番の型（`fx/slash_{nn}.png`）
    let lineOf = lineCounter(text);
    for (const m of patternTokens(text)) {
      const body = m.token.split(/\{n{1,3}\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\d+");
      const re = new RegExp(`(?:^|/)${body}$`);
      const line = lineOf(m.index);
      for (const entry of entries) if (re.test(entry.rel)) note(entry, { where, line, how: "pattern" });
    }
    // 式でつなぐ名前の一部（"radio_" + n、`cg_${n}`、n + "_smile.png"）
    lineOf = lineCounter(text);
    for (const m of text.matchAll(LITERAL)) {
      const value = m[1] ?? m[2] ?? m[3] ?? "";
      if (value.length < 3) continue;
      const end = m.index + m[0].length;
      const template = m[3] !== undefined;
      const line = lineOf(m.index);
      // 名前の頭: 区切りで終わるか、後ろに + か ${ が続く
      if (SEPARATOR_END.test(value) || neighbor(text, end, 1) === "+" || (template && text.startsWith("${", end))) {
        const name = value.slice(value.lastIndexOf("/") + 1);
        const found = new Set([...withPrefix(byPath, value), ...(name.length >= 3 ? withPrefix(byName, name) : [])]);
        for (const entry of found) if (entry.name !== name && entry.path !== value && entry.rel !== value) note(entry, { where, line, how: "fragment" });
      }
      // 名前の終わり: 区切りで始まるか、前に + があり、拡張子の前に名前の文字がある
      if ((SEPARATOR_START.test(value) || neighbor(text, m.index - 1, -1) === "+") && value.replace(/\.[^./]*$/, "").length >= 2 && !value.includes("/")) {
        for (const entry of withPrefix(byReversedName, [...value].reverse().join(""))) if (entry.name !== value) note(entry, { where, line, how: "fragment" });
      }
    }
  }
  for (const e of entries) if (e.uses.length > 0) out.set(e.id, e.uses);
  return out;
}

/** 作品の文字のファイル（assetTextFiles）を、assetTextUses に渡す形で読む（where は作品のフォルダからのパス）。読めないものは飛ばす。 */
export function readAssetTextFiles(project: Pick<Project, "root" | "paths" | "config" | "plugins">): { where: string; text: string; source: AssetTextSource }[] {
  const out: { where: string; text: string; source: AssetTextSource }[] = [];
  for (const { source, file } of assetTextFiles(project)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // 読めないファイル（消えた、権限が無いなど）は名前を探さない（その所の名前は数えない。lim unused は消さずに候補を出すだけ）
      continue;
    }
    out.push({ where: assetTextWhere(project.root, file), text, source });
  }
  return out;
}

/** 文字のファイル（絶対パス）の場所の名前（作品のフォルダからのパス。作品の外のものは絶対パス）。 */
export function assetTextWhere(root: string, file: string): string {
  const rel = relative(root, file).split(sep).join("/");
  return rel.startsWith("..") ? file : rel;
}
