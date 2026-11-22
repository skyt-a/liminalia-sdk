import { normalizeBooleanArgs } from "./args.ts";
import type { Argument, Diagnostic, Expr, Inline, Script, Statement } from "./ast.ts";
import type { DataText } from "./data-schema.ts";
import { legacyEndingText } from "./endings.ts";
import { parseInline, printInline } from "./inline.ts";
import { projectTexts, type ProjectTextSource } from "./project-texts.ts";
import { CHOICE_OPTION, type CommandSpec, type Registry } from "./registry.ts";
import { hash, similarity } from "./text-hash.ts";

/**
 * 多言語。原文のシナリオはそのままで、言語ごとの訳を lang/<言語>.json に置く。
 *
 * - 訳すのは本文の行・選択肢の文・話者名・システム画面の文言と、コマンドの文字（@layer-text の文字など。仕様で translate: "text" の引数に
 *   字面で書いたものと、`@set 変数 = "文字"` の右辺の文字。translatableSetValue）・作品の設定の文字（章の題、おまけの題や説明、持ち物の名前など。project-texts.ts）
 * - 本文の行と選択肢とコマンドの文字は「ファイル名と原文から作る鍵」で引く（作品の設定の文字のファイル名は liminalia.json）。原文を書き換えると鍵が変わり、古い訳はそのままでは使われなくなる。
 *   lim i18n（制作画面の訳の画面も同じ）は訳を捨てない:
 *   - 原文が同じ行がほかの鍵にある（ファイルの名前を変えた・行を別のファイルへ移した）→ 訳をそのまま引き継ぐ
 *   - 同じファイルに近い原文の訳がある（原文を少し書き換えた）→ 訳は空のまま、previous に古い原文と訳を添える
 *   - どれにも当たらない訳 → stale に取っておく（原文を元に戻せば、その行に戻る）
 * - 訳は .lim の本文と同じ書き方（ルビ・改行・クリック待ち・本文中の命令）。訳が空の行は原文を出す
 * - 同じファイルの同じ原文は一つの訳を使う。場面（ラベル）ごとに訳し分けるときは contexts に場面ごとの訳を書く
 *   （同じ原文が二つ以上の場面に出る項目に、lim i18n が場面の名前を空の訳で並べる。鍵の決め方は変えない）
 * - 行の終わりに固定の行 ID（`#line:ID`。line-ids.ts）を書いた行は、鍵を原文によらない `ファイル:l@ID`（選択肢は `ファイル:c@ID`）にする。
 *   原文を書き換えても鍵は変わらず、訳は使われ続け、訳したときの原文を translatedFrom に残す（訳し直したら消す）
 * - システム画面の文言（ui）は、日本語と英語は組み込みのものを使う。ほかの言語は lim i18n が英語の原文を添えて並べる（英語を下敷きにし、訳を書いたものだけ置き換える）
 */
export interface TranslationFile {
  /** 言語（"en" など）。 */
  language: string;
  /** 話者名（原文の名前 → 訳）。 */
  speakers?: Record<string, string>;
  /** 本文の行と選択肢（鍵 → 原文と訳）。 */
  lines?: Record<string, TranslationEntry>;
  /** 今のシナリオに無い原文の訳（消さずに取っておく。要らなければ消してよい）。 */
  stale?: Record<string, TranslationEntry>;
  /**
   * システム画面の文言（"title.start" のような鍵 → 訳）。訳だけの文字列か、英語の原文を添えたもの（lim i18n が日本語と英語以外の言語に並べる）。
   * 訳が空なら英語の文言を出す。
   */
  ui?: Record<string, string | UiTranslation>;
}

/** システム画面の文言の訳（英語の原文を添えたもの）。 */
export interface UiTranslation {
  /** 英語の原文（既定のシステム画面の strings-en.ts）。 */
  source: string;
  /** 訳。空なら英語の文言を出す。 */
  text: string;
  /** 訳したときの英語の原文（エンジンのバージョンが上がって英語が変わったあいだだけ。訳は使われ続ける。訳し直したら消す）。 */
  translatedFrom?: string;
}

/** システム画面の文言の鍵と、その英語の原文（既定のシステム画面の strings-en.ts の、文字の項目）。 */
export interface UiSourceText {
  key: string;
  source: string;
}

/** システム画面の文言の訳の文字（文字列でも、原文を添えたものでも）。無ければ ""。 */
export function uiTranslationText(value: string | UiTranslation | undefined | null): string {
  if (typeof value === "string") return value;
  return value && typeof value === "object" && typeof value.text === "string" ? value.text : "";
}

/** システム画面の文言を lim i18n が並べる言語か（日本語と英語は組み込みの文言があるので並べない）。 */
export function listsUiTexts(language: string): boolean {
  const base = language.split("-")[0]!.toLowerCase();
  return base !== "ja" && base !== "en";
}

