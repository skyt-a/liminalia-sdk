import * as fs from "node:fs";
import { imageSize } from "@liminalia/lang";

/** ファイルの頭のこれだけを読む（JPEG の大きさは撮影情報の後ろにあることが多い）。 */
const HEAD_BYTES = 64 * 1024;
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

type Size = { width: number; height: number } | null;
/** 読んだ大きさ（パス → 更新時刻と大きさが同じ間は読み直さない）。 */
const known = new Map<string, { mtime: number; bytes: number; size: Size }>();

/**
 * 画像の大きさ（素材の一覧に添える）。読めないファイル（svg・壊れたものなど）は null。
 * 全体を読まないよう openSync で頭だけ読む。openSync の無い環境（スマホ版の Service Worker の fs）では大きさを出さない。
 */
export function imageHeadSize(path: string, mtime: number, bytes: number): Size {
  if (!IMAGE.test(path)) return null;
  const hit = known.get(path);
  if (hit && hit.mtime === mtime && hit.bytes === bytes) return hit.size;
  const size = readSize(path);
  known.set(path, { mtime, bytes, size });
  return size;
}

function readSize(path: string): Size {
  const open = Reflect.get(fs, "openSync") as typeof fs.openSync | undefined;
  const read = Reflect.get(fs, "readSync") as typeof fs.readSync | undefined;
  const close = Reflect.get(fs, "closeSync") as typeof fs.closeSync | undefined;
  if (!open || !read || !close) return null;
  let fd: number | null = null;
  try {
    fd = open(path, "r");
    const head = new Uint8Array(HEAD_BYTES);
    const got = read(fd, head, 0, HEAD_BYTES, 0);
    return imageSize(head.subarray(0, got));
  } catch {
    return null;
  } finally {
    if (fd !== null) close(fd);
  }
}
