import type { Diagnostic } from "./ast.ts";

/**
 * 書き方の提案の診断（演出や台本の書き方をよくする案。直さなくても作品は止まらず、黙って違う動きにもならない）。
 * 立ち絵のちらつき（chara-reshow、chara-hide-per-line、solo=true にまとめられる全消し chara-solo）、音の抜け（long-silence、redundant-stop、loop-across-files）、
 * 既定値と同じ値（same-as-default）、場面転換にまとめられる塊（scene-change-candidate）、ほかのファイルから入るシーンの初めの背景（scene-start-no-bg）。
 * 制作画面は、チェックのタブの丸に数えず、チェックの画面の「問題」とは別に数える。
 */
export const SUGGESTION_CODES: ReadonlySet<string> = new Set(["chara-reshow", "chara-hide-per-line", "chara-solo", "long-silence", "redundant-stop", "loop-across-files", "same-as-default", "scene-change-candidate", "scene-start-no-bg"]);

/** 書き方の提案か（check.severity でエラーにしたものは提案に数えない）。 */
export function isSuggestion(d: Pick<Diagnostic, "code" | "severity">): boolean {
  return d.severity !== "error" && SUGGESTION_CODES.has(d.code);
}
