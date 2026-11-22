/**
 * 診断の説明（lim explain）の元。docs/design/format.md の code の表（見出しに code のある表）から、code ごとの重さ・中身・節を読む。
 * 資料を一つの正本にするため、lim explain が読む @liminalia/lang の DIAGNOSTIC_DOCS はここから作る
 * （npx tsx packages/cli/scripts/diagnostic-docs.ts。食い違いは test/explain.test.ts が見つける）。
 */
export interface DiagnosticDoc {
  /** 重さ（エラー・警告・情報。「エラー、警告」のように並ぶこともある）。 */
  severity: string;
  /** 中身（表の文。`…` はそのまま）。 */
  summary: string;
  /** 資料の節（"9. 構文チェック / 確かめること / 構文" など）。 */
  section: string;
  /** 同じ行に並ぶほかの code。 */
  related: string[];
}

export function diagnosticDocsFromMarkdown(md: string): Record<string, DiagnosticDoc> {
  const out: Record<string, DiagnosticDoc> = {};
  const lines = md.split("\n");
  let h2 = "";
  let h3 = "";
  let group = "";
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("```")) fence = !fence;
    if (fence) continue;
    if (line.startsWith("## ")) [h2, h3, group] = [line.slice(3).trim(), "", ""];
    else if (line.startsWith("### ")) [h3, group] = [line.slice(4).trim(), ""];
    else if (/^\*\*[^*]+\*\*$/.test(line.trim())) group = line.trim().slice(2, -2);
    if (!line.trimStart().startsWith("|")) continue;
    const header = cells(line);
    const codeAt = header.indexOf("code");
    // 見出しの行の次が区切りの行（|---|）である表だけ
    if (codeAt < 0 || !/^\s*\|[\s|:-]+\|\s*$/.test(lines[i + 1] ?? "")) continue;
    const severityAt = header.indexOf("重さ");
    const summaryAt = header.length - 1;
    for (i += 2; i < lines.length && lines[i]!.trimStart().startsWith("|"); i++) {
      const row = cells(lines[i]!);
      const codes = [...(row[codeAt] ?? "").matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]!);
      const severity = severityAt >= 0 ? (row[severityAt] ?? "") : "";
      // 決まりの表（決まり | code | 知らせること）は、決まりの名前を中身に添える
      const summary = (codeAt > 0 && severityAt < 0 ? `${row[0]}: ${row[summaryAt]}` : (row[summaryAt] ?? "")).replace(/\\\|/g, "|");
      const section = [h2, h3, group].filter((x) => x !== "").join(" / ");
      for (const code of codes) {
        if (out[code]) continue;
        out[code] = { severity, summary, section, related: codes.filter((c) => c !== code) };
      }
    }
    i--;
  }
  return out;
}

/** 表の一行を区切る（\| は区切りにしない）。 */
function cells(line: string): string[] {
  const parts: string[] = [];
  let cur = "";
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (body[i] === "|") {
      parts.push(cur.trim());
      cur = "";
    } else cur += body[i];
  }
  parts.push(cur.trim());
  return parts;
}

/** 生成するファイル（src/diagnostic-docs.ts）の中身。 */
export function renderDiagnosticDocs(docs: Readonly<Record<string, DiagnosticDoc>>): string {
  const sorted = Object.fromEntries(Object.entries(docs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `// 生成したファイル。手で直さない（元は docs/design/format.md の code の表。npx tsx packages/cli/scripts/diagnostic-docs.ts で作り直す）。
import type { DiagnosticDoc } from "./diagnostic-docs-source.ts";

export const DIAGNOSTIC_DOCS: Readonly<Record<string, DiagnosticDoc>> = ${JSON.stringify(sorted, null, 2)};
`;
}
