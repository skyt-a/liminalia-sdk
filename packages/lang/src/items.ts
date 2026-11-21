import type { Diagnostic, Script } from "./ast.ts";

/**
 * 持ち物（liminalia.json の items）。名前 → 表示名・絵（image フォルダ）・説明。
 * 持っている数はゲームの変数のうち、式からは書けない名前 ITEMS_KEY に置く（セーブ・巻き戻し・ロードでそのまま戻る）。
 */
export interface ItemDef {
  name: string;
  image?: string;
  description?: string;
}

export type ItemsConfig = Record<string, ItemDef>;

/** 持っている数を置く、ゲームの変数の名前（式の名前に使えない文字を含むので、作品の変数と重ならない）。 */
export const ITEMS_KEY = "@items";

const FILE = "liminalia.json";

/** 持ち物の定義の形と、シナリオが使う持ち物の名前（@item-add・@item-remove と、式の item("…")）。 */
export function checkItems(raw: unknown, scripts: ReadonlyMap<string, Script>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const bad = (message: string) => out.push({ severity: "error", code: "bad-items", message, file: FILE, line: 1 });
  let items: ItemsConfig = {};
  if (raw !== undefined) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("items は名前 → { name, image, description } の組で書きます");
    else {
      for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
        const d = v as Partial<ItemDef> | null;
        if (!d || typeof d !== "object" || typeof d.name !== "string" || d.name === "") bad(`items.${key} に name（表示する名前）がありません`);
        else if ((d.image !== undefined && typeof d.image !== "string") || (d.description !== undefined && typeof d.description !== "string")) bad(`items.${key} の image と description は文字列で書きます`);
      }
      items = raw as ItemsConfig;
    }
  }
  const keys = Object.keys(items);
  const unknown = (file: string, line: number, key: string, column?: number) => {
    if (Object.hasOwn(items, key)) return;
    out.push({ severity: "error", code: "unknown-item", message: `持ち物 ${key} は liminalia.json の items にありません`, file, line, ...(column ? { column } : {}), ...(keys.length ? { hint: keys.join(" / ") } : { hint: `"items": { "${key}": { "name": "…" } }` }) });
  };
  for (const [file, script] of scripts) {
    // 文と式をたどる（行は一番近い文のもの）
    const walk = (node: unknown, line: number): void => {
      if (Array.isArray(node)) {
        for (const n of node) walk(n, line);
        return;
      }
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      const at = typeof n.line === "number" ? n.line : line;
      if (n.kind === "command" && (n.name === "item-add" || n.name === "item-remove")) {
        const args = n.args as { key: string | null; value: { kind: string; value?: unknown }; column: number }[];
        const a = args.find((x) => x.key === "item") ?? args.find((x) => x.key === null);
        if (a?.value.kind === "string") unknown(file, at, String(a.value.value), a.column);
      }
      if (n.kind === "call" && n.callee === "item") {
        const first = (n.args as { kind: string; value?: unknown }[] | undefined)?.[0];
        if (first?.kind === "literal" && typeof first.value === "string") unknown(file, at, first.value);
      }
      for (const v of Object.values(n)) if (v && typeof v === "object") walk(v, at);
    };
    walk(script.body, 1);
  }
  return out;
}

/** 持ち物の絵（image フォルダ）。 */
export function itemAssetReferences(raw: unknown): { folder: string; path: string; where: string }[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, Partial<ItemDef>>).flatMap(([key, d]) => (typeof d?.image === "string" && d.image !== "" ? [{ folder: "image", path: d.image, where: `items.${key}.image` }] : []));
}
