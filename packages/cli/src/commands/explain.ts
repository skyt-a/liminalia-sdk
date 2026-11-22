import { DIAGNOSTIC_CODES_EN, typoDistance } from "@liminalia/lang";
import { DIAGNOSTIC_DOCS } from "../diagnostic-docs.ts";
import { DIAGNOSTIC_EXAMPLES } from "../diagnostic-examples.ts";

const SEVERITY_EN: Readonly<Record<string, string>> = { エラー: "error", 警告: "warning", 情報: "info" };

/** 書式の資料（docs/design/format.md）のサイトのページ。作品の外で lim を使う人にも開ける場所を示す。 */
const FORMAT_DOC = "https://liminalia.skyta.dev/docs/design/format/";
const FORMAT_DOC_EN = "https://liminalia.skyta.dev/en/docs/design/format/";

/** 重さの言葉を英語に（「エラー、警告」→ "error, warning"）。 */
function severityEn(text: string): string {
  return text
    .split("、")
    .map((s) => SEVERITY_EN[s.trim()] ?? s.trim())
    .join(", ");
}

/** 知っている code（資料の表と英語の表の両方）。 */
export function knownCodes(): string[] {
  return [...new Set([...Object.keys(DIAGNOSTIC_DOCS), ...Object.keys(DIAGNOSTIC_CODES_EN)])].sort();
}

/** 綴りの近い code。 */
export function nearCode(code: string): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const c of knownCodes()) {
    const d = typoDistance(code, c);
    if (d < bestDistance) [best, bestDistance] = [c, d];
  }
  return best !== null && bestDistance <= Math.max(2, Math.floor(code.length / 3)) ? best : null;
}

/** 一つの code の説明（重さ、中身、例と直した形、資料の節、同じ行のほかの code）。無い code なら null。 */
export function explainText(code: string, language: "ja" | "en" = "ja"): string | null {
  const doc = DIAGNOSTIC_DOCS[code];
  const en = DIAGNOSTIC_CODES_EN[code];
  if (!doc && !en) return null;
  const example = DIAGNOSTIC_EXAMPLES[code];
  const indent = (text: string) =>
    text
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n");
  const out: string[] = [];
  if (language === "en") {
    out.push(`${code}${doc?.severity ? ` (${severityEn(doc.severity)})` : ""}`, en ?? doc!.summary);
    if (example) out.push("", "Example:", indent(example.bad), "Fixed:", indent(example.good));
    if (doc) out.push("", `Docs: ${FORMAT_DOC_EN}, section ${doc.section.split(".")[0]}`);
    if (doc && doc.related.length > 0) out.push(`Related: ${doc.related.join(", ")}`);
    return out.join("\n");
  }
  out.push(`${code}${doc?.severity ? `（${doc.severity}）` : ""}`, doc?.summary ?? en!);
  if (example) out.push("", "書き方の例:", indent(example.bad), "直した形:", indent(example.good));
  if (doc) out.push("", `資料: ${FORMAT_DOC} の「${doc.section.split(" / ").join("」の「")}」`);
  if (doc && doc.related.length > 0) out.push(`同じ表の行の code: ${doc.related.join("、")}`);
  return out.join("\n");
}

/**
 * lim explain [コード] [--lang en] — 診断の code の説明と例と直し方を出す。code を省くと一覧。作品の外でも動く。
 * 知らない code なら近い code を示して false。
 */
export function runExplain(code: string | undefined, language: "ja" | "en" = "ja"): boolean {
  if (code === undefined) {
    for (const c of knownCodes()) {
      const doc = DIAGNOSTIC_DOCS[c];
      console.log(`${c.padEnd(28)} ${language === "en" ? (DIAGNOSTIC_CODES_EN[c] ?? "") : (doc?.summary ?? DIAGNOSTIC_CODES_EN[c] ?? "")}`);
    }
    return true;
  }
  const text = explainText(code, language);
  if (text !== null) {
    console.log(text);
    return true;
  }
  const near = nearCode(code);
  console.error(language === "en" ? `lim explain: there's no code ${code}${near ? ` (did you mean ${near}?)` : ""}` : `lim explain: ${code} という code はありません${near ? `（${near} のことですか？）` : ""}`);
  return false;
}
