import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { projectRuntimeOptions, RUNTIME_OPTION_OWNERS, type RuntimeOptions } from "@liminalia/runtime";
import { runVoiceLock } from "../src/commands/voice-lock.ts";
import { runCoverage } from "../src/commands/coverage.ts";
import { findReach, readProjectScripts } from "../src/commands/reach.ts";
import { runProjectTests } from "../src/commands/test.ts";
import { traceProject } from "../src/commands/trace.ts";
import { loadContext } from "../src/context.ts";
import { buildSeedSave } from "../src/seed.ts";
import { PARITY_PAGES, PARITY_STATE, writeParityProject } from "../../runtime/test/parity-project.ts";

// 作った実行器の設定を受け取る（実行器はそのまま動かす）。画面なしの流しは、どれも最後は Runtime を作る
const made = vi.hoisted(() => [] as RuntimeOptions[]);
vi.mock("../../runtime/src/runtime.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../runtime/src/runtime.ts")>();
  class Runtime extends real.Runtime {
    constructor(...args: ConstructorParameters<typeof real.Runtime>) {
      super(...args);
      made.push(args[1] ?? {});
    }
  }
  return { ...real, Runtime };
});

/**
 * 画面なしで流すコマンド（lim trace、lim test、lim coverage、lim build --seed、lim reach）が、作品の設定（自動配置、commandDefaults、
 * 言語、章、版、台詞の括弧、ボイスの番号の固定、CG、実績、エンディングの種類）を遊ぶ側と同じに使い、遊ぶ側と同じ結果になること。
 * 遊ぶ側の結果（PARITY_PAGES、PARITY_STATE）は、web/test/e2e/headless-parity.test.ts がブラウザで流して確かめている。
 */

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-parity-"));
  writeParityProject(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const value = await fn();
    return { value, out: log.mock.calls.map((c) => String(c[0])).join("\n") };
  } finally {
    log.mockRestore();
  }
}

describe("画面なしの流しと遊ぶ側の結果", () => {
  it("lim trace は遊ぶ側と同じ本文を出し、同じ状態で終わる", async () => {
    const { trace, runtime } = await traceProject(dir, "xa");
    const pages = trace.flatMap((t) => (t.type === "page" ? [t.text] : []));
    expect(pages).toEqual(PARITY_PAGES);
    const voices = trace.flatMap((t) => (t.type === "page" && t.voice ? [t.voice] : []));
    expect(voices).toEqual(["voice/akari/007.ogg", "voice/akari/012.ogg"]);
    const sprites = runtime.state.stage.sprites;
    expect(Object.fromEntries(Object.entries(sprites).map(([who, s]) => [who, s.autoSlot]))).toEqual(PARITY_STATE.slots);
    expect(runtime.state.stage.voice?.auto?.アカリ?.next).toBe(PARITY_STATE.nextVoice);
    expect(runtime.system.cg_unlocked).toEqual(PARITY_STATE.cg);
    expect(Object.keys(runtime.system.achievements as object).sort()).toEqual(PARITY_STATE.achievements);
    expect(runtime.save().gameVersion).toBe("1.0.0");
  });

  it("lim test は遊ぶ側が出したものを期待に書いたテストを通す", async () => {
    const [file] = await runProjectTests(dir);
    expect(file!.problems).toEqual([]);
    expect(file!.tests.map((t) => [t.name, t.ok, t.failures.map((f) => f.ja)])).toEqual([["遊ぶ側と同じ", true, []]]);
  });

  it("lim coverage は遊ぶ側が通る行をすべて通る（ファイルごとの流しも、はじめからの流しも）", async () => {
    const { out } = await captured(() => runCoverage(dir, 2, 1, 2, { json: true }));
    const report = JSON.parse(out) as { files: { file: string; reached: number; total: number }[]; diagnostics: unknown[]; route: { lines: { reached: number; total: number }; kinds: Record<string, { reached: number; total: number }> } };
    expect(report.files).toEqual([{ file: "xa", reached: PARITY_PAGES.length, total: PARITY_PAGES.length, complete: true }]);
    expect(report.route.lines).toMatchObject({ reached: PARITY_PAGES.length, total: PARITY_PAGES.length });
    expect(report.route.kinds).toEqual({ special: { reached: 1, total: 1 } });
    expect(report.diagnostics).toEqual([]);
  });

  it("lim build --seed のセーブに作品の版が入る（書き出したゲームで読むと、save.version が作品の版になる）", async () => {
    const ctx = await loadContext(dir);
    const save = await buildSeedSave(ctx, { file: "xa", label: null, mode: "fresh" });
    expect(save.gameVersion).toBe("1.0.0");
    expect(Object.fromEntries(Object.entries(save.stage.sprites).map(([who, s]) => [who, s.autoSlot]))).toEqual(PARITY_STATE.slots);
  });

  it("lim reach は、作品の版で分かれる先の行にも届く", async () => {
    const ctx = await loadContext(dir);
    const r = await findReach(ctx, readProjectScripts(ctx), "xa:15", 5000);
    expect(r).toMatchObject({ found: true, file: "xa", line: 15 });
  });
});

