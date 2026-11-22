import type { Script, Statement } from "@liminalia/lang";

/** 分岐やマクロを含む、台本中の話者ごとの台詞数。 */
export function scriptSpeakerCounts(script: Script): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  const visit = (body: readonly Statement[]) => {
    for (const s of body) {
      if (s.kind === "say") counts[s.speaker] = (counts[s.speaker] ?? 0) + 1;
      else if (s.kind === "if") for (const branch of s.branches) visit(branch.body);
      else if (s.kind === "define") visit(s.body);
    }
  };
  visit(script.body);
  return counts;
}
