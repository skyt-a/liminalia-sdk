import { forwardFunction } from "./host.ts";
import type * as Ks from "@liminalia/ks-import";

/**
 * TyranoScript からの取り込み（作品のプラグインの "./import"）の約束。設定の型はここにあり、
 * castFromTatieSettings は取り込みの実装を呼ぶ（lim import の中で動く）。
 */

/** Tyrano Tatie と同じ形の設定を、キャラクターの定義にする。 */
export const castFromTatieSettings = forwardFunction<typeof Ks.castFromTatieSettings>("import", "castFromTatieSettings");

export type {
  AfterImportContext,
  AfterImportResult,
  ConvertOptions,
  ImportOptions,
  ImportReport,
  TagConversion,
  TagMapping,
  TagMappingContext,
  TagProfile,
  TatieSettings,
  TyranoImportProfile,
  WriteCastContext,
} from "@liminalia/ks-import";