/**
 * 入口ごとに、作った実行器の設定が、作品の設定から作るもの（projectRuntimeOptions）をすべて持つこと。入口を足したら、ここにも足す。
 * except は、その入口がわざと変えるもの（ボイスの番号を見る流しは、数え方の番号を見るので固定を使わない）。
 */
describe("画面なしの流しの入口と実行器の設定", () => {
  /** 作った実行器がどれも、作品の設定から作るものを同じ値で持つ。関数は同じ入力に同じ答えを返すかで見る。 */
  async function expectProjectOptions(run: () => Promise<unknown>, except: Partial<RuntimeOptions> = {}, at = dir): Promise<void> {
    const ctx = await loadContext(at);
    const lock = (() => {
      try {
        return JSON.parse(readFileSync(join(at, "voice-lock.json"), "utf8"));
      } catch {
        return null;
      }
    })();
    const want: Record<string, unknown> = { ...projectRuntimeOptions({ config: ctx.project.config, speakers: ctx.cast.speakers, commands: ctx.implementations, cast: ctx.cast.cast, voiceLock: lock, loadData: () => undefined }), ...except };
    made.length = 0;
    await captured(async () => run());
    expect(made.length).toBeGreaterThan(0);
    for (const got of made as Record<string, unknown>[]) {
      for (const [key, owner] of Object.entries(RUNTIME_OPTION_OWNERS)) {
        if (owner !== "project") continue;
        expect(key in got, key).toBe(key in want);
        const value = want[key];
        if (key === "commands") expect((got[key] as { name: string }[]).map((c) => c.name), key).toEqual((value as { name: string }[]).map((c) => c.name));
        else if (key === "cg") expect((got.cg as RuntimeOptions["cg"])?.("bgimage", "hill_night.webp"), key).toBe(true);
        else if (key === "stripQuotes") expect((got.stripQuotes as () => boolean)(), key).toBe((value as () => boolean)());
        else if (typeof value === "function") expect(typeof got[key], key).toBe("function");
        else expect(got[key], key).toEqual(value);
      }
    }
  }

  it("lim trace", () => expectProjectOptions(() => traceProject(dir, "xa")));
  it("lim test", () => expectProjectOptions(() => runProjectTests(dir)));
  it("lim coverage（ファイルごとと、はじめから）", () => expectProjectOptions(() => runCoverage(dir, 1, 1, 1, { json: true })));
  it("lim build --seed", () => expectProjectOptions(async () => buildSeedSave(await loadContext(dir), { file: "xa", label: null, mode: "successful_route" })));
  it("lim reach（道筋の探索と、選び方を短くする流し）", () => expectProjectOptions(async () => {
    const ctx = await loadContext(dir);
    return findReach(ctx, readProjectScripts(ctx), "xa:15", 5000);
  }));
  it("lim voice-lock（固定がまだ無いときに、数え方の番号を見る流し）", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "liminalia-parity-lock-"));
    try {
      cpSync(dir, fresh, { recursive: true });
      rmSync(join(fresh, "voice-lock.json"));
      await expectProjectOptions(() => runVoiceLock(fresh, 1), { voiceLock: null }, fresh);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
