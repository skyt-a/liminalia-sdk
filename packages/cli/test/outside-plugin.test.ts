import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProject, STD_PLUGIN } from "@liminalia/project";
import { StudioWorkspace } from "../../studio/src/server/workspace.ts";
import { runCheck } from "../src/commands/check.ts";

/**
 * liminalia.json の plugins に作品の外のフォルダ（その Mac にだけある道具のプラグイン。liminalia-mirror など）を書いた作品。
 * フォルダが無いコンピューターでは飛ばして止まらず、制作画面だけのプラグインは書き出すゲームに入らない。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let base: string;
let dir: string;

function setPlugins(plugins: string[]): void {
  const path = join(dir, "liminalia.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as { plugins?: string[] };
  writeFileSync(path, JSON.stringify({ ...config, plugins }));
}

/** 作品の隣に、制作画面の口だけを持つプラグインを置く。 */
function studioOnlyPlugin(): string {
  const folder = join(base, "tool-plugin");
  mkdirSync(join(folder, "src"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "tool-plugin", type: "module", exports: { "./studio": "./src/studio.ts", "./studio-server": "./src/studio-server.ts" } }));
  writeFileSync(join(folder, "src/studio.ts"), 'export default { name: "tool", views: [] };\n');
  writeFileSync(join(folder, "src/studio-server.ts"), 'export default { name: "tool", routes: {} };\n');
  return folder;
}

