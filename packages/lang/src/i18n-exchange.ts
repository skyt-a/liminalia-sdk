import type { Inline, Script } from "./ast.ts";
import { translatableOccurrences, translationKeyKind, type TranslationFile, type UiTranslation } from "./i18n.ts";
import { parseInline, plainText, printInline } from "./inline.ts";
import type { Registry } from "./registry.ts";
import { parseCsv, toCsv } from "./voice-script.ts";

/**
 * 訳の受け渡し。訳のファイル（lang/<言語>.json）を、翻訳する人が扱いやすい表（CSV）と XLIFF 1.2 にし、訳を書き込んだものを読み戻す。
 * 表の列は 鍵・種類（line・choice・command・setting・speaker・ui）・話者（コマンドの文字と作品の設定の文字は、どこの文字か）・原文・訳・前の原文・前の訳・文脈。
 * 読み戻すときは鍵で引き、原文が変わっていた行は書かない（鍵を一覧で返す）。本文の行と選択肢の訳は .lim の本文の書き方を確かめ、読めない訳は書かずに位置を返す。
 * 場面ごとの訳（contexts）は、その項目のすぐ後に 鍵#場面 の行で並べる（訳が空なら、場面に分けない訳を使う）。
 * システム画面の文言（ui。日本語と英語以外の言語）は 鍵 ui:title.start の行で、原文は英語。
 *
 * XLIFF では、本文の行と選択肢の書き方を訳す人のツールが壊さないように、インラインの要素にする:
 * `{br}` `{click}` `{noclick}` は `<x/>`、`{r …}` `{= …}` `{@…}` `{img …}` は中身ごと `<ph>`、文字を囲む書き方（`{b …}` `{c …}` など）は `<g>`。
 * note には話者、場面、位置（ファイルと行）、前後の行、長さの目安を書く。
 */
export const EXCHANGE_HEADER = ["key", "kind", "speaker", "source", "translation", "previous_source", "previous_translation", "context"] as const;

/** 項目の場所（表と XLIFF の文脈。exchangeContext）。 */
export interface ExchangePlace {
  /** 台本の名前（シナリオのフォルダからのパス、拡張子なし）。 */
  file: string;
  line: number;
  /** 場面（直前のラベル。無ければ ""）。 */
  scene: string;
  /** 前の本文の行と次の本文の行（話者付き。長いものは縮める）。 */
  before?: string;
  after?: string;
}

/** 鍵 → 項目の場所。 */
export type ExchangeContext = ReadonlyMap<string, ExchangePlace>;

/** 書き出しの指定。 */
export interface ExchangeOptions {
  /** 項目の場所（note と表の文脈の列に書く）。 */
  context?: ExchangeContext;
  /** 訳の無い項目だけ（changed と両方なら、どちらかに当たるもの）。 */
  untranslated?: boolean;
  /** 訳のあとで原文が変わった項目だけ（前の訳を添えた項目と、translatedFrom の付いた項目）。 */
  changed?: boolean;
  /** note と文脈の列の言葉（既定は日本語）。 */
  noteLanguage?: "ja" | "en";
}

/** 前後の行を縮める長さ。 */
const NEIGHBOR_MAX = 80;

/** 台本から、訳すものの場所と前後の行を集める（同じ鍵は最初に出る所）。 */
export function exchangeContext(scripts: ReadonlyMap<string, Script>, registry?: Registry): Map<string, ExchangePlace> {
  const out = new Map<string, ExchangePlace>();
  const clip = (s: string) => ([...s].length > NEIGHBOR_MAX ? `${[...s].slice(0, NEIGHBOR_MAX).join("")}…` : s);
  for (const name of [...scripts.keys()].sort()) {
    const all = translatableOccurrences(scripts.get(name)!, registry);
    const shown = all.map((o) => (o.kind === "line" ? `${o.speaker ?? ""}${o.source}` : o.kind === "option" ? `- ${o.source}` : null));
    for (let i = 0; i < all.length; i++) {
      const o = all[i]!;
      if (out.has(o.key)) continue;
      let before: string | undefined;
      let after: string | undefined;
      for (let j = i - 1; j >= 0 && before === undefined; j--) before = shown[j] ?? undefined;
      for (let j = i + 1; j < all.length && after === undefined; j++) after = shown[j] ?? undefined;
      out.set(o.key, { file: name, line: o.line, scene: o.context, ...(before !== undefined ? { before: clip(before) } : {}), ...(after !== undefined ? { after: clip(after) } : {}) });
    }
  }
  return out;
}

