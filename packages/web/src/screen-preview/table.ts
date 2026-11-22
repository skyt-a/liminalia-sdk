/**
 * 標準の画面の一覧を Node から読む口（lim shot --screens と、lim mcp の list_screens と screen_shot が読む）。
 * 画面に関わるものを読まない（samples.ts と system/screen-catalog.ts の表だけ）。書き出したゲームには入らない。
 */
export { screenPreviewTable } from "./samples.ts";
export { SYSTEM_SCREEN_VARS } from "../system/screen-catalog.ts";
