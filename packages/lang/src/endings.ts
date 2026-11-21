import { normalizeBooleanArgs } from "./args.ts";
import type { Argument, Diagnostic, DiagnosticFix, Script, Statement } from "./ast.ts";
import { parseLiteral } from "./args.ts";
import type { CommandSpec, Registry } from "./registry.ts";
import { storyCalls } from "./story.ts";

/**
 * エンディングの種類（プレイを終える命令の ending=。`@title-screen ending=bad title="沈黙"`）。
 *
 * - ending= は種類（文言ではない）。組み込みは bad、normal、good、true と、受け皿の other。作品は liminalia.json の endingKinds で種類を足せる
 *   （`"endingKinds": { "secret": "SECRET END" }`。組み込みの種類を書けば、その作品の文言にする）。
 * - title= はその結末だけの名前（訳す文）。画面は種類の文言（既定のシステム画面の ending.kinds、作品の endingKinds）に title を添えて出す。
 *   other は種類の文言を持たず、title だけを出す。
 * - 録画と lim playtest の避ける指定（--avoid-ending、playtest.avoidEndings）、lim coverage と全ルートテストの数え方、台本のテストの
 *   expect ending、フローチャートとおまけの一覧、MCP、実績（extra.achievements の endings と式の endings()）は、どれも種類で引く。
 *   訳した作品でも、遊ぶ言語によらず同じに数える（引くのは台本に書いた原文）。
 * - 前の書き方（書式の版 2 まで。ending= に「BAD END」「通り雨」などの文言をそのまま書いた）も動き続ける。文言から種類が分かるもの
 *   （BAD END、GOOD END、TRUE END、NORMAL END と表記ゆれ）はその種類、分からないものは other とその文言の title として引き、画面には
 *   書いた文言をそのまま出す。lim migrate が今の書き方へ移す（migrateEndingValue）。
 */

/** 組み込みの種類（並びは一覧と補完の順）。 */
export const ENDING_KINDS: readonly string[] = ["bad", "normal", "good", "true", "other"];

/** 受け皿の種類（種類の文言を持たず、title だけを出す。文言から種類の分からない前の書き方もこれ）。 */
export const OTHER_ENDING = "other";

/** 組み込みの種類の既定の文言（日本語も英語も同じ。既定のシステム画面の ending.kinds と同じもの）。other は持たない。 */
export const ENDING_KIND_LABELS: Readonly<Record<string, string>> = { bad: "BAD END", normal: "NORMAL END", good: "GOOD END", true: "TRUE END" };

/** 種類の名前の形（英小文字で始まり、英小文字、数字、-、_）。 */
export const ENDING_KIND_NAME = /^[a-z][a-z0-9_-]*$/;

/** 見た結末を置く、全セーブ共通の変数の名前（式の名前に使えない文字を含むので、作品の変数と重ならない）。式の endings() が数える。 */
export const ENDINGS_KEY = "@endings";

/** 一つの結末を引くもの。kind は種類、title はその結末の名前（原文）。legacy は前の書き方で ending= に書いた文言（移していない作品だけ）。 */
export interface EndingRef {
  kind: string;
  title?: string;
  legacy?: string;
}

/** 種類を引くのに使う、作品の種類（liminalia.json の endingKinds の、形の正しいもの）。 */
export interface EndingKinds {
  /** 使える種類の名前（組み込みと作品の）。 */
  names: ReadonlySet<string>;
  /** 作品が決めた文言（種類 → 文言。組み込みの種類を書き換えたものも）。 */
  labels: Readonly<Record<string, string>>;
}

/** liminalia.json の endingKinds（読めない項目は飛ばす）から、使える種類を作る。 */
export function endingKinds(config?: unknown): EndingKinds {
  const labels: Record<string, string> = {};
  if (config && typeof config === "object" && !Array.isArray(config)) {
    for (const [k, v] of Object.entries(config as Record<string, unknown>)) if (ENDING_KIND_NAME.test(k) && typeof v === "string") labels[k] = v;
  }
  return { names: new Set([...ENDING_KINDS, ...Object.keys(labels)]), labels };
}

/** 組み込みの種類だけ（作品の設定を読まない所。種類の名前の形のものは種類とみなす）。 */
const BUILTIN: EndingKinds = endingKinds();