export interface TranslationEntry {
  /** 原文（訳す人が見るため。鍵を作った元）。 */
  source: string;
  /** 訳。空なら原文を出す。 */
  text: string;
  /**
   * 訳したときの原文。固定の行 ID の行で、訳したあとに原文を書き換えたあいだだけ（訳は使われ続ける）。
   * 表と XLIFF の --changed で書き出し、訳し直して取り込むと消える。
   */
  translatedFrom?: string;
  /** 話者（訳す人が見るため。選択肢は "choice"）。 */
  speaker?: string;
  /** どこの文字か（コマンドの文字は "@layer-text" など、作品の設定の文字は "extra.cg" など。訳す人が見るため）。 */
  note?: string;
  /** 原文を書き換える前の原文と訳（訳が空のあいだだけ。訳す人が見て直す）。 */
  previous?: { source: string; text: string };
  /**
   * 場面ごとの訳（ラベルの名前 → 訳）。同じ原文が二つ以上の場面（ラベル。最初のラベルより前と @define の中は場面なし）に出る項目に並ぶ。
   * 空なら text を使う。
   */
  contexts?: Record<string, string>;
}

/** 言語の表示名（設定画面）。無い言語は言語の名前そのもの。 */
export const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  ja: "日本語",
  en: "English",
  ko: "한국어",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  fr: "Français",
  de: "Deutsch",
  es: "Español",
  it: "Italiano",
  pt: "Português",
  ru: "Русский",
};

/** 訳すものの種類。line は本文の行、option は選択肢の文、arg はコマンドの文字、text は作品の設定の文字。 */
export type TranslatableKind = "line" | "option" | "arg" | "text";

const KIND_LETTER: Readonly<Record<TranslatableKind, string>> = { line: "l", option: "c", arg: "a", text: "t" };

/** 作品の設定の文字の鍵の、ファイル名の部分。 */
export const PROJECT_TEXT_FILE = "liminalia.json";

/**
 * 訳の鍵。本文の行（kind = "line"）・選択肢（"option"）の原文は printInline で書き直したもの。
 * コマンドの文字（"arg"）は書いたファイル、作品の設定の文字（"text"）は liminalia.json をファイル名にする。
 */
export function translationKey(file: string, kind: TranslatableKind, source: string): string {
  return `${file}:${KIND_LETTER[kind]}${hash(source)}`;
}

/** 作品の設定の文字の鍵。 */
export function projectTextKey(source: string): string {
  return translationKey(PROJECT_TEXT_FILE, "text", source);
}

/** 作品のデータ（data/*.json）の訳す文の鍵の頭（`data/codex.json:t…`）。 */
export const DATA_TEXT_PREFIX = "data/";

/** 作品のデータの訳す文の鍵（file は paths.data からの名前）。 */
export function dataTextKey(file: string, source: string): string {
  return translationKey(`${DATA_TEXT_PREFIX}${file}`, "text", source);
}

const isDataKey = (key: string) => key.startsWith(DATA_TEXT_PREFIX);

/** 作品のデータの訳す文を除いた元（データは言語ごとに並べ方を変えるので、別に集める）。 */
function withoutData(sources: TranslationSources): TranslationSources {
  const { data: _data, ...rest } = sources;
  return rest;
}

/** 固定の行 ID（`#line:ID`）を書いた行の訳の鍵（`ファイル:l@ID`、選択肢は `ファイル:c@ID`）。原文によらない。 */
export function lineIdKey(file: string, kind: "line" | "option", id: string): string {
  return `${file}:${KIND_LETTER[kind]}@${id}`;
}

/** 鍵の行 ID（固定の行 ID の鍵でなければ null）。 */
export function lineIdOfKey(key: string): string | null {
  const at = key.lastIndexOf(":");
  return key.charAt(at + 2) === "@" ? key.slice(at + 3) : null;
}

/** 鍵の種類（分からない形なら null）。 */
export function translationKeyKind(key: string): TranslatableKind | null {
  const letter = key.slice(key.lastIndexOf(":") + 1, key.lastIndexOf(":") + 2);
  return (Object.keys(KIND_LETTER) as TranslatableKind[]).find((k) => KIND_LETTER[k] === letter) ?? null;
}

/** 命令の引数を、仕様の引数の名前と組にする（位置引数は positional の順）。 */
function namedArgs(spec: CommandSpec, args: readonly Argument[]): [string, Argument][] {
  const out: [string, Argument][] = [];
  let position = 0;
  for (const a of normalizeBooleanArgs(spec, args)) {
    const name = a.key ?? spec.positional[position++];
    if (name !== undefined) out.push([name, a]);
  }
  return out;
}

