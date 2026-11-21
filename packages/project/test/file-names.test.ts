import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportFileNames, fileNameProblems, suggestFileName } from "../src/file-names.ts";

const errors = (name: string, platform: "windows" | "mac" | "linux") => fileNameProblems(name, platform).filter((p) => p.level === "error").length;

describe("書き出すファイルの名前", () => {
  it("UTF-8 のバイト数で名前の上限を確かめる", () => {
    expect(errors("あ".repeat(66), "linux")).toBe(0);
    expect(errors("あ".repeat(67), "linux")).toBe(1);
    expect(errors("a".repeat(200), "linux")).toBe(0);
    expect(errors("a".repeat(201), "linux")).toBe(1);
    expect(errors("😀".repeat(50), "linux")).toBe(0);
    expect(errors("😀".repeat(51), "linux")).toBe(1);
    expect(suggestFileName("あ".repeat(86), "id")).toBe("あ".repeat(66));
    expect(suggestFileName("😀".repeat(64), "id")).toBe("😀".repeat(50));
  });

  it("上限の名前に日時と拡張子を足してもフォルダを作れる", () => {
    const name = `${"あ".repeat(66)}aa`;
    expect(errors(name, "linux")).toBe(0);
    const component = `${name}_20261121_101413.apk`;
    expect(Buffer.byteLength(component)).toBeLessThanOrEqual(255);
    const dir = mkdtempSync(join(tmpdir(), "liminalia-file-name-"));
    try {
      expect(() => mkdirSync(join(dir, component))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("OS ごとに使えない名前を知らせる", () => {
    expect(errors("STARS -星を待つ丘-", "windows")).toBe(0);
    expect(errors("STARS -星を待つ丘-", "mac")).toBe(0);
    expect(errors("Stars: Night", "windows")).toBe(1);
    expect(errors("Stars: Night", "mac")).toBe(1);
    expect(errors("Stars: Night", "linux")).toBe(0);
    expect(errors("a?b", "windows")).toBe(1);
    expect(errors("a?b", "mac")).toBe(0);
    expect(errors("a/b", "linux")).toBe(1);
    // 予約名（拡張子が付いていても）、末尾の空白とピリオド
    expect(errors("CON", "windows")).toBe(1);
    expect(errors("nul.txt", "windows")).toBe(1);
    expect(errors("console", "windows")).toBe(0);
    expect(errors("game.", "windows")).toBe(1);
    expect(errors("game ", "windows")).toBe(1);
    expect(errors("game.", "mac")).toBe(0);
    // 制御文字、空、長すぎる名前はどの OS でも
    expect(errors("a\tb", "linux")).toBe(1);
    expect(errors("  ", "mac")).toBe(1);
    expect(errors("あ".repeat(101), "linux")).toBe(1);
    // Linux の先頭の - は警告だけ
    expect(fileNameProblems("-game", "linux")).toEqual([{ level: "warning", message: expect.stringContaining("オプション") }]);
  });

  it("どの OS でも使える名前の案を作る", () => {
    for (const [from, to] of [
      ["Stars: Night?", "Stars： Night？"],
      ["CON", "CON_"],
      ["CON.txt", "CON_.txt"],
      ["nul.tar.gz", "nul_.tar.gz"],
      ["game. ", "game"],
      ["-x", "_x"],
      ['<>:"/\\|?*', "＜＞：＂／＼｜？＊"],
      ["a\tb", "ab"],
      ["...", "id"],
    ] as const) {
      const s = suggestFileName(from, "id");
      expect(s).toBe(to);
      for (const p of ["windows", "mac", "linux"] as const) expect(errors(s, p)).toBe(0);
    }
  });

  it("書き出し先ごとに作る名前と、確かめる OS", () => {
    const cfg = { id: "my_game", title: "A:B" };
    const files = exportFileNames(cfg, ["windows", "linux", "browser"], "mac");
    expect(files.map((f) => [f.name, f.platform, f.problems.some((p) => p.level === "error")])).toEqual([
      ["A:B", "windows", true],
      ["A:B", "mac", true],
      ["A:B", "linux", false],
      ["my_game", "linux", false],
    ]);
    // build.executableName があればそれを使う
    expect(exportFileNames({ ...cfg, build: { executableName: "AB" } }, ["windows"], "mac").every((f) => f.name === "AB" && f.problems.length === 0)).toBe(true);
    // ブラウザだけなら確かめる名前は無い
    expect(exportFileNames(cfg, ["browser"], "mac")).toEqual([]);
  });
});
