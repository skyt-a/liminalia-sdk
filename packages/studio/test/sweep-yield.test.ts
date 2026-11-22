import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProject } from "@liminalia/project";
import { StudioWorkspace } from "../src/server/workspace.ts";
import { makeShape, type ShapeInfo } from "../dev/shapes.ts";

/** 届かない行の探索（GET /sweep/reach）が、探している間も開発サーバーを止めず、ほかの行を頼まれたらやめること。 */

let dir: string;
let ws: StudioWorkspace;
let info: ShapeInfo;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-sweep-yield-"));
  info = makeShape("branchy", dir);
  ws = await StudioWorkspace.open(loadProject(dir));
  await ws.sweep(info.file);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** ms ごとに時計を見て、いちばん長く待たされた間（ミリ秒）を返す関数と、止める関数。 */
function watchStalls(ms = 10): { worst(): number; stop(): void } {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, ms);
  return { worst: () => worst, stop: () => clearInterval(timer) };
}

describe("届かない行の探索", () => {
  it("探している間も、ほかの処理へときどき手を離す", async () => {
    const stalls = watchStalls();
    const started = performance.now();
    const reach = ws.reach(info.file, info.unreachable!);
    // 1 秒ほど探させてから、ほかの行を頼んで前の探索をやめさせる
    await new Promise((r) => setTimeout(r, 1000));
    const other = ws.reach(info.file, info.unreachable! - 1);
    const first = await reach;
    stalls.stop();
    expect(first).toEqual({ sweep: null, reason: "cancelled" });
    expect(performance.now() - started).toBeLessThan(5000);
    // 手を離す間（30ms）に、時計の 10ms ごとの見回りより大きく遅れない
    expect(stalls.worst()).toBeLessThan(250);
    await other;
  }, 30000);

  it("ファイルが変わったら、探している途中のものをやめる", async () => {
    const reach = ws.reach(info.file, info.unreachable!);
    await new Promise((r) => setTimeout(r, 500));
    const { text, hash } = ws.fileText(info.file);
    const w = ws.write(info.file, `${text}\n`, hash, false);
    expect(w.ok).toBe(true);
    expect(await reach).toEqual({ sweep: null, reason: "cancelled" });
  }, 30000);

  it("頼みが切れたらやめる", async () => {
    const abort = new AbortController();
    const reach = ws.reach(info.file, info.unreachable!, abort.signal);
    await new Promise((r) => setTimeout(r, 300));
    abort.abort();
    expect(await reach).toEqual({ sweep: null, reason: "cancelled" });
  }, 30000);
});