async function limCheck(): Promise<boolean> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    return await runCheck(dir, true);
  } finally {
    log.mockRestore();
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "liminalia-outside-plugin-"));
  dir = join(base, "game");
  cpSync(TEMPLATE, dir, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("作品の外のフォルダのプラグイン", () => {
  it("フォルダが無ければ飛ばし、一度だけ知らせる。lim check と制作画面は止まらない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setPlugins(["../no-such-tool", join(base, "absent-tool")]);
    expect(loadProject(dir).plugins).toEqual([STD_PLUGIN]);
    loadProject(dir);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      "[プラグイン] ../no-such-tool が見つからないので読み込みません（作品の外のフォルダ）",
      `[プラグイン] ${join(base, "absent-tool")} が見つからないので読み込みません（作品の外のフォルダ）`,
    ]);
    expect(await limCheck()).toBe(true);
    const ws = await StudioWorkspace.open(loadProject(dir));
    expect(ws.check().diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("作品の中のフォルダは、無ければ lim check では止まり、制作画面は外して開いて診断にする", async () => {
    setPlugins(["./plugins/missing"]);
    expect(loadProject(dir).plugins).toEqual([STD_PLUGIN, join(dir, "plugins/missing")]);
    // 外して読むとき（lim studio）と同じ理由の文（絶対パスを入れない）
    await expect(limCheck()).rejects.toThrow("プラグイン ./plugins/missing を読み込めません（フォルダがありません）");
    const ws = await StudioWorkspace.open(loadProject(dir));
    expect(ws.projectInfo().pluginErrors).toEqual([{ spec: "./plugins/missing", message: "フォルダがありません" }]);
    expect(ws.check().diagnostics.filter((d) => d.category === "plugin").map((d) => d.message)).toEqual(["プラグイン ./plugins/missing を読み込めません（フォルダがありません）"]);
  });

  it("lim studio の読み方（skipBrokenPlugins）は、見つからないパッケージ、フォルダ、package.json、読み込むと止まる入口を外して開く", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mkdirSync(join(dir, "plugins/empty"), { recursive: true });
    mkdirSync(join(dir, "plugins/throws"), { recursive: true });
    writeFileSync(join(dir, "plugins/throws/package.json"), JSON.stringify({ name: "throws", type: "module", exports: { "./commands": "./commands.ts" } }));
    writeFileSync(join(dir, "plugins/throws/commands.ts"), 'throw new Error("わざと止める");\nexport default { name: "throws", commands: [] };\n');
    setPlugins(["no-such-package-xyz", "./plugins/nothing", "./plugins/empty", "./plugins/throws"]);
    // 省いたとき（lim check など）は、見つからないパッケージで、一文の理由で止まる（Node の require の生の文を出さない）
    expect(() => loadProject(dir)).toThrow("プラグイン no-such-package-xyz を読み込めません（パッケージが見つかりません）");
    const project = loadProject(dir, { skipBrokenPlugins: true });
    expect(project.plugins).toEqual([STD_PLUGIN, join(dir, "plugins/throws")]);
    const ws = await StudioWorkspace.open(project);
    expect(ws.projectInfo().pluginErrors).toEqual([
      { spec: "no-such-package-xyz", message: "パッケージが見つかりません" },
      { spec: "./plugins/nothing", message: "フォルダがありません" },
      { spec: "./plugins/empty", message: "package.json がありません" },
      { spec: "./plugins/throws", message: "わざと止める" },
    ]);
    // 未定義のコマンドは、プラグインの診断にまとめる
    writeFileSync(join(dir, "scenario/extra.lim"), "# extra\n@stamp a\n@stamp b\n@glow\n");
    const plugin = ws.check().diagnostics.filter((d) => d.category === "plugin");
    expect(plugin.map((d) => d.message)).toEqual([
      "プラグイン no-such-package-xyz を読み込めません（パッケージが見つかりません）",
      "プラグイン ./plugins/nothing を読み込めません（フォルダがありません）",
      "プラグイン ./plugins/empty を読み込めません（package.json がありません）",
      "プラグイン ./plugins/throws を読み込めません（わざと止める）",
    ]);
    expect(plugin[0]!.hint).toBe("未定義のコマンド @stamp、@glow（3 か所）は、このプラグインのものかもしれません。読み込めるように直すと消えます");
    expect(plugin[0]!.messageEn).toBe("Can't load the plugin no-such-package-xyz (package not found)");
    expect(ws.check().diagnostics.filter((d) => d.code === "unknown-command")).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("入口のファイルが無い、読むモジュールが無いプラグインは、Node の生の文でなく分かる理由にする（英語も）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const [name, text] of [
      ["noentry", null],
      ["nomodule", 'import "no-such-module-xyz";\nexport default { name: "nomodule", commands: [] };\n'],
    ] as const) {
      mkdirSync(join(dir, `plugins/${name}`), { recursive: true });
      writeFileSync(join(dir, `plugins/${name}/package.json`), JSON.stringify({ name, type: "module", exports: { "./commands": "./src/commands.ts" } }));
      if (text) {
        mkdirSync(join(dir, `plugins/${name}/src`), { recursive: true });
        writeFileSync(join(dir, `plugins/${name}/src/commands.ts`), text);
      }
    }
    setPlugins(["./plugins/noentry", "./plugins/nomodule"]);
    const ws = await StudioWorkspace.open(loadProject(dir, { skipBrokenPlugins: true }));
    expect(ws.projectInfo().pluginErrors).toEqual([
      { spec: "./plugins/noentry", message: "入口のファイル src/commands.ts がありません" },
      { spec: "./plugins/nomodule", message: "読み込むモジュール no-such-module-xyz が見つかりません（npm install で入れるか、import の書き方を確かめます）" },
    ]);
    expect(ws.check().diagnostics.filter((d) => d.category === "plugin").map((d) => d.messageEn)).toEqual([
      "Can't load the plugin ./plugins/noentry (the entry file src/commands.ts doesn't exist)",
      "Can't load the plugin ./plugins/nomodule (the module no-such-module-xyz it imports wasn't found (install it with npm install or check the import))",
    ]);
  });

  it("あるフォルダは読み、制作画面の入口だけのプラグインはゲームに入らない", async () => {
    const folder = studioOnlyPlugin();
    setPlugins(["../tool-plugin"]);
    const project = loadProject(dir);
    expect(project.plugins).toEqual([STD_PLUGIN, folder]);
    expect(await limCheck()).toBe(true);
    // プレイヤー（書き出すゲーム）が読むのは "./commands" と "./web" だけ。制作画面は "./studio" を読む
    process.env.LIMINALIA_PROJECT = dir;
    const { projectModule, studioModule } = await import("../../web/vite.config.ts");
    const load = (p: ReturnType<typeof projectModule>, id: string) => (p.load as (id: string) => string | null)(`\0${id}`) ?? "";
    expect(load(projectModule(project), "virtual:liminalia/project")).not.toContain("tool-plugin");
    expect(load(studioModule(project), "virtual:liminalia/studio")).toContain(join(folder, "src/studio.ts"));
  });
});
