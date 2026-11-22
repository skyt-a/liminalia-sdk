import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { longPath } from "../src/web.ts";

describe("開発サーバーに渡すフォルダの長い名前（Windows の 8.3 形式）", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("Windows で ~ を含むパスは、OS に実際の名前を聞いて置き換える", () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-long-"));
    const short = join(dir, "RUNNER~1");
    mkdirSync(short);
    expect(longPath(short, "win32")).toBe(realpathSync.native(short));
  });

  it("~ を含まないパスと、Windows のほかの OS ではそのまま", () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-long-"));
    expect(longPath(dir, "win32")).toBe(dir);
    expect(longPath(join(dir, "A~1"), "darwin")).toBe(join(dir, "A~1"));
  });

  it("無いパスは置き換えずに返す", () => {
    expect(longPath("C:\\Users\\NOBODY~1\\none", "win32")).toBe("C:\\Users\\NOBODY~1\\none");
  });
});
