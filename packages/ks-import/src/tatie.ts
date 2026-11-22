import { appearanceKey, DEFAULT_APPEARANCE, DEFAULT_FRAME_SIZE, FRAME_POSITIONS, frameSize, type Cast, type CastAppearance, type CastEntry, type CastFrame, type CastVariant } from "@liminalia/lang";

/**
 * 立ち絵プラグイン Tyrano Tatie（tatie）の設定（`window.TYRANO_TATIE_SETTINGS`）をキャストにする。
 * エンジンのキャストは tatie の設定と同じ形なので、ほぼそのまま移す（storage → image）。
 * 枠は tatie の実行時と同じ値で埋めて書き出す（幅・高さ 632×843、left / center / right は (0, 0)）。
 * 別の名前のグローバルに同じ形の設定を持つ作品のプラグインからも使える。
 */
export function castFromTatieSettings(settings: unknown): Cast {
  const characters = (settings as { characters?: Record<string, unknown> } | null)?.characters ?? {};
  const cast: Cast = {};
  for (const [name, raw] of Object.entries(characters)) {
    const character = (raw ?? {}) as TatieCharacter;
    const entry: CastEntry = { appearances: {} };
    if (character.defaultAppearance) entry.defaultAppearance = character.defaultAppearance;
    for (const [key, appearance] of Object.entries(tatieAppearances(character))) {
      const out: CastAppearance = { variants: {} };
      if (appearance.label) out.label = appearance.label;
      for (const [variantKey, variant] of Object.entries(appearance.variants ?? {})) {
        if (!variant || typeof variant.storage !== "string") continue;
        const v: CastVariant = { image: variant.storage, frame: tatieFrame(variant.frame) };
        if (variant.cacheKey) v.cacheKey = String(variant.cacheKey);
        out.variants[variantKey] = v;
      }
      entry.appearances[key] = out;
    }
    cast[name] = entry;
  }
  return cast;
}

/**
 * キャストを重ねる。同じ名前のキャストは、立ち絵セットごと・差分ごとに over が勝つ
 * （over に無い立ち絵セット・差分は base のものが残る）。defaultAppearance も over にあれば over のもの。
 */
export function mergeCast(base: Cast, over: Cast): Cast {
  const out: Cast = structuredClone(base);
  for (const [name, entry] of Object.entries(over)) {
    const target = out[name];
    if (!target) {
      out[name] = structuredClone(entry);
      continue;
    }
    if (entry.defaultAppearance) target.defaultAppearance = entry.defaultAppearance;
    for (const [key, appearance] of Object.entries(entry.appearances)) {
      const into = (target.appearances[key] ??= { variants: {} });
      if (appearance.label) into.label = appearance.label;
      Object.assign(into.variants, structuredClone(appearance.variants));
    }
  }
  return out;
}

/**
 * キャストの画像と枠を tatie の設定に書き戻す（立ち絵の位置調整画面の保存）。settings はその場で書き換える。
 *
 * - 書くのは差分の storage（= image）と frame だけ。無いキャスト・立ち絵セット・差分は足す
 * - 設定の知らない項目・defaultCharacter・frameReference・立ち絵セットの label・差分の cacheKey は保つ
 *   （足した差分にだけ、キャストの cacheKey を写す）
 * - 枠のない差分（[chara_new] 由来の、画像の実寸で出すもの）は tatie では書けないので書かない（skipped に挙げる）
 * - キャストから消した立ち絵セット・差分・キャストは、設定からは消さない
 * - 旧形式（立ち絵セットのない、差分だけの設定）のキャストは、その一つの立ち絵セットだけを書くならそのまま差分を書き、
 *   ほかの立ち絵セットを足すときは tatie の保存と同じく appearances の形に移す
 */
