import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProject } from "@liminalia/project";
import { StudioWorkspace } from "../../studio/src/server/workspace.ts";
import { runCheck } from "../src/commands/check.ts";
import { runFmt } from "../src/commands/fmt.ts";

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;

/** 作品の scenario/ に台本を置く（name は "part1/side" のような名前）。 */
function put(name: string, text: string): void {
  const path = join(dir, "scenario", `${name}.lim`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** console.log に出したものを集めて返す。 */
async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const result = await fn();
    return { result, out: log.mock.calls.map((c) => String(c[0])).join("\n") };
  } finally {
    log.mockRestore();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-subfolder-"));
  cpSync(TEMPLATE, dir, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("サブフォルダの台本", () => {
  it("lim check はサブフォルダの台本も検査し、飛び先として見る（名前は制作画面と同じ）", async () => {
    put("part1/side", "# top\n寄り道の本文\n@jump epilogue#dawn\n");
    const start = join(dir, "scenario", "start.lim");
    writeFileSync(start, readFileSync(start, "utf8").replace("# start\n", "# start\n@jump part1/side#top\n"));
    const ok = await quiet(() => runCheck(dir, true));
    const json = JSON.parse(ok.out) as { files: number; errors: number };
    expect(json.errors).toBe(0);
    expect(json.files).toBe(3);
    expect(ok.result).toBe(true);
    const ws = await StudioWorkspace.open(loadProject(dir));
    expect(ws.files()).toEqual(["epilogue", "part1/side", "start"]);

    // サブフォルダの台本の誤りは、その名前で知らせる
    put("part1/side", "# top\n@jump nowhere\n");
    const bad = await quiet(() => runCheck(dir, true));
    const diagnostics = (JSON.parse(bad.out) as { diagnostics: { file: string; severity: string }[] }).diagnostics.filter((d) => d.severity === "error");
    expect(bad.result).toBe(false);
    expect(diagnostics.map((d) => d.file)).toContain("part1/side");
  });

  it("lim fmt もサブフォルダの台本を整える", async () => {
    put("part1/side", "@bg   room\n本文\n");
    const r = await quiet(() => runFmt(dir, true));
    expect(r.result).toBe(false);
    expect(r.out).toContain("part1/side.lim");
  });
});
