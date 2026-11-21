import type { ExtraConfig } from "./extra.ts";

/**
 * 追加の中身・修正（パック）。書き出したゲームの packs/<id>/ に置くと、起動したときに読み込む。
 * - 台本・データ・素材は、同じ名前のものを本体より先に使う（修正の差し替え）。新しい名前のものは足す
 * - extra（CG・回想・音楽・実績・用語集・章）は本体の一覧の後ろに足す
 * - 入っているパックは system.packs（id → 版）で台本から見られる（@if (system.packs.dlc1) など）
 * 作品のフォルダの packs/<id>/pack.json（id・title・version・requires・order・extra）を書き、lim pack が files（中身の一覧）を足して書き出す。
 */
export interface PackManifest {
  id: string;
  title?: string;
  version?: string;
  /** 要る本体の版（liminalia.json の version。違えば読み込まずに知らせる）。 */
  requires?: string;
  /** 読み込む順（小さいものから。同じなら id の順）。後に読んだものが先に読んだものを差し替える。 */
  order?: number;
  extra?: ExtraConfig;
  /**
   * 中身の一覧（lim pack が書く）。scenario は拡張子なしの名前、data は data からのパス、assets は "種類/パス"。
   * cast が true なら cast.json を丸ごと差し替え、lang は差し替える訳の言語（lang/<言語>.json）。
   */
  files?: { scenario: string[]; data: string[]; assets: string[]; cast?: boolean; lang?: string[] };
}

/** パックの extra を本体の extra の後ろに足す（cgAuto・flowchart は本体のまま）。 */
export function mergePackExtra(base: ExtraConfig | undefined, packs: readonly PackManifest[]): ExtraConfig | undefined {
  const lists = ["cg", "replay", "music", "movies", "characters", "achievements", "glossary", "chapters"] as const;
  if (!packs.some((p) => p.extra)) return base;
  const out: ExtraConfig = { ...(base ?? {}) };
  for (const key of lists) {
    const items = [...((base?.[key] as unknown[] | undefined) ?? []), ...packs.flatMap((p) => (p.extra?.[key] as unknown[] | undefined) ?? [])];
    if (items.length > 0) (out as Record<string, unknown>)[key] = items;
  }
  return out;
}

/** 読み込む順に並べる。 */
export function sortPacks<T extends PackManifest>(packs: readonly T[]): T[] {
  return [...packs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}
