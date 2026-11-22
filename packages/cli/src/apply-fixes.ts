import { renameSync, writeFileSync } from "node:fs";
import { applyFix, applyLinesFix, type Diagnostic } from "@liminalia/lang";
import { countEn } from "./english.ts";

/**
 * 診断に付いた機械で当てられる直し方（fix。delete-line、replace、replace-lines）を、台本の中身にまとめて当てる（lim check --fix と MCP の apply_fixes）。
 * 下の行から当てる（行を消しても上の行の番号が変わらない）。桁のある replace は同じ行に重ならなければ右から順にいくつでも当て
 * （左の桁は変わらない）、ほかの直し方は行ごとに一つ。重なる直し方は飛ばして left に数える（もう一度流すと当たる）。
 * 書いたあとに中身が変わっていて当てられないものは飛ばす。行の終わりの \r（CRLF のファイル）はそのまま残す。
 */
export function applyFixesToText(text: string, diagnostics: readonly Diagnostic[]): { text: string; applied: (Diagnostic & { result: string | null })[]; left: number } {
  const rows = text.split("\n");
  /** 当てた診断と、当てたあとの行（行を消したなら null）。 */
  const applied: (Diagnostic & { result: string | null })[] = [];
  /** 当てた行（元の番号。1 から）→ 行ごとの直し方を当てたなら "line"、桁のある replace だけなら当てた所の一番左の位置。 */
  const touched = new Map<number, number | "line">();
  let left = 0;
  const ordered = [...diagnostics].filter((x) => x.fix).sort((a, b) => b.line - a.line || (b.column ?? 0) - (a.column ?? 0));
  for (const d of ordered) {
    const fix = d.fix!;
    const index = d.line - 1;
    if (fix.kind === "replace-lines") {
      const span = fix.lines.length;
      if ([...Array(span).keys()].some((k) => touched.has(d.line + k))) {
        left++;
        continue;
      }
      const bare = rows.slice(index, index + span).map((r) => r.replace(/\r$/, ""));
      const r = applyLinesFix(bare, 0, fix);
      if (!r) continue;
      const cr = rows[index]!.endsWith("\r") ? "\r" : "";
      rows.splice(index, r.count, r.text + cr);
      for (let k = 0; k < span; k++) touched.set(d.line + k, "line");
      applied.push({ ...d, result: r.text });
      continue;
    }
    const row = rows[index];
    if (row === undefined) continue;
    const before = touched.get(d.line);
    // 桁のある replace だけが、同じ行のほかの直し方の左に重ねて当てられる
    const partial = fix.kind === "replace" && d.column !== undefined;
    if (before === "line" || (before !== undefined && !partial)) {
      left++;
      continue;
    }
    const cr = row.endsWith("\r") ? "\r" : "";
    const r = applyFix(cr ? row.slice(0, -1) : row, fix, d.column);
    // この流しで書き換えた所に当たらなくなったものも、もう一度流すと当たる
    if (!r) {
      if (before !== undefined) left++;
      continue;
    }
    if (!r.remove && before !== undefined && r.at + r.length > before) {
      left++;
      continue;
    }
    touched.set(d.line, partial && !r.remove ? r.at : "line");
    if (r.remove) rows.splice(index, 1);
    else rows[index] = r.text + cr;
    applied.push({ ...d, result: r.remove ? null : r.text });
  }
  return { text: rows.join("\n"), applied: applied.reverse(), left };
}

/** 当てた直し方（ファイルは拡張子付きの台本の名前）。 */
export interface FixedPlace {
  file: string;
  line: number;
  code: string;
}

/**
 * 作品の台本（files: 名前 → 中身）に、codes の診断の直し方を当てて書く（lim check --fix）。UTF-8 で読めない台本（encodings）は書かない。
 * paths は名前 → ファイル。当てたものを返す。
 */
export function applyFixesToFiles(files: ReadonlyMap<string, { text: string }>, paths: ReadonlyMap<string, string>, encodings: ReadonlyMap<string, string>, diagnostics: readonly Diagnostic[], codes: ReadonlySet<string>): FixedPlace[] & { left?: number } {
  const fixed: FixedPlace[] & { left?: number } = [];
  let left = 0;
  for (const [name, { text }] of files) {
    const path = paths.get(name);
    if (!path || encodings.has(name)) continue;
    const r = applyFixesToText(text, diagnostics.filter((d) => d.file === name && codes.has(d.code)));
    left += r.left;
    if (r.applied.length === 0) continue;
    writeFileSync(`${path}.tmp`, r.text);
    renameSync(`${path}.tmp`, path);
    for (const d of r.applied) fixed.push({ file: `${name}.lim`, line: d.line, code: d.code });
  }
  if (left > 0) fixed.left = left;
  return fixed;
}

/** 当てた直し方を出す（lim check --fix。このあとに直したあとの検査を出す）。left は同じ所に重なって当てなかった直し方の数。 */
export function printFixed(fixed: readonly FixedPlace[] & { left?: number }, codes: readonly string[], language: string): void {
  const en = language === "en";
  if (fixed.left) console.log(en ? `${countEn(fixed.left, "fix", "fixes")} overlapped another fix in the same place and weren't applied. Run lim check --fix again to apply them` : `同じ所に重なる直し方が ${fixed.left} 件あり、当てませんでした。もう一度 lim check --fix で当てます`);
  if (fixed.length === 0) {
    console.log(en ? `No fixes to apply for ${codes.join(", ")}` : `${codes.join("、")} の当てられる直し方はありませんでした`);
    return;
  }
  for (const f of fixed) console.log(en ? `Fixed: ${f.file}:${f.line} [${f.code}]` : `直しました: ${f.file}:${f.line} [${f.code}]`);
  console.log(en ? `Applied ${countEn(fixed.length, "fix", "fixes")}. Checking again:\n` : `${fixed.length} か所を直しました。直したあとの検査:\n`);
}