/** 仕様で訳す印（translate）のある引数に、字面で書いた文字。 */
function translatableArgs(spec: CommandSpec | undefined, args: readonly Argument[], want: "text" | "name"): string[] {
  if (!spec) return [];
  const out: string[] = [];
  for (const [name, a] of namedArgs(spec, args)) {
    const type = spec.params[name]?.type;
    if (type?.kind === "string" && type.translate === want && a.value.kind === "string" && a.value.value.trim() !== "") out.push(a.value.value);
    // プレイを終える命令の ending= は種類で訳さない。前の書き方の文言（BAD END、通り雨など。種類の名前の形でないもの）だけは、移すまで訳す
    else if (want === "text" && spec.ends === true && name === "ending" && a.value.kind === "string" && legacyEndingText(a.value.value)) out.push(a.value.value);
  }
  return out;
}

/**
 * `@set` の右辺の訳す文字。`@set 変数 = "文字"`（= で、右辺が字面の文字だけ）の文字に、文字（かな、漢字、英字など）が一つでもあれば返す。
 * 式で作る文字（`"第" + n + "話"` など）と、+= などで足す文字は訳さない。鍵はコマンドの文字と同じ（`ファイル:a…`）。
 * 実行器は、訳があれば訳を変数に入れる（入れたあとで言語を替えても、入れた値のまま）。
 */
export function translatableSetValue(op: string, value: Expr): string | null {
  if (op !== "=" || value.kind !== "literal" || typeof value.value !== "string") return null;
  return /\p{L}/u.test(value.value) ? value.value : null;
}

/** 変数の名前（`game.name` など。名前と . の並びでなければ空）。訳す人に見せる note に使う。 */
function variableName(e: Expr): string {
  if (e.kind === "name") return e.name;
  if (e.kind === "member") {
    const object = variableName(e.object);
    return object ? `${object}.${e.property}` : "";
  }
  return "";
}

/**
 * シナリオに字面で書いた表示名（`話者{name …}「…」` の文字だけのものと、`@name 話者 as=…` の文字列）。訳のファイルの speakers に並べる。
 * registry を渡せば、名前の印（translate: "name"）のある引数に字面で書いた名前（@chat の話者など）も。
 * {= 式} や (式) で決めるもの（プレイヤーが入力した名前など）は含めない。
 */
export function displayNames(script: Script, registry?: Registry): string[] {
  const out = new Set<string>();
  const visit = (body: readonly Statement[]) => {
    for (const s of body) {
      if (s.kind === "say" && s.name?.every((n) => n.kind === "text")) out.add(s.name.map((n) => (n.kind === "text" ? n.text : "")).join(""));
      else if (s.kind === "command" && s.name === "name") {
        const as = s.args.find((a) => a.key === "as")?.value;
        if (as?.kind === "string") out.add(as.value);
      } else if (s.kind === "command" && registry) for (const name of translatableArgs(registry.get(s.name), s.args, "name")) out.add(name);
      else if (s.kind === "if") for (const b of s.branches) visit(b.body);
      else if (s.kind === "define") visit(s.body);
    }
  };
  visit(script.body);
  return [...out];
}

/** 訳すもの一つ。 */
export interface Translatable {
  key: string;
  kind: TranslatableKind;
  source: string;
  /** 話者（地の文・コマンドの文字・作品の設定の文字は null）。 */
  speaker: string | null;
  /** 台本の行（作品の設定の文字は 0）。 */
  line: number;
  /** どこの文字か（コマンドの文字は "@layer-text" など、作品の設定の文字は "extra.cg" など）。 */
  note?: string;
  /** 同じ原文が二つ以上の場面に出るとき、出る場面（ラベルの名前。場面なしは含めない）。場面ごとに訳し分けられる。 */
  contexts?: string[];
  /** 固定の行 ID（`#line:ID` を書いた行。鍵は lineIdKey）。 */
  id?: string;
}

/** 訳すものの出てくる所一つ（同じ鍵が何度も出れば、出るたびに一つ）。 */
export interface TranslatableOccurrence {
  key: string;
  kind: TranslatableKind;
  source: string;
  speaker: string | null;
  line: number;
  note?: string;
  /** 場面（直前のラベル。最初のラベルより前と @define の中は ""）。 */
  context: string;
  id?: string;
}

/**
 * シナリオの訳すものを、出てくる順に一つずつ（同じ鍵も出るたびに。collectTranslatable の元）。
 * 固定の行 ID のある本文の行と選択肢は、鍵を lineIdKey にする。
 */
