import type { Step } from "./file-undo.ts";
import { StudioError } from "./workspace.ts";

/**
 * いくつものファイルを書き換える操作（名前の変更・シーンの移動）を、途中で書けなくなったら元へ戻すための手順の控え。
 * 書いたらすぐ、その書き込みを元に戻す手順を remember で控え、失敗したら新しい順に行う。
 */

/**
 * 書き終えたものを元に戻す手順を控える。name は戻せなかったときに書き手に挙げる名前。
 * redo（やり直し方と、今があと・前のままかの確かめ方）も渡すと、操作が終わったあとも ⌘Z で戻せる（./file-undo.ts の控え）。
 * 一つでも redo の無い手順があれば、その操作は ⌘Z では戻せない。
 */
export type Remember = (name: string, undo: () => void, redo?: Redo) => void;

/** ⌘Z で戻すために、元に戻す手順に添えるもの。 */
export type Redo = Omit<Step, "name" | "undo">;

/** 書き終えたものを新しい順に元へ戻し、書き手に出す文を返す（戻せなかったものは名前を挙げる）。 */
export function rollback(undo: readonly { name: string; run: () => void }[], head = "シーンの名前を変更できませんでした。.liminalia やシナリオのフォルダに書き込めるか確認してください。"): string {
  const stuck: string[] = [];
  for (const u of [...undo].reverse()) {
    try {
      u.run();
    } catch (e) {
      console.error(e);
      stuck.push(u.name);
    }
  }
  if (stuck.length === 0) return `${head}書き換えた分は元に戻しました`;
  return `${head}次のものは元に戻せなかったので、変更履歴などから確認してください: ${stuck.join("、")}`;
}

/**
 * work を行い、途中で投げたら控えた手順で元に戻してから失敗を返す（何も書く前に投げた StudioError は、理由をそのまま返す）。
 * 書いたあとに投げた StudioError の理由は、元に戻したことを伝える文の次の行に添える。
 */
export function withRollback<T>(head: string, work: (remember: Remember) => T, keep?: (steps: Step[] | null) => void): T {
  const undo: { name: string; run: () => void; redo?: Redo }[] = [];
  try {
    const out = work((name, run, redo) => void undo.push({ name, run, ...(redo ? { redo } : {}) }));
    // 終わったら、⌘Z で戻せる形の手順（すべてにやり直し方があるときだけ）を渡す
    keep?.(undo.every((u) => u.redo) ? undo.map((u) => ({ name: u.name, undo: u.run, ...u.redo! })) : null);
    return out;
  } catch (e) {
    if (undo.length === 0 && e instanceof StudioError) throw e;
    console.error(e);
    // 理由が分かるもの（ほかで変更されていた・名前が重なったなど）は次の行に添える
    throw new StudioError(409, rollback(undo, head) + (e instanceof StudioError ? `\n${e.message}` : ""));
  }
}
