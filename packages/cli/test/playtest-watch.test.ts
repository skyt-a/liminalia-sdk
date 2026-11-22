import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildStoryMap, CORE_COMMANDS, createRegistry, endingKinds, endingRef, parse } from "@liminalia/lang";
import { parseFlags } from "../src/context.ts";
import { printRun, type PlaytestRun } from "../src/commands/playtest.ts";
import { avoidEndingNotes, DEFAULT_AVOID_ENDINGS, endingAvoided, endingTraps } from "../src/playtest-avoid.ts";
import { englishLine } from "../src/english-output.ts";
import { FAST_RATE, FAST_SOURCE, playtestWatchFlags, shotName, WATCH_SOURCE, withCg } from "../src/playtest-watch.ts";
import { lineLabel, requireFfmpeg } from "../src/commands/shot-video.ts";
import { FrameFeeder, VideoChooser } from "../src/video-timeline.ts";
import { commandFlags } from "../src/usage.ts";

/**
 * lim playtest の付け足し（--fast、--log、--shots、--avoid-choice、--avoid-ending）と lim shot --video。
 * 書き出したゲームを流すものは Chromium が要るので LIMINALIA_E2E_BROWSER=1 のときだけ（録画は ffmpeg もあるときだけ）。
 */

const LIM = resolve(import.meta.dirname, "../bin/lim.mjs");
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");

/** 台本の組から地図を作る。 */
function mapOf(files: Record<string, string>, entry = "start") {
  const scripts = new Map(Object.entries(files).map(([name, text]) => [name, { script: parse(text, name), text }]));
  return buildStoryMap({ scripts, registry: createRegistry(CORE_COMMANDS), entry, hooks: new Map(), data: () => undefined });
}

