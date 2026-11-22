import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadProject } from "@liminalia/project";
import { DataStore } from "../src/server/data-store.ts";
import { afterEach, describe, expect, it } from "vitest";
import { HISTORY_BYTES, HISTORY_KEEP, HISTORY_RECENT, keepVersion, listVersions, thinVersions, versionStamp, versionTime, type VersionInfo } from "../src/server/versions.ts";

/** 変更履歴の間引き（直近は細かく、古いほど粗く）。 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = new Date(2026, 10, 5, 15, 30, 0).getTime();

/** 何ミリ秒前に書いた版の並び（新しい順）。 */
const versions = (ago: number[], bytes = 100): VersionInfo[] =>
  [...ago]
    .sort((a, b) => a - b)
    .map((a) => {
      const time = now - a;
      return { id: versionStamp(new Date(time)), time, bytes };
    });

/** 残る版が何分前のものか。 */
const kept = (list: VersionInfo[]) => {
  const keep = thinVersions(list, now);
  return list.filter((v) => keep.has(v.id)).map((v) => (now - v.time) / MIN);
};

describe("間引き", () => {
  it("新しいものはそのまま、10 分前までは 1 分に一つ（その分の最後のもの）", () => {
    // 10 秒ごとに 9 分書いた
    const list = versions(Array.from({ length: 54 }, (_, i) => i * 10_000));
    const out = kept(list);
    expect(out.slice(0, HISTORY_RECENT)).toEqual([0, 10, 20, 30, 40].map((s) => s / 60));
    // 残りは書いた分ごとに一つ
    const minutes = out.slice(HISTORY_RECENT).map((m) => new Date(now - m * MIN).getMinutes());
    expect(new Set(minutes).size).toBe(minutes.length);
    expect(out.length).toBeLessThanOrEqual(HISTORY_RECENT + 10);
  });

  it("24 時間前までは 1 時間に一つ、それより前は 1 日に一つ", () => {
    const list = versions([
      // そのまま
      0,
      MIN,
      2 * MIN,
      3 * MIN,
      4 * MIN,
      // 13:30・13:25・13:20 は 13 時の一つ（13:30）
      2 * HOUR,
      2 * HOUR + 5 * MIN,
      2 * HOUR + 10 * MIN,
      // 10:29・10:28 は 10 時の一つ
      5 * HOUR + MIN,
      5 * HOUR + 2 * MIN,
      // 3 日の 15 時・14 時・13 時台は一日に一つ
      2 * DAY,
      2 * DAY + HOUR,
      2 * DAY + 2 * HOUR,
      9 * DAY,
    ]);
    expect(kept(list)).toEqual([0, 1, 2, 3, 4, 120, 301, 2 * 24 * 60, 9 * 24 * 60]);
  });

  it(`合わせて ${HISTORY_KEEP} 件、決まった大きさまで（古いものから消し、いちばん新しいものは残す）`, () => {
    const many = versions(Array.from({ length: 80 }, (_, i) => i * DAY));
    expect(thinVersions(many, now).size).toBe(HISTORY_KEEP);
    expect(kept(many).at(-1)).toBe((HISTORY_KEEP - 1) * 24 * 60);
    expect(kept(versions([0, DAY, 2 * DAY], HISTORY_BYTES / 2 + 1))).toEqual([0]);
    expect(kept(versions([0], HISTORY_BYTES * 2))).toEqual([0]);
  });

  it("id の日時を読む", () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 6);
    expect(versionStamp(d)).toBe("20260102-030405-006");
    expect(versionTime("20260102-030405-006-2")).toBe(d.getTime());
    expect(versionTime("bad")).toBeNull();
  });
});

describe("置き場", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("作品のデータの履歴も同じく間引く", () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-versions-"));
    cpSync(resolve(import.meta.dirname, "../../../templates/default"), dir, { recursive: true });
    const store = new DataStore(loadProject(dir));
    let hash: string | null = null;
    for (let i = 0; i < 12; i++) {
      const r = store.write("notes.json", `{"n":${i}}`, hash);
      if (!r.ok) throw new Error("conflict");
      hash = r.hash;
    }
    const kept = readdirSync(join(dir, ".liminalia/history/@data/notes.json"));
    expect(kept.length).toBeGreaterThanOrEqual(HISTORY_RECENT + 1);
    expect(kept.length).toBeLessThanOrEqual(HISTORY_RECENT + 2);
  });

  it("残して間引き、日時の読めない名前には触らない", () => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-versions-"));
    writeFileSync(join(dir, "memo.json"), "{}");
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, `${versionStamp(new Date(now - (10 + i) * DAY))}.json`), `"${i}"`);
    const id = keepVersion(dir, ".json", '"new"', new Date(now));
    const list = listVersions(dir, ".json");
    expect(list[0]!.id).toBe(id);
    expect(list).toHaveLength(4);
    expect(readdirSync(dir)).toContain("memo.json");
  });
});
