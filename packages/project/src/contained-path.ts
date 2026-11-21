import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** 未作成のファイルは、存在する親の実体に残りの名前をつないで判定する。壊れたリンクは断る。 */
function prospectivePath(path: string): string | null {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      if (lstatSync(current, { throwIfNoEntry: false })) return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** 設定されたフォルダ内の読み書きか。新規ファイルと、フォルダ内を指すリンクも扱う。 */
export function containedPath(root: string, path: string): boolean {
  if (!within(root, path)) return false;
  const base = prospectivePath(root);
  const actual = prospectivePath(path);
  return base !== null && actual !== null && within(base, actual);
}
