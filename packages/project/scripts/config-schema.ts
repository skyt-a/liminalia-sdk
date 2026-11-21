/**
 * 設定の JSON Schema（packages/project/schemas と packages/vscode/schemas）を、型（ProjectConfig、CastEntry、TranslationFile）から作り直す。
 *   npx tsx packages/project/scripts/config-schema.ts
 * 型を直したら流す（食い違いは packages/project/test/config-schema.test.ts が見つける）。
 * lim check が知らない項目の警告に使い、VS Code の拡張機能が jsonValidation で補完と説明に使う。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateConfigSchemas, SCHEMA_OUTPUTS, VSCODE_SCHEMA_DIR, vscodeOnlySchemas } from "./config-schema-gen.ts";

const root = new URL("../../../", import.meta.url);
const schemas = generateConfigSchemas(fileURLToPath(root));
for (const dir of SCHEMA_OUTPUTS) {
  mkdirSync(new URL(dir, root), { recursive: true });
  for (const [name, schema] of Object.entries(schemas)) writeFileSync(new URL(`${dir}/${name}`, root), `${JSON.stringify(schema, null, 2)}\n`);
}
// VS Code の拡張機能だけに置くもの（lang/*.json に当てる、訳のファイルの形のときだけ確かめる Schema）
const vscode = vscodeOnlySchemas(schemas);
for (const [name, schema] of Object.entries(vscode)) writeFileSync(new URL(`${VSCODE_SCHEMA_DIR}/${name}`, root), `${JSON.stringify(schema, null, 2)}\n`);
console.log(`${Object.keys(schemas).join("、")} → ${SCHEMA_OUTPUTS.join("、")}。${Object.keys(vscode).join("、")} → ${VSCODE_SCHEMA_DIR}`);