describe("避けるエンディング", () => {
  it("種類で引く（大文字と小文字は区別しない）。種類でない文字は名前に含むもの。種類の無いエンディングは当たらない", () => {
    const ref = (ending: string, title?: string) => endingRef(ending, title) ?? undefined;
    expect(endingAvoided(ref("bad"), ["bad"])).toBe(true);
    expect(endingAvoided(ref("bad", "沈黙"), ["BAD"])).toBe(true);
    expect(endingAvoided(ref("true"), DEFAULT_AVOID_ENDINGS)).toBe(false);
    expect(endingAvoided(ref("other", "沈黙の朝"), ["沈黙"])).toBe(true);
    expect(endingAvoided(undefined, ["bad"])).toBe(false);
    expect(endingAvoided(ref("bad"), [""])).toBe(false);
    // 前の書き方（移していない作品）も、文言から読んだ種類で引く
    expect(endingAvoided(ref("BAD END"), DEFAULT_AVOID_ENDINGS)).toBe(true);
    expect(endingAvoided(ref("バッドエンド 2"), DEFAULT_AVOID_ENDINGS)).toBe(true);
    expect(endingAvoided(ref("TRUE END"), DEFAULT_AVOID_ENDINGS)).toBe(false);
    // 作品が足した種類（liminalia.json の endingKinds）
    const kinds = endingKinds({ secret: "SECRET END" });
    expect(endingAvoided(endingRef("secret", undefined, kinds) ?? undefined, ["secret"], kinds)).toBe(true);
    expect(endingAvoided(endingRef("SECRET END", undefined, kinds) ?? undefined, ["secret"], kinds)).toBe(true);
  });

  it("避けるエンディングにしか到達しないシーンだけを返す（条件分岐の先に別の終わりがあれば避けない。頭の無いファイルはファイルの名前でも）", () => {
    const map = mapOf({
      start: [
        "# start",
        "@choice",
        "- 眠る -> #sleep",
        "- 進む -> #go",
        "- 迷う -> #maybe",
        "- 出る -> lost",
        "@end",
        "# sleep",
        "朝になった。",
        '@title-screen ending="BAD END"',
        "# go",
        "歩きだした。",
        "@jump goal",
        "# maybe",
        "@if game.brave",
        "@jump #go",
        "@end",
        "@jump #sleep",
      ].join("\n"),
      goal: ["# goal", "着いた。"].join("\n"),
      lost: ["# lost", "迷った。", '@title-screen ending="Bad End"'].join("\n"),
    });
    expect(endingTraps(map, ["bad"])).toEqual(["lost", "lost#lost", "start#sleep"]);
    expect(endingTraps(map, [])).toEqual([]);
    // 種類が当たらなければ何も避けない
    expect(endingTraps(map, ["normal"])).toEqual([]);
  });

  it("今の書き方（ending=種類 title=名前）も同じに避け、名前の文字でも引ける", () => {
    const map = mapOf({
      start: ["# start", "@choice", "- 眠る -> #sleep", "- 進む -> #go", "@end", "# sleep", '@title-screen ending=bad title="眠りの底"', "# go", "着いた。", '@title-screen ending=good title="朝"'].join("\n"),
    });
    expect(endingTraps(map, ["bad"])).toEqual(["start#sleep"]);
    expect(endingTraps(map, ["BAD END"])).toEqual(["start#sleep"]);
    expect(endingTraps(map, ["眠り"])).toEqual(["start#sleep"]);
    expect(endingTraps(map, ["good"])).toEqual(["start#go"]);
  });

  it("値なしの既定は、種類 bad と、名前が DEAD END や GAME OVER のエンディング（移すと種類 other になるもの、作品が足した種類）", () => {
    const map = mapOf({
      start: [
        "# start",
        "@choice",
        "- 眠る -> #sleep",
        "- 落ちる -> #fall",
        "- 負ける -> #lose",
        "- 進む -> #go",
        "@end",
        "# sleep",
        '@title-screen ending=bad title="眠りの底"',
        "# fall",
        '@title-screen ending="DEAD END"',
        "# lose",
        '@title-screen ending=other title="ゲームオーバー"',
        "# go",
        '@title-screen ending=good title="朝"',
      ].join("\n"),
    });
    expect(endingTraps(map, DEFAULT_AVOID_ENDINGS)).toEqual(["start#fall", "start#lose", "start#sleep"]);
    // 作品が足した種類も、文言が DEAD END なら避ける
    const kinds = endingKinds({ dead: "DEAD END" });
    expect(endingAvoided(endingRef("dead", undefined, kinds) ?? undefined, DEFAULT_AVOID_ENDINGS, kinds)).toBe(true);
    expect(endingAvoided(endingRef("other", "Game Over 2") ?? undefined, DEFAULT_AVOID_ENDINGS)).toBe(true);
    // 名前に END を含むだけのもの（Deadline）は避けない
    expect(endingAvoided(endingRef("other", "Deadline") ?? undefined, DEFAULT_AVOID_ENDINGS)).toBe(false);
  });

  it("避けるエンディングを始めに並べ、当たるものが無ければそう言う", () => {
    const map = mapOf({
      start: ["# start", "@choice", "- 眠る -> #sleep", "- 進む -> #go", "@end", "# sleep", '@title-screen ending=bad title="眠りの底"', "# go", '@title-screen ending=good title="朝"'].join("\n"),
    });
    expect(avoidEndingNotes(map, DEFAULT_AVOID_ENDINGS)).toEqual(["避けるエンディング: bad「眠りの底」（start#sleep）"]);
    expect(avoidEndingNotes(map, ["lost"])).toEqual(["避けるエンディングがありません（lost に当たるエンディングがありません）。種類（ending=）か名前（title=）を --avoid-ending に書きます"]);
    expect(avoidEndingNotes(map, [])).toEqual([]);
    const many = mapOf({ start: ["# start", ...Array.from({ length: 9 }, (_, i) => `# b${i}\n@title-screen ending=bad`)].join("\n") });
    expect(avoidEndingNotes(many, ["bad"])).toEqual(["避けるエンディング: bad（start#b0）、bad（start#b1）、bad（start#b2）、bad（start#b3）、bad（start#b4）、bad（start#b5）、ほか 3 か所"]);
    for (const line of [...avoidEndingNotes(map, ["bad"]), ...avoidEndingNotes(map, ["lost"]), ...avoidEndingNotes(many, ["bad"])]) expect(englishLine(line)).not.toMatch(/避ける|ありません|ほか/);
  });

  it("@stop で止まるシーン（書きかけの作品の続き）とまだ無いファイルへの飛び先は、避けない終わりとして数える", () => {
    const map = mapOf({
      start: ["# start", "@choice", "- 眠る -> #sleep", "- 進む -> #go", "- 次へ -> later", "@end", "# sleep", '@title-screen ending="BAD END"', "# go", "続きは未定。", "@stop"].join("\n"),
    });
    // 進む（@stop）と次へ（まだ無いファイル）は BAD END に決まらないので、避けるのは眠るだけ
    expect(endingTraps(map, ["bad"])).toEqual(["start#sleep"]);
  });
});

