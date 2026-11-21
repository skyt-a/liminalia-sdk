import { describe, expect, it } from "vitest";
import { coverage, findRoute, walk, type CommandContext, type CommandImpl, type PickOutcome, type Walk } from "../src/index.ts";

/** 外れを選ぶと選択肢に戻る場面と、当たりの先の別ファイル。 */
const files: Record<string, string> = {
  start: [
    "@set game.key = 0", // 1
    "# menu", // 2
    "どれにする？", // 3
    "@choice", // 4
    "- 外れ -> #miss", // 5
    "- 鍵 -> #key", // 6
    "- 扉 -> #door", // 7
    "@end", // 8
    "# miss", // 9
    "何もない。", // 10
    "@jump #menu", // 11
    "# key", // 12
    "@set game.key = 1", // 13
    "鍵を拾った。", // 14
    "@jump #menu", // 15
    "# door", // 16
    "@if game.key == 1", // 17
    "@jump next", // 18
    "@end", // 19
    "開かない。", // 20
    "@jump #menu", // 21
  ].join("\n"),
  next: "@bg room.png\n扉の向こう。\n@set temp.came = true\n終わり。",
};
const loadSource = async (f: string) => files[f]!;

describe("道筋の探索", () => {
  it("walk は plan を使い切ると、同じ選択肢に戻るたびに次を選ぶ", async () => {
    const pages: string[] = [];
    const { result, walk: w } = await walk({ loadSource, start: "start", page: (at) => void pages.push(`${at.file}:${at.line}`) });
    expect(result.reason).toBe("end");
    // 外れ → 鍵 → 扉（鍵があるので next へ）
    expect(w.choices.map((c) => [c.picked, c.text, `${c.file}:${c.line}`])).toEqual([
      [0, "外れ", "start:4"],
      [1, "鍵", "start:4"],
      [2, "扉", "start:4"],
    ]);
    expect(pages).toEqual(["start:3", "start:10", "start:3", "start:14", "start:3", "next:2", "next:4"]);
    expect(w.assigned).toEqual({ "game.key": { file: "start", line: 13 }, "temp.came": { file: "next", line: 3 } });
  });

  it("offset で最初に選ぶ番号をずらせる", async () => {
    const { walk: w } = await walk({ loadSource, start: "start", offset: 2, page: (at) => at.file === "start" && at.line === 20 });
    expect(w.choices.map((c) => c.picked)).toEqual([2]);
  });

  it("findRoute は後戻りしながら、着く道筋とその時点のセーブを返す", async () => {
    const found = await findRoute({ loadSource, start: "start", reached: (kind, at) => kind === "page" && at.file === "next" });
    expect(found).not.toBeNull();
    expect(found!.at).toEqual({ file: "next", line: 2 });
    expect(found!.save.position).toMatchObject({ unit: "next", index: 1 });
    expect(found!.save.stage.background).toBe("room.png");
    expect(found!.save.game).toEqual({ key: 1 });
    expect(found!.choices.map((c) => c.text)).toEqual(["外れ", "鍵", "扉"]);
    expect(found!.assigned).toEqual({ "game.key": { file: "start", line: 13 } });
  });

  it("バッドエンドに行った道筋は捨て、最後の選択を次の番号に変えてやり直す", async () => {
    const sources: Record<string, string> = {
      a: "@choice\n- 崖 -> #cliff\n- 道 -> #road\n@end\n# cliff\n落ちた。\n@jump end\n# road\n@choice\n- 右 -> #right\n- 左 -> b\n@end\n# right\n行き止まり。",
      b: "着いた。",
      end: "おしまい。",
    };
    let runs = 0;
    const found = await findRoute({
      loadSource: async (f) => sources[f]!,
      start: "a",
      reached: (kind, at) => {
        if (kind === "choice" && at.line === 1) runs++;
        return kind === "page" && at.file === "b";
      },
    });
    expect(found!.choices.map((c) => c.text)).toEqual(["道", "左"]);
    expect(runs).toBe(3);
  });

  it("選択肢で着いたと見なすと、その選択肢から再開するセーブになる", async () => {
    const found = await findRoute({ loadSource, start: "start", reached: (kind) => kind === "choice" });
    expect(found!.save.position).toMatchObject({ unit: "start", index: 3 });
    expect(found!.choices).toEqual([]);
  });

  it("着かなければ null", async () => {
    expect(await findRoute({ loadSource, start: "start", reached: (_k, at) => at.file === "nowhere", attempts: 5 })).toBeNull();
  });

  it("セーブから再開して流せる（temp と変数を決めた行を引き継ぐ）", async () => {
    const found = await findRoute({ loadSource, start: "start", reached: (kind, at) => kind === "page" && at.file === "next" });
    let last: Walk | null = null;
    const { result } = await walk({
      loadSource,
      start: { save: found!.save, temp: { t: 1 }, assigned: found!.assigned },
      page: (_at, w) => void (last = w),
    });
    expect(result.reason).toBe("end");
    const w = last as unknown as Walk;
    expect(w.runtime.state.temp).toEqual({ t: 1, came: true });
    expect(Object.keys(w.assigned)).toEqual(["game.key", "temp.came"]);
  });

  it("walk の step は命令を実行する直前に呼び、そのときのセーブは前の命令を実行した直後の状態", async () => {
    const steps: string[] = [];
    let afterBg: string | null = null;
    await walk({
      loadSource,
      start: "next",
      step: (at, w) => {
        steps.push(`${at.file}:${at.line}`);
        if (at.line === 2) afterBg = w.runtime.save().stage.background;
      },
    });
    expect(steps).toEqual(["next:1", "next:2", "next:3", "next:4"]);
    expect(afterBg).toBe("room.png");
  });

  it("条件（if=）付きの選択肢は、道筋の探索と網羅でも出すものだけから選ぶ", async () => {
    const menu: Record<string, string> = {
      ask: [
        "@set game.a = false", // 1
        "@set game.b = false", // 2
        "# menu", // 3
        "@choice", // 4
        "- A のこと -> #a if=(game.a == false)", // 5
        "- B のこと -> #b if=(game.b == false)", // 6
        "- もういい -> #done if=(game.a && game.b)", // 7
        "@end", // 8
        "# a", // 9
        "@set game.a = true", // 10
        "A を聞いた。", // 11
        "@jump #menu", // 12
        "# b", // 13
        "@set game.b = true", // 14
        "B を聞いた。", // 15
        "@jump #menu", // 16
        "# done", // 17
        "終わり。", // 18
      ].join("\n"),
    };
    const load = async (f: string) => menu[f]!;
    const { result, walk: w } = await walk({ loadSource: load, start: "ask" });
    expect(result.reason).toBe("end");
    expect(w.choices.map((c) => [c.count, c.text])).toEqual([
      [2, "A のこと"],
      [1, "B のこと"],
      [1, "もういい"],
    ]);
    const found = await findRoute({ loadSource: load, start: "ask", reached: (kind, at) => kind === "page" && at.line === 18 });
    expect(found!.choices.map((c) => c.text)).toEqual(["A のこと", "B のこと", "もういい"]);
    const report = await coverage({ files: ["ask"], loadSource: load, runs: 2 });
    expect([...report.files[0]!.reached].sort((a, b) => a - b)).toEqual([11, 15, 18]);
    // どの選択肢にも条件があるが、最後の選択肢が残りの裏返しで止まらないので、検査も知らせない
    expect(report.diagnostics.map((d) => d.diagnostic.code)).toEqual([]);
  });

  it("coverage は種を変えると random の別の分かれ方も通る", async () => {
    const src = ["@if random() < 0.5", "  表。", "@else", "  裏。", "@end"].join("\n");
    const load = async () => src;
    const one = await coverage({ files: ["r"], loadSource: load, runs: 1 });
    expect(one.files[0]!.reached.size).toBe(1);
    const many = await coverage({ files: ["r"], loadSource: load, runs: 1, seeds: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(many.files[0]!.reached.size).toBe(2);
  });
  /** 描画側の画面で行き先を選ばせる命令（答えが返らなければ ctx.pick で選ぶ）。offer に無い行き先は画面なしでは選ばれない。 */
  const door = (offer: string[]): CommandImpl => ({
    spec: { name: "door", summary: "", positional: [], params: {}, example: "@door" },
    run: async (_args, ctx: CommandContext) => {
      const answer = (await ctx.present({}, true)) as string | undefined;
      const outcomes: PickOutcome<string>[] = offer.map((label) => ({ label, target: `d#${label}`, value: label }));
      const picked = await ctx.pick(outcomes, answer ?? null);
      if (picked !== null) await ctx.runtime.jump(`d#${picked}`);
    },
  });
  const doorSrc = ["@door", "# left", "左。", "@door", "# right", "右。", "@door", "# secret", "隠し部屋。"].join("\n");

  it("ctx.pick は画面なしなら一覧を選択肢として渡し、探索も網羅もどの行き先も試せる", async () => {
    const load = async () => doorSrc;
    const runtime = { commands: [door(["left", "right", "secret"])] };
    const found = await findRoute({ loadSource: load, start: "d", runtime, reached: (kind, at) => kind === "page" && at.line === 9 });
    expect(found!.choices.at(-1)?.text).toBe("secret");
    const report = await coverage({ files: ["d"], loadSource: load, runtime, runs: 3 });
    expect([...report.files[0]!.reached].sort((a, b) => a - b)).toEqual([3, 6, 9]);
  });

  it("coverage のファイルごとの流しは、@call で呼ぶだけのファイルの @return を誤りにせず、続きのラベルも網羅に数える（2026-11-19 の O2）", async () => {
    const sources: Record<string, string> = {
      start: "# start\n　はじまり。\n@call extra#a\n@call extra#b\n　おわり。\n",
      extra: "# a\n　サブa。\n@return\n# b\n　サブb。\n@return\n",
    };
    const report = await coverage({ files: ["start", "extra"], loadSource: async (f) => sources[f]!, runs: 2 });
    expect(report.diagnostics).toEqual([]);
    expect([...report.files.find((f) => f.file === "extra")!.reached].sort((a, b) => a - b)).toEqual([2, 5]);
    // ふつうの流し（はじめから、lim test、lim trace）では、呼ばれていない @return は今までどおり誤り
    const found: string[] = [];
    const { walk: w } = await walk({ loadSource: async (f) => sources[f]!, start: "extra", runtime: { onError: "continue" }, onDiagnostic: (d) => found.push(d.message) });
    expect(w.runtime).toBeDefined();
    expect(found.some((m) => m.includes("@return"))).toBe(true);
  });

  it("coverage は命令が教えた行き先が選択肢に一度も出なければ警告する", async () => {
    const load = async () => doorSrc;
    const promised = new Map([["d:1", ["d#left", "d#right", "d#secret"]]]);
    const missing = await coverage({ files: ["d"], loadSource: load, runtime: { commands: [door(["left", "right"])] }, runs: 2, promised });
    expect(missing.diagnostics.map((d) => [d.diagnostic.code, d.diagnostic.line, d.diagnostic.message.includes("d#secret")])).toEqual([["target-never-offered", 1, true]]);
    const all = await coverage({ files: ["d"], loadSource: load, runtime: { commands: [door(["left", "right", "secret"])] }, runs: 2, promised });
    expect(all.diagnostics).toEqual([]);
  });
});

describe("道筋の探索での CG の解放", () => {
  it("画面なしで流しても、一覧にある CG を @bg で出したら解放する", async () => {
    const { walk: w } = await walk({ loadSource: async () => "@bg stills/a.png\n終わり。", start: "s", runtime: { cg: (_f, image) => image.startsWith("stills/") } });
    expect(w.runtime.system.cg_unlocked).toEqual({ "stills/a.png": true });
  });
});
