import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { profileMarkdown, type ProfileReport } from "../src/commands/profile.ts";
import { writeProfileReport } from "@liminalia/studio/profile";

/** lim profile。プレイヤーを開いて計るのは Chromium が要るので、LIMINALIA_E2E_BROWSER=1 のときだけ動かす。 */

const LIM = resolve(import.meta.dirname, "../bin/lim.mjs");
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");

describe("計測.md", () => {
  it("要約、時間のかかった素材、ページごとの表を書く", () => {
    const r: ProfileReport = {
      target: "start",
      pages: 1,
      samples: [{ page: 1, at: "start:3", fps: 60, memory: 10 * 1024 * 1024, dom: 80, resources: 2, longFrames: 0 }],
      summary: {
        fps: { average: 60, min: 58 },
        frames: { count: 120, long: 1, longest: 70 },
        longTasks: null,
        memory: { start: 10 * 1024 * 1024, end: 12 * 1024 * 1024, max: 12 * 1024 * 1024, limit: null },
        dom: { max: 80 },
        resources: { image: { count: 1, bytes: 2048 }, audio: { count: 1, bytes: 4096 }, video: { count: 0, bytes: 0 }, font: { count: 0, bytes: 0 }, other: { count: 0, bytes: 0 } },
        slowest: [{ name: "bgimage/room.png", kind: "image", ms: 12, bytes: 2048 }],
      },
    };
    const md = profileMarkdown(r);
    expect(md).toContain("# パフォーマンス計測（start から 1 ページ）");
    expect(md).toContain("| 長いフレーム（50ms 超） | 1 / 120（一番長いもの 70 ms） |");
    expect(md).toContain("| bgimage/room.png | 12 ms | 2.0 KB |");
    expect(md).toContain("| 1 | start:3 | 60 | 10.0 MB | 80 | 2 | 0 |");
    expect(md).not.toContain("長いタスク");

    // 英語（lim profile --lang en、Studio の英語の表示）
    const en = profileMarkdown(r, "en");
    expect(en).toContain("# Performance profile (1 page from start)");
    expect(en).toContain("| Long frames (over 50 ms) | 1 / 120 (longest 70 ms) |");
    expect(en).toContain("| Images loaded | 1 image, 0.0 MB |");
    expect(en).toContain("| Audio loaded | 1 audio file, 0.0 MB |");
    expect(en).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
    // 英語は profile.md と profile.json、日本語は前からの 計測.md と 計測.json
    const root = mkdtempSync(join(tmpdir(), "liminalia-profile-names-"));
    try {
      writeProfileReport(root, r, undefined, "en");
      expect([existsSync(join(root, "exports/profile/profile.md")), existsSync(join(root, "exports/profile/profile.json")), existsSync(join(root, "exports/profile/計測.md"))]).toEqual([true, true, false]);
      writeProfileReport(root, r);
      expect(existsSync(join(root, "exports/profile/計測.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const work = mkdtempSync(join(tmpdir(), "liminalia-profile-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!process.env.LIMINALIA_E2E_BROWSER)("lim profile", { timeout: 180_000 }, () => {
  it("ひな形を進めながら計り、計測.md と計測.json を書く", () => {
    const dir = join(work, "p");
    cpSync(TEMPLATE, dir, { recursive: true });
    const r = spawnSync(process.execPath, [LIM, "profile", dir, "--pages", "8", "--wait", "200"], { encoding: "utf8", timeout: 170_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const json = JSON.parse(readFileSync(join(dir, "exports/profile/計測.json"), "utf8")) as ProfileReport;
    expect(json.pages).toBe(8);
    expect(json.summary.fps.average).toBeGreaterThan(0);
    expect(json.summary.frames.count).toBeGreaterThan(0);
    expect(json.summary.resources.image.count).toBeGreaterThan(0);
    expect(json.samples.map((s) => s.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(existsSync(join(dir, "exports/profile/計測.md"))).toBe(true);
  });
});
