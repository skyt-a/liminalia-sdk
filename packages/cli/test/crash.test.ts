import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { transformSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crashPositions, runCrash } from "../src/commands/crash.ts";
import { originalPosition, parseSourceMap } from "../src/source-map.ts";

/** lim crash: 止まったときの記録のプログラムの位置を、書き出しのソースマップ（build.sourcemap: "separate"）で元の位置へ戻す。 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-crash-"));
  cpSync(TEMPLATE, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 縮めた束とそのソースマップ（元は src/sample.ts）。 */
function bundle() {
  const source = ["export function first(a: number) {", "  return a + 1;", "}", "", "export function broken(x: { y?: { z: number } }) {", "  const value = x.y!.z;", "  return value * 2;", "}", ""].join("\n");
  const r = transformSync(source, { loader: "ts", minify: true, sourcemap: "external", sourcefile: "../../src/sample.ts", format: "esm" });
  const code = r.code;
  // 縮めた束の中の「.z」の位置（1 から数えた行と桁）
  const index = code.indexOf(".z");
  const before = code.slice(0, index);
  const line = before.split("\n").length;
  const column = index - before.lastIndexOf("\n");
  return { code, map: r.map, line, column };
}

async function quiet<T>(run: () => Promise<T>): Promise<{ value: T; out: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const value = await run();
    return { value, out: log.mock.calls.map((c) => String(c[0])).join("\n") };
  } finally {
    log.mockRestore();
  }
}

describe("ソースマップを読む", () => {
  it("縮めた束の位置を、元のファイルと行と桁に戻す", () => {
    const b = bundle();
    const map = parseSourceMap(b.map);
    const at = originalPosition(map, b.line, b.column);
    expect(at).toMatchObject({ source: "../../src/sample.ts", line: 6 });
    expect(originalPosition(map, 999, 1)).toBeNull();
  });

  it("記録の source と stack から、束の位置を拾う（Chrome と Safari、Firefox の書き方）", () => {
    const found = crashPositions({
      source: "https://example.com/game/engine/index-abc.js:1:120",
      stack: "TypeError: x\n    at broken (https://example.com/game/engine/index-abc.js:1:120)\n    at https://example.com/game/engine/core-def.js:3:9\nbroken@file:///C:/Game/resources/engine/index-abc.js:1:121",
    });
    expect(found.map((p) => `${p.file}:${p.line}:${p.column}`)).toEqual(["engine/index-abc.js:1:120", "engine/core-def.js:3:9", "engine/index-abc.js:1:121"]);
  });
});

describe("lim crash", () => {
  it("記録の build の日時でソースマップの控えを選び、プログラムの位置を戻して、台本の位置と並べる", async () => {
    const b = bundle();
    const maps = join(dir, "dist", "sourcemaps", "game-2026-11-08T01-02-03-004Z", "engine");
    mkdirSync(maps, { recursive: true });
    writeFileSync(join(maps, "index-abc.js.map"), b.map);
    // 違う日時の控え（選ばない）
    mkdirSync(join(dir, "dist", "sourcemaps", "game-2026-11-01T00-00-00-000Z", "engine"), { recursive: true });
    const record = join(dir, "crash.json");
    writeFileSync(
      record,
      JSON.stringify({
        message: "Cannot read properties of undefined (reading 'z')",
        stack: `TypeError: Cannot read properties of undefined (reading 'z')\n    at broken (https://example.com/engine/index-abc.js:${b.line}:${b.column})`,
        kind: "error",
        source: `https://example.com/engine/index-abc.js:${b.line}:${b.column}`,
        at: "start:12",
        step: "start:14",
        trail: ["start:5", "start:12"],
        diagnostics: ["start:13 [unknown-asset] 素材がありません"],
        version: "1.0.0",
        build: "2026-11-08T01:02:03.004Z",
        date: "2026-11-09T00:00:00.000Z",
        userAgent: "",
      }),
    );
    const json = await quiet(() => runCrash(dir, record, { json: true }));
    expect(json.value).toBe(true);
    const j = JSON.parse(json.out) as { maps: string; source: { original: { source: string; line: number } }; stack: { original?: { source: string; line: number } }[]; at: string; step: string; trail: string[] };
    expect(j.maps).toContain("game-2026-11-08T01-02-03-004Z");
    expect(j.source.original).toMatchObject({ source: "src/sample.ts", line: 6 });
    expect(j.stack[0]!.original).toMatchObject({ source: "src/sample.ts", line: 6 });
    expect(j).toMatchObject({ at: "start:12", step: "start:14", trail: ["start:5", "start:12"] });
    const text = await quiet(() => runCrash(dir, record, {}));
    expect(text.out).toContain("src/sample.ts:6");
    expect(text.out).toContain("start:12");
    expect(text.out).toContain("[unknown-asset]");
  });

  it("合う控えが無ければ、そう言って台本の位置だけを出す", async () => {
    const record = join(dir, "crash.json");
    writeFileSync(record, JSON.stringify({ message: "x", stack: "", kind: "rejection", at: "start:3", version: "1", build: "2026-01-01T00:00:00.000Z", date: "", userAgent: "" }));
    const r = await quiet(() => runCrash(dir, record, {}));
    expect(r.value).toBe(false);
    expect(r.out).toContain("2026-01-01T00:00:00.000Z");
    expect(r.out).toContain("start:3");
  });
});
