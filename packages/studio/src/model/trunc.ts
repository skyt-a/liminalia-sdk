/**
 * 狭い欄で真ん中を省く名前（ファイル名、素材の名前）の、後ろに残す所。DOM を持たない（dom.ts の middleTruncated が使う）。
 */

/** これより短い名前は分けない（字の数）。 */
const SHORT = 12;
/** 並びに頭のそろった名前が無いときに、後ろに残す字の数（拡張子を含む）。 */
const TAIL = 8;
/** 区別の付く所をこれより長く残さない（字の数。長ければ後ろの TAIL 字にする）。 */
const TAIL_MAX = 16;
/** 頭がそろっているとみなす、共通の頭の長さ（字の数）。 */
const SHARED_MIN = 3;

/** 字の種類（数字、英字、そのほか）。種類の変わり目を語の切れ目にする。 */
const kindOf = (c: string) => (/\d/.test(c) ? "d" : /\p{L}/u.test(c) ? "l" : "o");
const SEPARATOR = /[_\-. /]/;

/** chars の at の前が語の切れ目か（区切りの字の後ろか、字の種類の変わり目）。 */
function boundary(chars: readonly string[], at: number): boolean {
  if (at <= 0 || at >= chars.length) return true;
  return SEPARATOR.test(chars[at - 1]!) || kindOf(chars[at - 1]!) !== kindOf(chars[at]!);
}

/**
 * name を省くときに後ろに残す字の頭の位置（字の数で）。短い名前は null（分けない）。
 * 並び（siblings。同じ欄に並ぶ名前）に頭のそろった名前があれば（episode1_2.lim と episode10_1.lim）、そろった頭の後ろ
 * （語の切れ目まで戻す）から残す。「e…e1_2.lim」のように、頭の語の途中から残して区別の付く所が見づらくならないように。
 * そうでなければ後ろの TAIL 字（chapter_001.lim と chapter_002.lim のように、後ろだけが違う名前が同じ「chapter_00…」にならないように）。
 */
export function truncSplit(name: string, siblings: readonly string[] = []): number | null {
  const chars = [...name];
  if (chars.length <= SHORT) return null;
  const fallback = chars.length - TAIL;
  // 並びの名前ごとに、共通の頭を語の切れ目まで戻した長さ。頭のそろった名前のうち、いちばん短いもの（そろった頭の全体）の後ろから残す
  let shared = Number.POSITIVE_INFINITY;
  for (const s of siblings) {
    if (s === name) continue;
    const other = [...s];
    let n = 0;
    while (n < chars.length - 1 && n < other.length && chars[n] === other[n]) n++;
    while (n > 0 && !boundary(chars, n)) n--;
    if (n >= SHARED_MIN) shared = Math.min(shared, n);
  }
  if (!Number.isFinite(shared) || chars.length - shared > TAIL_MAX) return fallback;
  return shared;
}
