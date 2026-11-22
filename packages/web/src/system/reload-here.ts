import { printInline, textSimilarity } from "@liminalia/lang";
import type { Program } from "@liminalia/runtime";

const PAGE_TEXT_MATCH_THRESHOLD = 0.6;

/**
 * テストプレイの「この場所から読み直す」（default.ts の reloadHere）で、直したあとの台本のどの行が今のページにあたるかを求める。
 *
 * 実行器はロードのとき、今のページの文の鍵が同じ本文を探し、無ければ元の行にいちばん近い本文を選ぶ（Runtime の relocate）。
 * 今のページの文を直したうえで、その上に行を足した・消したときは、いちばん近い本文が別のページになることがある。そこで、
 * 前後の変わっていないページに囲まれた範囲で、話者が同じ原文に似たページを探す。見つからなければ、前の変わっていないページから数え、無ければ後ろから数える。
 *
 * line は今のページの行（直す前）。求められなければ null。
 */
export function relocatedLine(old: Program, next: Program, line: number): number | null {
  const before = [...old.pageKeys].sort((a, b) => a[0] - b[0]);
  const after = [...next.pageKeys].sort((a, b) => a[0] - b[0]);
  const here = before.findIndex(([l]) => l === line);
  if (here < 0 || after.length === 0) return null;
  /** 直したあとに一つだけある鍵の、直したあとの並びの位置（無い・いくつもあれば -1）。 */
  const counts = new Map<string, number>();
  for (const [, key] of after) counts.set(key, (counts.get(key) ?? 0) + 1);
  const position = (key: string) => (counts.get(key) === 1 ? after.findIndex(([, k]) => k === key) : -1);
  // 今のページの文がそのまま一つだけあれば、その行
  const same = position(before[here]![1]);
  if (same >= 0) return after[same]![0];

  let previous: { index: number; position: number } | null = null;
  for (let i = here - 1; i >= 0; i--) {
    const at = position(before[i]![1]);
    if (at >= 0) {
      previous = { index: i, position: at };
      break;
    }
  }
  let following: { index: number; position: number } | null = null;
  for (let i = here + 1; i < before.length; i++) {
    const at = position(before[i]![1]);
    if (at >= 0) {
      following = { index: i, position: at };
      break;
    }
  }

  let start = 0;
  let end = after.length;
  let bounded = false;
  if (previous && following) {
    if (previous.position < following.position) {
      start = previous.position + 1;
      end = following.position;
      bounded = true;
    }
  } else if (previous) {
    start = previous.position + 1;
    bounded = true;
  } else if (following) {
    end = following.position;
    bounded = true;
  }

  const oldText = pageTexts(old).get(line);
  if (bounded && start < end && oldText !== undefined) {
    const nextTexts = pageTexts(next);
    let bestLine: number | null = null;
    let best = PAGE_TEXT_MATCH_THRESHOLD;
    let tied = false;
    for (const [candidateLine] of after.slice(start, end)) {
      const candidate = nextTexts.get(candidateLine);
      if (!candidate || candidate.speaker !== oldText.speaker) continue;
      const score = textSimilarity(oldText.content, candidate.content);
      if (score > best) {
        best = score;
        bestLine = candidateLine;
        tied = false;
      } else if (score === best) tied = true;
    }
    if (bestLine !== null && !tied) return bestLine;
  }

  // 原文の類似で見つからなければ、前の変わっていないページから数える
  if (previous) {
    const target = previous.position + (here - previous.index);
    return target < after.length ? after[target]![0] : null;
  }
  // 前に手がかりが無ければ、後ろの変わっていないページから数える
  if (following) {
    const target = following.position - (following.index - here);
    return target >= 0 ? after[target]![0] : null;
  }
  return null;
}

function pageTexts(program: Program): Map<number, { speaker: string | null; content: string }> {
  const out = new Map<number, { speaker: string | null; content: string }>();
  for (const unit of [program.main, ...program.defines.values()]) {
    for (const ins of unit.instructions) {
      if (ins.op === "say") out.set(ins.line, { speaker: ins.speaker ?? null, content: printInline(ins.content) });
    }
  }
  return out;
}