type RowKind = "line" | "choice" | "command" | "setting" | "speaker" | "ui";

interface Row {
  key: string;
  kind: RowKind;
  speaker: string;
  source: string;
  text: string;
  prevSource: string;
  prevText: string;
  /** 場面ごとの訳の行（鍵#場面）の場面。 */
  context?: string;
  /** 訳のあとで原文が変わった。 */
  changed: boolean;
  /** 訳の場所を引く鍵（場面ごとの訳の行は元の項目の鍵）。 */
  base: string;
}

/** 本文の書き方で読む種類（本文の行と選択肢）。 */
const markup = (kind: RowKind) => kind === "line" || kind === "choice";

/** 訳の表の行。話者名は鍵を "speaker:名前" に、システム画面の文言は "ui:鍵" に、場面ごとの訳は "鍵#場面" にする（context はその場面）。 */
function entries(file: TranslationFile): Row[] {
  const kindOf = (key: string, speaker: string | undefined): RowKind => {
    const kind = translationKeyKind(key);
    return kind === "arg" ? "command" : kind === "text" ? "setting" : kind === "option" || speaker === "choice" ? "choice" : "line";
  };
  const out: Row[] = [];
  for (const [name, text] of Object.entries(file.speakers ?? {})) out.push({ key: `speaker:${name}`, kind: "speaker", speaker: "", source: name, text, prevSource: "", prevText: "", changed: false, base: `speaker:${name}` });
  for (const [key, e] of Object.entries(file.lines ?? {})) {
    const from = typeof e.translatedFrom === "string" && e.text !== "" ? e.translatedFrom : null;
    const row: Row = {
      key,
      kind: kindOf(key, e.speaker),
      speaker: e.speaker === "choice" ? "" : (e.speaker ?? e.note ?? ""),
      source: e.source,
      text: e.text,
      prevSource: from ?? e.previous?.source ?? "",
      prevText: from !== null ? e.text : (e.previous?.text ?? ""),
      changed: from !== null || !!e.previous,
      base: key,
    };
    out.push(row, ...Object.entries(e.contexts ?? {}).map(([context, text]) => ({ ...row, key: `${key}#${context}`, text, prevSource: "", prevText: "", context, changed: false })));
  }
  for (const [key, value] of Object.entries(file.ui ?? {})) {
    // 原文を添えずに書いた訳（英語の作品の上書きなど）は、訳す元が無いので並べない
    if (!value || typeof value !== "object" || typeof value.source !== "string") continue;
    const from = typeof value.translatedFrom === "string" && value.text !== "" ? value.translatedFrom : null;
    out.push({ key: `ui:${key}`, kind: "ui", speaker: "", source: value.source, text: value.text ?? "", prevSource: from ?? "", prevText: from !== null ? value.text : "", changed: from !== null, base: `ui:${key}` });
  }
  return out;
}

/** 書き出す行（--untranslated・--changed で絞る。場面ごとの訳の行は、元の項目を書き出すときだけ）。 */
function selected(file: TranslationFile, o: ExchangeOptions): Row[] {
  const rows = entries(file);
  if (!o.untranslated && !o.changed) return rows;
  const want = (r: Row) => (o.untranslated === true && r.text === "") || (o.changed === true && r.changed);
  const keep = new Set(rows.filter((r) => r.context === undefined && want(r)).map((r) => r.base));
  return rows.filter((r) => keep.has(r.base));
}

