import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { projectRuntimeOptions, RUNTIME_OPTION_OWNERS, type RuntimeOptions } from "@liminalia/runtime";
import { lineSave } from "@liminalia/editor/protocol";
import { localSweeps, readVoiceLockFile, type LocalProject } from "../src/play-from.ts";
import { LimProject } from "../src/model.ts";
import { buildInput, listAssets, loadCommands, readCastFile, readProjectInfo } from "../src/project.ts";
import { PARITY_PAGES, PARITY_STATE, writeParityProject } from "../../runtime/test/parity-project.ts";

// 作った実行器の設定を受け取る（実行器はそのまま動かす）
const made = vi.hoisted(() => [] as RuntimeOptions[]);
vi.mock("../../runtime/src/runtime.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../runtime/src/runtime.ts")>();
  class Runtime extends real.Runtime {
    constructor(...args: ConstructorParameters<typeof real.Runtime>) {
      super(...args);
      made.push(args[1] ?? {});
    }
  }
  return { ...real, Runtime };
});

/**
 * VS Code の「ここからテストプレイ」が言語サーバーの中で作る現在地が、作品の設定（言語、章、版、ボイスの番号の固定、実績、自動配置）を
 * 遊ぶ側と同じに使い、遊ぶ側と同じ行を通ること。遊ぶ側の結果は web/test/e2e/headless-parity.test.ts。
 */

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-parity-vscode-"));
  writeParityProject(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 言語サーバーの liminalia/playFrom と同じ形で、作品を読む（server.ts）。 */
async function local(): Promise<LocalProject> {
  const info = readProjectInfo(dir);
  const commands = await loadCommands(info, { trusted: true, workspaceFolders: [dir], node: process.execPath });
  const { speakers, cast } = readCastFile(info.paths.cast);
  const textOf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  const project = new LimProject(buildInput(info, { commands, speakers, cast }, textOf, (folder) => listAssets(join(info.paths.assets, folder))));
  const scripts = new Map([...project.scripts()].map(([name, script]) => [name, { script, text: project.input.files.get(name)!.text }] as const));
  return { scripts, registry: project.registry, speakers, cast, implementations: commands.implementations, config: info.config, data: () => undefined, voiceLock: readVoiceLockFile(info.paths.voiceLock) };
}

describe("言語サーバーの中で作る現在地と遊ぶ側の結果", () => {
  it("遊ぶ側と同じ行を通り、同じ状態で終わる", async () => {
    made.length = 0;
    const p = await local();
    const sweep = await localSweeps(p).sweep("xa", { from: 1, to: 40 });
    // 作った実行器はどれも、作品の設定から作るもの（projectRuntimeOptions）をすべて持つ
    const want: Record<string, unknown> = projectRuntimeOptions({ config: p.config, speakers: p.speakers, commands: p.implementations, cast: p.cast, voiceLock: p.voiceLock ?? null });
    expect(made.length).toBeGreaterThan(0);
    for (const got of made as Record<string, unknown>[]) {
      for (const [key, owner] of Object.entries(RUNTIME_OPTION_OWNERS)) {
        if (owner !== "project" || key === "loadData") continue;
        expect(key in got, key).toBe(key in want);
        if (key === "stripQuotes") expect((got.stripQuotes as () => boolean)(), key).toBe(true);
        else if (typeof want[key] === "function") expect(typeof got[key], key).toBe("function");
        else expect(got[key], key).toEqual(want[key]);
      }
      expect(typeof got.loadData).toBe("function");
    }
    const lines = Object.keys(sweep.lines).map(Number).sort((a, b) => a - b);
    expect(lines).toHaveLength(PARITY_PAGES.length);
    const last = lineSave(sweep, sweep.lines[lines.at(-1)!]!);
    expect(Object.fromEntries(Object.entries(last.stage.sprites).map(([who, s]) => [who, s.autoSlot]))).toEqual(PARITY_STATE.slots);
    expect(last.stage.voice?.auto?.アカリ?.next).toBe(PARITY_STATE.nextVoice);
    expect(last.gameVersion).toBe("1.0.0");
  });

  it("voice-lock.json を読み、無い・読めなければ null", () => {
    expect(readVoiceLockFile(join(dir, "voice-lock.json"))?.lines).toBeDefined();
    expect(readVoiceLockFile(join(dir, "none.json"))).toBeNull();
    expect(readVoiceLockFile(join(dir, "scenario", "xa.lim"))).toBeNull();
  });
});
