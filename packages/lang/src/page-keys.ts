import type { Script, Statement } from "./ast.ts";
import { printInline } from "./inline.ts";
import { hash } from "./text-hash.ts";

/**
 * 本文のページ（台詞と地の文）の鍵。既読を覚えるのに使う（遊ぶ側の既読はファイルごとにこの鍵の集まりで持つ）。
 *
 * 行の番号で覚えると、シナリオを直して行がずれたときに、前の行の既読が新しく足した行に付いてしまう（既読スキップで飛ばされる）。
 * 鍵は、そのページの話者と原文に、一つ前のページの話者と原文を添えて作る。行を足しても動かしても、ラベルの名前を変えても変わらない。
 * - 新しく足したページは、同じ文がほかにあっても前のページが違うので、新しい鍵になる（未読のまま）
 * - 足したページのすぐ後のページと、書き換えたページのすぐ後のページも、前のページが変わるので未読になる
 * - 前のページまで同じ組がファイルに二つ以上あるときは、二つ目から何度目かを添える（-2、-3 …）
 *
 * 順番は書いた順（@if の枝と @define の中も、書いてある位置で数える）。値は行の番号 → 鍵。
 */
export function pageKeys(script: Script): Map<number, string> {
  const out = new Map<number, string>();
  const seen = new Map<string, number>();
  let previous = "";
  const visit = (body: readonly Statement[]) => {
    for (const s of body) {
      if (s.kind === "say" || s.kind === "prose") {
        const own = `${s.kind === "say" ? s.speaker : ""}\u0000${printInline(s.content)}`;
        const base = `p${hash(`${own}\u0000${previous}`)}`;
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        out.set(s.line, count === 1 ? base : `${base}-${count}`);
        previous = own;
      } else if (s.kind === "if") for (const b of s.branches) visit(b.body);
      else if (s.kind === "define") visit(s.body);
    }
  };
  visit(script.body);
  return out;
}