export function translatableOccurrences(script: Script, registry?: Registry): TranslatableOccurrence[] {
  const out: TranslatableOccurrence[] = [];
  /** 今の場面（直前のラベル。@define の中は ""）。 */
  let context = "";
  const push = (kind: TranslatableKind, source: string, speaker: string | null, line: number, note?: string, id?: string) => {
    if (source.trim() === "") return;
    const key = id && (kind === "line" || kind === "option") ? lineIdKey(script.file, kind, id) : translationKey(script.file, kind, source);
    out.push({ key, kind, source, speaker, line, ...(note ? { note } : {}), context, ...(id ? { id } : {}) });
  };
  const add = (kind: "line" | "option", content: Inline[], speaker: string | null, line: number, id?: string) => push(kind, printInline(content), speaker, line, undefined, id);
  const args = (name: string, spec: CommandSpec | undefined, list: readonly Argument[], line: number) => {
    for (const text of translatableArgs(spec, list, "text")) push("arg", text, null, line, `@${name}`);
  };
  const visit = (body: Statement[]) => {
    for (const s of body) {
      if (s.kind === "say") add("line", s.content, s.speaker, s.line, s.id);
      else if (s.kind === "prose") add("line", s.content, null, s.line, s.id);
      else if (s.kind === "choice")
        for (const o of s.options) {
          add("option", o.content, null, o.line, o.id);
          if (registry) args("choice", CHOICE_OPTION, o.args, o.line);
        }
      else if (s.kind === "command" && registry) args(s.name, registry.get(s.name), s.args, s.line);
      else if (s.kind === "set") {
        const text = translatableSetValue(s.op, s.value);
        if (text !== null) push("arg", text, null, s.line, `@set ${variableName(s.target)}`.trimEnd());
      } else if (s.kind === "label") context = s.name;
      else if (s.kind === "if") for (const b of s.branches) visit(b.body);
      else if (s.kind === "define") {
        const outside = context;
        context = "";
        visit(s.body);
        context = outside;
      }
    }
  };
  visit(script.body);
  return out;
}

/**
 * シナリオの訳すもの（本文の行と選択肢の文と、`@set 変数 = "文字"` の文字。同じ鍵は一度だけ）。@define の中も含める。
 * registry を渡せば、行のコマンドと選択肢の、訳す印（translate: "text"）のある引数に字面で書いた文字（コマンドの文字）も。
 * 本文の中のコマンド（{@…}）の文字は、行の訳の中で訳すので含めない。
 */
export function collectTranslatable(script: Script, registry?: Registry): Translatable[] {
  const out: Translatable[] = [];
  const seen = new Map<string, Translatable>();
  /** 項目ごとの出る場面（"" は場面なし）。 */
  const places = new Map<Translatable, Set<string>>();
  for (const o of translatableOccurrences(script, registry)) {
    let t = seen.get(o.key);
    if (!t) {
      t = { key: o.key, kind: o.kind, source: o.source, speaker: o.speaker, line: o.line, ...(o.note ? { note: o.note } : {}), ...(o.id ? { id: o.id } : {}) };
      seen.set(o.key, t);
      places.set(t, new Set());
      out.push(t);
    }
    places.get(t)!.add(o.context);
  }
  for (const [t, at] of places) if (at.size >= 2) t.contexts = [...at].filter((c) => c !== "");
  return out;
}

/**
 * 実行している位置の場面（訳の contexts の名前）。labels はラベルの名前 → 命令の番号（本体の Unit の labels）、index は今の命令の番号。
 * 番号が index 以下でいちばん大きいラベル。無ければ ""。
 */
export function contextAt(labels: Readonly<Record<string, number>>, index: number): string {
  let best = "";
  let at = -1;
  for (const [name, i] of Object.entries(labels)) if (i <= index && i > at) [best, at] = [name, i];
  return best;
}

/** 作品の設定の訳す文字（liminalia.json）。 */
export function collectProjectTexts(config: ProjectTextSource): Translatable[] {
  return projectTexts(config).map(({ source, note }) => ({ key: projectTextKey(source), kind: "text" as const, source, speaker: null, line: 0, note }));
}

/**
 * 訳すものを集める元（registry はコマンドの文字、project は作品の設定の文字。渡さなければ集めない）。
 * ui はシステム画面の文言と英語の原文（@liminalia/web の ui-strings.ts）。日本語と英語以外の言語の訳のファイルに並べる。
 */