describe("付け足しの旗", () => {
  it("--avoid-ending を値なしで書くと既定（種類 bad と、名前が DEAD END や GAME OVER のもの）。値は , で区切る", () => {
    expect(DEFAULT_AVOID_ENDINGS).toEqual(["bad", "DEAD END", "GAME OVER", "デッドエンド", "ゲームオーバー"]);
    expect(playtestWatchFlags(parseFlags(["--avoid-ending"]))).toEqual({ avoidEndings: [...DEFAULT_AVOID_ENDINGS] });
    expect(playtestWatchFlags(parseFlags(["--avoid-ending", "BAD END, LOST", "--avoid-choice", "眠る,逃げる", "--fast", "--log", "--shots"]))).toEqual({
      fast: true,
      log: true,
      shots: true,
      avoidChoices: ["眠る", "逃げる"],
      avoidEndings: ["BAD END", "LOST"],
    });
    expect(playtestWatchFlags(parseFlags([]))).toEqual({});
  });

  it("lim playtest と lim shot が新しい旗を受ける", () => {
    for (const f of ["fast", "log", "shots", "avoid-choice", "avoid-ending"]) expect(commandFlags("playtest").has(f), f).toBe(true);
    for (const f of ["video", "pages", "read", "choose"]) expect(commandFlags("shot").has(f), f).toBe(true);
    // 値を取らない旗（後ろの書き出しのフォルダを値として読まない）
    expect(parseFlags(["--log", "dist/browser/game"]).positional).toEqual(["dist/browser/game"]);
  });
});

/** ページで動く手順を、偽の window と document で評価する。 */
function evalPage<T>(source: string, window: unknown, document: unknown): T {
  return new Function("window", "document", `return (${source})`)(window, document) as T;
}

