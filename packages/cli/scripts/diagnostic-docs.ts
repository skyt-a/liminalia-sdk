/**
 * lim explain が読む診断の説明（src/diagnostic-docs.ts）を、docs/design/format.md の code の表から作り直す。
 *   npx tsx packages/cli/scripts/diagnostic-docs.ts
 * 資料の表を直したら流す（食い違いは test/explain.test.ts が見つける）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { diagnosticDocsFromMarkdown, renderDiagnosticDocs } from "../src/diagnostic-docs-source.ts";

const root = new URL("../../../", import.meta.url);
const docs = diagnosticDocsFromMarkdown(readFileSync(new URL("docs/design/format.md", root), "utf8"));
writeFileSync(new URL("packages/cli/src/diagnostic-docs.ts", root), renderDiagnosticDocs(docs));
console.log(`packages/cli/src/diagnostic-docs.ts: ${Object.keys(docs).length}`);
