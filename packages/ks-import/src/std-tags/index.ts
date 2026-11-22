import type { TyranoImportProfile } from "../import.ts";
import type { TagMapping } from "../mapping.ts";
import { MAPPINGS as anim } from "./anim.ts";
import { MAPPINGS as image } from "./image.ts";
import { MAPPINGS as movie } from "./movie.ts";
import { MAPPINGS as screen, UNSUPPORTED_TAGS } from "./screen.ts";
import { MAPPINGS as text } from "./text.ts";

/**
 * 標準の命令（@liminalia/std）の変換表。TyranoScript・TyranoBuilder に標準である画像・レイヤー・合成・フィルタ・
 * 立ち絵の移動・動画・要素の動き・画面の切り替えと揺れ・レイヤーの文字のタグを、標準の命令にする。
 * 標準の命令はどのプロジェクトにも入るので、lim import はいつもこの表を先頭に重ねる。
 * 命令の仕様は取り込みの registry から引く（このパッケージは @liminalia/std を読まない）。
 */
export const STD_MAPPINGS: readonly TagMapping[] = [...image, ...movie, ...anim, ...screen, ...text];

/** 標準の命令の取り込みでは扱わないタグ（タグ名 → 理由）。 */
export const STD_UNSUPPORTED_TAGS: Readonly<Record<string, string>> = UNSUPPORTED_TAGS;

/** 標準の命令の取り込み設定（combineImportProfiles で先頭に置く）。 */
export const STD_IMPORT: TyranoImportProfile = { mappings: STD_MAPPINGS, unsupportedTags: STD_UNSUPPORTED_TAGS };
