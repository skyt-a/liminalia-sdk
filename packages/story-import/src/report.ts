import { check, parse, type Registry } from "@liminalia/lang";
import type { Outcome } from "./ir.ts";
import type { StoryImportResult } from "./session.ts";

export interface StoryCheck {
  syntaxErrors: string[];
  checkErrors: string[];
}

/**
 * 変換した .lim を読み直して、構文と命令の型を検査する（TyranoScript の取り込みと同じ確かめ）。
 * speakers は台詞として読む話者（今の話者に変換で増えた話者を足したもの）。
 */
export function recheck(r: StoryImportResult, registry: Registry, speakers: readonly string[]): StoryCheck {
  const out: StoryCheck = { syntaxErrors: [], checkErrors: [] };
  const all = [...new Set([...speakers, ...r.speakers])];
  for (const f of r.files) {
    const script = parse(f.text, f.name, { speakers: all });
    for (const d of script.diagnostics) out.syntaxErrors.push(`${f.name}.lim:${d.line} [${d.code}] ${d.message}`);
    for (const d of check(script, { registry })) {
      if (d.severity !== "error") continue;
      out.checkErrors.push(`${f.name}.lim:${d.line} [${d.code}] ${d.message}`);
    }
  }
  return out;
}

/** 取り込みの報告（import-report.md と同じ形の Markdown）。 */
export function storyReport(kind: string, r: StoryImportResult, c: StoryCheck | null): string {
  const lines: string[] = [];
  const all = Object.values(r.totals).reduce((a, b) => a + b, 0) || 1;
  const pct = (n: number) => `${((n / all) * 100).toFixed(2)}%`;
  lines.push(`# 取り込みの報告（${kind}、${r.files.length} ファイル）`, "");
  lines.push(`| 結果 | 件数 | 割合 |`, `|---|---:|---:|`);
  for (const k of ["mapped", "dropped", "generic", "manual"] as Outcome[]) lines.push(`| ${k} | ${r.totals[k]} | ${pct(r.totals[k])} |`);
  lines.push("");
  if (c) lines.push(`- 構文エラー（読み直し）: ${c.syntaxErrors.length} 件`, `- 命令の検査エラー: ${c.checkErrors.length} 件`);
  lines.push(`- 書き出したファイル: ${r.files.map((f) => `${f.name}.lim（${f.source}）`).join("、") || "なし"}`);
  lines.push(`- 台詞 ${r.stats.says} 行、地の文 ${r.stats.prose} 行、選択肢 ${r.stats.choices} か所、ラベル ${r.stats.labels} 個`);
  lines.push(`- 話者: ${r.speakers.join("、") || "なし"}${r.newSpeakers.length > 0 ? `（追加: ${r.newSpeakers.join("、")}）` : ""}`);
  const vars = Object.entries(r.variables);
  if (vars.length > 0) lines.push(`- 変数の初期値: ${vars.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("、")}`);
  lines.push("", "## 対応表に無いタグとコマンド（コメントにしたもの）", "");
  for (const [t, n] of [...r.unmapped].sort((a, b) => b[1] - a[1])) lines.push(`- ${t}: ${n}`);
  if (r.unsupported.size > 0) {
    lines.push("", "## 変換しない構文", "");
    for (const [t, n] of [...r.unsupported].sort((a, b) => b[1] - a[1])) lines.push(`- ${t}: ${n}`);
  }
  const byCode = new Map<string, number>();
  for (const i of r.issues) byCode.set(i.code, (byCode.get(i.code) ?? 0) + 1);
  lines.push("", "## 診断の内訳", "");
  for (const [code, n] of [...byCode].sort((a, b) => b[1] - a[1])) lines.push(`- ${code}: ${n}`);
  lines.push("", "## 手作業が必要な箇所", "");
  for (const i of r.issues) if (i.severity !== "info") lines.push(`- ${i.file}:${i.line} [${i.code}] ${i.message}`);
  const info = r.issues.filter((i) => i.severity === "info");
  if (info.length > 0) {
    lines.push("", "## 情報", "");
    for (const i of info) lines.push(`- ${i.file}:${i.line} [${i.code}] ${i.message}`);
  }
  if (c) {
    for (const [title, list] of [["構文エラー", c.syntaxErrors], ["命令の検査エラー", c.checkErrors]] as const) {
      if (list.length === 0) continue;
      lines.push("", `## ${title}`, "");
      for (const e of list) lines.push(`- ${e}`);
    }
  }
  return lines.join("\n") + "\n";
}
