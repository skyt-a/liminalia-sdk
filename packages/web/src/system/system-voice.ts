import { parseExpr, type UiVoiceEntry } from "@liminalia/lang";
import { evaluate, truthy, type Scope } from "@liminalia/runtime";

/**
 * システムボイス（ui.systemVoice）の候補から、鳴らすファイルを一つ選ぶ。
 * - if（全セーブ共通の変数の式）が偽のものは除く。式が読めなければ除く
 * - character（遊ぶ人がコンフィグで選んだ担当。"" はすべて、"off" は鳴らさない）に合わないものは除く（担当の無い候補は誰でも鳴らす）
 * - 残りから random で一つ
 */
export function pickSystemVoice(list: readonly UiVoiceEntry[] | undefined, character: string, system: Scope, random: () => number = Math.random): string | null {
  if (!list?.length || character === "off") return null;
  const ok = list
    .map((e) => (typeof e === "string" ? { file: e } : e))
    .filter((e) => (character === "" || !e.character || e.character === character) && systemCondition(e.if, system));
  if (ok.length === 0) return null;
  return ok[Math.min(ok.length - 1, Math.floor(random() * ok.length))]!.file;
}

/** 全セーブ共通の変数（system.…）だけで決まる条件の式。無ければ真、読めなければ偽。 */
export function systemCondition(condition: string | undefined, system: Scope): boolean {
  if (!condition) return true;
  try {
    return truthy(evaluate(parseExpr(condition), { lookup: (name) => (name === "system" ? system : null), random: Math.random }));
  } catch {
    return false;
  }
}

/** コンフィグで選べる担当のキャラクター（候補に出てくる順）。 */
export function systemVoiceCharacters(entries: readonly { character?: string }[]): string[] {
  return [...new Set(entries.flatMap((e) => (e.character ? [e.character] : [])))];
}
