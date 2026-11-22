import { STANDARD_TEMPLATES } from "./index.ts";
import { STANDARD_SCREENS } from "./rules.ts";

/**
 * テンプレートで直せる標準の画面の表（docs/screens.md と英訳の印 <!-- screen-templates:start --> と end のあいだ）。
 * packages/web/scripts/screen-catalog.ts が書き、test/screen-catalog.test.ts が突き合わせる。遊ぶ側からは読まない（DOM を使わない）。
 */

/** 画面の名前（表の見出し）。 */
const NAMES: Readonly<Record<string, { ja: string; en: string }>> = {
  confirm: { ja: "確認", en: "Confirmation" },
  menu: { ja: "メニュー", en: "Menu" },
  help: { ja: "操作説明", en: "Controls help" },
  ending: { ja: "結末の名前", en: "Ending name" },
  choice: { ja: "選択肢", en: "Choices" },
  saveload: { ja: "セーブとロード", en: "Save and load" },
  backlog: { ja: "バックログ", en: "Backlog" },
  title: { ja: "タイトル", en: "Title" },
  config: { ja: "コンフィグ", en: "Settings" },
};

const code = (s: string) => `\`${s}\``;

/** 部品の名前と版（テンプレートの字面から）。 */
export function templateParts(html: string): { part: string; version: number }[] {
  return [...html.matchAll(/<template\b[^>]*\bdata-part="([\w-]+)"[^>]*\bdata-version="(\d+)"/g)].map((m) => ({ part: m[1]!, version: Number(m[2]) }));
}

/** テンプレートで直せる画面の表（Markdown）。 */
export function screenTemplatesMarkdown(lang: "ja" | "en"): string {
  const sep = lang === "ja" ? "、" : ", ";
  const rules = STANDARD_SCREENS;
  const head = lang === "ja" ? ["画面", "ui.templates のキー", "部品（バージョン）", "押すと起きること（data-role）", "値（data-field、data-if、data-attr-*）"] : ["Screen", "Key in ui.templates", "Parts (version)", "Actions (data-role)", "Values (data-field, data-if, data-attr-*)"];
  const rows = Object.keys(STANDARD_TEMPLATES).map((id) => {
    const r = rules[id]!;
    const parts = templateParts(STANDARD_TEMPLATES[id]!).map((p) => `${code(p.part)} ${p.version}`);
    // メニューはシステムの操作の名前をすべて取るので、名前を並べずにまとめて書く
    const roles = id === "menu" ? [lang === "ja" ? "システムの操作の名前（`SYSTEM_ACTIONS`）" : "system action names (`SYSTEM_ACTIONS`)", ...r.roles.filter((x) => x === "close" || x === "open").map(code)] : r.roles.map(code);
    const cells = [NAMES[id]?.[lang] ?? id, code(id), parts.join(sep), roles.join(sep), r.fields.map(code).join(sep)];
    return `| ${cells.join(" | ")} |`;
  });
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows].join("\n");
}

/** 印のあいだを表で書き直したもの（印が無ければ null）。 */
export function withScreenTemplates(doc: string, lang: "ja" | "en"): string | null {
  const start = "<!-- screen-templates:start -->";
  const end = "<!-- screen-templates:end -->";
  const a = doc.indexOf(start);
  const b = doc.indexOf(end);
  if (a < 0 || b < a) return null;
  return `${doc.slice(0, a + start.length)}\n${screenTemplatesMarkdown(lang)}\n${doc.slice(b)}`;
}
