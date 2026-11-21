import { describe, expect, it } from "vitest";
import { ENDINGS_KEY, parseExpr } from "@liminalia/lang";
import { HeadlessHost } from "../src/headless.ts";
import { Runtime, type RuntimeOptions } from "../src/runtime.ts";

/** 選ぶ番号ごとにエンディングへ進む台本。 */
const SCRIPT = [
  "@choice",
  "- 眠る -> #sleep",
  "- 待つ -> #wait",
  "- 出る -> #leave",
  "- 古い -> #old",
  "- 秘密 -> #secret",
  "@end",
  "# sleep",
  "眠った。",
  '@title-screen ending=bad title="眠りの底"',
  "# wait",
  "待った。",
  '@title-screen ending=bad title="待ちぼうけ"',
  "# leave",
  "朝になった。",
  "@title-screen ending=true",
  "# old",
  "前の書き方。",
  '@title-screen ending="BAD END"',
  "# secret",
  "秘密の扉。",
  "@title-screen ending=secret",
].join("\n");

/** 一つの全セーブ共通の変数で、選び方を変えて何回か遊ぶ。 */
async function playAll(picks: number[], options: Partial<RuntimeOptions> = {}, translate?: Record<string, string>) {
  const system = {};
  const runs: { runtime: Runtime; host: HeadlessHost }[] = [];
  for (const pick of picks) {
    const host = new HeadlessHost({ loadSource: async () => SCRIPT, choices: [pick] });
    const runtime = new Runtime(host, { endingKinds: { secret: "SECRET END" }, ...options });
    runtime.system = system;
    if (translate) runtime.translator = { line: () => null, option: () => null, speaker: () => null, arg: (file, source) => translate[`${file}:${source}`] ?? null };
    await runtime.start("a");
    runs.push({ runtime, host });
  }
  return { system, runs, last: runs.at(-1)!.runtime };
}

describe("見たエンディングの記録と endings()", () => {
  it("種類ごとに、見たエンディングを数える（同じエンディングは何度見ても一つ）", async () => {
    const { last } = await playAll([0, 0, 1, 2]);
    const count = (expr: string) => last.eval(parseExpr(expr));
    expect([count("endings()"), count('endings("bad")'), count('endings("true")'), count('endings("good")'), count('endings("*")')]).toEqual([3, 2, 1, 0, 3]);
  });

  it("移していない前の書き方は文言から読んだ種類で数え、作品が足した種類も数える", async () => {
    const { last } = await playAll([3, 4]);
    expect([last.eval(parseExpr('endings("bad")')), last.eval(parseExpr('endings("secret")'))]).toEqual([1, 1]);
  });

  it("英語で遊んでも（title を訳しても）、原文で数えるので同じ", async () => {
    const plain = await playAll([0, 1, 3]);
    const english = await playAll([0, 1, 3], { language: "en" }, { "a:眠りの底": "Deep Sleep", "a:待ちぼうけ": "Waiting", "a:BAD END": "Bad Ending" });
    expect(english.system).toEqual(plain.system);
    expect(Object.keys((plain.system as Record<string, Record<string, unknown>>)[ENDINGS_KEY]!).sort()).toEqual(["a#old|bad|", "a#sleep|bad|眠りの底", "a#wait|bad|待ちぼうけ"]);
    // 訳した名前は画面に渡す（描画側は訳を出す）
    const sent = english.runs[0]!.host.trace.find((t) => t.type === "command" && t.name === "title-screen");
    expect(sent?.type === "command" ? sent.args.title : null).toBe("Deep Sleep");
  });

  it("見た数で進める実績（extra.achievements の endings）は、届いたときに解除して @achieve-progress の形で知らせる", async () => {
    const { runs, system } = await playAll([0, 0, 1, 2], { endingAchievements: { all_bad: { endings: "bad", goal: 2 }, any: { endings: "*", goal: 3 } } });
    const sent = runs.flatMap((r) => r.host.trace.flatMap((t) => (t.type === "command" && t.name === "achieve-progress" ? [t.args] : [])));
    expect(sent).toEqual([
      { id: "all_bad", value: 1, goal: 2, unlocked: false },
      { id: "any", value: 1, goal: 3, unlocked: false },
      { id: "all_bad", value: 2, goal: 2, unlocked: true },
      { id: "any", value: 2, goal: 3, unlocked: false },
      { id: "any", value: 3, goal: 3, unlocked: true },
    ]);
    const s = system as { achievement_progress: Record<string, number>; achievements: Record<string, string> };
    expect(s.achievement_progress).toEqual({ all_bad: 2, any: 3 });
    expect(Object.keys(s.achievements).sort()).toEqual(["all_bad", "any"]);
  });

  it("ending=true は種類の true として画面に渡す", async () => {
    const { runs } = await playAll([2]);
    const sent = runs[0]!.host.trace.find((t) => t.type === "command" && t.name === "title-screen");
    expect(sent?.type === "command" ? sent.args.ending : null).toBe("true");
  });
});
