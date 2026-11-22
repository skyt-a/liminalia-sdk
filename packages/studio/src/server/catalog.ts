import { cpSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 公式のプラグインの一覧（同梱の catalog.json）。npm は使わず、一覧のフォルダから作品の plugins/<id> へ写して入れる。
 *
 * 一覧のフォルダの探し方（catalogDir）:
 *   1. 環境変数 LIMINALIA_PLUGIN_CATALOG（デスクトップ版はアプリの Resources/plugins を渡す）
 *   2. このリポジトリの catalog/（lim dev・lim studio をリポジトリから動かすとき）
 *
 * catalog.json の形:
 *   { "plugins": [{ "id", "name", "nameEn", "description", "descriptionEn", "version"?, "folder", "folderEnv"?, "entries"? }] }
 *   - folder は一覧のフォルダからの相対パスか絶対パス。folderEnv の環境変数があれば、そちらを使う
 *     （リポジトリの catalog/ は隣に置いた別のリポジトリを指す。アプリに入れるときは写したフォルダの名前に書き換える）
 *   - version・entries を省くと、フォルダの package.json（version と exports）から求める
 */

export const CATALOG_ENV = "LIMINALIA_PLUGIN_CATALOG";
export const CATALOG_FILE = "catalog.json";
/** 写さないもの（入れた作品では使わない）。 */
export const CATALOG_SKIP = new Set(["node_modules", ".git", "test", "tests", "__tests__", ".DS_Store"]);
/** プラグインの入口として数えるもの。 */
const ENTRIES = ["commands", "web", "import", "studio", "studio-server"] as const;
/** id はそのまま plugins/<id> のフォルダの名前になる。 */
const ID = /^[a-z][a-z0-9-]*$/;

export interface CatalogEntry {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  version?: string;
  folder: string;
  folderEnv?: string;
  entries?: string[];
}

/** 読んだ一覧の一つ。dir は写す元のフォルダ（無ければ null）。 */
export interface CatalogItem {
  entry: CatalogEntry;
  dir: string | null;
  /** 写す元のパッケージの名前（package.json の name。無ければ id）。 */
  packageName: string;
  version: string;
  entries: string[];
}

/** 一覧のフォルダ。見つからなければ null。 */
export function catalogDir(env: Record<string, string | undefined> = process.env): string | null {
  const given = env[CATALOG_ENV]?.trim();
  if (given) return resolve(given);
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../catalog");
  return existsSync(resolve(repo, CATALOG_FILE)) ? repo : null;
}

/** 一覧を読む。フォルダや catalog.json が無ければ空。形が誤っていれば投げる。 */
export function readCatalog(dir: string | null, env: Record<string, string | undefined> = process.env): CatalogItem[] {
  if (!dir) return [];
  const file = resolve(dir, CATALOG_FILE);
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, "utf8")) as { plugins?: unknown };
  if (!Array.isArray(raw.plugins)) throw new Error(`${file} に plugins の配列がありません`);
  const seen = new Set<string>();
  return raw.plugins.map((p: Partial<CatalogEntry>) => {
    if (typeof p.id !== "string" || !ID.test(p.id)) throw new Error(`${file} の id ${String(p.id)} は使えません（英小文字で始め、英小文字、数字、- だけ）`);
    if (seen.has(p.id)) throw new Error(`${file} に id ${p.id} が二つあります`);
    seen.add(p.id);
    if (typeof p.folder !== "string" || !p.folder) throw new Error(`${file} の ${p.id} に folder がありません`);
    const entry: CatalogEntry = {
      id: p.id,
      name: String(p.name ?? p.id),
      nameEn: String(p.nameEn ?? p.name ?? p.id),
      description: String(p.description ?? ""),
      descriptionEn: String(p.descriptionEn ?? p.description ?? ""),
      folder: p.folder,
      ...(typeof p.version === "string" ? { version: p.version } : {}),
      ...(typeof p.folderEnv === "string" ? { folderEnv: p.folderEnv } : {}),
      ...(Array.isArray(p.entries) ? { entries: p.entries.map(String) } : {}),
    };
    const fromEnv = entry.folderEnv ? env[entry.folderEnv]?.trim() : undefined;
    const folder = fromEnv ? resolve(fromEnv) : isAbsolute(entry.folder) ? entry.folder : resolve(dir, entry.folder);
    const pkgFile = resolve(folder, "package.json");
    if (!existsSync(pkgFile)) return { entry, dir: null, packageName: entry.id, version: entry.version ?? "", entries: entry.entries ?? [] };
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { name?: string; version?: string; exports?: Record<string, unknown> };
    return {
      entry,
      dir: folder,
      packageName: pkg.name ?? entry.id,
      version: entry.version ?? pkg.version ?? "",
      entries: ENTRIES.filter((e) => pkg.exports?.[`./${e}`] !== undefined),
    };
  });
}

/** プラグインのフォルダを写す（node_modules・.git・test などは写さない）。 */
export function copyPluginFolder(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (src) => src === from || !CATALOG_SKIP.has(basename(src)),
  });
}

/** 版の比べ方（数の並びとして。a が新しければ正）。 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}
