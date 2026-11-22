/**
 * 標準の画面の表（src/system/screen-catalog.ts）と、テンプレートで直せる画面の表（src/system/screens/table.ts）を、
 * docs/screens.md と英訳（site/src/content/en/docs/screens.md）の印のあいだに書き直す。
 * 画面の一覧を直したら流す（npx tsx packages/web/scripts/screen-catalog.ts）。test/screen-catalog.test.ts が、書き直していなければ落ちる。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { withScreenCatalog } from "../src/system/screen-catalog.ts";
import { withScreenTemplates } from "../src/system/screens/table.ts";

const repo = resolve(import.meta.dirname, "../../..");

/** 表を入れる資料（リポジトリの直下から）と、その言語。 */
export const SCREEN_CATALOG_DOCS = [
  { file: "docs/screens.md", lang: "ja" },
  { file: "site/src/content/en/docs/screens.md", lang: "en" },
] as const;

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  for (const { file, lang } of SCREEN_CATALOG_DOCS) {
    const path = resolve(repo, file);
    const next = withScreenCatalog(readFileSync(path, "utf8"), lang);
    if (next === null) throw new Error(`${file} に表の印（<!-- screen-catalog:start --> と end）がありません`);
    const withTemplates = withScreenTemplates(next, lang);
    if (withTemplates === null) throw new Error(`${file} に表の印（<!-- screen-templates:start --> と end）がありません`);
    writeFileSync(path, withTemplates);
    console.log(`${file} の表を書き直しました`);
  }
}
