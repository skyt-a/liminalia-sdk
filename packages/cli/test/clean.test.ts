import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEEP, keepAfterBuild, keepSourceMaps, oldBuilds, oldSourceMaps, pruneBuilds, pruneSourceMaps, runClean } from "../src/commands/clean.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-clean-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function made(path: string, bytes = 10): void {
  if (/\.(apk|aab)$/.test(path)) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes));
  } else {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "x.bin"), Buffer.alloc(bytes));
  }
}

describe("古い書き出しの片付け", () => {
  it("名前ごと（版ごと・apk と aab も別）に新しいものから残し、日時の無いものとブラウザ版には触らない", () => {
    const out = join(dir, "dist");
    for (const s of ["20260101_000000", "20260201_000000", "20260301_000000"]) {
      made(join(out, "mac", `Game_${s}`));
      made(join(out, "android", `Game_${s}.apk`));
    }
    made(join(out, "mac", "Game_demo_20260101_000000"));
    made(join(out, "android", "Game_20260101_000000.aab"));
    made(join(out, "mac", "my-notes"));
    made(join(out, "browser", "game"));
    const old = oldBuilds(out, 2).map((b) => b.path.slice(out.length + 1)).sort();
    expect(old).toEqual(["android/Game_20260101_000000.apk", "mac/Game_20260101_000000"]);
    const removed = pruneBuilds(out, 1, { targets: ["mac"], protect: [join(out, "mac", "Game_20260201_000000")] });
    expect(removed.map((b) => b.path.slice(out.length + 1)).sort()).toEqual(["mac/Game_20260101_000000"]);
    expect(existsSync(join(out, "mac", "Game_20260201_000000"))).toBe(true);
    expect(existsSync(join(out, "mac", "my-notes"))).toBe(true);
    expect(existsSync(join(out, "android", "Game_20260101_000000.apk"))).toBe(true);
  });

  it("書き出しのたびに残す数は LIMINALIA_KEEP、build.keep、既定 3 件の順。0 なら片付けない", () => {
    expect(keepAfterBuild(undefined, undefined)).toBe(DEFAULT_KEEP);
    expect(DEFAULT_KEEP).toBe(3);
    expect(keepAfterBuild(5, "")).toBe(5);
    expect(keepAfterBuild(5, " 2 ")).toBe(2);
    expect(keepAfterBuild(0, undefined)).toBeNull();
    expect(keepAfterBuild(5, "0")).toBeNull();
    expect(() => keepAfterBuild(-1, undefined)).toThrow(/0 以上の整数/);
    expect(() => keepAfterBuild(undefined, "two")).toThrow(/0 以上の整数/);
    expect(() => keepAfterBuild(1.5, undefined)).toThrow(/0 以上の整数/);
  });

  it("lim clean は build.keep が 0（片付けない）なら 1 件残す", () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "g", title: "G", entry: "start", build: { keep: 0 } }));
    for (const s of ["20260101_000000", "20260201_000000"]) made(join(dir, "dist", "windows", `G_${s}`));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      runClean(dir, {});
      expect(existsSync(join(dir, "dist", "windows", "G_20260101_000000"))).toBe(false);
      expect(existsSync(join(dir, "dist", "windows", "G_20260201_000000"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("lim clean は build.keep を既定にし、--dry-run なら消さない", () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "g", title: "G", entry: "start", build: { keep: 2 } }));
    for (const s of ["20260101_000000", "20260201_000000", "20260301_000000"]) made(join(dir, "dist", "windows", `G_${s}`));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      runClean(dir, { dryRun: true });
      expect(existsSync(join(dir, "dist", "windows", "G_20260101_000000"))).toBe(true);
      runClean(dir, {});
      expect(existsSync(join(dir, "dist", "windows", "G_20260101_000000"))).toBe(false);
      expect(existsSync(join(dir, "dist", "windows", "G_20260201_000000"))).toBe(true);
      expect(() => runClean(dir, { targets: ["browser"] })).toThrow(/browser/);
    } finally {
      log.mockRestore();
    }
  });
});

