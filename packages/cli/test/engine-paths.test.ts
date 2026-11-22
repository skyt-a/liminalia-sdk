import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { packageName } from "../bin/hooks.mjs";
import { bundledCatalogDir, CLI_ROOT, desktopDir, electronVersion, installedFromPackage, nodeEngines, webDir } from "../src/engine-paths.ts";

/** lim と一緒に動かすエンジンの場所（このリポジトリ、制作アプリ、npm で入れた lim のどれでも見つける）。npm の形は scripts/npm-pack.mjs。 */

const repo = resolve(import.meta.dirname, "../../..");

describe("エンジンの場所", () => {
  it("このリポジトリでは cli の隣の desktop と web を使う", () => {
    expect(CLI_ROOT).toBe(join(repo, "packages/cli"));
    expect(desktopDir()).toBe(join(repo, "packages/desktop"));
    expect(existsSync(join(desktopDir(), "update.cjs"))).toBe(true);
    expect(webDir()).toBe(join(repo, "packages/web"));
    expect(installedFromPackage()).toBe(false);
    // 公式のプラグインの一覧はリポジトリの catalog/ を読む（cli の中の plugins/ は npm で配る形にだけある）
    expect(bundledCatalogDir()).toBeNull();
  });

  it("Node の版は直下の package.json の engines、Electron の版は electron のパッケージから", () => {
    expect(nodeEngines()).toBe((JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { engines: { node: string } }).engines.node);
    expect(electronVersion()).toBe((JSON.parse(readFileSync(join(repo, "node_modules/electron/package.json"), "utf8")) as { version: string }).version);
  });

  it("lim の読み込みの口は、パッケージの名前で lim の依存かを見る", () => {
    expect(packageName("vite")).toBe("vite");
    expect(packageName("vite/dist/node/index.js")).toBe("vite");
    expect(packageName("@liminalia/web/pwa-icons")).toBe("@liminalia/web");
    expect(packageName("./a.ts")).toBeNull();
    expect(packageName("node:fs")).toBeNull();
    expect(packageName("file:///a.mjs")).toBeNull();
    expect(packageName("C:\\a.mjs")).toBeNull();
  });
});