export interface TranslationSources {
  registry?: Registry;
  project?: ProjectTextSource;
  ui?: readonly UiSourceText[];
  /**
   * 作品のデータの訳す文（dataTranslatables）。渡さなければ、訳のファイルのデータの訳（`data/…` の鍵）には触らない
   * （使われているかも数えない）。英語では、英語の欄（titleEn など）に書いた文は並べない。
   */
  data?: readonly DataText[];
  /**
   * ほかにこの訳を使う台本（パック packs/<id>/scenario の台本。パックに訳が無ければ本体の訳を、パックの訳はパックを入れると本体の台本にも使われる）。
   * その台本だけが使う訳も「使われている」に数える（検査は使われていない訳にせず、lim i18n は stale に移さずに残す）。訳し漏れには数えない。
   */
  alsoUsedBy?: readonly ReadonlyMap<string, Script>[];
  /**
   * 一緒に遊ばれて、この訳で出る台本（訳を持たないパックの台本は本体の訳で出る、など）。alsoUsedBy と同じく使われているに数え、
   * 検査は訳し漏れ（untranslated）にも数える。
   */
  alsoShown?: readonly ReadonlyMap<string, Script>[];
}

/** ほかの台本（alsoUsedBy と alsoShown）だけが使う訳す行（鍵 → 項目。scripts で使うものは除く）。shown は alsoShown の台本のものか。 */
function alsoUsedTranslatables(sources: TranslationSources, known: ReadonlySet<string>): Map<string, Translatable & { shown: boolean }> {
  const out = new Map<string, Translatable & { shown: boolean }>();
  const add = (sets: readonly ReadonlyMap<string, Script>[] | undefined, shown: boolean) => {
    for (const set of sets ?? []) for (const t of collectAllTranslatable(set, sources.registry ? { registry: sources.registry } : {})) if (!known.has(t.key) && !out.get(t.key)?.shown) out.set(t.key, { ...t, shown });
  };
  add(sources.alsoShown, true);
  add(sources.alsoUsedBy, false);
  return out;
}

/** 訳すものすべて（ファイル名の順、ファイルの中は台本の順。作品の設定の文字は最後）。 */
export function collectAllTranslatable(scripts: ReadonlyMap<string, Script>, sources: TranslationSources = {}): Translatable[] {
  const out: Translatable[] = [];
  for (const name of [...scripts.keys()].sort()) out.push(...collectTranslatable(scripts.get(name)!, sources.registry));
  if (sources.project) out.push(...collectProjectTexts(sources.project));
  if (sources.data) out.push(...collectDataTexts(sources.data));
  return out;
}

/** 作品のデータの訳す文（同じファイルの同じ文は一つ。英語の欄のあるものは en を残す）。 */
function collectDataTexts(data: readonly DataText[], language?: string): Translatable[] {
  const seen = new Set<string>();
  const out: Translatable[] = [];
  const english = !!language && language.toLowerCase().startsWith("en");
  for (const d of data) {
    if (english && d.en) continue;
    const key = dataTextKey(d.file, d.source);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, kind: "text", source: d.source, speaker: null, line: 0, note: `${DATA_TEXT_PREFIX}${d.file} ${d.note}` });
  }
  return out;
}

/** これ以上近ければ、書き換える前の原文とみなす。 */
const NEAR = 0.6;

/** 鍵のファイルの部分（"episode1:l1234abcd" → "episode1"）。 */
const fileOfKey = (key: string) => key.slice(0, key.lastIndexOf(":"));

export interface TranslationUpdate {
  file: TranslationFile;
  /** 新しく足した行（訳は空。previous が付いたものも含む）。 */
  added: number;
  /** 原文が同じ行の訳を引き継いだ（ファイルの名前を変えた・行を移した）。 */
  carried: number;
  /** 近い原文の古い訳を previous に添えた。 */
  suggested: number;
  /** どの行にも当たらず stale に取っておいた訳。 */
  kept: number;
  /** 訳が空のまま使われなくなったので外した行。 */
  removed: number;
  translated: number;
  total: number;
  /** 訳のあとで原文が変わった行（固定の行 ID の行。訳は使われ続け、translatedFrom が付く）。 */
  outdated: number;
  /** システム画面の文言（日本語と英語以外の言語で、ui を渡したときだけ）。outdated は英語の原文が変わった訳。 */
  ui?: { total: number; translated: number; added: number; outdated: number };
}

/**
 * 訳のファイルを今のシナリオに合わせる。今ある訳は残し、新しい行は訳を空で足す。並びはファイル名とシナリオの順。
 * 使われなくなった訳は捨てない（引き継ぐ・previous に添える・stale に取っておく。上の説明）。訳が空の行だけ外す。
 */
