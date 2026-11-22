import { describe, expect, it, vi } from "vitest";
import { HeadlessHost, Runtime, type RuntimeOptions, type Translator, type WalkOptions } from "@liminalia/runtime";

// 先へ流す実行器に渡した設定を受け取る（流しはしない）
const walked = vi.hoisted(() => [] as WalkOptions[]);
vi.mock("@liminalia/runtime", async (importOriginal) => {
  const real = await importOriginal<typeof import("@liminalia/runtime")>();
  return {
    ...real,
    walk: async (o: WalkOptions) => {
      walked.push(o);
      return { result: { reason: "end", at: { unit: "a", index: 0 } }, walk: { runtime: null, choices: [], assigned: {} } };
    },
  };
});

const { AHEAD_RUNTIME_OPTIONS, findChoiceAhead, hasChoiceAhead, unreadAhead } = await import("../src/system/choice-history.ts");

const translator = (name: string): Translator => ({ line: () => null, option: () => null, speaker: () => name });

/**
 * 実行器の設定をすべて書いたもの（Required なので、実行器の設定を足すと、ここに足すまで型の確かめが通らない）。
 * 値は見分けられれば何でもよい。
 */
const full: Required<RuntimeOptions> = {
  speakers: ["アカリ"],
  commands: [],
  commandDefaults: { chara: { "auto-layout": true } },
  seed: 7,
  maxSteps: 123,
  loadData: () => "遊ぶ側のデータ",
  onError: "stop",
  returnWithoutCall: "error",
  onAssign: () => undefined,
  onStep: () => undefined,
  beforeStep: () => undefined,
  variables: { "game.x": 1 },
  language: "ja",
  translator: translator("作ったとき"),
  platform: { device: "pc", app: false },
  chapters: [{ id: "c1", title: "一章", files: ["a"] }],
  achievementGoals: { a: 3 },
  endingAchievements: { e: { endings: "*", goal: 2 } },
  endingKinds: { bad: "バッド" },
  cast: {},
  autoLayout: { enter: "start" },
  voiceLock: { version: 1, lines: {} } as unknown as NonNullable<RuntimeOptions["voiceLock"]>,
  afterLoad: "a#after",
  cg: () => true,
  chatDialogue: { me: "わたし" },
  inlineChoices: true,
  stripQuotes: () => true,
  gameVersion: "1.2.0",
  programCache: new Map(),
};

describe("「次の選択肢へ」「次の未読へ」の先流しの実行器の設定", () => {
  it("遊んでいる実行器の設定を、分けたとおりに渡す（copy は同じ値、play は渡さない、ahead は今の言語と訳と上限）", async () => {
    // 表と、すべてを書いた設定の項目がそろっている
    expect(Object.keys(AHEAD_RUNTIME_OPTIONS).sort()).toEqual(Object.keys(full).sort());
    const runtime = new Runtime(new HeadlessHost({ loadSource: async () => "" }), full);
    expect(runtime.options).toBe(full);
    // 作ったあとに替えた言語と訳と機種（遊んでいる間に替わるもの）
    const now = translator("今");
    runtime.language = "en";
    runtime.translator = now;
    runtime.platform = { device: "mobile", app: true };
    const loadData = () => "先流しのデータ";
    walked.length = 0;
    const base = { runtime, loadSource: async () => "" };
    await unreadAhead({ ...base, loadData, isRead: () => true });
    await hasChoiceAhead({ ...base, loadData });
    await findChoiceAhead({ ...base, loadData });
    // データを渡さなければ、遊ぶ実行器を作ったときのもの
    await hasChoiceAhead(base);
    expect(walked).toHaveLength(4);
    for (const [i, o] of walked.entries()) {
      const given = o.runtime as Record<string, unknown>;
      for (const [key, use] of Object.entries(AHEAD_RUNTIME_OPTIONS)) {
        const live = full[key as keyof RuntimeOptions];
        if (use === "copy") expect(given[key], key).toBe(live);
        else if (use === "play") expect(key in given, key).toBe(false);
      }
      expect({ language: given.language, translator: given.translator, platform: given.platform, onError: given.onError }).toEqual({ language: "en", translator: now, platform: { device: "mobile", app: true }, onError: "continue" });
      expect(given.translator).toBe(now);
      expect(given.maxSteps).toBeGreaterThan(full.maxSteps);
      expect(given.loadData).toBe(i < 3 ? loadData : full.loadData);
    }
  });

  it("訳は実行器の設定でも渡せる", () => {
    const tr = translator("設定");
    expect(new Runtime(new HeadlessHost({ loadSource: async () => "" }), { translator: tr }).translator).toBe(tr);
    expect(new Runtime(new HeadlessHost({ loadSource: async () => "" })).translator).toBeNull();
  });
});
