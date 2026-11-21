import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadProject, projectDataReader } from "../src/index.ts";

describe("作品のデータを読む", () => {
  const dir = mkdtempSync(join(tmpdir(), "liminalia-data-reader-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "t", title: "t", entry: "start" }));
  mkdirSync(join(dir, "data", "codes"), { recursive: true });
  writeFileSync(join(dir, "data", "code.en.json"), JSON.stringify({ lang: "en" }));
  writeFileSync(join(dir, "data", "codes", "v1.2.json"), JSON.stringify({ v: 1 }));

  it(".json を省ける。名前に点があっても拡張子とみなさない", () => {
    const read = projectDataReader(loadProject(dir));
    expect(read("code.en")).toEqual({ lang: "en" });
    expect(read("code.en.json")).toEqual({ lang: "en" });
    expect(read("codes/v1.2")).toEqual({ v: 1 });
    expect(read("code")).toBeUndefined();
    expect(read("../liminalia")).toBeUndefined();
  });
});