/** 種類の既定の文言（作品の文言、組み込みの文言の順。無ければ ""）。ゲームの画面は遊んでいる言語の文言を別に引く。 */
export function endingKindLabel(kind: string, kinds: EndingKinds = BUILTIN): string {
  return kinds.labels[kind] ?? ENDING_KIND_LABELS[kind] ?? "";
}

/** 文言の表記ゆれをそろえる（全角を半角、英字を小文字、空白と区切りの記号を外す、ENDING を END に。エンディングとエンドは PHRASES が両方読む）。 */
function squash(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_\-・·.]+/g, "")
    .replace(/ending$/, "end");
}

/** 組み込みの種類の文言（そろえたもの）。BAD END、バッドエンドなど。 */
const PHRASES: readonly [string, RegExp][] = [
  ["bad", /^(?:bad|バッド)(?:end|エン(?:ド|ディング))$/],
  ["normal", /^(?:normal|ノーマル)(?:end|エン(?:ド|ディング))$/],
  ["good", /^(?:good|グッド)(?:end|エン(?:ド|ディング))$/],
  ["true", /^(?:true|トゥルー)(?:end|エン(?:ド|ディング))$/],
];

/** 一語だけで種類を言うもの（BAD、バッドなど。避ける指定で使う）。文の頭には使わない（Bad timing を bad にしない）。 */
const WORDS: readonly [string, RegExp][] = [
  ["bad", /^(?:bad|バッド)$/],
  ["normal", /^(?:normal|ノーマル)$/],
  ["good", /^(?:good|グッド)$/],
  ["true", /^(?:true|トゥルー)$/],
];

/** 文言全体が種類を言っているか（BAD END、Bad Ending、バッドエンド、作品の endingKinds の文言、種類の名前）。words は一語の BAD なども見る。 */
function phraseKind(text: string, kinds: EndingKinds, words: boolean): string | null {
  const s = squash(text);
  if (s === "") return null;
  for (const [kind, label] of Object.entries(kinds.labels)) if (label !== "" && squash(label) === s) return kind;
  for (const [kind, re] of PHRASES) if (re.test(s)) return kind;
  if (words) {
    for (const [kind, re] of WORDS) if (re.test(s)) return kind;
    if (kinds.names.has(s)) return s;
  }
  return null;
}

