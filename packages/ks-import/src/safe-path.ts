import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * インポート元（他人のプロジェクトかもしれない）のファイルを読み書きするときの、パスの確かめ。
 * シンボリックリンクや ../ で、プロジェクトのフォルダの外のファイルを読んだり上書きしたりしないようにする。
 */

/** child が root の中（root そのものを含む）か。実体はたどらず、パスの形だけで比べる。 */
export function within(root: string, child: string): boolean {
  const r = relative(resolve(root), resolve(child));
  if (r === "") return true;
  if (isAbsolute(r)) return false; // Windows で別のドライブ
  return r !== ".." && !r.startsWith(`..${sep}`) && !r.startsWith("../");
}

/** どのフォルダに付けてもその外へ出ない相対パスか（絶対パス、ドライブ名、.. を含むものは不可）。 */
export function isPlainRelative(rel: string): boolean {
  if (rel === "" || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith("\\") || rel.startsWith("/")) return false;
  return !rel.split(/[\\/]/).includes("..");
}

function real(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** path の実体（シンボリックリンクをたどった先）が roots のどれかの中にあるか。path が無ければ false。 */
export function realWithin(roots: readonly string[], path: string): boolean {
  const target = real(path);
  if (target === null) return false;
  return roots.some((root) => {
    const r = real(root);
    return r !== null && within(r, target);
  });
}

/**
 * まだ無いかもしれない path について、いちばん近い実在の親（path が在ればそれ自身）の実体が root の中か。
 * これから書くファイルの置き場所を確かめるのに使う。
 */
export function realParentWithin(root: string, path: string): boolean {
  const r = real(root);
  if (r === null) return false;
  let at = resolve(path);
  for (;;) {
    const found = real(at);
    if (found !== null) return within(r, found);
    const parent = resolve(at, "..");
    if (parent === at) return false;
    at = parent;
  }
}

/** root から rel までのあいだのフォルダとファイル（root そのものは除く）に、シンボリックリンクがあるか。無いものは見ない。 */
export function symlinkOnPath(root: string, rel: string): boolean {
  let at = root;
  for (const part of rel.split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * root の中の rel に書いてよいか。rel が外へ出る形でなく、途中にシンボリックリンクがなく、置き場所の実体が root の中なら null。
 * いけなければ理由。
 */
export function unsafeWriteTarget(root: string, rel: string): string | null {
  if (!isPlainRelative(rel)) return "フォルダの外を指すパスです";
  if (symlinkOnPath(root, rel)) return "シンボリックリンクです（リンク先には書きません）";
  if (!realParentWithin(root, join(root, rel))) return "フォルダの外を指すパスです";
  return null;
}
