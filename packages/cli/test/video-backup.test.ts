import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { backupResume } from "../src/video-backup.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("再開で録り直す動画と進行記録の控えを作り、元は変更しない", () => {
  const dir = mkdtempSync(join(tmpdir(), "video-backup-test-")); dirs.push(dir);
  writeFileSync(join(dir, "liminalia-video.json"), '{"finished":false}');
  writeFileSync(join(dir, "006_ep1.mp4"), "old video");
  const backup = backupResume(dir, [{ n: 6, name: "ep1", key: "ep1", file: "006_ep1.mp4", status: "recording" }]);
  expect(readFileSync(join(backup, "006_ep1.mp4"), "utf8")).toBe("old video");
  expect(readFileSync(join(backup, "liminalia-video.json"), "utf8")).toBe('{"finished":false}');
  expect(readFileSync(join(dir, "006_ep1.mp4"), "utf8")).toBe("old video");
});

test("記録の不正なパスは控えを作る前に拒否する", () => {
  const dir = mkdtempSync(join(tmpdir(), "video-backup-test-")); dirs.push(dir);
  expect(() => backupResume(dir, [{ n: 6, name: "bad", key: "bad", file: "../escape.mp4", status: "recording" }])).toThrow();
  expect(readdirSync(dir)).toEqual([]);
  expect(existsSync(join(dir, "../escape.mp4"))).toBe(false);
});
