import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Inline, Statement } from "@liminalia/lang";
import { STD_WEB_FEATURE_NAMES, STD_WEB_FEATURE_OF, type StdWebFeature } from "@liminalia/std/features";

/** 図鑑のデータ（@liminalia/std の CODEX_FILE。ここでは std の命令の全体を読まないように名前だけ持つ）。 */
const CODEX_FILE = "codex.json";

/** これより大きいファイルは読まない（プラグインに同梱した外の部品など）。 */
const MAX_SOURCE = 2 * 1024 * 1024;
/** 拡張子を省いた import の読み方（TypeScript の ".js" で .ts を指す書き方も）。 */
const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs"];

/** 行の命令と、本文・選択肢の中の命令（{@…}）。@if・@while・@for・@with・@define の中も。 */
function* commandNames(body: readonly Statement[]): Generator<string> {
  for (const s of body) {
    if (s.kind === "command") yield s.name;
    else if (s.kind === "say" || s.kind === "prose") yield* inlineNames(s.content);
    else if (s.kind === "choice") for (const o of s.options) yield* inlineNames(o.content);
    else if (s.kind === "if") for (const b of s.branches) yield* commandNames(b.body);
    else if (s.kind === "define") yield* commandNames(s.body);
  }
}

function* inlineNames(nodes: readonly Inline[]): Generator<string> {
  for (const n of nodes) {
    if (n.kind === "command") yield n.name;
    else if ("children" in n) yield* inlineNames(n.children);
  }
}

/** import の行き先のファイル（拡張子を省いたもの、フォルダの index も）。無ければ null。 */
function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...(/\.[cm]?js$/.test(base) ? EXTENSIONS.map((e) => base.replace(/\.[cm]?js$/, e)) : []), ...EXTENSIONS.map((e) => join(base, `index${e}`))];
  return candidates.find((f) => existsSync(f) && statSync(f).isFile()) ?? null;
}

/**
 * プラグインの入口（"./web"・"./commands"）から、相対の import（import()・export … from も）でたどれる、そのフォルダの中のコード。
 * 書き出しに入るのはこれだけなので、テストや道具、プラグインのフォルダに置いたほかのもの（作品のフォルダそのものがプラグインのときの書き出しなど）は見ない。
 */
function pluginSources(dir: string, entries: readonly string[]): string[] {
  const root = resolve(dir) + sep;
  const seen = new Set<string>();
  const queue = entries.filter((f) => existsSync(f)).map((f) => resolve(f));
  const out: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (statSync(file).size > MAX_SOURCE) continue;
    const text = readFileSync(file, "utf8");
    out.push(text);
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const next = resolveImport(file, m[1]!);
      if (next && next.startsWith(root) && !next.includes(`${sep}node_modules${sep}`)) queue.push(next);
    }
  }
  return out;
}

/** stdWebFeaturesOf が見るもの（台本・設定・データ・プラグイン）。 */
export interface StdWebUsage {
  /** 台本（下書きを除く）。 */
  scripts: Iterable<{ body: readonly Statement[] }>;
  ui?: { chat?: { dialogue?: unknown }; languages?: Record<string, { chat?: { dialogue?: unknown } } | undefined> } | undefined;
  /** 作品のデータのフォルダ（paths.data）。 */
  dataDir: string;
  /** 標準の命令のほかのプラグイン（フォルダと、書き出しに入る入口 "./web"・"./commands" のファイル）。 */
  plugins: readonly { dir: string; entries: readonly string[] }[];
}

/**
 * 作品が使う標準の命令の描画の部品（@liminalia/std の STD_WEB_FEATURES。並びは表の順）。書き出しはこれを始めに読み、ほかは描くときに読む。
 * - 台本（下書きを除く）の命令。本文と選択肢の中の命令（{@…}）、@if・@define の中も
 * - プラグイン（標準の命令のほか）の書き出しに入るコードに、部品の命令の名前を文字列で書いたもの（描画側から host.present で描かせるなど）
 * - ui.chat.dialogue（本文をチャットの画面に積む。言語ごとの ui.languages も）→ chat
 * - data/codex.json（図鑑。メニュー、おまけ、@open-screen codex、プラグインの画面から開く）→ codex
 * 見落としても描けなくなるのではなく、初めて描くときに読む（その一回だけ読む間が空く）。
 */
export function stdWebFeaturesOf(u: StdWebUsage): StdWebFeature[] {
  const used = new Set<StdWebFeature>();
  const add = (name: string) => {
    const f = STD_WEB_FEATURE_OF.get(name);
    if (f) used.add(f);
  };
  for (const script of u.scripts) for (const name of commandNames(script.body)) add(name);
  const dialogue = (ui: { chat?: { dialogue?: unknown } } | undefined) => ui?.chat?.dialogue === true;
  if (dialogue(u.ui) || Object.values(u.ui?.languages ?? {}).some(dialogue)) used.add("chat");
  if (existsSync(join(u.dataDir, CODEX_FILE))) used.add("codex");
  for (const plugin of u.plugins) {
    for (const text of pluginSources(plugin.dir, plugin.entries)) {
      // 文字列に書いた（"…"・'…'・`…`）部品の命令の名前
      for (const m of text.matchAll(/["'`]([a-z][a-z-]*)["'`]/g)) add(m[1]!);
    }
  }
  return STD_WEB_FEATURE_NAMES.filter((f) => used.has(f));
}
