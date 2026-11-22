import type { Registry } from "@liminalia/lang";
import type { TagProfile } from "./convert.ts";
import type { AfterImportResult, TyranoImportProfile } from "./import.ts";
import { toProfile } from "./mapping.ts";

/**
 * 複数の取り込み設定（組み込みの標準の変換表と、プラグインごとの "./import"）を一つにする。
 * 並べた順に重ね、同じタグ・同じ命令は後のものが勝つ。[iscript] の置き換えは前のものから試す。
 * afterImport と writeCast は並べた順にすべて呼ぶ（cast は後のものが勝ち、notes と書き換えたファイルはつなげる）。
 */
export function combineImportProfiles(profiles: readonly TyranoImportProfile[]): TyranoImportProfile {
  const combined: TyranoImportProfile = {
    skipFiles: profiles.flatMap((p) => p.skipFiles ?? []),
    tags: Object.assign({}, ...profiles.map((p) => p.tags ?? {})) as TagProfile,
    plugins: profiles.flatMap((p) => p.plugins ?? []),
    mappings: profiles.flatMap((p) => p.mappings ?? []),
    scriptRules: profiles.flatMap((p) => p.scriptRules ?? []),
    unsupportedTags: Object.assign({}, ...profiles.map((p) => p.unsupportedTags ?? {})) as Record<string, string>,
    backport: Object.assign({}, ...profiles.map((p) => p.backport ?? {})) as NonNullable<TyranoImportProfile["backport"]>,
  };
  const scriptProfiles = profiles.flatMap((p) => (p.scriptProfile ? [p.scriptProfile] : []));
  if (scriptProfiles.length > 0) {
    combined.scriptProfile = (code) => {
      for (const f of scriptProfiles) {
        const r = f(code);
        if (r) return r;
      }
      return null;
    };
  }
  const afterImports = profiles.flatMap((p) => (p.afterImport ? [p.afterImport.bind(p)] : []));
  if (afterImports.length > 0) {
    combined.afterImport = async (ctx) => {
      const out: AfterImportResult = {};
      for (const f of afterImports) {
        const r = await f(ctx);
        if (!r) continue;
        if (r.cast) out.cast = { ...(out.cast ?? {}), ...r.cast };
        if (r.notes) out.notes = [...(out.notes ?? []), ...r.notes];
      }
      return out;
    };
  }
  const writeCasts = profiles.flatMap((p) => (p.writeCast ? [p.writeCast.bind(p)] : []));
  if (writeCasts.length > 0) {
    combined.writeCast = async (ctx) => {
      const files: string[] = [];
      for (const f of writeCasts) files.push(...((await f(ctx)) ?? []));
      return files;
    };
  }
  return combined;
}

/**
 * 取り込み設定から、変換に渡すタグの変換と [iscript] の置き換えを作る。
 * タグは 変換表（mappings）→ 扱わないタグ（unsupportedTags）→ 直接の変換（tags）の順に重ね、後のものが勝つ。
 * [iscript] は scriptProfile、次に scriptRules を前から試す。
 */
export function resolveImportProfile(profile: TyranoImportProfile, registry: Registry): { tags: TagProfile; scriptProfile: (code: string) => string[] | null } {
  const tags = toProfile(profile.mappings ?? [], registry);
  for (const [tag, reason] of Object.entries(profile.unsupportedTags ?? {})) {
    tags[tag] = () => ({ name: "", positional: [], named: [], unsupported: reason });
  }
  Object.assign(tags, profile.tags ?? {});
  const rules = profile.scriptRules ?? [];
  return {
    tags,
    scriptProfile: (code) => {
      const r = profile.scriptProfile?.(code);
      if (r) return r;
      for (const rule of rules) {
        const out = rule(code);
        if (out) return out;
      }
      return null;
    },
  };
}
