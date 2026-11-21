import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findVariants, mergeVariantDictionaries, textStats, textUnits, type Script, type TextStats, type VariantDictionary, type VariantGroup, type VoiceLock } from "@liminalia/lang";
import type { ProjectConfig } from "./index.ts";

/** 作者の手元だけの表記ゆれの辞書（liminalia.json の stats.variants と同じ形。.liminalia/ は版の管理に入れない）。 */
export const LOCAL_VARIANTS_FILE = ".liminalia/variants.json";

/** 表記ゆれの辞書（liminalia.json の stats.variants に、.liminalia/variants.json を重ねる）。読めないファイルは無いものとする。 */
export function variantDictionary(root: string, config: ProjectConfig): VariantDictionary {
  let local: VariantDictionary | null = null;
  const path = join(root, LOCAL_VARIANTS_FILE);
  if (existsSync(path)) {
    try {
      local = JSON.parse(readFileSync(path, "utf8")) as VariantDictionary;
    } catch {
      // 作品の表記の辞書が読めなければ、エンジンの辞書だけで数える
      local = null;
    }
  }
  return mergeVariantDictionaries(config.stats?.variants, local);
}

export interface ProjectTextReport {
  stats: TextStats;
  variants: VariantGroup[];
}

/** 文字数と表記ゆれの候補（lim stats と Studio のチェックの画面）。scripts はファイル名の順に並べたもの。 */
export function projectTextReport(o: { root: string; config: ProjectConfig; scripts: ReadonlyMap<string, Script>; speakers: readonly string[]; lock: VoiceLock | null }): ProjectTextReport {
  return {
    stats: textStats(o.scripts, o.lock),
    variants: findVariants(textUnits(o.scripts), { speakers: o.speakers, dictionary: variantDictionary(o.root, o.config), glossary: o.config.extra?.glossary ?? [] }),
  };
}
