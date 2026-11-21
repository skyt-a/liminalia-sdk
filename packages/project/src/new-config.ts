import { SCRIPT_FORMAT } from "@liminalia/lang";

/**
 * 新しく作る作品の設定のファイルの頭（lim new と、スマホ版の制作画面の新規作成が使う。ブラウザでも動く。fs を使わない）。
 */

/**
 * 設定の JSON Schema（packages/project/schemas）をサイトに置いた場所（site/scripts/prepare-schemas.mjs が写す）。
 * 新しく作る liminalia.json、cast.json と、lim i18n が作るファイルの先頭の "$schema" に書く（VS Code の拡張を入れていないエディタと、AI のアシスタントも項目を引ける）。
 */
export const SCHEMA_BASE_URL = "https://liminalia.skyta.dev/schemas/";

/** その設定のファイルの JSON Schema の URL。 */
export function schemaUrl(name: "liminalia" | "cast" | "lang"): string {
  return `${SCHEMA_BASE_URL}${name}.schema.json`;
}

/**
 * 用意したひな形（templates/default）から作る作品の liminalia.json。先頭に $schema、id、title、version（ひな形にあれば）、format（今の書式の版）を
 * この順に置き、ひな形の値を重ねる（lim new の並び）。format を書かないと、作品は書式の版 1 として扱われる。
 */
export function newProjectConfig(template: Readonly<Record<string, unknown>>, o: { id: string; title: string }): Record<string, unknown> {
  const head = { $schema: schemaUrl("liminalia"), id: o.id, title: o.title, ...(template.version !== undefined ? { version: template.version } : {}), format: SCRIPT_FORMAT };
  return { ...head, ...template, ...head };
}

/**
 * JSON の文字の先頭に "$schema" を書く（もう書いてあれば、そのまま返す）。ほかの書き方（並びと字下げ）はそのまま、最初の { の次の行に足す。
 */
export function withSchemaText(raw: string, url: string): string {
  const json = JSON.parse(raw) as Record<string, unknown>;
  if (!json || typeof json !== "object" || Array.isArray(json) || "$schema" in json) return raw;
  const m = /^\{\r?\n([ \t]*)/.exec(raw);
  const empty = Object.keys(json).length === 0;
  return m && !empty ? raw.replace(/^\{(\r?\n)([ \t]*)/, (_, nl: string, indent: string) => `{${nl}${indent}"$schema": ${JSON.stringify(url)},${nl}${indent}`) : `${JSON.stringify({ $schema: url, ...json }, null, 2)}\n`;
}
