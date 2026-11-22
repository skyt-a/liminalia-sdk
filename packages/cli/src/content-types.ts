import { extname } from "node:path";
import { MEDIA_TYPES } from "@liminalia/lang/media";

/**
 * 書き出したブラウザ版を手元で配るとき（lim playtest、書き出しのあとの起動の確かめ）の、拡張子 → 中身の種類。
 * 素材は書き出しと開発サーバーと同じ表（@liminalia/lang の MEDIA_TYPES）を使い、ここではページとエンジンの分だけを足す。
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".lim": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".ico": "image/x-icon",
  ...MEDIA_TYPES,
};

/** ファイルの名前から中身の種類（表に無ければ application/octet-stream）。 */
export function contentTypeOf(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}