/** 文言の頭の種類のあとに続いてよい文字（区切り、数、括弧）。 */
const AFTER_PHRASE = /^[\s:：\-－‐—―~～〜・「『(（[【〔<＜#＃0-9０-９.。、,]/;
/** 名前の頭から外す区切り。 */
const LEADING_SEPARATORS = /^[\s:：\-－‐—―・.。、,]+/;
/** 名前全体を囲む括弧。 */
const WRAPPED = /^(?:「(.+)」|『(.+)』|（(.+)）|\((.+)\)|【(.+)】|〔(.+)〕|\[(.+)\])$/s;

/**
 * 前の書き方の文言（`ending="BAD END"`）から、種類と名前を読む。文言全体が種類なら名前は ""（BAD END、Bad Ending、バッドエンド）。
 * 頭が種類で後ろに続きがあれば、その続きを名前にする（「BAD END 2：沈黙」は bad と「2：沈黙」）。どちらでもなければ null。
 */
export function endingKindOfText(text: string, kinds: EndingKinds = BUILTIN): { kind: string; title: string } | null {
  const whole = phraseKind(text, kinds, false);
  if (whole) return { kind: whole, title: "" };
  // 頭のいちばん長い所から種類を探す
  const trimmed = text.trim();
  for (let i = trimmed.length - 1; i > 0; i--) {
    const rest = trimmed.slice(i);
    if (!AFTER_PHRASE.test(rest)) continue;
    const kind = phraseKind(trimmed.slice(0, i), kinds, false);
    if (!kind) continue;
    let title = rest.replace(LEADING_SEPARATORS, "").trim();
    const wrapped = WRAPPED.exec(title);
    if (wrapped) title = wrapped.slice(1).find((x) => x !== undefined)!.trim();
    return { kind, title };
  }
  return null;
}

/** 前の書き方の文言か（種類の名前の形でない。BAD END、通り雨など）。移すまでは訳す文として扱う。 */
export function legacyEndingText(value: string): boolean {
  const v = value.trim();
  return v !== "" && !ENDING_KIND_NAME.test(v);
}

/** ending= の値を文字にする（`ending=true` は真偽の字面に読めるので、種類の true にする）。書いていなければ ""。 */
export function endingValueText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === true) return "true";
  return "";
}

/**
 * プレイを終える命令の ending= と title= から、結末を引くものを作る。ending= も title= も無ければ null。
 * ending= が種類でなければ前の書き方として、文言から種類と名前を読む（読めなければ other とその文言）。title= だけなら other。
 */
export function endingRef(ending: unknown, title: unknown, kinds: EndingKinds = BUILTIN): EndingRef | null {
  const value = endingValueText(ending);
  const name = typeof title === "string" ? title.trim() : "";
  if (value === "") return name === "" ? null : { kind: OTHER_ENDING, title: name };
  if (kinds.names.has(value)) return { kind: value, ...(name ? { title: name } : {}) };
  const read = endingKindOfText(value, kinds);
  const t = name || (read ? read.title : value);
  return { kind: read?.kind ?? OTHER_ENDING, ...(t ? { title: t } : {}), legacy: value };
}

/**
 * 結末が、避ける指定や expect ending に書いたもの（query）に当たるか。種類の名前（大文字と小文字は区別しない）か、種類を言う文言
 * （BAD END、バッドなど）なら種類で引く。それ以外は、その結末の名前（title。前の書き方なら書いた文言）がそれを含むか
 * （大文字と小文字、全角と半角は区別しない）。どれも原文で引くので、訳した作品でも遊ぶ言語によらず同じ。
 */
export function endingMatches(ref: EndingRef, query: string, kinds: EndingKinds = BUILTIN): boolean {
  const kind = queryKind(query, kinds);
  if (kind !== undefined) return kind !== null && ref.kind === kind;
  const needle = query.trim().normalize("NFKC").toLowerCase();
  return [ref.title, ref.legacy].some((t) => t !== undefined && t.normalize("NFKC").toLowerCase().includes(needle));
}

/** query が種類を言っていればその種類、空なら null、種類でなければ undefined（名前で引く）。 */
export function queryKind(query: string, kinds: EndingKinds = BUILTIN): string | null | undefined {
  const q = query.trim();
  if (q === "") return null;
  if (kinds.names.has(q.toLowerCase())) return q.toLowerCase();
  return phraseKind(q, kinds, true) ?? undefined;
}

/** 道具（lim coverage、MCP、制作画面）に出す結末の名前。種類と、名前があれば「名前」（`bad「沈黙」`）。 */
export function endingLabel(ref: EndingRef): string {
  return `${ref.kind}${ref.title ? `「${ref.title}」` : ""}`;
}

/** 文の名前付きの引数（位置で渡したものも仕様の名前で）。 */
function namedArgs(spec: CommandSpec, args: readonly Argument[]): Map<string, Argument> {
  const out = new Map<string, Argument>();
  let position = 0;
  for (const a of normalizeBooleanArgs(spec, args)) {
    const name = a.key ?? spec.positional[position++];
    if (name !== undefined) out.set(name, a);
  }
  return out;
}

/** 字面の値（式は null）。 */
function literal(a: Argument | undefined): string | true | null {
  if (!a) return null;
  if (a.value.kind === "string") return a.value.value;
  if (a.value.kind === "bool" && a.value.value) return true;
  return null;
}

/** プレイを終える命令の、ending= と title= を書いた行（@if と @define の中も）。 */
export interface EndingSite {
  file: string;
  line: number;
  /** 命令の名前（title-screen など）。 */
  command: string;
  ref: EndingRef;
  /** ending= の字面（式なら無い）と、その引数。 */
  ending?: { value: string; arg: Argument };
  title?: { value: string; arg: Argument };
}

/** 文の中の、プレイを終える命令の結末（ending= か title= を字面で書いたもの）を集める。 */
export function endingSitesIn(file: string, script: Script, registry: Registry, kinds: EndingKinds = BUILTIN): EndingSite[] {
  const out: EndingSite[] = [];
  const visit = (body: readonly Statement[]) => {
    for (const s of body) {
      if (s.kind === "if") for (const b of s.branches) visit(b.body);
      if (s.kind === "define") visit(s.body);
      if (s.kind !== "command") continue;
      const spec = registry.get(s.name);
      if (!spec?.ends) continue;
      const args = namedArgs(spec, s.args);
      const e = literal(args.get("ending"));
      const t = literal(args.get("title"));
      const ref = endingRef(e, t, kinds);
      if (!ref) continue;
      out.push({
        file,
        line: s.line,
        command: s.name,
        ref,
        ...(e !== null ? { ending: { value: endingValueText(e), arg: args.get("ending")! } } : {}),
        ...(typeof t === "string" ? { title: { value: t, arg: args.get("title")! } } : {}),
      });
    }
  };
  visit(script.body);
  return out;
}

/** 前の書き方の ending= を今の書き方にしたもの。kind は種類、title は名前（無ければ無い）。whole は文言全体が種類だったか。 */
export interface EndingMigration {
  kind: string;
  title?: string;
  whole: boolean;
}

/** ending= の値を今の書き方にする（種類ならそのままなので null）。 */
export function migrateEndingValue(value: string, kinds: EndingKinds = BUILTIN): EndingMigration | null {
  const v = value.trim();
  if (v === "" || kinds.names.has(v)) return null;
  const read = endingKindOfText(v, kinds);
  if (read) return { kind: read.kind, ...(read.title ? { title: read.title } : {}), whole: read.title === "" };
  return { kind: OTHER_ENDING, title: v, whole: false };
}

/** 移した一か所（1 始まりの行、前の値、今の種類と名前）。 */
export interface EndingChange {
  line: number;
  from: string;
  kind: string;
  title?: string;
  whole: boolean;
  /** 書いた文言の種類の部分（文言全体が種類か、頭が種類のとき。BAD END、Bad End など）。画面の文言を残すのに使う。 */
  phrase?: string;
}

/** 文字列を .lim の "…" で書く。 */
function quoted(text: string): string {
  return JSON.stringify(text);
}

/**
 * 台本の前の書き方の ending=（文言）を、種類と title= に書き換える（`ending="BAD END"` → `ending=bad`、`ending="通り雨"` →
 * `ending=other title="通り雨"`）。title= をすでに書いた行は、ending= だけを種類にする。改行の形（\r\n）はそのまま。
 */
export function migrateEndingSource(source: string, script: Script, registry: Registry, kinds: EndingKinds = BUILTIN): { text: string; changes: EndingChange[] } {
  const rows = source.split("\n");
  const changes: EndingChange[] = [];
  for (const site of endingSitesIn(script.file, script, registry, kinds)) {
    if (!site.ending) continue;
    const m = migrateEndingValue(site.ending.value, kinds);
    if (!m) continue;
    const row = rows[site.line - 1];
    if (row === undefined) continue;
    const cr = row.endsWith("\r") ? "\r" : "";
    const body = cr ? row.slice(0, -1) : row;
    const span = argumentSpan(body, site.ending.arg.column);
    if (!span) continue;
    const token = body.slice(span.start, span.end);
    const key = site.ending.arg.key ? `${site.ending.arg.key}=` : "";
    const written = parseLiteral(token.slice(key.length));
    if (!token.startsWith(key) || written.kind !== "string" || written.value !== site.ending.value) continue;
    // ending= を種類にし、名前があればすぐ後ろに title= を足す（種類はそのまま書ける名前なので "…" で囲まない）
    const title = site.title ? undefined : m.title;
    rows[site.line - 1] = `${body.slice(0, span.start)}${key}${m.kind}${title !== undefined ? ` title=${quoted(title)}` : ""}${body.slice(span.end)}${cr}`;
    const phrase = m.whole ? site.ending.value : m.title !== undefined && m.kind !== OTHER_ENDING ? phrasePart(site.ending.value, kinds) : undefined;
    changes.push({ line: site.line, from: site.ending.value, kind: m.kind, ...(title !== undefined ? { title } : {}), whole: m.whole, ...(phrase ? { phrase } : {}) });
  }
  return { text: rows.join("\n"), changes };
}

/** 行の中の、column（Argument.column。1 始まり）から始まる引数の字面の範囲（"…" と (…) の中の空白では区切らない）。無ければ null。 */
function argumentSpan(line: string, column: number): { start: number; end: number } | null {
  const start = column - 1;
  if (start < 0 || start >= line.length || line[start] === " " || line[start] === "\t") return null;
  let i = start;
  let inQuote = false;
  let depth = 0;
  while (i < line.length && (inQuote || depth > 0 || (line[i] !== " " && line[i] !== "\t"))) {
    if (inQuote && line[i] === "\\") i++;
    else if (line[i] === '"') inQuote = !inQuote;
    else if (!inQuote && line[i] === "(") depth++;
    else if (!inQuote && line[i] === ")") depth--;
    i++;
  }
  return { start, end: Math.min(i, line.length) };
}

/** 文言の頭の種類の部分（「BAD END 2：沈黙」の BAD END）。 */
function phrasePart(text: string, kinds: EndingKinds): string | undefined {
  const trimmed = text.trim();
  for (let i = trimmed.length - 1; i > 0; i--) if (AFTER_PHRASE.test(trimmed.slice(i)) && phraseKind(trimmed.slice(0, i), kinds, false)) return trimmed.slice(0, i).trim();
  return undefined;
}

/** 検査に渡すもの。 */
export interface EndingCheckInput {
  scripts: ReadonlyMap<string, Script>;
  registry: Registry;
  /** liminalia.json の endingKinds と format（台本の書式の版）、playtest、extra。 */
  endingKinds?: unknown;
  format?: unknown;
  playtest?: unknown;
  extra?: unknown;
}

/** 種類の一覧の文（検査の直し方）。 */
function kindList(kinds: EndingKinds): string {
  return [...kinds.names].join("、");
}

/**
 * エンディングの種類の検査（lim check、制作画面、VS Code、MCP の check_text が同じものを出す）。
 * - liminalia.json の endingKinds の形
 * - プレイを終える命令の ending=: 種類でない値は、書式の版が 2 までなら前の書き方として警告（legacy-ending。lim migrate で移せる）、
 *   3 からはエラー（unknown-ending-kind）。どちらも直し方を付ける
 * - playtest.avoidEndings と extra.achievements の endings に書いた種類、式の endings("種類") の種類
 */
export function checkEndings(input: EndingCheckInput): Diagnostic[] {
  const out: Diagnostic[] = [];
  const config = "liminalia.json";
  const raw = input.endingKinds;
  if (raw !== undefined) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) out.push({ severity: "error", code: "bad-config", message: "endingKinds は種類の名前と文言の組で書きます", file: config, line: 1, hint: '"endingKinds": { "secret": "SECRET END" }' });
    else
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!ENDING_KIND_NAME.test(k)) out.push({ severity: "error", code: "bad-config", message: `endingKinds の ${k} は種類の名前に使えません（英小文字で始め、英小文字、数字、-、_ で書きます）`, file: config, line: 1 });
        else if (typeof v !== "string") out.push({ severity: "error", code: "bad-config", message: `endingKinds の ${k} は文言の文字列で書きます`, file: config, line: 1, hint: `"${k}": "${k.toUpperCase()} END"` });
      }
  }
  const kinds = endingKinds(raw);
  const format = typeof input.format === "number" && Number.isInteger(input.format) ? input.format : 1;
  const refs: EndingRef[] = [];
  for (const [file, script] of input.scripts) {
    for (const site of endingSitesIn(file, script, input.registry, kinds)) {
      refs.push(site.ref);
      const value = site.ending?.value;
      if (value === undefined || value === "" || kinds.names.has(value)) continue;
      const m = migrateEndingValue(value, kinds)!;
      const written = `${site.ending!.arg.key ? `${site.ending!.arg.key}=` : ""}${site.ending!.arg.value.kind === "string" && site.ending!.arg.value.quoted ? quoted(value) : value}`;
      const now = `ending=${m.kind}${m.title !== undefined && !site.title ? ` title=${quoted(m.title)}` : ""}`;
      const fix: DiagnosticFix = { kind: "replace", find: written, with: now };
      const column = site.ending!.arg.column;
      if (format < 3) {
        out.push({ severity: "warning", code: "legacy-ending", message: `ending= に文言（${value}）を書いた前の書き方です。ending= には種類を、名前は title= に書きます`, file, line: site.line, column, hint: `${now} と書きます（作品全体は lim migrate で移せます）`, fix, fixes: [fix] });
        continue;
      }
      // 種類の名前の形なら、近い種類の名前を案に出す
      const near = ENDING_KIND_NAME.test(value) ? nearest(value, kinds.names) : null;
      if (near) {
        const f: DiagnosticFix = { kind: "replace", find: `ending=${value}`, with: `ending=${near}` };
        out.push({ severity: "error", code: "unknown-ending-kind", message: `エンディングの種類 ${value} はありません`, file, line: site.line, column, hint: `${near} のことですか？（種類を足すなら liminalia.json の endingKinds に書きます）`, fix: f, fixes: [f] });
      } else if (ENDING_KIND_NAME.test(value)) {
        out.push({ severity: "error", code: "unknown-ending-kind", message: `エンディングの種類 ${value} はありません`, file, line: site.line, column, hint: `種類は ${kindList(kinds)} のどれかです（種類を足すなら liminalia.json の endingKinds に書きます）` });
      } else {
        out.push({ severity: "error", code: "unknown-ending-kind", message: `ending= には種類を書きます（${value} は種類ではありません）`, file, line: site.line, column, hint: `${now} と書きます（作品全体は lim migrate で移せます）`, fix, fixes: [fix] });
      }
    }
  }
  // 避ける指定（種類か、結末の名前に含む文字）
  const playtest = input.playtest;
  const avoid = playtest && typeof playtest === "object" && !Array.isArray(playtest) ? (playtest as { avoidEndings?: unknown }).avoidEndings : undefined;
  if (Array.isArray(avoid)) {
    for (const q of avoid) {
      if (typeof q !== "string" || q.trim() === "") continue;
      if (queryKind(q, kinds) !== undefined) continue;
      if (refs.some((r) => endingMatches(r, q, kinds))) continue;
      out.push({ severity: "warning", code: "unknown-ending-kind", message: `playtest.avoidEndings の ${q} に当たるエンディングがありません`, file: config, line: 1, hint: `種類（${kindList(kinds)}）か、エンディングの title に含む文字を書きます` });
    }
  }
  // 実績の endings（その種類の結末を見た数で進める）
  const extra = input.extra;
  const achievements = extra && typeof extra === "object" && !Array.isArray(extra) ? (extra as { achievements?: unknown }).achievements : undefined;
  if (Array.isArray(achievements)) {
    for (const a of achievements as { id?: unknown; endings?: unknown; goal?: unknown }[]) {
      if (!a || typeof a !== "object" || a.endings === undefined) continue;
      const id = typeof a.id === "string" ? a.id : "";
      if (typeof a.endings !== "string" || (a.endings !== "*" && !kinds.names.has(a.endings)))
        out.push({ severity: "error", code: "bad-config", message: `extra.achievements ${id} の endings は種類の名前か "*" で書きます`, file: config, line: 1, hint: `種類は ${kindList(kinds)} のどれかです` });
      if (typeof a.goal !== "number") out.push({ severity: "error", code: "bad-config", message: `extra.achievements ${id} に endings を書くときは goal（見る数）も書きます`, file: config, line: 1, hint: `"goal": 3` });
    }
  }
  // 式の endings("種類")
  for (const [file, script] of input.scripts) {
    for (const c of storyCalls(script)) {
      if (c.callee !== "endings" || c.value === "*" || kinds.names.has(c.value)) continue;
      out.push({ severity: "warning", code: "unknown-ending-kind", message: `endings() のエンディングの種類 ${c.value} はありません`, file, line: c.line, hint: `種類は ${kindList(kinds)} のどれかです` });
    }
  }
  return out;
}

