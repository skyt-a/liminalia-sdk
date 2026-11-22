import { describe, expect, it } from "vitest";
import { projectRuntimeOptions, RUNTIME_OPTION_OWNERS, type ProjectRuntimeSource, type RuntimeOptions, type Translator } from "../src/index.ts";

/**
 * 作品の設定から実行器の設定を作る関数（projectRuntimeOptions）と、実行器の設定の分け方（RUNTIME_OPTION_OWNERS）。
 * 遊ぶ側と画面なしの流しが同じ関数で作るので、作品の設定を片方にだけ渡す抜けが起きない。実行器の設定を足したら、
 * 分け方に足すまで型の確かめが通らず（satisfies）、"project" に分けたのに関数が埋めなければここで落ちる。
 */

/** 実行器の設定をすべて書いたもの（Required なので、実行器の設定を足すと、ここに足すまで型の確かめが通らない）。 */
const full: Required<RuntimeOptions> = {
  speakers: [],
  commands: [],
  commandDefaults: {},
  seed: 1,
  maxSteps: 1,
  loadData: () => undefined,
  onError: "continue",
  returnWithoutCall: "error",
  onAssign: () => undefined,
  onStep: () => undefined,
  beforeStep: () => undefined,
  variables: {},
  language: "",
  translator: null,
  platform: { device: "pc", app: false },
  chapters: [],
  achievementGoals: {},
  endingAchievements: {},
  endingKinds: {},
  cast: {},
  autoLayout: {},
  voiceLock: null,
  afterLoad: "",
  cg: () => false,
  chatDialogue: {},
  inlineChoices: true,
  stripQuotes: () => false,
  gameVersion: "",
  programCache: new Map(),
};

const translator: Translator = { line: () => null, option: () => null, speaker: () => null };

/** 作品の設定をすべて書いた元。 */
const source: ProjectRuntimeSource = {
  config: {
    version: "1.2.0",
    variables: { "game.x": 1 },
    afterLoad: "a#after",
    commandDefaults: { chara: { "auto-layout": true } },
    chapters: [{ id: "c1", title: "一章", files: ["a"] }],
    extra: {
      cg: [{ id: "n", images: ["night.webp"] }],
      achievements: [
        { id: "star", title: "星", goal: 3 },
        { id: "ends", title: "終わり", endings: "*", goal: 2 },
      ],
    },
    endingKinds: { special: "特別" },
    autoLayout: { enter: "start" },
    ui: { chat: { dialogue: true, me: "わたし" }, text: { quotes: "strip" }, choice: { position: "inline" }, languages: { en: { text: { quotes: "keep" } } } },
    languages: ["ja", "en"],
  },
  speakers: ["アカリ"],
  commands: [{ name: "x", run: () => undefined } as never],
  cast: { アカリ: { appearances: {} } },
  voiceLock: { lines: {} },
  loadData: () => "データ",
  language: "ja",
  translator,
};

describe("作品の設定から作る実行器の設定", () => {
  it("分け方は実行器の設定の項目をすべて持ち、呼ぶ側が決める項目には理由がある", () => {
    expect(Object.keys(RUNTIME_OPTION_OWNERS).sort()).toEqual(Object.keys(full).sort());
    for (const [key, owner] of Object.entries(RUNTIME_OPTION_OWNERS)) if (owner !== "project") expect(owner.caller.length, key).toBeGreaterThan(10);
  });

  it("関数が埋める項目は、分け方の project とちょうど同じ（呼ぶ側が決める項目は埋めない）", () => {
    const project = Object.entries(RUNTIME_OPTION_OWNERS).flatMap(([key, owner]) => (owner === "project" ? [key] : []));
    expect(Object.keys(projectRuntimeOptions(source)).sort()).toEqual(project.sort());
  });

  it("作品の設定を、遊ぶ側と同じ読み方で読む", () => {
    const o = projectRuntimeOptions(source);
    expect(o).toMatchObject({
      speakers: ["アカリ"],
      variables: { "game.x": 1 },
      afterLoad: "a#after",
      gameVersion: "1.2.0",
      commandDefaults: { chara: { "auto-layout": true } },
      chapters: [{ id: "c1", title: "一章", files: ["a"] }],
      achievementGoals: { star: 3 },
      endingAchievements: { ends: { endings: "*", goal: 2 } },
      endingKinds: { special: "特別" },
      autoLayout: { enter: "start" },
      voiceLock: { lines: {} },
      chatDialogue: { me: "わたし" },
      inlineChoices: true,
      language: "ja",
    });
    expect(o.translator).toBe(translator);
    expect(o.loadData?.("a")).toBe("データ");
    expect(o.cg?.("bgimage", "night.webp")).toBe(true);
    expect(o.cg?.("bgimage", "day.webp")).toBe(false);
    // 台詞の括弧は、遊ぶ言語の ui.languages を重ねたもの
    expect(o.stripQuotes?.()).toBe(true);
    expect(projectRuntimeOptions({ ...source, language: "en" }).stripQuotes?.()).toBe(false);
  });

  it("言語を渡さなければ原文の言語（languages の先頭。無ければ空）で、訳は無し", () => {
    const { language: _l, translator: _t, ...rest } = source;
    expect(projectRuntimeOptions(rest)).toMatchObject({ language: "ja", translator: null });
    expect(projectRuntimeOptions({ ...rest, config: {} })).toMatchObject({ language: "", translator: null, voiceLock: { lines: {} } });
  });

  it("形の違う値は使わない（lim check が知らせる）", () => {
    const o = projectRuntimeOptions({ config: { version: 3, variables: [1], afterLoad: "", commandDefaults: "x", chapters: { a: 1 }, extra: [], endingKinds: ["a"], autoLayout: 1, ui: "x", languages: "ja" }, speakers: [], commands: [], cast: {} });
    expect(o).toEqual({ speakers: [], commands: [], cast: {}, achievementGoals: {}, endingAchievements: {}, voiceLock: null, stripQuotes: expect.any(Function), language: "", translator: null });
    expect(o.stripQuotes?.()).toBe(false);
  });
});
