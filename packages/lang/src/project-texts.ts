import type { ChapterInfo } from "./chapters.ts";
import type { ExtraConfig } from "./extra.ts";
import type { ItemsConfig } from "./items.ts";
import type { UiConfig } from "./ui.ts";

/**
 * 作品の設定（liminalia.json）に書いた、プレイヤーに見せる文字。多言語の作品では訳のファイルの lines に「作品の設定の文字」として並び
 * （鍵は liminalia.json と原文から作る）、遊んでいる言語の訳に替えて見せる。
 *
 * 対象: 作品の題（title。タイトル画面とページの題）、章（chapters の題・番号・副題）、おまけ（CG・回想・音楽・実績・用語集・章選択・ムービー・立ち絵の鑑賞の題や説明、
 * cgAuto の見出し、フローチャートの場面の題）、持ち物（名前と説明）、ui の章の名前（chapterNames）・注意書き（contentWarning）・
 * 表示の切り替えの名前（contentFilter.label）・操作説明のページ（help.pages）・効果音の字幕（captions.sounds）、エンディングの種類の文言（endingKinds）。
 */
export interface ProjectTextSource {
  title?: string | undefined;
  /** エンディングの種類（種類 → 画面の文言。endings.ts）。 */
  endingKinds?: Readonly<Record<string, string>> | undefined;
  chapters?: readonly ChapterInfo[] | undefined;
  extra?: ExtraConfig | undefined;
  items?: ItemsConfig | undefined;
  ui?: UiConfig | undefined;
}

/** 文字一つ。note はどこに書いたものか（"extra.cg" など。訳す人が見るため）。 */
export type ProjectTextVisitor = (source: string, note: string) => string;

/**
 * 作品の設定の文字を一つずつ fn に渡し、返した文字に置き換えた写しを作る（元は書き換えない。書いていない項目はそのまま）。
 * 文字でないもの・空の文字は渡さない。
 */
export function mapProjectTexts<T extends ProjectTextSource>(config: T, fn: ProjectTextVisitor): T {
  const str = (v: unknown, note: string): unknown => (typeof v === "string" && v.trim() !== "" ? fn(v, note) : v);
  /** 配列の要素（オブジェクト）の、決めた項目だけを置き換える。 */
  const list = <E>(v: readonly E[], note: string, keys: readonly string[], more?: (e: Record<string, unknown>, out: Record<string, unknown>) => void): E[] => {
    if (!Array.isArray(v)) return v as E[];
    return v.map((e) => {
      if (!e || typeof e !== "object") return e;
      const out: Record<string, unknown> = { ...(e as Record<string, unknown>) };
      for (const k of keys) if (k in out) out[k] = str(out[k], note);
      more?.(e as Record<string, unknown>, out);
      return out as E;
    });
  };
  const record = (v: Record<string, string>, note: string): Record<string, string> =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, s]) => [k, str(s, note) as string])) : v;

  const out: T = { ...config };
  if (typeof config.title === "string") out.title = str(config.title, "title") as string;
  if (config.endingKinds && typeof config.endingKinds === "object" && !Array.isArray(config.endingKinds)) out.endingKinds = record({ ...config.endingKinds }, "endingKinds");
  if (Array.isArray(config.chapters)) out.chapters = list(config.chapters, "chapters", ["title", "number", "subtitle"]);
  const extra = config.extra;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    const e: ExtraConfig = { ...extra };
    if (extra.cg) e.cg = list(extra.cg, "extra.cg", ["title", "group", "description"]);
    if (extra.cgAuto && typeof extra.cgAuto === "object" && extra.cgAuto.groups) e.cgAuto = { ...extra.cgAuto, groups: record(extra.cgAuto.groups, "extra.cgAuto") };
    if (extra.replay) e.replay = list(extra.replay, "extra.replay", ["title"]);
    if (extra.music) e.music = list(extra.music, "extra.music", ["title", "artist", "description"]);
    if (extra.achievements) e.achievements = list(extra.achievements, "extra.achievements", ["title", "description"]);
    if (extra.glossary)
      e.glossary = list(extra.glossary, "extra.glossary", ["term", "reading", "description", "group"], (g, o) => {
        if (Array.isArray(g.aliases)) o.aliases = g.aliases.map((a) => str(a, "extra.glossary"));
      });
    if (extra.chapters) e.chapters = list(extra.chapters, "extra.chapters", ["title", "synopsis"]);
    if (extra.movies) e.movies = list(extra.movies, "extra.movies", ["title"]);
    if (extra.characters) e.characters = list(extra.characters, "extra.characters", ["name"]);
    if (extra.flowchart && typeof extra.flowchart === "object" && extra.flowchart.titles) e.flowchart = { ...extra.flowchart, titles: record(extra.flowchart.titles, "extra.flowchart") };
    out.extra = e;
  }
  const items = config.items;
  if (items && typeof items === "object" && !Array.isArray(items)) {
    out.items = Object.fromEntries(
      Object.entries(items).map(([id, item]) => [id, item && typeof item === "object" ? { ...item, name: str(item.name, "items") as string, ...(item.description !== undefined ? { description: str(item.description, "items") as string } : {}) } : item]),
    );
  }
  const ui = config.ui;
  if (ui && typeof ui === "object" && !Array.isArray(ui)) {
    const u: UiConfig = { ...ui };
    if (ui.chapterNames) u.chapterNames = record(ui.chapterNames, "ui.chapterNames");
    if (ui.contentWarning && typeof ui.contentWarning === "object") {
      const w = ui.contentWarning;
      u.contentWarning = { ...w, text: str(w.text, "ui.contentWarning") as string, ...(w.title !== undefined ? { title: str(w.title, "ui.contentWarning") as string } : {}), ...(w.button !== undefined ? { button: str(w.button, "ui.contentWarning") as string } : {}) };
    }
    if (ui.contentFilter && typeof ui.contentFilter === "object" && typeof ui.contentFilter.label === "string") u.contentFilter = { ...ui.contentFilter, label: str(ui.contentFilter.label, "ui.contentFilter") as string };
    if (ui.help && typeof ui.help === "object" && Array.isArray(ui.help.pages)) u.help = { ...ui.help, pages: list(ui.help.pages, "ui.help", ["title", "text"]) };
    if (ui.captions && typeof ui.captions === "object" && ui.captions.sounds) u.captions = { ...ui.captions, sounds: record(ui.captions.sounds, "ui.captions") };
    out.ui = u;
  }
  return out;
}

/** 作品の設定の訳す文字（書いた順。同じ文字は一度だけ。note は最初に見つけた場所）。 */
export function projectTexts(config: ProjectTextSource): { source: string; note: string }[] {
  const seen = new Map<string, string>();
  mapProjectTexts(config, (source, note) => {
    if (!seen.has(source)) seen.set(source, note);
    return source;
  });
  return [...seen].map(([source, note]) => ({ source, note }));
}