describe("ページで動く手順", () => {
  it("書き換えで __name などが混ざらない、そのまま動く JavaScript", () => {
    for (const s of [FAST_SOURCE, WATCH_SOURCE]) expect(s).not.toContain("__name");
    expect(() => new Function(`return (${WATCH_SOURCE})`)()).not.toThrow();
  });

  it("--fast は setTimeout の待ちを縮め、終わりのあるアニメーションだけを速くする", () => {
    const delays: number[] = [];
    const queued: (() => void)[] = [];
    const window = {
      setTimeout: (fn: () => void, ms: number) => {
        delays.push(ms);
        queued.push(fn);
        return 1;
      },
    };
    const anim = (endTime: number) => ({ playbackRate: 1, effect: { getComputedTiming: () => ({ endTime }) }, updatePlaybackRate(r: number) { this.playbackRate = r; } });
    const once = anim(400);
    const loop = anim(Infinity);
    const document = { getAnimations: () => [once, loop] };
    evalPage(FAST_SOURCE, window, document);
    (window.setTimeout as (fn: () => void, ms: number) => number)(() => undefined, 1000);
    expect(delays.at(-1)).toBe(1000 / FAST_RATE);
    // 掃除は元の setTimeout で回る
    queued[0]!();
    expect(once.playbackRate).toBe(FAST_RATE);
    expect(loop.playbackRate).toBe(1);
    // 一度速くしたものはもう変えない
    queued.at(-1)!();
    expect(once.playbackRate).toBe(FAST_RATE);
  });

  it("避ける選択肢を飛ばして選び、ページと選択肢の様子を知らせる", async () => {
    const reports: Record<string, unknown>[] = [];
    const button = (text: string) => ({ textContent: text, getAttribute: () => null, querySelector: () => null });
    const buttons = [button("眠る"), button("進む"), button("迷う")];
    let waiting = true;
    let pages = 1;
    const stage = { background: "room.png", sprites: { アオイ: { appearance: "", variant: "smile", at: "left" } }, bgm: { file: "theme.ogg", volume: 100, loop: true }, loopingSe: { rain: { file: "rain.ogg", volume: 50 } }, mask: null, extra: { "image.layers": { fg1: [{ kind: "image", file: "letter.png" }] } } };
    const host = {
      get waiting() {
        return waiting;
      },
      choose(..._args: unknown[]) {
        return Promise.resolve(0);
      },
    };
    const backlog = [{ speaker: "アオイ", label: "葵", parts: [{ text: "こんにちは" }, { br: true }, { text: "また明日" }], voice: { file: "v1.ogg" }, at: { file: "start", line: 3 } }];
    const window: Record<string, unknown> = {
      __liminalia: { host, runtime: () => ({ at: { file: "start", line: 3 }, state: { stage } }), pages: () => pages, system: { backlog } },
      __liminaliaPlaytestReport: async (r: Record<string, unknown>) => void reports.push(r),
    };
    const document = { querySelectorAll: () => buttons, querySelector: () => null };
    evalPage<(o: unknown) => void>(WATCH_SOURCE, window, document)({ log: true, avoidChoices: ["迷う"], traps: ["start#sleep"] });
    const hook = window.__liminaliaPlaytest as { step(): Promise<void>; pick(b: unknown[], i: number): number; choice(b: unknown[], i: number): Promise<void>; avoided: number };
    // 実行器が描画側へ渡す選択肢のジャンプ先を控える
    await (host.choose as (...a: unknown[]) => Promise<number>)(["眠る", "進む", "迷う"], null, undefined, ["start#sleep", "start#go", "start#maybe"]);
    expect(hook.pick(buttons, 0)).toBe(1);
    expect(hook.pick(buttons, 2)).toBe(1);
    expect(hook.pick(buttons, 1)).toBe(1);
    expect(hook.avoided).toBe(2);
    await hook.step();
    await hook.step(); // 同じページはもう知らせない
    pages = 2;
    waiting = false;
    await hook.step(); // クリック待ちでなければ知らせない
    await hook.choice(buttons, 1);
    expect(reports).toEqual([
      {
        kind: "page",
        n: 1,
        at: "start:3",
        name: "葵",
        text: "こんにちは\nまた明日",
        voice: "v1.ogg",
        stage: { bg: "room.png", images: ["fg1:letter.png"], sprites: { アオイ: "smile@left" }, bgm: "theme.ogg", se: { rain: "rain.ogg" } },
        changed: true,
      },
      { kind: "choice", n: 2, at: "start:3", options: ["眠る", "進む", "迷う"], pick: 1, avoided: ["眠る", "迷う"], stage: { bg: "room.png", images: ["fg1:letter.png"], sprites: { アオイ: "smile@left" }, bgm: "theme.ogg", se: { rain: "rain.ogg" } }, changed: true },
    ]);
  });

  it("背景が CG なら cg を付け、スクリーンショットの名前は通し番号と位置", () => {
    const isCg = (folder: string, image: string) => folder === "bgimage" && image.startsWith("cg/");
    expect(withCg({ bg: "cg/a.png", bgm: "x.ogg" }, isCg)).toEqual({ bg: "cg/a.png", cg: true, bgm: "x.ogg" });
    expect(withCg({ bg: "room.png" }, isCg)).toEqual({ bg: "room.png" });
    expect(withCg(null, isCg)).toBeNull();
    expect(shotName(3, "chapter/one:12", "page")).toBe("0003_chapter_one_12.jpg");
    expect(shotName(14, "start:40", "choice")).toBe("0014_start_40_choice.jpg");
  });
});

