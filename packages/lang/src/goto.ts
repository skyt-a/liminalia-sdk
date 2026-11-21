import { parseTargetText } from "./args.ts";
import { blockAt, commandSiteAt, indentOf, inlineCommands, namedArgs, optionSite, positionalIndex, tokenAt, type CommandSite } from "./line-syntax.ts";
import type { CommandSpec } from "./registry.ts";

/**
 * ジャンプ先へ移動（VS Code の拡張機能の「定義へ移動」と、Studio の ⌘クリック・F12 が共有する）。
 * 行の中のジャンプ先の字面を見つけ（@jump・@call の最初のパラメータ、target 型のパラメータ（本文の中の {@…} も）、選択肢の `->` の後ろ）、
 * それを書いたファイルから見た場所に解決する（`#ラベル` はそのファイル、`ファイル` はその頭、`ファイル#ラベル`。サブフォルダの `part1/chapter2` も）。
 */

/** 行の中のジャンプ先の字面と、その位置（行の中の 0 始まりの位置。end は含まない）。 */
export interface TargetSite {
  text: string;
  start: number;
  end: number;
}

/** ジャンプ先を解決するのに使う、作品のファイルとラベル（行は 1 始まり）。 */
export interface TargetFiles {
  has(file: string): boolean;
  labels(file: string): readonly { name: string; line: number }[];
}

/** 解決した場所（行は 1 始まり。ラベルの無いジャンプ先はファイルの 1 行目）。 */
export interface TargetPlace {
  file: string;
  line: number;
  label: string | null;
}

type SpecOf = (name: string) => CommandSpec | undefined;

/** 命令の、target 型のパラメータ（@jump・@call は最初のパラメータ）。 */
function commandTargets(site: CommandSite, specOf: SpecOf): TargetSite[] {
  if (!site.inline && (site.name === "jump" || site.name === "call")) {
    const t = site.args[0];
    return t ? [{ text: t.text, start: t.start, end: t.end }] : [];
  }
  const spec = specOf(site.name);
  if (!spec) return [];
  const out: TargetSite[] = [];
  for (const token of site.args) {
    const name = token.key ?? spec.positional[positionalIndex(site.args, token, token.start)];
    if (name === undefined || spec.params[name]?.type.kind !== "target") continue;
    out.push({ text: namedArgs([token], [name]).get(name)!.value, start: token.valueStart, end: token.end });
  }
  return out;
}

/**
 * lines の line 行目（0 始まり）の、offset の位置のジャンプ先。命令の名前の上・ジャンプ先でないところなら null。
 * @jump・@call は、名前より後ろならどこでも最初のパラメータ（VS Code の「定義へ移動」と同じ）。
 */
export function targetSiteAt(lines: readonly string[], line: number, offset: number, specOf: SpecOf): TargetSite | null {
  const text = lines[line] ?? "";
  const block = blockAt(lines, line);
  const site = commandSiteAt(text, offset, block);
  if (site) {
    if (offset <= site.nameEnd) return null;
    if (!site.inline && (site.name === "jump" || site.name === "call")) return commandTargets(site, specOf)[0] ?? null;
    const token = tokenAt(site.args, offset);
    return token ? (commandTargets(site, specOf).find((t) => t.end === token.end) ?? null) : null;
  }
  if (block === "choice") {
    const option = optionSite(text);
    if (option && option.target.text && offset >= option.target.start && offset <= option.target.end) return { text: option.target.text, start: option.target.start, end: option.target.end };
  }
  return null;
}

/** lines の line 行目（0 始まり）にあるジャンプ先すべて（行の命令か選択肢、本文の中の {@…}）。前から順に。 */
export function targetSitesOf(lines: readonly string[], line: number, specOf: SpecOf): TargetSite[] {
  const text = lines[line] ?? "";
  const block = blockAt(lines, line);
  if (block === "script") return [];
  if (block === "choice") {
    const option = optionSite(text);
    return option?.target.text ? [{ text: option.target.text, start: option.target.start, end: option.target.end }] : [];
  }
  const indent = indentOf(text);
  if (text[indent] === "@") {
    const site = commandSiteAt(text, text.length, block);
    return site ? commandTargets(site, specOf) : [];
  }
  if (text[indent] === "#" || text.startsWith("//", indent)) return [];
  return inlineCommands(text).flatMap((s) => commandTargets(s, specOf));
}

/**
 * ジャンプ先の字面（`#ラベル`・`ファイル`・`ファイル#ラベル`）を、fromFile から見た場所にする。
 * 式（`(game.next)`）・無いファイル・無いラベルなら null。
 */
export function resolveTargetText(text: string, fromFile: string, files: TargetFiles): TargetPlace | null {
  const t = parseTargetText(text);
  if (!t) return null;
  const file = t.file ?? fromFile;
  if (!files.has(file)) return null;
  if (t.label === null) return { file, line: 1, label: null };
  const label = files.labels(file).find((l) => l.name === t.label);
  return label ? { file, line: label.line, label: label.name } : null;
}
