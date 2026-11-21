import { normalizeBooleanArgs } from "./args.ts";
import type { Argument, Diagnostic, Inline, Script, Statement, Target } from "./ast.ts";
import { parseTargetText } from "./args.ts";
import type { ExtraConfig } from "./extra.ts";
import type { CommandSpec, Registry } from "./registry.ts";

/**
 * 章の情報（liminalia.json の chapters）。章の番号・題・英題と、その章のシナリオファイルを一か所に書く。
 * 章の扉と章の終わりのコマンド（プラグインは runtime.chapter で読む）、式の chapter()、セーブスロットの見出し（chapterOf）、
 * おまけの CG の見出し（extra.cg の chapter）と章選択（extra.chapters の題）がここを読む。
 *
 * ```json
 * "chapters": [
 *   { "id": "ch1", "number": "第一章", "title": "星を待つ丘", "subtitle": "THE HILL OF STARS", "files": ["chapter1_*"] }
 * ]
 * ```
 */
export interface ChapterInfo {
  /** 名前（式の chapter() が返す値。extra.cg の chapter・extra.chapters の id で指す）。 */
  id: string;
  /** 題。 */
  title: string;
  /** 番号の表記（第一章、EPISODE 01 など）。 */
  number?: string;
  /** 副題や英題。 */
  subtitle?: string;
  /** この章のシナリオファイル（拡張子なし。* は任意の文字の並び。chapter1_* など）。 */
  files?: string[];
  /** 作品が足す項目（扉に出す絵など）。プラグインのコマンドが読む。 */
  [key: string]: unknown;
}

const FILE = "liminalia.json";

/** ファイルの並び（* は任意の文字の並び）の判定。 */
function matcher(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

/** そのファイル（拡張子なし。`ファイル::マクロ` の実行単位でもよい）を含む章。無ければ null。前に書いた章が優先する。 */
export function chapterOf(chapters: readonly ChapterInfo[] | undefined, file: string): ChapterInfo | null {
  const name = file.includes("::") ? file.slice(0, file.indexOf("::")) : file;
  for (const c of chapters ?? []) if (Array.isArray(c.files) && c.files.some((p) => typeof p === "string" && matcher(p).test(name))) return c;
  return null;
}

/** 見出しの文（番号があれば番号、無ければ題）。おまけの CG の見出しに使う。 */
export function chapterHeading(c: ChapterInfo): string {
  return typeof c.number === "string" && c.number !== "" ? c.number : c.title;
}

/**
 * 章の情報の検査。形の崩れ・id の重なり・題の無いものはエラー。どのシナリオにも当たらない files の並びと、二つの章に入るシナリオは警告。
 * files は scenarioFiles（拡張子なしの名前）と突き合わせる。
 */
export function checkChapters(raw: unknown, scenarioFiles: Iterable<string>): Diagnostic[] {
  if (raw === undefined) return [];
  const out: Diagnostic[] = [];
  const error = (message: string, hint?: string) => out.push({ severity: "error", code: "bad-chapters", message, file: FILE, line: 1, ...(hint ? { hint } : {}) });
  const warn = (message: string, hint?: string) => out.push({ severity: "warning", code: "chapter-files", message, file: FILE, line: 1, ...(hint ? { hint } : {}) });
  if (!Array.isArray(raw)) {
    error("chapters は章の配列で書きます", '"chapters": [{ "id": "ch1", "number": "第一章", "title": "雨の駅", "files": ["chapter1*"] }]');
    return out;
  }
  const files = [...scenarioFiles];
  const ids = new Set<string>();
  const owner = new Map<string, string>();
  for (const c of raw as Partial<ChapterInfo>[]) {
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      error("chapters の一つ一つは { id, title, files } の形で書きます");
      continue;
    }
    if (typeof c.id !== "string" || c.id === "") {
      error("chapters に id のないものがあります");
      continue;
    }
    if (ids.has(c.id)) error(`chapters の id ${c.id} が重複しています`);
    ids.add(c.id);
    if (typeof c.title !== "string" || c.title === "") error(`chapters ${c.id} に title（題）がありません`);
    for (const key of ["number", "subtitle"] as const) if (c[key] !== undefined && typeof c[key] !== "string") error(`chapters ${c.id} の ${key} は文字列で書きます`);
    if (c.files === undefined) continue;
    if (!Array.isArray(c.files) || c.files.some((f) => typeof f !== "string" || f === "")) {
      error(`chapters ${c.id} の files はシナリオファイルの名前の配列で書きます（* は任意の文字の並び）`, '"files": ["chapter1", "chapter1_*"]');
      continue;
    }
    for (const pattern of c.files) {
      const re = matcher(pattern);
      const hit = files.filter((f) => re.test(f));
      if (hit.length === 0) warn(`chapters ${c.id} の files の ${pattern} に当たるシナリオファイルがありません`);
      for (const f of hit) {
        const first = owner.get(f);
        if (first !== undefined && first !== c.id) warn(`シナリオファイル ${f} が章 ${first} と ${c.id} の両方に入っています（前の ${first} とみなします）`);
        else owner.set(f, c.id);
      }
    }
  }
  return out;
}

