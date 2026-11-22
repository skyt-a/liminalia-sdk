import { dataTextKey, LANGUAGE_NAMES, lineIdKey, parseInline, projectTextKey, translationKey, type Inline, type TranslationFile } from "@liminalia/lang";
import type { Translator } from "@liminalia/runtime";

/**
 * 訳のファイルから、実行器の訳の口を作る。本文の行と選択肢の訳は使うときに .lim の本文として読み、読んだものは覚えておく。
 * コマンドの文字と作品の設定の文字は、書いたまま使う。場面（context）が渡され、その場面の訳（contexts）があればそちらを使う。
 */
export function createTranslator(file: TranslationFile): Translator {
  /** 訳の文字（場面の訳があればそれ、無ければ場面に分けない訳）。 */
  const textOf = (key: string, context?: string): string | undefined => {
    const entry = file.lines?.[key];
    return (context ? entry?.contexts?.[context] : undefined) || entry?.text;
  };
  const cache = new Map<string, Inline[] | null>();
  const get = (key: string, context?: string): Inline[] | null => {
    const id = context ? `${key}#${context}` : key;
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const text = textOf(key, context);
    let value: Inline[] | null = null;
    if (typeof text === "string" && text !== "") {
      const { content, errors } = parseInline(text);
      if (errors.length > 0) console.warn(`翻訳に構文エラーがあるため、原文を表示します: ${key} ${errors.map((e) => e.message).join(" ")}`);
      else value = content;
    }
    cache.set(id, value);
    return value;
  };
  // 固定の行 ID（#line:ID）のある行は ID の鍵で引き、無ければ原文の鍵（ID を振ったあと、まだ lim i18n で合わせていない訳）
  const byId = (f: string, kind: "line" | "option", source: string, context: string | undefined, id: string | undefined) => (id ? get(lineIdKey(f, kind, id), context) : null) ?? get(translationKey(f, kind, source), context);
  return {
    line: (f, source, context, id) => byId(f, "line", source, context, id),
    option: (f, source, context, id) => byId(f, "option", source, context, id),
    speaker: (name) => file.speakers?.[name] || null,
    arg: (f, source, context) => textOf(translationKey(f, "arg", source), context) || null,
    text: (source) => file.lines?.[projectTextKey(source)]?.text || null,
  };
}

/** 今の言語の訳のファイル（作品のデータの訳す文を引く。原文の言語で遊んでいるときは null）。 */
let dataTranslation: TranslationFile | null = null;

/** 今の言語の訳のファイルを置く（システム画面が言語を替えたときに呼ぶ）。 */
export function setDataTranslation(file: TranslationFile | null): void {
  dataTranslation = file;
}

/**
 * 作品のデータ（data/*.json）の、訳す印の付いた文（d.string の translate）の今の言語の訳。訳が無ければ原文。
 * file は paths.data からの名前（codex.json）。標準の命令の画面（図鑑、調べる画面、地図の選択）とプラグインの描画が、文字を出すたびに読む。
 */
export function dataText(file: string, source: string): string {
  if (!source || !dataTranslation) return source;
  return dataTranslation.lines?.[dataTextKey(file, source)]?.text || source;
}

/**
 * 遊ぶ言語を決める。覚えている言語があればそれ、無ければブラウザの言語に合うもの（"en-US" なら "en"）、
 * それも無ければ原文の言語（先頭）。
 */
export function pickLanguage(languages: readonly string[], saved: string, preferred: readonly string[]): string {
  if (languages.length === 0) return "";
  if (saved && languages.includes(saved)) return saved;
  for (const p of preferred) {
    const exact = languages.find((l) => l.toLowerCase() === p.toLowerCase());
    if (exact) return exact;
    const base = languages.find((l) => l.split("-")[0]!.toLowerCase() === p.split("-")[0]!.toLowerCase());
    if (base) return base;
  }
  return languages[0]!;
}

/** 設定画面に出す言語の名前。 */
export function languageName(language: string): string {
  return LANGUAGE_NAMES[language] ?? language;
}