const NOTE_WORDS = {
  ja: {
    speaker: "話者",
    kind: "種類",
    kinds: { line: "地の文", choice: "選択肢", command: "コマンドの文字", setting: "作品の設定の文字", speaker: "話者名", ui: "システム画面の文言" },
    scene: "場面",
    sceneContext: (s: string) => `場面: ${s}（空なら場面に分けない訳を使う）`,
    position: (file: string, line: number) => `位置: ${file}.lim ${line} 行目`,
    before: "前の行",
    after: "次の行",
    length: (n: number) => `長さの目安: 原文 ${n} 字`,
    uiLength: (n: number) => `長さの目安: 英語で ${n} 字（ボタンや見出しに収まる長さに）`,
    previous: (s: string, t: string) => `前の原文: ${s} / 前の訳: ${t}`,
    translatedFrom: (s: string) => `訳したときの原文: ${s}（原文が変わりました。訳を確かめてください）`,
  },
  en: {
    speaker: "Speaker",
    kind: "Kind",
    kinds: { line: "Narration", choice: "Choice", command: "Command text", setting: "Project setting text", speaker: "Speaker name", ui: "System screen text" },
    scene: "Scene",
    sceneContext: (s: string) => `Scene: ${s} (if empty, the translation without a scene is used)`,
    position: (file: string, line: number) => `Position: ${file}.lim line ${line}`,
    before: "Previous line",
    after: "Next line",
    length: (n: number) => `Length: ${n} ${n === 1 ? "character" : "characters"} in the source`,
    uiLength: (n: number) => `Length: ${n} ${n === 1 ? "character" : "characters"} in English (short enough for buttons and headings)`,
    previous: (s: string, t: string) => `Previous source: ${s} / Previous translation: ${t}`,
    translatedFrom: (s: string) => `Translated from: ${s} (the source changed; check the translation)`,
  },
} as const;

/** 原文の長さ（本文の行と選択肢は表示される文字だけ）。 */
function sourceLength(r: Row): number {
  if (!markup(r.kind)) return [...r.source].length;
  const { content, errors } = parseInline(r.source);
  return [...(errors.length > 0 ? r.source : plainText(content))].length;
}

/** 項目の文脈（話者、場面、位置、前後の行、長さの目安、前の原文と訳）。表の文脈の列は話者と前の原文を除く（ほかの列にあるため）。 */
function noteLines(r: Row, o: ExchangeOptions, forTable: boolean): string[] {
  const w = NOTE_WORDS[o.noteLanguage ?? "ja"];
  const place = r.kind === "speaker" || r.kind === "ui" ? undefined : o.context?.get(r.base);
  const out: string[] = [];
  if (!forTable) {
    // 台詞は話者、コマンドの文字と作品の設定の文字はどこの文字か、ほかは種類
    if (r.speaker && r.kind === "line") out.push(`${w.speaker}: ${r.speaker}`);
    else if (r.speaker && (r.kind === "command" || r.kind === "setting")) out.push(`${w.kinds[r.kind]}: ${r.speaker}`);
    else out.push(`${w.kind}: ${w.kinds[r.kind]}`);
  }
  if (r.context !== undefined) out.push(w.sceneContext(r.context));
  else if (place?.scene) out.push(`${w.scene}: ${place.scene}`);
  if (place) out.push(w.position(place.file, place.line));
  if (place?.before !== undefined) out.push(`${w.before}: ${place.before}`);
  if (place?.after !== undefined) out.push(`${w.after}: ${place.after}`);
  if (r.kind !== "speaker") out.push(r.kind === "ui" ? w.uiLength(sourceLength(r)) : w.length(sourceLength(r)));
  if (!forTable && r.prevSource) out.push(r.changed && r.prevText === r.text && r.text !== "" ? w.translatedFrom(r.prevSource) : w.previous(r.prevSource, r.prevText));
  return out;
}