export function updateTranslation(existing: TranslationFile | null, language: string, scripts: ReadonlyMap<string, Script>, speakers: readonly string[], sources: TranslationSources = {}): TranslationUpdate {
  // データの訳す文を渡さなければ、データの訳（data/… の鍵）はそのまま残す
  const kept = (entries: Record<string, TranslationEntry> | undefined) => Object.fromEntries(Object.entries(entries ?? {}).filter(([k]) => !sources.data && isDataKey(k)));
  const keptLines = kept(existing?.lines);
  const keptStale = kept(existing?.stale);
  const managed = (entries: Record<string, TranslationEntry> | undefined) => Object.fromEntries(Object.entries(entries ?? {}).filter(([k]) => sources.data || !isDataKey(k)));
  const base = [...collectAllTranslatable(scripts, withoutData(sources)), ...(sources.data ? collectDataTexts(sources.data, language) : [])];
  // 一緒に遊ばれてこの訳で出る台本（alsoShown。訳を持たないパック）の行も一覧に並べる（台本の行のあと）
  const others = alsoUsedTranslatables(sources, new Set(base.map((t) => t.key)));
  const current: Translatable[] = [...base, ...[...others.values()].filter((t) => t.shown).map(({ shown: _, ...t }) => t)];
  const live = new Set(current.map((t) => t.key));
  // ほかの台本（alsoUsedBy。訳を持つパック）だけが使う訳は、今のまま残す（stale に移さず、引き継ぎの元にもしない）
  const keptOthers = Object.fromEntries(Object.entries(existing?.lines ?? {}).filter(([k]) => others.has(k) && !live.has(k)));
  const old: Record<string, TranslationEntry> = Object.fromEntries(Object.entries({ ...managed(existing?.stale), ...managed(existing?.lines) }).filter(([k]) => !(k in keptOthers)));
  // 今のシナリオに無い訳（引き継ぎ・添える元）。訳のあるものだけ
  const orphans = new Map(Object.entries(old).filter(([k, e]) => !live.has(k) && typeof e?.text === "string" && (e.text !== "" || Object.values(e.contexts ?? {}).some((v) => v !== ""))));
  const bySource = new Map<string, string>();
  const byContext = new Map<string, string>();
  for (const [k, e] of orphans) {
    const index = e.text ? bySource : byContext;
    const key = e.text ? e.source : `${translationKeyKind(k)}\u0000${e.source}`;
    if (!index.has(key)) index.set(key, k);
  }

  // 固定の行 ID → 今のシナリオに無い訳の鍵（行をほかのファイルへ移したとき、同じ ID の訳を引き継ぐ）
  const byId = new Map<string, string>();
  for (const k of orphans.keys()) {
    const id = lineIdOfKey(k);
    if (id !== null && !byId.has(`${translationKeyKind(k)}\u0000${id}`)) byId.set(`${translationKeyKind(k)}\u0000${id}`, k);
  }

  const lines: Record<string, TranslationEntry> = {};
  let added = 0;
  let carried = 0;
  let suggested = 0;
  let translated = 0;
  let outdated = 0;
  const fresh: Translatable[] = [];
  for (const t of current) {
    let prev = old[t.key];
    /** 訳したときの原文（固定の行 ID の行で、訳のあとに原文が変わったとき）。 */
    let from: string | undefined = prev && typeof prev.translatedFrom === "string" && prev.text ? prev.translatedFrom : undefined;
    if (prev && typeof prev.source === "string" && prev.source !== t.source) {
      // 固定の行 ID の行は、原文を書き換えても訳を使い続け、訳したときの原文を残す
      if (t.id) from = prev.text ? (from ?? prev.source) : undefined;
      // 鍵が同じで原文が違う（鍵の重なり）。訳は空にして、前の訳を添える
      else prev = { source: t.source, text: "", ...(prev.text ? { previous: { source: prev.source, text: prev.text } } : {}) };
    }
    let text = prev?.text ?? "";
    let previous = text === "" ? prev?.previous : undefined;
    let before = prev?.contexts ?? {};
    if (!prev) {
      const same = bySource.get(t.source) ?? byContext.get(`${t.kind}\u0000${t.source}`);
      const moved = t.id ? byId.get(`${t.kind}\u0000${t.id}`) : undefined;
      if (same && orphans.has(same)) {
        text = orphans.get(same)!.text;
        before = orphans.get(same)!.contexts ?? {};
        orphans.delete(same);
        carried++;
      } else if (moved && orphans.has(moved) && similarity(t.source, orphans.get(moved)!.source) >= NEAR) {
        // 同じ行 ID の行をほかのファイルへ移して、原文も少し書き換えた
        const e = orphans.get(moved)!;
        text = e.text;
        before = e.contexts ?? {};
        from = e.translatedFrom ?? e.source;
        orphans.delete(moved);
        carried++;
      } else {
        added++;
        fresh.push(t);
      }
    }
    if (from === t.source || text === "") from = undefined;
    if (text !== "") translated++;
    if (from !== undefined) outdated++;
    // 場面ごとの訳: 今出る場面を並べ、書いた訳は残す（場面が無くなっても、訳のあるものは残す）
    const contexts = t.contexts ? { ...Object.fromEntries(t.contexts.map((c) => [c, before[c] ?? ""])), ...Object.fromEntries(Object.entries(before).filter(([, v]) => v !== "")) } : Object.fromEntries(Object.entries(before).filter(([, v]) => v !== ""));
    lines[t.key] = {
      source: t.source,
      text,
      ...(from !== undefined ? { translatedFrom: from } : {}),
      ...(t.kind === "option" ? { speaker: "choice" } : t.speaker ? { speaker: t.speaker } : {}),
      ...(t.note ? { note: t.note } : {}),
      ...(previous ? { previous } : {}),
      ...(Object.keys(contexts).length > 0 ? { contexts } : {}),
    };
  }
  // 新しい行に、同じファイルの近い原文の古い訳を添える（近いものから）
  const byFile = new Map<string, Map<string, TranslationEntry>>();
  for (const [k, e] of orphans) {
    if (!e.text) continue;
    const file = fileOfKey(k);
    if (!byFile.has(file)) byFile.set(file, new Map());
    byFile.get(file)!.set(k, e);
  }
  for (const t of fresh) {
    const candidates = byFile.get(fileOfKey(t.key));
    if (!candidates) continue;
    let best: [string, number] | null = null;
    for (const [k, e] of candidates) {
      const score = similarity(t.source, e.source);
      if (score >= NEAR && (!best || score > best[1])) best = [k, score];
    }
    if (!best) continue;
    const e = orphans.get(best[0])!;
    lines[t.key]!.previous = { source: e.source, text: e.text };
    orphans.delete(best[0]);
    candidates.delete(best[0]);
    suggested++;
  }
  const stale: Record<string, TranslationEntry> = { ...keptStale };
  for (const [k, e] of orphans) stale[k] = { source: e.source, text: e.text, ...(e.translatedFrom !== undefined ? { translatedFrom: e.translatedFrom } : {}), ...(e.speaker ? { speaker: e.speaker } : {}), ...(e.note ? { note: e.note } : {}), ...(e.contexts ? { contexts: e.contexts } : {}) };
  const removed = Object.keys(old).filter((k) => !live.has(k)).length - (Object.keys(stale).length - Object.keys(keptStale).length) - carried - suggested;
  const total = Object.keys(lines).length;
  Object.assign(lines, keptOthers, keptLines);
  const speakerNames: Record<string, string> = {};
  // 表示名（{name …} と @name as= の字面で書いたもの）も、話者名と同じく訳す
  for (const s of [...speakers, ...[...scripts.values()].flatMap((script) => displayNames(script, sources.registry))]) speakerNames[s] = existing?.speakers?.[s] ?? "";
  const ui = sources.ui && listsUiTexts(language) ? updateUiTexts(existing?.ui, sources.ui) : null;
  const uiFile = ui?.ui ?? existing?.ui;
  const file: TranslationFile = {
    language,
    speakers: speakerNames,
    lines,
    ...(Object.keys(stale).length ? { stale } : {}),
    ...(uiFile && Object.keys(uiFile).length > 0 ? { ui: uiFile } : {}),
  };
  return { file, added, carried, suggested, kept: Object.keys(stale).length - Object.keys(keptStale).length, removed, translated, total, outdated, ...(ui ? { ui: ui.counts } : {}) };
}

