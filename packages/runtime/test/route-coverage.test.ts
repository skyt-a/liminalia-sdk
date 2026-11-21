import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coverage, routeCoverage, type Value } from "../src/index.ts";

/** 1 章で決めた変数で、2 章の行き先が分かれる。 */
const files: Record<string, string> = {
  ch1: [
    "どちらへ？", // 1
    "@choice", // 2
    "- 右 -> #right", // 3
    "- 左 -> #left", // 4
    "@end", // 5
    "# right", // 6
    "@set game.side = 1", // 7
    "@jump ch2", // 8
    "# left", // 9
    "@set game.side = 2", // 10
    "@jump ch2", // 11
  ].join("\n"),
  ch2: [
    "@if game.side == 1", // 1
    "右の先。", // 2
    '@title-screen ending="RIGHT END"', // 3
    "@end", // 4
    "@if game.side == 2", // 5
    "左の先。", // 6
    '@title-screen ending="LEFT END"', // 7
    "@end", // 8
    "どちらでもない。", // 9
  ].join("\n"),
};
const loadSource = async (f: string) => files[f]!;

describe("はじめから流すルートの網羅", () => {
  it("ほかのファイルで決めた変数を引き継いで分かれ、どのエンディングに届いたかを数える", async () => {
    const endings = new Map([
      ["ch2:3", "RIGHT END"],
      ["ch2:7", "LEFT END"],
    ]);
    const r = await routeCoverage({ entry: "ch1", loadSource, runs: 2, endings });
    expect(Object.fromEntries(r.endings)).toEqual({ "RIGHT END": 1, "LEFT END": 1 });
    expect([...(r.reached.get("ch2") ?? [])].sort()).toEqual([2, 6]);
    expect(r.runs.map((x) => x.choices)).toEqual([1, 1]);
    // ファイルごとに流す網羅では、変数の無い ch2 は「どちらでもない」にしか届かない
    const each = await coverage({ files: ["ch2"], loadSource, runs: 1 });
    expect([...each.files[0]!.reached]).toEqual([9]);
  });

  it("エンディングの一覧に無い終わり方は、終わった場所で数える", async () => {
    // 一覧を渡さなければ、@title-screen で止まった場所の名前になる
    const r = await routeCoverage({ entry: "ch1", loadSource, runs: 1 });
    expect([...r.endings.keys()]).toEqual(["止まった（ch2:3）"]);
    const plain = await routeCoverage({ entry: "ch2", loadSource, runs: 1 });
    expect([...plain.endings.keys()]).toEqual(["ファイルの終わり（ch2:9）"]);
  });
});

/**
 * 分岐の見本（fixtures/branching。選択肢の入れ子、合流、条件付きの選択肢、変数で分かれる結末、別のファイルへの結末）。
 * どの選択肢でも同じ番号を選び続ける流し方では、勇気か落とし物の結末に届かなかった。
 */
const FIXTURE = join(import.meta.dirname, "fixtures", "branching");
const fixture = async (f: string) => readFileSync(join(FIXTURE, "scenario", `${f}.lim`), "utf8");
const fixtureVariables = (JSON.parse(readFileSync(join(FIXTURE, "liminalia.json"), "utf8")) as { variables: Record<string, Value> }).variables;
/** 見本のプレイを終える命令の行 → エンディングの名前。 */
const fixtureEndings = async () => {
  const out = new Map<string, string>();
  for (const f of ["start", "epilogue"]) {
    (await fixture(f)).split("\n").forEach((line, i) => {
      const m = /^@title-screen ending="(.+)"$/.exec(line);
      if (m) out.set(`${f}:${i + 1}`, m[1]!);
    });
  }
  return out;
};

describe("選び方を広げて流す（全ルートテストと lim coverage）", () => {
  it("ファイルごとに流す網羅は、見本の本文の行をすべて通り、選び方を試し終える", async () => {
    const r = await coverage({ files: ["start", "epilogue"], loadSource: fixture, runtime: { variables: fixtureVariables } });
    for (const f of r.files) expect([...f.reached].sort((a, b) => a - b), f.file).toEqual(f.lines);
    expect(r.files.map((f) => f.complete)).toEqual([true, true]);
    expect(r.diagnostics).toEqual([]);
  });

  it("はじめから流すと、7 通りの選び方をすべて試し、4 つの結末すべてに届く", async () => {
    const endings = await fixtureEndings();
    const r = await routeCoverage({ entry: "start", loadSource: fixture, runtime: { variables: fixtureVariables }, endings });
    expect(r.complete).toBe(true);
    expect(r.runs).toHaveLength(7);
    expect(Object.fromEntries(r.endings)).toEqual({ 真実: 2, 勇気: 1, 落とし物: 2, 帰り道: 2 });
    const each = await coverage({ files: ["start", "epilogue"], loadSource: fixture, runtime: { variables: fixtureVariables } });
    for (const f of each.files) expect([...(r.reached.get(f.file) ?? [])].sort((a, b) => a - b), f.file).toEqual(f.lines);
  });

  it("上限の回数で止め、試し終えていないことを返す（まだ選ばれていない選択肢を先に試すので、少ない回数でも結末に届く）", async () => {
    const endings = await fixtureEndings();
    const r = await routeCoverage({ entry: "start", loadSource: fixture, runtime: { variables: fixtureVariables }, endings, runs: 4 });
    expect(r.complete).toBe(false);
    expect(r.runs).toHaveLength(4);
    expect(r.endings.size).toBeGreaterThanOrEqual(3);
    const each = await coverage({ files: ["start"], loadSource: fixture, runtime: { variables: fixtureVariables }, runs: 2 });
    expect(each.files[0]!.complete).toBe(false);
  });

  it("外れを選ぶと同じ選択肢へ戻る輪は、前と同じ状態に来たら打ち切り、選び方を試し終える", async () => {
    const quiz = ["# gate", "合言葉は？", "@choice", "- 月 -> #wrong", "- 星 -> #pass", "@end", "# wrong", "違う。", "@jump #gate", "# pass", "通れた。"].join("\n");
    const r = await routeCoverage({ entry: "q", loadSource: async () => quiz, runs: 32 });
    expect(r.complete).toBe(true);
    expect(r.runs.length).toBeLessThan(10);
    expect(r.runs.some((x) => x.merged)).toBe(true);
    // 合流して止めた回は、終わり方に数えない
    expect([...r.endings.values()].reduce((a, b) => a + b, 0)).toBe(r.runs.filter((x) => !x.merged).length);
    expect([...(r.reached.get("q") ?? [])].sort((a, b) => a - b)).toEqual([2, 8, 11]);
  });

  it("どの選択肢を選んでも本文の無い同じ選択肢へ戻る輪でも、終わる", async () => {
    const loop = ["# top", "@choice", "- 右 -> #top", "- 左 -> #top", "@end"].join("\n");
    const r = await coverage({ files: ["l"], loadSource: async () => loop, runs: 16 });
    expect(r.files[0]!.complete).toBe(true);
  });

  it("random は種ごとに選び方を広げる", async () => {
    const src = ["@if random() < 0.5", "表。", "@else", "裏。", "@end", "@choice", "- a -> #a", "- b -> #b", "@end", "# a", "A。", "# b", "B。"].join("\n");
    const r = await coverage({ files: ["r"], loadSource: async () => src, runs: 4, seeds: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(r.files[0]!.reached.size).toBe(4);
    expect(r.files[0]!.complete).toBe(true);
  });
});