export function applyCastToTatieSettings(settings: unknown, cast: Cast): { settings: TatieSettings; written: number; skipped: string[] } {
  const out = (settings && typeof settings === "object" ? settings : {}) as TatieSettings;
  out.characters ??= {};
  const skipped: string[] = [];
  let written = 0;
  for (const [name, entry] of Object.entries(cast)) {
    const framed = new Map<string, [string, CastVariant][]>();
    for (const [key, appearance] of Object.entries(entry.appearances ?? {})) {
      const list: [string, CastVariant][] = [];
      for (const [variantKey, variant] of Object.entries(appearance.variants ?? {})) {
        if (variant.frame) list.push([variantKey, variant]);
        else skipped.push(`${name} / ${key} / ${variantKey}`);
      }
      if (list.length > 0) framed.set(key, list);
    }
    if (framed.size === 0) continue;
    const character = (out.characters[name] ??= { defaultAppearance: appearanceKey(entry), appearances: {} });
    if (!character.appearances) {
      const legacy = character.defaultAppearance || DEFAULT_APPEARANCE;
      if ([...framed.keys()].every((key) => key === legacy)) {
        character.variants ??= {};
        for (const [variantKey, variant] of framed.get(legacy)!) writeTatieVariant(character.variants, variantKey, variant);
        written += framed.get(legacy)!.length;
        continue;
      }
      character.appearances = { [legacy]: { label: "標準", variants: character.variants ?? {} } };
      delete character.variants;
    }
    for (const [key, list] of framed) {
      const appearance = (character.appearances[key] ??= entry.appearances[key]?.label ? { label: entry.appearances[key].label, variants: {} } : { variants: {} });
      appearance.variants ??= {};
      for (const [variantKey, variant] of list) writeTatieVariant(appearance.variants, variantKey, variant);
      written += list.length;
    }
  }
  return { settings: out, written, skipped };
}

function writeTatieVariant(variants: Record<string, TatieVariant | undefined>, key: string, variant: CastVariant): void {
  const target = variants[key];
  const frame = variant.frame!;
  const size = frameSize(frame);
  const tatieFrame = { width: size.width, height: size.height, positions: structuredClone(frame.positions ?? {}) };
  if (target) {
    target.storage = variant.image;
    target.frame = { ...target.frame, ...tatieFrame };
    return;
  }
  variants[key] = { storage: variant.image, ...(variant.cacheKey ? { cacheKey: variant.cacheKey } : {}), frame: tatieFrame };
}

// ---- tatie の設定の形 ----

/** tatie の設定（`window.TYRANO_TATIE_SETTINGS`）。知らない項目もそのまま持つ。 */
export interface TatieSettings {
  defaultCharacter?: string;
  characters: Record<string, TatieCharacter>;
  [key: string]: unknown;
}

interface TatieVariant {
  storage?: string;
  cacheKey?: string | number;
  frame?: { width?: unknown; height?: unknown; positions?: Record<string, { left?: unknown; top?: unknown } | undefined>; [key: string]: unknown };
  [key: string]: unknown;
}

interface TatieAppearance {
  label?: string;
  variants?: Record<string, TatieVariant | undefined>;
  [key: string]: unknown;
}

interface TatieCharacter {
  defaultAppearance?: string;
  appearances?: Record<string, TatieAppearance>;
  /** 旧形式（立ち絵セットのない、差分だけの設定）。 */
  variants?: Record<string, TatieVariant | undefined>;
  [key: string]: unknown;
}

/** 立ち絵セット。旧形式は defaultAppearance（無ければ "default"）の一つの立ち絵セットとして読む。 */
function tatieAppearances(character: TatieCharacter): Record<string, TatieAppearance> {
  if (character.appearances) return character.appearances;
  if (character.variants) return { [character.defaultAppearance || DEFAULT_APPEARANCE]: { label: "標準", variants: character.variants } };
  return {};
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : fallback;
}

function tatieFrame(frame: TatieVariant["frame"]): CastFrame {
  const positions: NonNullable<CastFrame["positions"]> = {};
  const source = frame?.positions ?? {};
  for (const key of new Set([...FRAME_POSITIONS, ...Object.keys(source)])) {
    const p = source[key];
    positions[key] = { left: numberOr(p?.left, 0), top: numberOr(p?.top, 0) };
  }
  return { width: numberOr(frame?.width, DEFAULT_FRAME_SIZE.width), height: numberOr(frame?.height, DEFAULT_FRAME_SIZE.height), positions };
}