describe("ソースマップの控え（build.sourcemap: \"separate\"）の片付け", () => {
  const stamps = ["2026-11-01T00-00-00-000Z", "2026-11-02T00-00-00-000Z", "2026-11-03T09-30-15-120Z"];

  it("名前ごと（エディションとテスト版も別）に新しいものから残し、日時の形でない名前には触らない", () => {
    const out = join(dir, "dist");
    for (const t of stamps) {
      made(join(out, "sourcemaps", `game-${t}`));
      made(join(out, "sourcemaps", `game-test-${t}`));
    }
    made(join(out, "sourcemaps", `game-demo-${stamps[0]}`));
    made(join(out, "sourcemaps", "released-1.0"));
    expect(oldSourceMaps(out, 1).map((b) => b.path.slice(out.length + 1)).sort()).toEqual([
      `sourcemaps/game-${stamps[0]}`,
      `sourcemaps/game-${stamps[1]}`,
      `sourcemaps/game-test-${stamps[0]}`,
      `sourcemaps/game-test-${stamps[1]}`,
    ]);
    // 今回書き出したものは数えるが消さない
    const removed = pruneSourceMaps(out, 2, { protect: [join(out, "sourcemaps", `game-${stamps[0]}`)] });
    expect(removed.map((b) => b.path.slice(out.length + 1)).sort()).toEqual([`sourcemaps/game-test-${stamps[0]}`]);
    expect(existsSync(join(out, "sourcemaps", `game-${stamps[0]}`))).toBe(true);
    expect(existsSync(join(out, "sourcemaps", "released-1.0"))).toBe(true);
    expect(existsSync(join(out, "sourcemaps", `game-demo-${stamps[0]}`))).toBe(true);
    expect(oldSourceMaps(join(dir, "none"), 1)).toEqual([]);
  });

  it("残す数は build.keepSourcemaps、無ければ書き出しと同じ数。0 なら片付けない", () => {
    expect(keepSourceMaps(undefined, 3)).toBe(3);
    expect(keepSourceMaps(undefined, null)).toBeNull();
    expect(keepSourceMaps(10, 3)).toBe(10);
    expect(keepSourceMaps(0, 3)).toBeNull();
    expect(() => keepSourceMaps(-1, 3)).toThrow(/build.keepSourcemaps/);
    expect(() => keepSourceMaps(1.5, 3)).toThrow(/0 以上の整数/);
  });

  it("lim clean はソースマップの控えも片付け（--target sourcemaps で絞れる）、build.keepSourcemaps を既定にする", () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "g", title: "G", entry: "start", build: { keep: 1, keepSourcemaps: 2 } }));
    for (const t of stamps) made(join(dir, "dist", "sourcemaps", `g-${t}`));
    for (const s of ["20260101_000000", "20260201_000000"]) made(join(dir, "dist", "windows", `G_${s}`));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      runClean(dir, { dryRun: true });
      const listed = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(listed).toContain(`g-${stamps[0]}`);
      expect(listed).not.toContain(`g-${stamps[1]}`);
      expect(existsSync(join(dir, "dist", "sourcemaps", `g-${stamps[0]}`))).toBe(true);
      runClean(dir, { targets: ["sourcemaps"] });
      expect(existsSync(join(dir, "dist", "sourcemaps", `g-${stamps[0]}`))).toBe(false);
      expect(existsSync(join(dir, "dist", "sourcemaps", `g-${stamps[1]}`))).toBe(true);
      // --target sourcemaps は書き出しに触らない
      expect(existsSync(join(dir, "dist", "windows", "G_20260101_000000"))).toBe(true);
      // --keep はどちらにも効く
      runClean(dir, { keep: 1 });
      expect(existsSync(join(dir, "dist", "sourcemaps", `g-${stamps[1]}`))).toBe(false);
      expect(existsSync(join(dir, "dist", "sourcemaps", `g-${stamps[2]}`))).toBe(true);
      expect(existsSync(join(dir, "dist", "windows", "G_20260101_000000"))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});