export interface ChapterUseInput {
  scripts: ReadonlyMap<string, Script>;
  /** liminalia.json の chapters（形の崩れたものは読める所だけ使う）。 */
  chapters: unknown;
  /** 組み込みとプラグインのコマンド（飛び先の型のパラメータ、@chapter-card と @chapter-end があるか）。 */
  registry: Registry;
  /** 作品のマクロ（名前 → 仕様）。 */
  macros: ReadonlyMap<string, CommandSpec>;
  /** はじめから届く位置（liminalia.json の entry、afterLoad、おまけの回想と章、プラグインのデータの行き先）。 */
  starts: Iterable<string>;
  /** 式の飛び先の候補（project.ts の targetCandidates）。 */
  candidates?: (target: Target, file: string) => string[] | null;
}

/** 章の扉と章末のコマンド（番号と題を省くと、今の章から補う。@liminalia/std の chapter.ts）。 */
const CHAPTER_CARDS = ["chapter-card", "chapter-end"];

/**
 * 章の使い方の検査（checkProject が呼ぶ）。
 * - chapter-card-empty（警告）: 番号も題も副題も書かない @chapter-card と @chapter-end が、どの章にも入らないシナリオにある（何も書かれていない扉が出る）。
 *   マクロの中は、マクロを書いたシナリオの章で見る（実行器もそうする）
 * - not-in-chapter（情報）: 章を使う作品で、はじめから届き、本文のあるシナリオがどの章にも入らない（そのあいだ、セーブスロットの章の見出しと
 *   式の chapter() が空になる）。届く先は @jump、@call、選択肢、飛び先の型のパラメータ、式の飛び先の候補、呼んだマクロの中の飛び先でたどる。
 *   下書きと、本文の無いシナリオ（マクロだけのものなど）は見ない
 */