export function translationToCsv(file: TranslationFile, options: ExchangeOptions = {}): string {
  return toCsv([[...EXCHANGE_HEADER], ...selected(file, options).map((e) => [e.key, e.kind, e.speaker, e.source, e.text, e.prevSource, e.prevText, noteLines(e, options, true).join("\n")])]);
}

// ---- XLIFF のインラインの要素 ----

const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
/** 本文の文字を .lim の書き方に戻す（{ } \ を \ で書く。inline.ts の printInline と同じ）。 */
const escLim = (s: string) => s.replace(/[\\{}]/g, (c) => `\\${c}`);

/** 原文の書き方の要素（id → 種類と .lim の書き方。g は囲みの頭 `{b ` など）。 */
type Code = { kind: "x" | "ph" | "g"; code: string };

const X_TYPES: Partial<Record<Inline["kind"], string>> = { br: "lb", click: "x-click", noclick: "x-noclick" };
const PH_TYPES: Partial<Record<Inline["kind"], string>> = { ruby: "x-ruby", value: "x-value", command: "x-command", image: "image" };
function groupType(node: Inline): string {
  if (node.kind === "style") return node.style;
  if (node.kind === "emphasis") return "x-dot";
  return `x-${node.kind}`;
}

/**
 * 本文の書き方を XLIFF の中身にする。codes を渡すと（訳を書くとき）、原文と同じ書き方の要素は同じ id にし、原文に無い囲みは <bpt>/<ept> にする。
 * 読めない書き方の文字（構文の誤り）は、そのまま文字にする。
 */
function encodeInline(text: string, source?: ReadonlyMap<string, Code>): { xml: string; codes: Map<string, Code> } {
  const codes = new Map<string, Code>();
  const { content, errors } = parseInline(text);
  if (errors.some((e) => (e.severity ?? "error") === "error")) return { xml: escXml(text), codes };
  const used = new Set<string>();
  let next = Math.max(0, ...[...(source?.keys() ?? [])].map(Number).filter(Number.isFinite)) + 1;
  const idFor = (code: Code): string | null => {
    if (!source) {
      const id = String(codes.size + 1);
      codes.set(id, code);
      return id;
    }
    for (const [id, c] of source) {
      if (!used.has(id) && c.kind === code.kind && c.code === code.code) {
        used.add(id);
        return id;
      }
    }
    return null;
  };
  const fresh = () => String(next++);
  const walk = (nodes: readonly Inline[]): string =>
    nodes
      .map((n) => {
        if (n.kind === "text") return escXml(escLim(n.text));
        const raw = printInline([n]);
        if (X_TYPES[n.kind]) return `<x id="${idFor({ kind: "x", code: raw }) ?? fresh()}" ctype="${X_TYPES[n.kind]}" equiv-text="${escXml(raw)}"/>`;
        if (PH_TYPES[n.kind]) return `<ph id="${idFor({ kind: "ph", code: raw }) ?? fresh()}" ctype="${PH_TYPES[n.kind]}">${escXml(raw)}</ph>`;
        if ("children" in n) {
          const head = printInline([{ ...n, children: [] } as Inline]).slice(0, -1);
          const id = idFor({ kind: "g", code: head });
          if (id !== null) return `<g id="${id}" ctype="${groupType(n)}">${walk(n.children)}</g>`;
          const own = fresh();
          return `<bpt id="${own}">${escXml(head)}</bpt>${walk(n.children)}<ept id="${own}">}</ept>`;
        }
        return escXml(raw);
      })
      .join("");
  return { xml: walk(content), codes };
}

