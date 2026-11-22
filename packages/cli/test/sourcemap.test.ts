import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moveSourceMaps } from "../src/commands/build.ts";

/** build.sourcemap: "separate" は、組み立てた束の .map を配るファイルから外し、書き出し先の sourcemaps/ に同じ並びで残す。 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-sourcemap-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ソースマップを配るファイルから外す", () => {
  it(".map だけを同じ並びで移し、束は残す", () => {
    const web = join(dir, "web");
    mkdirSync(join(web, "engine"), { recursive: true });
    writeFileSync(join(web, "engine", "index-abc.js"), "console.log(1)\n");
    writeFileSync(join(web, "engine", "index-abc.js.map"), '{"version":3}');
    writeFileSync(join(web, "lm-sw.js.map"), '{"version":3}');
    writeFileSync(join(web, "index.html"), "<!doctype html>");
    const to = join(dir, "sourcemaps", "game-2026");
    expect(moveSourceMaps(web, to)).toBe(2);
    expect(existsSync(join(web, "engine", "index-abc.js.map"))).toBe(false);
    expect(existsSync(join(web, "engine", "index-abc.js"))).toBe(true);
    expect(readFileSync(join(to, "engine", "index-abc.js.map"), "utf8")).toBe('{"version":3}');
    expect(existsSync(join(to, "lm-sw.js.map"))).toBe(true);
  });
});
