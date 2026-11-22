import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

/**
 * 人が配るひな形（lim new --template）から作るときに、写さないもの。
 * ひな形の作者の識別子と送り先（liminalia.json）と、ひな形の .gitignore に書いたもの、書き出し先（paths.out）、署名の鍵のファイル。
 */

/**
 * ひな形の作者のものなので写さない liminalia.json の設定（`.` で区切った道）。そのまま写すと、新しい作品の遊ぶ人の止まった記録や遊ばれ方、
 * テスト版の指摘、アップデートの確認がひな形の作者のサーバーへ送られ、バンドル ID、Steam の App ID、itch の行き先、署名、ストアの商品もぶつかる。
 */
export const TEMPLATE_OWNER_SETTINGS = [
  "author",
  "saves.carryFrom",
  "build.bundleId",
  "build.executableName",
  "build.buildNumber",
  "build.crashReport",
  "build.analytics",
  "build.feedback",
  "build.update",
  "build.steam",
  "build.itch",
  "build.store",
  "build.gameCenter",
  "build.playGames",
  "build.mac.signIdentity",
  "build.mac.notaryProfile",
  "build.windows.sign",
  "build.android.keystore",
  "build.android.alias",
  "build.android.storePasswordEnv",
  "build.android.keyPasswordEnv",
  "build.ios.team",
] as const;

/** 設定から TEMPLATE_OWNER_SETTINGS を外す（空になった入れ物も外す）。外した道を返す。 */
export function stripTemplateOwner(config: Record<string, unknown>): string[] {
  const removed: string[] = [];
  for (const path of TEMPLATE_OWNER_SETTINGS) {
    const keys = path.split(".");
    const parents: Record<string, unknown>[] = [config];
    let node: unknown = config;
    for (const k of keys.slice(0, -1)) {
      node = node && typeof node === "object" && !Array.isArray(node) ? (node as Record<string, unknown>)[k] : undefined;
      if (!node || typeof node !== "object" || Array.isArray(node)) break;
      parents.push(node as Record<string, unknown>);
    }
    const holder = parents[keys.length - 1];
    const last = keys.at(-1)!;
    if (!holder || !Object.hasOwn(holder, last)) continue;
    delete holder[last];
    removed.push(path);
    // 空になった入れ物（build.mac など）も外す
    for (let i = keys.length - 2; i >= 0; i--) {
      const child = parents[i + 1]!;
      if (Object.keys(child).length > 0) break;
      delete parents[i]![keys[i]!];
    }
  }
  return removed;
}

/**
 * .gitignore の決まりで、パス（ひな形のフォルダからの相対。区切りは /）を外すか。よく使う書き方だけを読む
 * （# のコメント、! の打ち消し、末尾の / はフォルダだけ、/ を含むものはひな形のフォルダから、* と ** と ?）。後に書いたものが勝つ。
 */
export function gitignoreMatcher(text: string): (path: string, isDir: boolean) => boolean {
  const rules = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((line) => {
      const negate = line.startsWith("!");
      let p = negate ? line.slice(1) : line;
      const dirOnly = p.endsWith("/");
      if (dirOnly) p = p.slice(0, -1);
      const anchored = p.includes("/");
      p = p.replace(/^\//, "");
      const glob = p
        .split(/(\*\*\/?|\*|\?)/)
        .map((part) => (part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
        .join("");
      return { negate, dirOnly, anchored, re: new RegExp(`^${glob}$`) };
    });
  return (path, isDir) => {
    let ignored = false;
    const name = path.slice(path.lastIndexOf("/") + 1);
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(r.anchored ? path : name)) ignored = !r.negate;
    }
    return ignored;
  };
}

/** ひな形から写さないもの（ひな形のフォルダからの相対パスで分かるもの）と、その理由。 */
export interface TemplateSkips {
  /** 写すかどうかを決める（src はひな形の中の実際のパス）。外したものは skipped に入れる。 */
  skip(src: string): boolean;
  /** 外したもの（ひな形のフォルダからの相対。フォルダは末尾に /）。 */
  skipped: string[];
}

/**
 * ひな形の .gitignore（npm で配るときの gitignore も）に書いたもの、ひな形の書き出し先（liminalia.json の paths.out）、
 * 署名の鍵のファイル（build.android.keystore、build.windows.sign.pfx）を写さない。
 */
export function templateSkips(src: string, config: { paths?: { out?: unknown }; build?: { android?: { keystore?: unknown }; windows?: { sign?: { pfx?: unknown } } } }): TemplateSkips {
  const ignores = [".gitignore", "gitignore"].filter((f) => existsSync(join(src, f))).map((f) => gitignoreMatcher(readFileSync(join(src, f), "utf8")));
  /** ひな形の中を指す設定のパス（外を指すものと絶対パスは見ない）。 */
  const inside = (p: unknown): string | null => {
    if (typeof p !== "string" || p === "" || isAbsolute(p)) return null;
    const rel = normalize(p).split(sep).join("/").replace(/\/$/, "");
    return rel.startsWith("../") || rel === ".." || rel === "." ? null : rel;
  };
  const exact = new Set([inside(config.paths?.out), inside(config.build?.android?.keystore), inside(config.build?.windows?.sign?.pfx)].filter((p): p is string => p !== null));
  const skipped: string[] = [];
  return {
    skipped,
    skip(path: string) {
      const rel = relative(src, path).split(sep).join("/");
      if (rel === "" || rel === ".gitignore" || rel === "gitignore") return false;
      const isDir = statSync(path).isDirectory();
      if (!exact.has(rel) && !ignores.some((m) => m(rel, isDir))) return false;
      skipped.push(isDir ? `${rel}/` : rel);
      return true;
    },
  };
}
