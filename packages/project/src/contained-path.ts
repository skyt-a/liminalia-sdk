import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** 一区切りのフォルダかファイルの名前か（空、. と ..、区切りの / と \、制御文字を含むものは違う）。 */
export function plainName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\\p{Cc}]/u.test(name);
}

/**
 * parent の直下の name のパス。name が一区切りの名前でないか、parent の直下に当たらなければ null
 * （書き出しの名前に作品の id・版・エディションの名前をつなぐ所で使う。parent そのものや、隣の書き出しを指さない）。
 */
export function childPath(parent: string, name: string): string | null {
  if (!plainName(name)) return null;
  const path = resolve(parent, name);
  return dirname(path) === resolve(parent) && basename(path) === name ? path : null;
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
