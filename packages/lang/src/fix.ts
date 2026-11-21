import type { DiagnosticFix, ReplaceLinesFix } from "./ast.ts";
import { parseArgs, printLiteral } from "./args.ts";

/** 行の中身を空白を一つにそろえたもの（delete-line の text と比べる）。 */
export const squeezeLine = (line: string) => line.trim().replace(/\s+/g, " ");

/**
 * 直し方を一行に当てる。delete-line は行ごと消す（remove）。replace は置き換えた行と、置き換えた所（at・length は元の行の位置）。
 * 書いたあとに中身が変わっていて当てられなければ null。column は診断の桁（1 から）。
 * column があれば、診断の指す所の find にだけ当てる（findAt）。同じ行のほかの所にある同じ字面には当てない（無ければ null）。
 */
export function applyFix(line: string, fix: DiagnosticFix, column?: number): { remove: true } | { remove: false; text: string; at: number; length: number } | null {
  if (fix.kind === "delete-line") return squeezeLine(line) === fix.text ? { remove: true } : null;
  // 何行かにまたがる直し方は applyLinesFix で当てる
  if (fix.kind === "replace-lines") return null;
  if (fix.find === "") return null;
  const at = column !== undefined ? findAt(line, fix.find, column) : line.indexOf(fix.find);
  if (at < 0) return null;
  return { remove: false, text: line.slice(0, at) + fix.with + line.slice(at + fix.find.length), at, length: fix.find.length };
}

/**
 * 診断の桁（column。1 から）が指す所の find の位置（無ければ -1）。find が桁の字を含むか、
 * 桁から始まる一つの語（"…" と (…) の外の空白か } まで。引数や命令の名前）の中で始まるもの（頭の空白は数えない。" 1s" の " "）だけを選ぶ。
 * 後ろの別の命令の同じ字面（`{@flash fade=1s}と{@bg x fade=1s}`）には当てない。
 */
export function findAt(line: string, find: string, column: number): number {
  const target = column - 1;
  const lead = find.length - find.trimStart().length;
  const end = wordEnd(line, target);
  for (let s = line.indexOf(find); s >= 0; s = line.indexOf(find, s + 1)) {
    const head = s + lead;
    if (s <= target && target < s + find.length) return s;
    if (head >= target && head < end) return s;
  }
  return -1;
}

/** line の start から始まる語の終わり（"…" と (…) の外の空白か } の位置）。 */
function wordEnd(line: string, start: number): number {
  let i = Math.max(0, start);
  let quoted = false;
  let depth = 0;
  while (i < line.length && (quoted || depth > 0 || (line[i] !== " " && line[i] !== "\t" && line[i] !== "}"))) {
    if (quoted && line[i] === "\\") i++;
    else if (line[i] === '"') quoted = !quoted;
    else if (!quoted && line[i] === "(") depth++;
    else if (!quoted && line[i] === ")") depth--;
    i++;
  }
  return Math.max(i, start + 1);
}

/** 命令の行の形（名前と、引数を読んで書き直したもの。空白や "…"、時間の書き方の違いをそろえる）。命令の行でなければ null。 */
export function commandShape(line: string): string | null {
  const m = /^@([a-z][a-z0-9-]*)(?:[ \t]+(.*))?$/.exec(line.trim());
  if (!m) return null;
  const { args, errors } = parseArgs(m[2] ?? "", 1);
  if (errors.some((e) => e.severity !== "warning")) return null;
  return [`@${m[1]}`, ...args.map((a) => `${a.key === null ? "" : `${a.key}=`}${printLiteral(a.value)}`)].join(" ");
}

/**
 * 何行かにまたがる直し方（replace-lines）を、行の並び rows の index 行目（0 から）から当てる。
 * 置き換える行の数（count）と、置き換えた一行（字下げは最初の行のもの）。書いたあとに行が変わっていて当てられなければ null。
 */
export function applyLinesFix(rows: readonly string[], index: number, fix: ReplaceLinesFix): { count: number; text: string } | null {
  if (index < 0 || index + fix.lines.length > rows.length) return null;
  for (let k = 0; k < fix.lines.length; k++) if (commandShape(rows[index + k]!) !== fix.lines[k]) return null;
  const indent = /^[ \t]*/.exec(rows[index]!)![0];
  return { count: fix.lines.length, text: indent + fix.with };
}