/**
 * システム画面の文言を、今の英語の原文に合わせる（日本語と英語以外の言語）。今ある訳は残し、新しい鍵は訳を空で足す。
 * 英語が変わった鍵は訳を使い続け、訳したときの英語を translatedFrom に残す。英語の表に無い鍵（作品が足した鍵、古い版の鍵）はそのまま残す。
 * 原文を添えずに書いた訳（文字列）は、今の英語の訳とみなす。
 */
function updateUiTexts(existing: TranslationFile["ui"], table: readonly UiSourceText[]): { ui: Record<string, string | UiTranslation>; counts: { total: number; translated: number; added: number; outdated: number } } {
  const ui: Record<string, string | UiTranslation> = {};
  const counts = { total: 0, translated: 0, added: 0, outdated: 0 };
  for (const { key, source } of table) {
    const prev = existing?.[key];
    const text = uiTranslationText(prev);
    let from = typeof prev === "object" && prev ? (typeof prev.translatedFrom === "string" ? prev.translatedFrom : prev.source !== source ? prev.source : undefined) : undefined;
    if (from === source || text === "") from = undefined;
    ui[key] = { source, text, ...(from !== undefined ? { translatedFrom: from } : {}) };
    counts.total++;
    if (prev === undefined) counts.added++;
    if (text !== "") counts.translated++;
    if (from !== undefined) counts.outdated++;
  }
  for (const [key, value] of Object.entries(existing ?? {})) if (!(key in ui)) ui[key] = value;
  return { ui, counts };
}

