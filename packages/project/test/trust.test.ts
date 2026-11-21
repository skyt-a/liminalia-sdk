import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "../src/index.ts";
import { projectCode, projectCodeLine, RESTRICTED_PLUGIN_MESSAGE, restrictedFromEnv } from "../src/trust.ts";

/** 作品を開くと動くもの（lim new --from の知らせ）と、使う人が選んだときだけの制限付きの読み込み。 */

let work: string;
const config = (extra: Record<string, unknown> = {}) => ({ id: "t", title: "T", entry: "start", ...extra });

function project(name: string, extra: Record<string, unknown> = {}): string {
  const root = join(work, name);
  mkdirSync(join(root, "scenario"), { recursive: true });
  writeFileSync(join(root, "liminalia.json"), JSON.stringify(config(extra)));
  writeFileSync(join(root, "scenario", "start.lim"), "こんにちは\n");
  return root;
}

function plugin(root: string, name: string, exports: Record<string, string>): void {
  const dir = join(root, "plugins", name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module", exports }));
  // 読まれたら印のファイルを書く（制限付きでは読まれないことを確かめる）
  writeFileSync(join(dir, "src", "commands.js"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(root, "ran.txt"))}, "ran");\nexport default { name: ${JSON.stringify(name)}, commands: [] };\n`);
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "liminalia-trust-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("作品を開くと動くもの", () => {
  it("プラグインとその入口、署名と包むコマンド、店の口、取り込みの設定を並べる（Git のフックは数えない）", () => {
    const root = project("a", {
      plugins: ["./plugins/mine"],
      import: { tyrano: { source: "../x", profile: "./plugins/profile" } },
      build: { windows: { sign: { command: ["jsign", "{file}"] }, wrap: ["drm", "{file}"] }, store: { desktop: { module: "plugins/gog/store.cjs" } } },
    });
    plugin(root, "mine", { "./commands": "./src/commands.js", "./web": "./src/web.js" });
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
    const code = projectCode(root);
    expect(code.map((c) => c.kind)).toEqual(["plugin", "plugin", "sign", "wrap", "store"]);
    expect(projectCodeLine(code[0]!)).toBe("プラグイン ./plugins/mine（独自の命令、描画）");
    expect(projectCodeLine(code[0]!, "en")).toBe("Plugin ./plugins/mine (custom commands, rendering)");
    expect(projectCodeLine(code[2]!)).toBe("Windows 版の署名のコマンド: jsign {file}");
  });

  it("コードの無い作品（ひな形のまま）は空", () => {
    expect(projectCode(project("b"))).toEqual([]);
  });
});

describe("制限付きで読む", () => {
  it("LIMINALIA_RESTRICTED=1 のときだけ（作品を開くたびに信頼を尋ねたり覚えたりはしない）", () => {
    expect(restrictedFromEnv({})).toBe(false);
    expect(restrictedFromEnv({ LIMINALIA_RESTRICTED: "1" })).toBe(true);
    expect(restrictedFromEnv({ LIMINALIA_RESTRICTED: "0" })).toBe(false);
    // 前の版の制作アプリが置いていた LIMINALIA_REQUIRE_TRUST は、もう見ない
    expect(restrictedFromEnv({ LIMINALIA_REQUIRE_TRUST: "1" })).toBe(false);
  });

  it("制限付きの loadProject はプラグインを読まず、帯に出す理由を残す", () => {
    const root = project("a", { plugins: ["./plugins/mine"] });
    plugin(root, "mine", { "./commands": "./src/commands.js" });
    const p = loadProject(root, { skipBrokenPlugins: true, restricted: true });
    expect(p.restricted).toBe(true);
    expect(p.plugins).toHaveLength(1);
    expect(p.pluginErrors).toEqual([{ spec: "./plugins/mine", message: RESTRICTED_PLUGIN_MESSAGE, restricted: true }]);
    const free = loadProject(root, { skipBrokenPlugins: true });
    expect(free.restricted).toBeUndefined();
    expect(free.plugins).toHaveLength(2);
  });
});
