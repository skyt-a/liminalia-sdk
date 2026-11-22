/**
 * lim のコマンドの英語の出力（--lang en）で共に使う小さな部品。
 */

/** 数と名詞。1 なら単数、ほかは複数（docs/design/wording.md の英語の決まり。1 file、2 files）。 */
export const countEn = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