/** XLIFF の中身（<source>・<target> の中）を .lim の本文に戻す。codes は原文の書き方の要素。読めない要素は errors に。 */
function decodeInline(xml: string, codes: ReadonlyMap<string, Code>): { text: string; errors: string[] } {
  const errors: string[] = [];
  let out = "";
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const attr = (attrs: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)?.slice(1).find((v) => v !== undefined);
  let at = 0;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    out += unescXml(xml.slice(at, m.index));
    at = tag.lastIndex;
    const [, close, name, attrs = "", self] = m;
    const id = attr(attrs, "id");
    switch (name) {
      case "x": {
        const c = id !== undefined ? codes.get(id) : undefined;
        const equiv = attr(attrs, "equiv-text");
        if (c?.kind === "x") out += c.code;
        else if (equiv !== undefined) out += unescXml(equiv);
        else errors.push(`<x id="${id ?? ""}"/> は原文にない要素です`);
        break;
      }
      case "ph":
      case "bpt":
      case "ept":
      case "it": {
        if (close || self) break;
        const end = xml.indexOf(`</${name}>`, at);
        if (end < 0) {
          errors.push(`<${name}> が閉じていません`);
          at = xml.length;
          tag.lastIndex = xml.length;
          break;
        }
        // 中の <sub> などは外して、書き方の文字だけを使う
        out += unescXml(xml.slice(at, end).replace(/<[^>]*>/g, ""));
        at = end + name.length + 3;
        tag.lastIndex = at;
        break;
      }
      case "g": {
        if (self) break;
        if (close) {
          out += "}";
          break;
        }
        const c = id !== undefined ? codes.get(id) : undefined;
        if (c?.kind === "g") out += c.code;
        else errors.push(`<g id="${id ?? ""}"> は原文にない要素です`);
        break;
      }
      // 翻訳のツールが付ける区切り（中身はそのまま）
      case "mrk":
        break;
      default:
        errors.push(`<${close}${name}> は読めない要素です`);
    }
  }
  out += unescXml(xml.slice(at));
  return { text: out, errors };
}