describe("結果の表示", () => {
  it("避けた選択肢、ページのログ、変わるたびのスクリーンショットを出す（--lang en は英語）", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const r: PlaytestRun = { run: 0, outcome: "ended", pages: 3, choices: [], at: null, errors: [], seconds: 1, avoided: 1, log: "/tmp/x/run-1.jsonl", shots: { count: 2, dir: "/tmp/x/run-1" } };
      printRun(r, "/tmp/build", true);
      printRun({ ...r, run: 1 }, "/tmp/build");
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain("  Avoided: 1 choice");
      expect(lines).toContain("  Page log: /tmp/x/run-1.jsonl");
      expect(lines).toContain("  Screenshots on changes: 2 images in /tmp/x/run-1");
      expect(lines).toContain("  避けた選択肢: 1 回");
      expect(lines).toContain("  ページのログ: /tmp/x/run-1.jsonl");
      expect(lines).toContain("  変わるたびのスクリーンショット: 2 枚（/tmp/x/run-1）");
    } finally {
      log.mockRestore();
    }
  });
});

describe("録画（lim shot --video）", () => {
  it("隅の文はファイル:行 と、その行の書き方（長ければ切る）", () => {
    expect(lineLabel("start", 12, "  アオイ「おはよう」  ")).toBe("start.lim:12\nアオイ「おはよう」");
    expect(lineLabel("start", 3, undefined)).toBe("start.lim:3");
    expect(lineLabel("a", 1, "x".repeat(70)).split("\n")[1]).toBe(`${"x".repeat(60)}…`);
  });

  it("動画のコマごとに、その時刻までに届いた最後のコマを見せる（録り始めから録り終えるまで、一定の速さ）", () => {
    // 10 fps で 1 秒。最初のコマは録り始める前に描かれたもの、次は 0.25 秒後、その次は 0.65 秒後に届いた
    const feeder = new FrameFeeder(10);
    const shots = [9500, 10250, 10650].map((t, i) => [t, Buffer.from([i])] as const);
    for (const [t, b] of shots) feeder.push(t, b);
    const taken = [...feeder.take(10_000, 0, 10_450), ...feeder.take(10_000, 5, 10_950)];
    expect(taken.map((b) => b[0])).toEqual([0, 0, 0, 1, 1, 1, 1, 2, 2, 2]);
    // 長さは録った時間で決まる（届いたコマの数ではない）
    const many = new FrameFeeder(30);
    for (const t of [10_000, 10_010, 10_020, 10_030]) many.push(t, Buffer.from([0]));
    expect(many.take(10_000, 0, 10_499)).toHaveLength(15);
    expect(new FrameFeeder().take(0, 0, 1000)).toEqual([]);
  });

  it("選択肢は番号か含む文で選び、当たらなければ押せるものを、同じ選択肢に戻るたびに次へ", () => {
    const chooser = new VideoChooser([2, "南", 0, "無い"]);
    expect(chooser.pick(["A", "B", "C"]).index).toBe(2);
    expect(chooser.pick(["北へ行く", "南へ行く"]).index).toBe(1);
    // 押せない番号と、当たらない文は、ふつうの選び方（押せるものの最初）
    expect(chooser.pick([null, "B"]).index).toBe(1);
    expect(chooser.pick(["X", "Y"]).index).toBe(0);
    // --choose を使い切ったら、同じ選択肢に戻るたびに次のもの（戻ってくる選択肢で同じものを選び続けない）
    const loop = new VideoChooser([]);
    expect([0, 1, 2, 3].map(() => loop.pick(["のぞく", null, "つける", "外へ"]).index)).toEqual([0, 2, 3, 0]);
  });

  it("ffmpeg が無ければ、入れ方を添えて始める前に止める", () => {
    expect(() => requireFfmpeg("liminalia-no-such-ffmpeg")).toThrow(/録画には ffmpeg が要りますが、見つかりません.*brew install ffmpeg/);
  });
});

