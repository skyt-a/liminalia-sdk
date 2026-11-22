import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProject } from "@liminalia/project";
import { runPluginChecks, type CommandPlugin, type PluginCheckProject } from "@liminalia/plugin-host";
import { StudioWorkspace } from "../../studio/src/server/workspace.ts";
import { runCheck } from "../src/commands/check.ts";

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;

/** check を持つプラグインを作品に置く。body は check の中身。 */
function addPlugin(name: string, body: string): void {
  const folder = join(dir, "plugins", name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module", exports: { "./commands": "./commands.mjs" } }));
  writeFileSync(join(folder, "commands.mjs"), `export default { name: ${JSON.stringify(name)}, commands: [], check(project) { ${body} } };\n`);
  const path = join(dir, "liminalia.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as { plugins?: string[] };
  config.plugins = [...(config.plugins ?? []), `./plugins/${name}`];
  writeFileSync(path, JSON.stringify(config));
}

/** lim check --json の出力。 */
async function limCheck(): Promise<{ ok: boolean; diagnostics: { code: string; message: string; plugin?: string; severity: string; file: string }[] }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const ok = await runCheck(dir, true);
    return { ok, ...(JSON.parse(String(log.mock.calls[0]![0])) as { diagnostics: never[] }) };
  } finally {
    log.mockRestore();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-plugin-check-"));
  cpSync(TEMPLATE, dir, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("プラグインの check", () => {
  it("lim check と制作画面のチェックの両方で動き、分類は plugin に入る", async () => {
    addPlugin("rules", `return [{ severity: "warning", code: "too-few", message: "ファイルが " + project.scripts.size + " 個です", file: "start", line: 3 }, { severity: "error", code: "no-file", message: "無し" }];`);
    const cli = await limCheck();
    const fromCli = cli.diagnostics.filter((d) => d.plugin === "rules");
    // lim check はファイル、行、桁の順に並べる（liminalia.json が start より先）
    expect(fromCli.map((d) => d.code)).toEqual(["no-file", "too-few"]);
    expect(fromCli[0]!.file).toBe("liminalia.json");
    expect(cli.ok).toBe(false);
    const ws = await StudioWorkspace.open(loadProject(dir));
    const result = ws.check();
    const fromStudio = result.diagnostics.filter((d) => d.plugin === "rules");
    expect(fromStudio.map((d) => d.category)).toEqual(["plugin", "plugin"]);
    expect(result.counts.plugin).toBe(2);
    expect(fromStudio[0]!.message).toBe("ファイルが 2 個です");
    expect({ file: fromStudio[0]!.file, line: fromStudio[0]!.line }).toEqual({ file: "start", line: 3 });
  });

  it("投げてもチェック全体は止まらず、そのプラグインの診断として出る。ほかのプラグインは動く", async () => {
    addPlugin("broken", `throw new Error("こわれた");`);
    addPlugin("fine", `return [{ severity: "info", code: "ok", message: "動いた" }];`);
    const cli = await limCheck();
    const failed = cli.diagnostics.find((d) => d.plugin === "broken")!;
    expect(failed.code).toBe("plugin-check-failed");
    expect(failed.severity).toBe("error");
    expect(failed.message).toContain("こわれた");
    expect(cli.diagnostics.some((d) => d.plugin === "fine" && d.code === "ok")).toBe(true);
    const ws = await StudioWorkspace.open(loadProject(dir));
    const result = ws.check();
    expect(result.diagnostics.find((d) => d.plugin === "broken")).toMatchObject({ code: "plugin-check-failed", category: "plugin" });
    expect(result.counts.plugin).toBe(2);
  });

  it("データと素材を読める", async () => {
    addPlugin("reads", `return Object.keys(project.data("notes.json") ?? {}).map((k) => ({ severity: "warning", code: "x", message: k + ":" + project.assetExists("image", k) }));`);
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data/notes.json"), JSON.stringify({ "no-such.png": "memo" }));
    const cli = await limCheck();
    expect(cli.diagnostics.find((d) => d.plugin === "reads")?.message).toBe("no-such.png:false");
  });
});

describe("runPluginChecks", () => {
  const project = {} as PluginCheckProject;
  const run = (check: (p: PluginCheckProject) => unknown) => runPluginChecks([{ name: "p", commands: [], check } as unknown as CommandPlugin], project);

  it("配列でないもの（Promise など）と形の合わない診断はエラーにする", () => {
    expect(run(async () => [])[0]).toMatchObject({ code: "plugin-check-invalid", plugin: "p", severity: "error" });
    expect(run(() => [{ code: "x" }])[0]).toMatchObject({ code: "plugin-check-invalid" });
  });

  it("訳はそのまま持つ。check の無いプラグインは呼ばない", () => {
    expect(run(() => [{ severity: "info", code: "c", message: "文", messageEn: "text", hint: "案", hintEn: "idea" }])[0]).toMatchObject({ messageEn: "text", hintEn: "idea", file: "liminalia.json", line: 1, plugin: "p" });
    expect(runPluginChecks([{ name: "q", commands: [] }], project)).toEqual([]);
  });
});
