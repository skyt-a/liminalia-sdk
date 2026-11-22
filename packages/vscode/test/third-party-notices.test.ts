import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledPackages, packageDirOf, readBundledPackage, renderNotices } from "../scripts/third-party-notices.ts";

// .vsix に入れる束ねた依存の利用条件（THIRD-PARTY-NOTICES.txt）を、esbuild の metafile の道筋から作る

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakePackage(root: string, rel: string, pkg: Record<string, unknown>, files: Record<string, string>): string {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe("packageDirOf", () => {
  it("一番内側の node_modules のパッケージのフォルダを返す（スコープつきも）", () => {
    expect(packageDirOf("../../node_modules/vscode-jsonrpc/lib/common/api.js")).toBe("../../node_modules/vscode-jsonrpc");
    expect(packageDirOf("../../node_modules/@isaacs/glob/dist/index.js")).toBe("../../node_modules/@isaacs/glob");
    expect(packageDirOf("node_modules/a/node_modules/b/index.js")).toBe("node_modules/a/node_modules/b");
  });

  it("自分の部品（node_modules の外）は数えない", () => {
    expect(packageDirOf("../lang/src/index.ts")).toBeUndefined();
    expect(packageDirOf("src/extension.ts")).toBeUndefined();
  });
});

describe("bundledPackages と renderNotices", () => {
  it("束ねたファイルの依存を一つずつ、名前の順に、利用条件の文と一緒に並べる", () => {
    const root = mkdtempSync(join(tmpdir(), "lim-notices-"));
    dirs.push(root);
    fakePackage(root, "node_modules/zeta", { name: "zeta", version: "1.0.0", license: "MIT" }, { LICENSE: "Copyright (c) Zeta\nPermission is hereby granted" });
    fakePackage(root, "node_modules/@s/alpha", { name: "@s/alpha", version: "2.0.0", license: "ISC" }, { "LICENSE.md": "ISC text" });
    const packages = bundledPackages(["node_modules/zeta/a.js", "node_modules/zeta/b.js", "node_modules/@s/alpha/index.js", "src/own.ts"], root);
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual(["@s/alpha@2.0.0", "zeta@1.0.0"]);
    const text = renderNotices(packages);
    expect(text).toContain("- zeta@1.0.0 (MIT)");
    expect(text).toContain("Copyright (c) Zeta\nPermission is hereby granted");
    expect(text).toContain("ISC text");
  });

  it("利用条件の文のファイルが無い依存があれば止める（表示が抜けたまま配らない）", () => {
    const root = mkdtempSync(join(tmpdir(), "lim-notices-"));
    dirs.push(root);
    const dir = fakePackage(root, "node_modules/nolicense", { name: "nolicense", version: "0.1.0", license: "MIT" }, { "README.md": "x" });
    expect(() => readBundledPackage(dir)).toThrow(/nolicense@0\.1\.0 に利用条件の文のファイル/);
  });
});