export function translationToXliff(file: TranslationFile, sourceLanguage: string, options: ExchangeOptions = {}): string {
  const units = selected(file, options).map((e) => {
    const note = noteLines(e, options, false).join("\n");
    const source = markup(e.kind) ? encodeInline(e.source) : { xml: escXml(e.source), codes: new Map<string, Code>() };
    const target = e.text === "" ? "" : markup(e.kind) ? encodeInline(e.text, source.codes).xml : escXml(e.text);
    const state = e.text === "" ? ' state="needs-translation"' : e.changed && e.context === undefined ? ' state="needs-review-translation"' : "";
    return `      <trans-unit id="${escXml(e.key)}" xml:space="preserve">\n        <source>${source.xml}</source>\n        <target${state}>${target}</target>\n        <note>${escXml(note)}</note>\n      </trans-unit>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">\n  <file original="liminalia" source-language="${escXml(sourceLanguage)}" target-language="${escXml(file.language)}" datatype="plaintext">\n    <body>\n${units.join("\n")}\n    </body>\n  </file>\n</xliff>\n`;
}

// ---- 読み戻し ----

/** 取り込む訳の位置。表の何行目か（見出しを 1 行目とする。表計算のアプリの行の番号）、XLIFF の何行目か、並び（applyTranslationEntries）の何番目か（0 始まり）。 */
export type ExchangeAt = { row: number } | { line: number } | { index: number };

/** 読んだ表の一行。XLIFF は <source>・<target> の中身のまま（読み戻すときに原文の書き方の要素で .lim に戻す）。source が null なら原文を確かめない。 */
interface TableRow {
  source: string | null;
  text: string;
  at: ExchangeAt;
  xliff: boolean;
}

/** 表か XLIFF から読んだ訳（鍵 → 原文と訳と位置）。 */
function readTable(text: string): Map<string, TableRow> {
  const out = new Map<string, TableRow>();
  if (/^\s*(?:<\?xml|<xliff)/.test(text)) {
    let at = 0;
    let line = 1;
    for (const m of text.matchAll(/<trans-unit\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/trans-unit>/g)) {
      const source = /<source[^>]*>([\s\S]*?)<\/source>/.exec(m[2]!)?.[1] ?? "";
      const target = /<target[^>]*>([\s\S]*?)<\/target>/.exec(m[2]!)?.[1] ?? "";
      for (; at < m.index; at++) if (text[at] === "\n") line++;
      out.set(unescXml(m[1]!), { source, text: target, at: { line }, xliff: true });
    }
    return out;
  }
  const [head, ...rows] = parseCsv(text.replace(/^﻿/, ""));
  const col = (name: string) => head?.indexOf(name) ?? -1;
  const [k, s, t] = [col("key"), col("source"), col("translation")];
  if (k < 0 || s < 0 || t < 0) throw new Error("表の 1 行目に key、source、translation の列がありません");
  rows.forEach((r, i) => {
    if (r[k]) out.set(r[k]!, { source: r[s] ?? "", text: r[t] ?? "", at: { row: i + 2 }, xliff: false });
  });
  return out;
}

/** 取り込まなかった訳と、取り込んだが確かめてほしい訳。at は表の行（row）か XLIFF の行（line）か並びの番号（index）、column は訳の中の何文字目か。 */
export interface ExchangeRejected {
  key: string;
  at: ExchangeAt;
  column?: number;
  message: string;
}

export interface ExchangeResult {
  file: TranslationFile;
  applied: number;
  /** 原文が今と違う（書き出したあとで台本が変わった）ので書かなかった行の数と鍵。 */
  changedSource: number;
  changedKeys: string[];
  /** 今の訳のファイルに無い鍵。 */
  unknown: number;
  /** 書き方が読めないので書かなかった訳。 */
  rejected: ExchangeRejected[];
  /** 書いたが、原文の本文中のコマンド（{@voice …} など）が抜けている訳。 */
  warnings: ExchangeRejected[];
}

/** 本文の中の命令の名前。 */
function commandNames(content: readonly Inline[], out: string[] = []): string[] {
  for (const n of content) {
    if (n.kind === "command") out.push(n.name);
    else if ("children" in n) commandNames(n.children, out);
  }
  return out;
}

/**
 * 表か XLIFF に書き込んだ訳を、訳のファイルに書き戻す。鍵で引き、原文が今と違う行（台本が変わった）は書かずに数え、鍵を返す。
 * 訳が空の行は書かない（今の訳を消さない）。本文の行と選択肢の訳は書き方を確かめ、読めない訳は書かずに位置と理由を返す。
 * 訳し直した項目の translatedFrom と previous は消す。
 */
export function applyTranslationTable(file: TranslationFile, text: string): ExchangeResult {
  return applyRows(file, readTable(text));
}

/**
 * 鍵ごとの訳を書く（lim mcp の write_translation）。鍵は表と同じ（本文の行と選択肢は訳のファイルの鍵、場面ごとの訳は 鍵#場面、
 * 話者名は speaker:名前、システム画面の文言は ui:鍵）。source を渡せば、今の原文と違うときは書かない（changedKeys）。
 * 書き方の確かめと、訳し直した項目の印の消し方は applyTranslationTable と同じ。at は並びの番号。
 */
export function applyTranslationEntries(file: TranslationFile, items: readonly { key: string; text: string; source?: string }[]): ExchangeResult {
  const rows = new Map<string, TableRow>();
  items.forEach((x, index) => rows.set(x.key, { source: x.source ?? null, text: x.text, at: { index }, xliff: false }));
  return applyRows(file, rows);
}

function applyRows(file: TranslationFile, table: ReadonlyMap<string, TableRow>): ExchangeResult {
  const next: TranslationFile = structuredClone(file);
  const r: ExchangeResult = { file: next, applied: 0, changedSource: 0, changedKeys: [], unknown: 0, rejected: [], warnings: [] };
  const changed = (key: string) => {
    r.changedSource++;
    r.changedKeys.push(key);
  };
  /** 読んだ文字（XLIFF は要素を戻す）。読めなければ null（rejected に入れる）。 */
  const read = (key: string, row: TableRow, xml: string, codes: ReadonlyMap<string, Code>): string | null => {
    if (!row.xliff) return xml;
    const d = decodeInline(xml, codes);
    if (d.errors.length > 0) {
      r.rejected.push({ key, at: row.at, message: d.errors.join("、") });
      return null;
    }
    return d.text;
  };
  for (const [key, row] of table) {
    if (row.text === "") continue;
    if (key.startsWith("speaker:")) {
      const name = key.slice("speaker:".length);
      if (!next.speakers || !(name in next.speakers)) {
        r.unknown++;
        continue;
      }
      const value = read(key, row, row.text, new Map());
      if (value === null || value === "") continue;
      if (next.speakers[name] !== value) r.applied++;
      next.speakers[name] = value;
      continue;
    }
    if (key.startsWith("ui:")) {
      const name = key.slice("ui:".length);
      const now = next.ui?.[name];
      if (!next.ui || now === undefined) {
        r.unknown++;
        continue;
      }
      const source = row.source === null ? null : read(key, row, row.source, new Map());
      const value = read(key, row, row.text, new Map());
      if ((row.source !== null && source === null) || value === null || value === "") continue;
      if (source !== null && typeof now === "object" && now && now.source !== source) {
        changed(key);
        continue;
      }
      if (typeof now === "string") {
        if (now !== value) r.applied++;
        next.ui[name] = value;
      } else {
        if (now.text !== value || now.translatedFrom !== undefined) r.applied++;
        const entry: UiTranslation = { source: now.source, text: value };
        next.ui[name] = entry;
      }
      continue;
    }
    // 場面ごとの訳（鍵#場面）
    const hash = key.lastIndexOf("#");
    const base = hash >= 0 ? key.slice(0, hash) : key;
    const context = hash >= 0 ? key.slice(hash + 1) : null;
    const entry = next.lines?.[base];
    if (!entry || (context !== null && !(context in (entry.contexts ?? {})))) {
      r.unknown++;
      continue;
    }
    const kind = translationKeyKind(base);
    const isMarkup = kind === "line" || kind === "option";
    const codes = isMarkup && row.xliff ? encodeInline(entry.source).codes : new Map<string, Code>();
    if (row.source !== null) {
      const source = read(key, row, row.source, codes);
      if (source === null) {
        r.rejected.pop();
        changed(key);
        continue;
      }
      if (entry.source !== source) {
        changed(key);
        continue;
      }
    }
    const value = read(key, row, row.text, codes);
    if (value === null || value === "") continue;
    if (isMarkup) {
      // .lim の本文として読めるか（読めない訳は、遊ぶときに原文を出すことになるので書かない）
      const { content, errors } = parseInline(value);
      const bad = errors.find((e) => (e.severity ?? "error") === "error");
      if (bad) {
        r.rejected.push({ key, at: row.at, column: [...value.slice(0, bad.offset)].length + 1, message: bad.message });
        continue;
      }
      const have = commandNames(content);
      const lost = [...new Set(commandNames(parseInline(entry.source).content).filter((n) => !have.includes(n)))];
      if (lost.length > 0) r.warnings.push({ key, at: row.at, message: `原文の本文中のコマンド ${lost.map((n) => `@${n}`).join(" ")} がありません` });
    }
    if (context !== null) {
      if (entry.contexts![context] !== value) r.applied++;
      entry.contexts![context] = value;
      continue;
    }
    if (entry.text !== value || entry.translatedFrom !== undefined) r.applied++;
    entry.text = value;
    delete entry.previous;
    delete entry.translatedFrom;
  }
  return r;
}

/** 訳の見積もりのための文字数（原文の文字数。訳がまだのものと全体）。 */
export function translationCount(file: TranslationFile): { lines: number; chars: number; untranslatedLines: number; untranslatedChars: number } {
  let lines = 0;
  let chars = 0;
  let untranslatedLines = 0;
  let untranslatedChars = 0;
  for (const e of entries(file)) {
    // 場面ごとの訳は書かなくてもよいので数えない
    if (e.context !== undefined) continue;
    const n = [...e.source].length;
    lines++;
    chars += n;
    if (e.text === "") {
      untranslatedLines++;
      untranslatedChars += n;
    }
  }
  return { lines, chars, untranslatedLines, untranslatedChars };
}
