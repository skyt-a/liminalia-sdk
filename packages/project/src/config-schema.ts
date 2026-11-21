import { readFileSync } from "node:fs";
import type { JsonSchema } from "@liminalia/lang";

/**
 * 設定の JSON Schema（packages/project/schemas。scripts/config-schema.ts が型から作る）。
 * スマホ版の Service Worker はこのファイルを読めない（import.meta.url が file:///sw.js になる）ので、組み立てでは Schema を束ねた中身に
 * 読み替える（packages/studio-mobile/scripts/sw-options.ts）。
 */
export function configSchema(name: "liminalia" | "cast" | "lang"): JsonSchema {
  return JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8")) as JsonSchema;
}