/** 近い名前（綴り違い）。 */
function nearest(word: string, names: Iterable<string>): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const n of names) {
    const d = editDistance(word, n);
    if (d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best !== null && bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** 実績のうち、見た結末の数で進めるもの（id → 種類（"*" はどれも）と goal）。実行器の endingAchievements に渡す。 */
export function endingAchievements(extra: unknown): Record<string, { endings: string; goal: number }> {
  const out: Record<string, { endings: string; goal: number }> = {};
  const list = extra && typeof extra === "object" && !Array.isArray(extra) ? (extra as { achievements?: unknown }).achievements : undefined;
  if (!Array.isArray(list)) return out;
  for (const a of list as { id?: unknown; endings?: unknown; goal?: unknown }[]) {
    if (a && typeof a.id === "string" && typeof a.endings === "string" && a.endings !== "" && typeof a.goal === "number" && a.goal > 0) out[a.id] = { endings: a.endings, goal: a.goal };
  }
  return out;
}

/** 見た結末の記録（ENDINGS_KEY の中身。結末の鍵 → 種類）から、その種類（"*" か省くとどれも）の数。 */
export function countEndings(record: unknown, kind?: string): number {
  if (!record || typeof record !== "object" || Array.isArray(record)) return 0;
  let n = 0;
  for (const v of Object.values(record as Record<string, unknown>)) if (kind === undefined || kind === "*" || v === kind) n++;
  return n;
}

/** 見た結末の鍵（シーンと、種類と名前。行がずれても変わらない）。 */
export function endingRecordKey(scene: string, ref: EndingRef): string {
  return `${scene}|${ref.kind}|${ref.title ?? ""}`;
}
