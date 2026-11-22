import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 依存の向き。書き出すゲームに入る部品（言語・実行・描画・標準の命令・プラグインの部品・デスクトップの殻）は、
 * TyranoScript の取り込み（@liminalia/ks-import）と制作画面（@liminalia/studio）を読まない。
 * 取り込みの知識は ks-import と、プラグインの "./import" だけが持つ。制作画面は開発サーバーだけに載る。
 * 書き出しそのものの検査は lim build（組み立てたエンジンに開発用の道具のモジュールがあれば止める）と template.test.ts。
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const GAME_PACKAGES = ["lang", "runtime", "web", "std", "sdk"];

/** 開発サーバーの Node 側だけで動き、書き出しには入らないファイル（立ち絵の位置調整画面の保存口・制作画面の「取り込み直す」の口）。 */
const DEV_SERVER_ONLY = new Set(["packages/web/src/caster/server.ts", "packages/web/src/import-server.ts"]);
/**
 * sdk のうち、ゲームに入らない入口（プラグインの制作画面・制作画面のサーバー・取り込みの部分だけが読む）。
 * 実装は読まず、制作画面と取り込みの型だけを読む（実装へは host.ts の口でつなぐ）。
 */
const SDK_NOT_IN_GAME = new Set(["packages/sdk/src/studio.ts", "packages/sdk/src/studio-server.ts", "packages/sdk/src/import.ts"]);

/** 開発専用ページからだけ読むブラウザ側のファイル。書き出しの入口やゲーム本体からは読まない。 */
const DEV_PAGE_ONLY = new Set<string>([]);

/** 値として読む import（import type は書き出しに残らないので除く）。 */
const importsOf = (source: string, pkg: string) =>
  new RegExp(`(?<!import type [^;]*)from\\s+["']${pkg}|import\\(\\s*["']${pkg}|require\\(\\s*["']${pkg}|^import\\s+["']${pkg}`, "m").test(source);

function sources(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.(ts|mts|js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("依存の向き", () => {
  it("ゲーム本体のパッケージは package.json で ks-import に依存しない", () => {
    for (const name of GAME_PACKAGES) {
      const pkg = JSON.parse(readFileSync(join(ROOT, "packages", name, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      expect(Object.keys(deps), name).not.toContain("@liminalia/ks-import");
    }
  });

  it("ゲーム本体のパッケージは package.json の dependencies で studio に依存しない", () => {
    for (const name of GAME_PACKAGES) {
      const pkg = JSON.parse(readFileSync(join(ROOT, "packages", name, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
      expect(Object.keys(pkg.dependencies ?? {}), name).not.toContain("@liminalia/studio");
    }
  });

  it("ゲーム本体のソースは studio を値として import しない（型だけは読んでよい）", () => {
    const files = [...GAME_PACKAGES.map((name) => join(ROOT, "packages", name, "src")), join(ROOT, "packages/desktop")].flatMap((dir) => sources(dir));
    const offenders = files
      .map((f) => relative(ROOT, f))
      .filter((f) => !DEV_SERVER_ONLY.has(f) && !DEV_PAGE_ONLY.has(f) && !SDK_NOT_IN_GAME.has(f) && !f.endsWith(".d.ts") && importsOf(readFileSync(join(ROOT, f), "utf8"), "@liminalia/studio"));
    expect(offenders).toEqual([]);
    // 見張りが効いていること
    expect(importsOf('import { x } from "@liminalia/studio/protocol";', "@liminalia/studio")).toBe(true);
    expect(importsOf('import "@liminalia/studio/client";', "@liminalia/studio")).toBe(true);
    expect(importsOf('import type { x } from "@liminalia/studio/protocol";', "@liminalia/studio")).toBe(false);
  });

  it("開発ページ専用のファイルは書き出さない HTML からだけ読み、公開しない", () => {
    const web = join(ROOT, "packages/web");
    const build = readFileSync(join(ROOT, "packages/cli/src/commands/build.ts"), "utf8");
    const devPages = [...(build.match(/const DEV_PAGES = \[([^\]]+)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(devPages.length).toBeGreaterThan(0);
    const html = readdirSync(web).filter((name) => name.endsWith(".html"));
    const pkg = JSON.parse(readFileSync(join(web, "package.json"), "utf8")) as { exports: unknown };
    for (const file of DEV_PAGE_ONLY) {
      const target = join(ROOT, file).replace(/\.[^.]+$/, "");
      const references = (source: string, dir: string) =>
        [...source.matchAll(/["'`]([^"'`\s]+)["'`]/g)].some((m) => {
          const specifier = m[1]!.split(/[?#]/)[0]!;
          const path = specifier.startsWith("/") ? join(web, specifier) : resolve(dir, specifier);
          return path.replace(/\.(?:ts|mts|js|mjs|cjs)$/, "") === target;
        });
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      const pages = html.filter((name) => references(readFileSync(join(web, name), "utf8"), web));
      expect(pages.length, file).toBeGreaterThan(0);
      expect(pages.filter((name) => !devPages.includes(name)), file).toEqual([]);
      expect(sources(join(web, "src")).filter((f) => references(readFileSync(f, "utf8"), dirname(f))), file).toEqual([]);
      expect(references(JSON.stringify(pkg.exports), web), file).toBe(false);
    }
  });

  it("studio は描画側（@liminalia/web）と取り込み（ks-import）を読まない", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages/studio/package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps).not.toContain("@liminalia/web");
    expect(deps).not.toContain("@liminalia/ks-import");
    const files = sources(join(ROOT, "packages/studio/src"));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => importsOf(readFileSync(f, "utf8"), "@liminalia/web") || importsOf(readFileSync(f, "utf8"), "@liminalia/ks-import"));
    expect(offenders).toEqual([]);
  });

  it("ゲーム本体のソースは ks-import を import しない", () => {
    const files = [...GAME_PACKAGES.map((name) => join(ROOT, "packages", name, "src")), join(ROOT, "packages/desktop")].flatMap((dir) => sources(dir));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .map((f) => relative(ROOT, f))
      .filter((f) => !DEV_SERVER_ONLY.has(f) && !SDK_NOT_IN_GAME.has(f))
      .filter((f) => /from\s+["']@liminalia\/ks-import|import\(\s*["']@liminalia\/ks-import|require\(\s*["']@liminalia\/ks-import|["'][./]*ks-import\//.test(readFileSync(join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