export function checkChapterUse(input: ChapterUseInput): Diagnostic[] {
  const out: Diagnostic[] = [];
  const { scripts, registry, macros } = input;
  const chapters = Array.isArray(input.chapters) ? (input.chapters as unknown[]).filter((c): c is ChapterInfo => !!c && typeof c === "object" && !Array.isArray(c)) : [];
  const inChapter = (file: string) => chapterOf(chapters, file) !== null;

  // ---- 章の扉と章末 ----
  for (const name of CHAPTER_CARDS) {
    if (!registry.has(name) || macros.has(name)) continue;
    for (const [file, script] of scripts) {
      if (script.draft || inChapter(file)) continue;
      const visit = (body: readonly Statement[]) => {
        for (const s of body) {
          if (s.kind === "if") for (const b of s.branches) visit(b.body);
          else if (s.kind === "define") visit(s.body);
          else if (s.kind === "command" && s.name === name && !s.args.some((a) => a.key === "number" || a.key === "title" || a.key === "subtitle")) {
            out.push({
              severity: "warning",
              code: "chapter-card-empty",
              message: `@${name} に番号も題も無く、${file} はどの章（liminalia.json の chapters）にも入っていないため、何も書かれていない扉が出ます`,
              file,
              line: s.line,
              hint: `number= か title= を書くか、liminalia.json の chapters のどれかの files に ${file} を足します`,
            });
          }
        }
      };
      visit(script.body);
    }
  }

  // ---- 章に入っていないシナリオ ----
  if (!chapters.some((c) => Array.isArray(c.files) && c.files.length > 0)) return out;
  /** 流れ（シナリオかマクロ）→ 移る先のシナリオと、呼ぶマクロ。 */
  const edges = new Map<string, { files: Set<string>; macros: Set<string> }>();
  const node = (key: string) => {
    let e = edges.get(key);
    if (!e) edges.set(key, (e = { files: new Set(), macros: new Set() }));
    return e;
  };
  for (const [file, script] of scripts) {
    const add = (sink: { files: Set<string> }, text: string) => {
      const t = parseTargetText(text.trim());
      if (t) sink.files.add(t.file ?? file);
    };
    const target = (sink: { files: Set<string> }, t: Target) => {
      if (!t.expr) sink.files.add(t.file ?? file);
      else for (const c of t.candidates ?? input.candidates?.(t, file) ?? []) add(sink, c);
    };
    const command = (sink: { files: Set<string>; macros: Set<string> }, name: string, args: readonly Argument[]) => {
      if (macros.has(name)) sink.macros.add(name);
      const spec = macros.get(name) ?? registry.get(name);
      if (!spec) return;
      let position = 0;
      for (const a of normalizeBooleanArgs(spec, args)) {
        const key = a.key ?? spec.positional[position++];
        if (key !== undefined && spec.params[key]?.type.kind === "target" && a.value.kind === "string") add(sink, a.value.value);
      }
    };
    const inline = (sink: { files: Set<string>; macros: Set<string> }, content: readonly Inline[]) => {
      for (const n of content) {
        if (n.kind === "command") command(sink, n.name, n.args);
        else if ("children" in n) inline(sink, n.children);
      }
    };
    const visit = (sink: { files: Set<string>; macros: Set<string> }, body: readonly Statement[]) => {
      for (const s of body) {
        if (s.kind === "jump" || s.kind === "call") target(sink, s.target);
        else if (s.kind === "choice") for (const o of s.options) target(sink, o.target);
        else if (s.kind === "command") command(sink, s.name, s.args);
        else if (s.kind === "say" || s.kind === "prose") inline(sink, s.content);
        else if (s.kind === "if") {
          if (s.with) command(sink, s.with.name, s.with.args);
          for (const b of s.branches) visit(sink, b.body);
        } else if (s.kind === "define") visit(node(`@${s.name}`), s.body);
      }
    };
    visit(node(file), script.body);
  }
  const reached = new Set<string>();
  const queue: string[] = [];
  const reach = (key: string) => {
    if (reached.has(key)) return;
    reached.add(key);
    queue.push(key);
  };
  for (const s of input.starts) {
    const t = parseTargetText(s.trim());
    if (t?.file) reach(t.file);
  }
  while (queue.length > 0) {
    const e = edges.get(queue.shift()!);
    if (!e) continue;
    for (const f of e.files) reach(f);
    for (const m of e.macros) reach(`@${m}`);
  }
  for (const [file, script] of scripts) {
    if (script.draft || !reached.has(file) || inChapter(file) || !script.body.some(showsText)) continue;
    out.push({
      severity: "info",
      code: "not-in-chapter",
      message: `シナリオ ${file} はどの章（liminalia.json の chapters）にも入っていません（このシナリオのあいだ、セーブスロットの章の見出しと式の chapter() が空になります）`,
      file,
      // 最初の文の行（ファイルの頭のコメントの後。「この行では出さない」の // lim-ignore がこの行に効く）
      line: script.body[0]?.line ?? 1,
      hint: `liminalia.json の chapters のどれかの files に ${file} を足します。章に入れないなら、このファイルの先頭に // lim-ignore-file not-in-chapter を書きます`,
    });
  }
  return out;
}

/** 遊ぶ人に見せる本文（台詞、地の文、選択肢）を含むか（@define の中は見ない）。 */
function showsText(s: Statement): boolean {
  return s.kind === "say" || s.kind === "prose" || s.kind === "choice" || (s.kind === "if" && s.branches.some((b) => b.body.some(showsText)));
}

/**
 * おまけの一覧に章の情報を入れる。extra.cg の chapter はその章の見出し（番号か題）を group にし、extra.chapters の title を省いたものは章の題で補う。
 * 章の情報が無ければ extra をそのまま返す。
 */
export function extraWithChapters(extra: ExtraConfig | undefined, chapters: readonly ChapterInfo[] | undefined): ExtraConfig | undefined {
  if (!extra || !Array.isArray(chapters) || chapters.length === 0) return extra;
  const byId = new Map(chapters.filter((c) => c && typeof c.id === "string").map((c) => [c.id, c]));
  const out: ExtraConfig = { ...extra };
  if (Array.isArray(extra.cg)) {
    out.cg = extra.cg.map((c) => {
      const ch = typeof c?.chapter === "string" ? byId.get(c.chapter) : undefined;
      return ch && c.group === undefined ? { ...c, group: chapterHeading(ch) } : c;
    });
  }
  if (Array.isArray(extra.chapters)) {
    out.chapters = extra.chapters.map((c) => {
      const ch = typeof c?.id === "string" ? byId.get(c.id) : undefined;
      return ch && (typeof c.title !== "string" || c.title === "") ? { ...c, title: ch.title } : c;
    });
  }
  return out;
}