const e2e = !!process.env.LIMINALIA_E2E_BROWSER;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const work = mkdtempSync(join(tmpdir(), "liminalia-playtest-watch-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function lim(args: string[]) {
  const r = spawnSync(process.execPath, [LIM, ...args], { encoding: "utf8", timeout: 300_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

describe.skipIf(!e2e)("書き出したゲームで", { timeout: 600_000 }, () => {
  const dir = join(work, "game");
  it("BAD END を避けて最後まで流し、ページのログと変わるたびのスクリーンショットを残す", () => {
    cpSync(TEMPLATE, dir, { recursive: true });
    // 流れ星の選択肢の先頭に BAD END へ向かうものを足す（既定の選び方なら最初に選ぶ）
    const start = join(dir, "scenario/start.lim");
    const text = readFileSync(start, "utf8");
    const choice = "@choice\n- 願いごとを言ってみる -> #wish\n";
    expect(text).toContain(choice);
    writeFileSync(start, `${text.replace(choice, "@choice\n- 眠ってしまう -> #sleep\n- 願いごとを言ってみる -> #wish\n")}\n# sleep\n　気がつくと朝だった。\n@title-screen ending="BAD END"\n`);
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, extra: { cg: [{ id: "morning", images: ["hill_morning.webp"] }] } }, null, 2));
    expect(lim(["build", dir, "browser", "--no-verify"]).code).toBe(0);

    // 既定の選び方では BAD END を選ぶ
    const plain = lim(["playtest", dir, "--json"]);
    expect((JSON.parse(plain.stdout) as { runs: PlaytestRun[] }).runs[0]!.choices).toContain("眠ってしまう");

    const r = lim(["playtest", dir, "--avoid-ending", "--log", "--shots", "--fast", "--json"]);
    expect(r.code, r.out).toBe(0);
    const run = (JSON.parse(r.stdout) as { runs: PlaytestRun[] }).runs[0]!;
    expect(run.outcome).toBe("ended");
    expect(run.choices).not.toContain("眠ってしまう");
    expect(run.avoided).toBe(1);
    const lines = readFileSync(run.log!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const pages = lines.filter((l) => l.kind === "page");
    expect(pages.length).toBe(run.pages);
    expect(pages[0]).toMatchObject({ n: 1, at: "start:23", stage: { bg: "hill_dusk.webp", bgm: "quiet_night.wav" } });
    expect(pages.some((p) => (p.stage as { sprites?: Record<string, string> }).sprites?.["アカリ"] === "normal@center")).toBe(true);
    expect(pages.some((p) => (p.stage as { cg?: boolean }).cg === true)).toBe(true);
    expect(lines.find((l) => l.kind === "choice" && (l.avoided as string[]).length > 0)).toMatchObject({ avoided: ["眠ってしまう"], pick: 1 });
    expect(lines.at(-1)).toMatchObject({ kind: "end", outcome: "ended" });
    // スクリーンショットはログに名前があり、ファイルがある
    const shots = lines.map((l) => l.shot).filter((s): s is string => typeof s === "string");
    expect(shots.length).toBe(run.shots!.count);
    expect(readdirSync(run.shots!.dir).sort()).toEqual([...shots].sort());
    expect(shots.some((s) => s.endsWith("_choice.jpg"))).toBe(true);
  });

  it.skipIf(!hasFfmpeg)("lim shot --video は、その位置から送りながら録画する", () => {
    const out = join(work, "clip.mp4");
    const r = lim(["shot", dir, "start#night", "--video", out, "--pages", "3", "--read", "300"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("（3 ページ");
    expect(existsSync(out) && statSync(out).size > 10_000).toBe(true);
  });
});
