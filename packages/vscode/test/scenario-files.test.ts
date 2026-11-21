import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listScenarioFiles, scenarioName } from "../src/project.ts";

describe("サブフォルダの台本", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("lim check と同じ名前（part1/chapter2）で集め、. で始まるものは見ない", () => {
    const dir = mkdtempSync(join(tmpdir(), "liminalia-vscode-scenario-"));
    dirs.push(dir);
    for (const name of ["start.lim", "part1/chapter2.lim", ".trash/old.lim", "part1/notes.txt"]) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), "");
    }
    expect([...listScenarioFiles(dir).keys()]).toEqual(["part1/chapter2", "start"]);
    expect(listScenarioFiles(dir).get("part1/chapter2")).toBe(join(dir, "part1", "chapter2.lim"));
  });

  it("シナリオのフォルダの中のファイルなら、その台本の名前を返す", () => {
    const dir = join(tmpdir(), "game", "scenario");
    expect(scenarioName(dir, join(dir, "start.lim"))).toBe("start");
    expect(scenarioName(dir, join(dir, "part1", "chapter2.lim"))).toBe("part1/chapter2");
    expect(scenarioName(dir, join(dir, "..", "other.lim"))).toBeNull();
    expect(scenarioName(dir, join(dir, ".trash", "old.lim"))).toBeNull();
    expect(scenarioName(dir, join(dir, "notes.txt"))).toBeNull();
  });
});
