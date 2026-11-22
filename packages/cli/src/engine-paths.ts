import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/**
 * lim と一緒に動かすエンジンのフォルダ。置き方は三つあり、どれでも見つける:
 * - このリポジトリ: packages/cli の隣に packages/web、packages/desktop
 * - 制作アプリ: node_modules/@liminalia/cli の隣に @liminalia/web、@liminalia/desktop（制作アプリを組み立てるときに置く）
 * - npm で入れた lim（scripts/npm-pack.mjs）: 外枠（desktop）は cli の中。web は依存として、隣か cli の node_modules の中
 *   （npm install -g は依存を cli の中に入れるので、隣を決め打ちしない）
 */

/** cli のフォルダ（packages/cli か、入れた @liminalia/cli）。 */
export const CLI_ROOT = resolve(import.meta.dirname, "..");

/** 書き出すデスクトップ版のゲームの外枠（main.cjs ほか）。 */
export function desktopDir(): string {
  const inside = join(CLI_ROOT, "desktop");
  return existsSync(join(inside, "main.cjs")) ? inside : resolve(CLI_ROOT, "../desktop");
}

/** プレイヤー（@liminalia/web）のフォルダ。依存として探し、見つからなければ cli の隣。 */
export function webDir(): string {
  try {
    return dirname(createRequire(import.meta.url).resolve("@liminalia/web/package.json"));
  } catch {
    // 制作アプリの中の web の package.json は ./package.json を外に出していない。そのときは隣
    return resolve(CLI_ROOT, "../web");
  }
}

/**
 * npm で入れた lim が持つ公式のプラグインの一覧（cli の plugins/。scripts/npm-pack.mjs が catalog.json とプラグインを入れる）。無ければ null。
 * 制作画面と lim mcp の install_plugin は、一覧を環境変数 LIMINALIA_PLUGIN_CATALOG かこのリポジトリの catalog/ で探す（@liminalia/studio の catalog.ts）。
 */
export function bundledCatalogDir(): string | null {
  const dir = join(CLI_ROOT, "plugins");
  return existsSync(join(dir, "catalog.json")) ? dir : null;
}

/** cli の package.json。 */
function cliPackage(): { version?: string; engines?: { node?: string }; liminalia?: { electron?: string } } {
  return JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8")) as ReturnType<typeof cliPackage>;
}

/** lim が要る Node の版（npm で配る cli の package.json の engines。このリポジトリでは直下の package.json）。 */
export function nodeEngines(): string {
  const own = cliPackage().engines?.node;
  if (own) return own;
  try {
    return (JSON.parse(readFileSync(resolve(CLI_ROOT, "../../package.json"), "utf8")) as { engines?: { node?: string } }).engines?.node ?? "";
  } catch {
    // 直下の package.json が無い置き方（制作アプリの中）では、版の確かめをしない
    return "";
  }
}

/**
 * 書き出すゲームに入れる Electron の版。このリポジトリでは electron のパッケージ、制作アプリの中ではアプリ自身の Electron、
 * npm で入れた lim では組み立てたときに書いた版（package.json の liminalia.electron。本体は書き出すときに取り寄せる）。見つからなければ null。
 */
export function electronVersion(): string | null {
  try {
    return (JSON.parse(readFileSync(createRequire(import.meta.url).resolve("electron/package.json"), "utf8")) as { version: string }).version;
  } catch {
    // electron のパッケージが無い（制作アプリと npm で入れた lim）。下の順で探す
  }
  if (process.versions.electron) return process.versions.electron;
  return cliPackage().liminalia?.electron ?? null;
}

/** npm などで入れた lim か（node_modules の中にある）。lim version は、そのときは Git のコミットを出さない（作品のリポジトリのものになるため）。 */
export function installedFromPackage(): boolean {
  return /[\\/]node_modules[\\/]/.test(CLI_ROOT);
}
