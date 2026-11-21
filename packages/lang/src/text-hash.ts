/** 原文から鍵を作る・書き換えの前後を見つけるための小さな道具（訳の鍵・ボイスの番号の固定）。 */

/** 文字列のハッシュ（FNV-1a 32bit の 16 進 8 桁）。 */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 文字の二つ組の重なり（Dice 係数。0〜1）。原文の書き換えの前後を見つけるため。 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let both = 0;
  for (const [g, n] of ga) both += Math.min(n, gb.get(g) ?? 0);
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
  return total === 0 ? 0 : (2 * both) / total;
}
