import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "@liminalia/project";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorChecks, nodeSatisfies } from "../src/commands/doctor.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-doctor-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("lim doctor", () => {
  it("Node の版を engines の書き方で比べる", () => {
    const range = "^22.23.4 || ^24.22.1 || >=26.12.1";
    expect(nodeSatisfies("v22.23.4", range)).toBe(true);
    expect(nodeSatisfies("v22.23.3", range)).toBe(false);
    expect(nodeSatisfies("v23.9.0", range)).toBe(false);
    expect(nodeSatisfies("v24.30.0", range)).toBe(true);
    expect(nodeSatisfies("v27.0.0", range)).toBe(true);
  });

  // 手元の道具（ffmpeg、cwebp、security、java など）を一つずつ起こして確かめるので、全体を並べて流すと 10 秒を超える
  it("作品の設定で使うものを「要る」にし、--target でも足す", { timeout: 60_000 }, () => {
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "g", title: "G", entry: "start", build: { windows: { installer: true }, steam: { appId: 480, depots: { windows: 481 } }, browser: { compress: { audio: {} } } } }));
    const env = { PATH: join(dir, "empty"), LIMINALIA_MAKENSIS: join(dir, "none"), LIMINALIA_STEAMCMD: join(dir, "none") };
    const checks = doctorChecks(loadProject(dir), ["update"], env);
    const of = (name: string) => checks.find((c) => c.name.startsWith(name))!;
    expect(of("makensis")).toMatchObject({ ok: false, need: "required" });
    expect(of("steamcmd")).toMatchObject({ ok: false, need: "required" });
    expect(of("ffmpeg").need).toBe("required");
    expect(of("cwebp").need).toBe("optional");
    expect(of("マニフェストの署名の秘密鍵")).toMatchObject({ ok: false, need: "required" });
    expect(of("bundletool").need).toBe("optional");
    // 作品を渡さなければ、共通のもののほかは「任意」
    const plain = doctorChecks(null, [], env);
    expect(plain.filter((c) => c.need === "required").map((c) => c.name)).toEqual(["Node.js", "Chromium（書き出しの確かめ、lim shot、lim playtest）"]);
  });
});