/** 本文の中の命令の名前（訳で落としていないかを見る）。 */
function commandNames(content: Inline[], out: string[] = []): string[] {
  for (const n of content) {
    if (n.kind === "command") out.push(n.name);
    else if ("children" in n) commandNames(n.children, out);
  }
  return out;
}

/**
 * 訳のファイルの検査。書き方の誤り（ルビ・本文中の命令の閉じ忘れなど）はエラー、
 * 原文にある本文中の命令（{@voice …} など）を訳で落としていれば警告、使われていない訳（原文が変わった）は警告。
 * コマンドの文字と作品の設定の文字は、集める元（sources の registry・project）を渡したときだけ、使われているかを見る。
 * 訳し漏れ（訳が空の行と、まだ訳のファイルに無い行）は数だけ情報で知らせる。
 */
export function checkTranslation(file: unknown, path: string, scripts: ReadonlyMap<string, Script>, sources: TranslationSources = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const at = (severity: Diagnostic["severity"], code: string, message: string, hint?: string) => out.push({ severity, code, message, file: path, line: 1, ...(hint ? { hint } : {}) });
  if (!file || typeof file !== "object") {
    at("error", "bad-translation", "翻訳ファイルが JSON オブジェクトではありません");
    return out;
  }
  const f = file as TranslationFile;
  const known = new Map<string, Translatable>();
  for (const t of [...collectAllTranslatable(scripts, withoutData(sources)), ...(sources.data ? collectDataTexts(sources.data, typeof f.language === "string" ? f.language : undefined) : [])]) known.set(t.key, t);
  // ほかの台本（パック）だけが使う訳も、使われている訳として書き方を確かめる（訳し漏れには数えない）
  const others = alsoUsedTranslatables(sources, new Set(known.keys()));
  let unused = 0;
  for (const [key, entry] of Object.entries(f.lines ?? {})) {
    const t = known.get(key) ?? others.get(key);
    if (!t) {
      const kind = translationKeyKind(key);
      // 集める元を渡していない種類は、使われているかが分からない
      if ((kind === "arg" && !sources.registry) || (kind === "text" && (isDataKey(key) ? !sources.data : !sources.project))) continue;
      unused++;
      continue;
    }
    // コマンドの文字と作品の設定の文字は、本文の書き方で読まない
    if (t.kind === "arg" || t.kind === "text") continue;
    // 訳と場面ごとの訳（鍵#場面）
    const texts: [string, string][] = [[key, typeof entry?.text === "string" ? entry.text : ""], ...Object.entries(entry?.contexts ?? {}).map(([c, v]): [string, string] => [`${key}#${c}`, typeof v === "string" ? v : ""])];
    for (const [where, text] of texts) {
      if (text === "") continue;
      const { content, errors } = parseInline(text);
      for (const e of errors) at("error", "bad-translation", `${where}（${t.source}）の訳の書き方が正しくありません: ${e.message}`);
      const want = commandNames(parseInline(t.source).content);
      const have = commandNames(content);
      const lost = want.filter((n) => !have.includes(n));
      if (lost.length > 0) at("warning", "translation-lost-command", `${where}（${t.source}）の訳に、原文の本文中のコマンド ${[...new Set(lost)].map((n) => `@${n}`).join(" ")} がありません`);
    }
  }
  let untranslated = 0;
  let outdated = 0;
  for (const t of [...known.values(), ...[...others.values()].filter((o) => o.shown)]) {
    const entry = f.lines?.[t.key];
    const text = entry?.text;
    if (typeof text !== "string" || text === "") untranslated++;
    // 訳のあとで原文が変わった（固定の行 ID の行。訳は使われ続ける）
    else if (typeof entry?.translatedFrom === "string" || (t.id && typeof entry?.source === "string" && entry.source !== t.source)) outdated++;
  }
  if (untranslated > 0) at("info", "untranslated", `訳のない項目が ${untranslated} 件あります（原文を表示します）`, "lim i18n で一覧に足し、訳を書きます（--count で文字数を数えます）");
  if (outdated > 0) at("info", "outdated-translation", `訳のあとで原文が変わった項目が ${outdated} 件あります（前の原文の訳を表示します）`, "lim i18n --export xliff --changed で訳し直す分を書き出します");
  if (unused > 0) at("warning", "unused-translation", `使われていない訳が ${unused} 件あります（原文が変わったか削除された行）`, "lim i18n で今のシナリオに合わせます（訳は破棄せず、引き継ぐか stale に残します）");
  const stale = Object.keys(f.stale ?? {}).length;
  if (stale > 0) at("info", "stale-translation", `今のシナリオにない原文の訳が stale に ${stale} 件残っています`, "不要なら stale から削除します");
  return out;
}
