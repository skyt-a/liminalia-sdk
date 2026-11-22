import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "@liminalia/lang";
import { loadProject } from "@liminalia/project";
import { projectRuntimeOptions, RUNTIME_OPTION_OWNERS, type RuntimeOptions } from "@liminalia/runtime";
import { lineSave } from "../src/protocol.ts";
import { lockVoices } from "../src/server/voice-lock.ts";
import { StudioWorkspace } from "../src/server/workspace.ts";
import { PARITY_PAGES, PARITY_SCENARIO, PARITY_STATE, writeParityProject } from "../../runtime/test/parity-project.ts";

// 作った実行器の設定を受け取る（実行器はそのまま動かす）
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
 * 制作画面の画面なしの流し（全ルートテストと現在地）が、作品の設定（言語、章、版、台詞の括弧、ボイスの番号の固定、実績、
 * エンディングの種類、自動配置）を遊ぶ側と同じに使い、遊ぶ側と同じ行を通ること。遊ぶ側の結果は web/test/e2e/headless-parity.test.ts。
 */

let dir: string;
let ws: StudioWorkspace;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-parity-studio-"));
  writeParityProject(dir);
  ws = await StudioWorkspace.open(loadProject(dir));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 遊ぶ側が出す本文の行（1 から）。 */
const pageLines = (() => {
  const script = parse(PARITY_SCENARIO, "xa", { speakers: ["アカリ", "ソウ", "ラジオ"] });
  const out: number[] = [];
  const walk = (body: typeof script.body) => {
    for (const s of body) {
      if (s.kind === "say" || s.kind === "prose") out.push(s.line);
      if (s.kind === "if") for (const b of s.branches) walk(b.body);
    }
  };
  walk(script.body);
  return out;
})();

describe("制作画面の画面なしの流しと遊ぶ側の結果", () => {
  it("全ルートテストは遊ぶ側が通る本文の行をすべて通る", async () => {
    expect(pageLines).toHaveLength(PARITY_PAGES.length);
    const r = await ws.coverage(2);
    expect(r.files).toEqual([{ file: "xa", lines: PARITY_PAGES.length, reached: PARITY_PAGES.length, unreached: [] }]);
    expect(r.diagnostics).toEqual([]);
  });

  it("現在地は遊ぶ側と同じ行を通り、同じ状態で終わる", async () => {
    const { sweep } = await ws.sweep("xa");
    expect(Object.keys(sweep.lines).map(Number).sort((a, b) => a - b)).toEqual(pageLines);
    const last = lineSave(sweep, sweep.lines[pageLines.at(-1)!]!);
    expect(Object.fromEntries(Object.entries(last.stage.sprites).map(([who, s]) => [who, s.autoSlot]))).toEqual(PARITY_STATE.slots);
    // 最後の台詞のあとの次のボイスの番号（固定した 12 の次）
    expect(last.stage.voice?.auto?.アカリ?.next).toBe(PARITY_STATE.nextVoice);
    expect(last.gameVersion).toBe("1.0.0");
  });
});

/**
 * 入口ごとに、作った実行器の設定が、作品の設定から作るもの（projectRuntimeOptions）をすべて持つこと。入口を足したら、ここにも足す。
 * except は、その入口がわざと変えるもの（ボイスの番号を見る流しは、数え方の番号を見るので固定を使わない）。
 */
describe("制作画面の画面なしの流しの入口と実行器の設定", () => {
  async function expectProjectOptions(w: StudioWorkspace, run: () => Promise<unknown>, except: Partial<RuntimeOptions> = {}): Promise<void> {
    const root = w.project.root;
    const config = JSON.parse(readFileSync(join(root, "liminalia.json"), "utf8"));
    const lock = (() => {
      try {
        return JSON.parse(readFileSync(join(root, "voice-lock.json"), "utf8"));
      } catch {
        return null;
      }
    })();
    const cast = JSON.parse(readFileSync(join(root, "cast.json"), "utf8"));
    const want: Record<string, unknown> = { ...projectRuntimeOptions({ config, speakers: cast.speakers, commands: [], cast: cast.cast, voiceLock: lock, loadData: () => undefined }), ...except };
    made.length = 0;
    await run();
    expect(made.length).toBeGreaterThan(0);
    for (const got of made as Record<string, unknown>[]) {
      for (const [key, owner] of Object.entries(RUNTIME_OPTION_OWNERS)) {
        if (owner !== "project") continue;
        expect(key in got, key).toBe(key in want);
        const value = want[key];
        if (key === "commands") expect((got.commands as unknown[]).length, key).toBeGreaterThan(0);
        else if (key === "cg") expect((got.cg as RuntimeOptions["cg"])?.("bgimage", "hill_night.webp"), key).toBe(true);
        else if (key === "stripQuotes") expect((got.stripQuotes as () => boolean)(), key).toBe((value as () => boolean)());
        else if (typeof value === "function") expect(typeof got[key], key).toBe("function");
        else expect(got[key], key).toEqual(value);
      }
    }
  }

  it("全ルートテスト", () => expectProjectOptions(ws, () => ws.coverage(1)));
  it("現在地と、届かない行の道筋の探索", async () => {
    const fresh = await StudioWorkspace.open(loadProject(dir));
    await expectProjectOptions(fresh, async () => {
      await fresh.sweep("xa");
      await fresh.reach("xa", 15);
    });
  });
  it("ボイスの番号の固定（固定がまだ無いときに、数え方の番号を見る流し）", async () => {
    const other = mkdtempSync(join(tmpdir(), "liminalia-parity-studio-lock-"));
    try {
      cpSync(dir, other, { recursive: true });
      rmSync(join(other, "voice-lock.json"));
      const w = await StudioWorkspace.open(loadProject(other));
      await expectProjectOptions(w, () => lockVoices(w, 1), { voiceLock: null });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("liminalia.json の版、言語、章、台詞の括弧が変わったら、現在地を作り直させる", async () => {
    const other = mkdtempSync(join(tmpdir(), "liminalia-parity-studio-config-"));
    try {
      cpSync(dir, other, { recursive: true });
      const w = await StudioWorkspace.open(loadProject(other));
      const before = await w.sweep("xa");
      expect(before.sweep.lines[15]).toBeDefined();
      const path = join(other, "liminalia.json");
      const config = JSON.parse(readFileSync(path, "utf8"));
      for (const change of [{ version: "2.0.0" }, { languages: ["en", "ja"] }, { chapters: [] }, { ui: { text: { quotes: "keep" } } }]) {
        writeFileSync(path, JSON.stringify({ ...config, ...change }));
        expect(w.variablesChanged(), JSON.stringify(change)).toBe(true);
        writeFileSync(path, JSON.stringify(config));
        expect(w.variablesChanged(), JSON.stringify(change)).toBe(true);
      }
      expect(w.variablesChanged()).toBe(false);
      writeFileSync(path, JSON.stringify({ ...config, version: "2.0.0" }));
      w.variablesChanged();
      expect((await w.sweep("xa")).sweep.lines[15]).toBeUndefined();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
