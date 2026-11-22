import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HeadlessHost, initialStage, Runtime } from "@liminalia/runtime";
import { combinePlugins } from "@liminalia/plugin-host";
import std from "@liminalia/std/commands";
import { afterGame, lineAssigned, lineChoices, lineSave, type AfterState, type LineState, type Sweep } from "../src/protocol.ts";
import { buildStoryMap, CORE_COMMANDS, createRegistry, framePosition, parse, type Cast } from "@liminalia/lang";
import { layoutSprites } from "../../web/src/sprite-layout.ts";
import { routeGuide, stageMarks, stageTrack, Sweeper, sweepRange } from "../src/sweep.ts";

/** ひな形「星を待つ丘」（読むだけ）で、各行の状態（現在地）を作る。 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const speakers = (JSON.parse(readFileSync(join(TEMPLATE, "cast.json"), "utf8")) as { speakers: string[] }).speakers;
const { implementations } = combinePlugins([std]);

function sweeper(extra: Record<string, string> = {}) {
  let loads = 0;
  const loadSource = async (file: string) => {
    loads++;
    return extra[file] ?? readFileSync(join(TEMPLATE, "scenario", `${file}.lim`), "utf8");
  };
  return { s: new Sweeper({ loadSource, runtime: { speakers, commands: implementations }, entry: "start" }), loads: () => loads };
}

/** 行の状態を全体に戻したもの（画面の lineView と同じ）。 */
function full(r: Pick<Sweep, "base" | "runs">, state: LineState) {
  const save = lineSave(r, state);
  return { ...state, save, stage: save.stage, game: save.game, assigned: lineAssigned(r, state), choices: lineChoices(r, state) };
}

/** 命令の行の直後の状態を全体に戻したもの（画面の afterView と同じ）。 */
function fullAfter(r: Pick<Sweep, "base" | "runs" | "stages">, state: AfterState) {
  return { ...state, stage: r.stages[state.stage]!, game: afterGame(r, state), assigned: lineAssigned(r, state), choices: lineChoices(r, state) };
}

describe("現在地（sweep）", () => {
  it("場面転換後の命令行には一時的なウィンドウ非表示を残し、次の本文の後で戻す", async () => {
    const text = ["@window show", "前の本文。", "@scene-change time=1s hold=500ms hide-window=true", "@wait 1s", "次の本文。", "@wait 1s", "@scene-change hide-window=false", "@wait 1s"].join("\n");
    const { s } = sweeper({ start: text });
    const r = await s.sweep("start");
    expect(fullAfter(r, r.after[3]!).stage.windowSuppressed).toBe(true);
    expect(fullAfter(r, r.after[4]!).stage.windowSuppressed).toBe(true);
    expect(fullAfter(r, r.after[6]!).stage.windowSuppressed).toBeUndefined();
    expect(fullAfter(r, r.after[7]!).stage.windowSuppressed).toBeUndefined();
  });
  it("はじめのファイルは道筋なしで、通った本文と選択肢の行ごとに状態を持つ", async () => {
    const { s } = sweeper();
    const r = await s.sweep("start");
    expect(r.how).toBe("entry");
    expect(r.route).toEqual([]);
    // 命令の行・空行・ラベルの行は持たない
    for (const line of [15, 16, 19, 42, 43]) expect(r.lines[line], String(line)).toBeUndefined();
    const first = full(r, r.lines[23]!);
    expect(first.stage.background).toBe("hill_dusk.webp");
    expect(first.stage.bgm).toMatchObject({ file: "quiet_night.wav", volume: 60, loop: true });
    expect(first.game).toEqual({ looked: false, wished: false });
    expect(first.assigned).toEqual({ "game.looked": { file: "start", line: 16 }, "game.wished": { file: "start", line: 17 } });
    expect(first.choices).toEqual([]);
    // 選択肢の行: そのセーブから再開すると、まずその選択肢を出す
    const menu = full(r, r.lines[52]!);
    expect(Object.keys(menu.stage.sprites)).toEqual(["アカリ", "ソウ"]);
    const host = new HeadlessHost({ loadSource: async (f) => readFileSync(join(TEMPLATE, "scenario", `${f}.lim`), "utf8"), whenChoicesRunOut: "stop" });
    await new Runtime(host, { speakers, commands: implementations }).load(menu.save);
    expect(host.trace.filter((t) => t.type === "page")).toEqual([]);
    expect(host.trace.find((t) => t.type === "choice")).toMatchObject({ options: ["望遠鏡をのぞく", "ラジオをつける", "外で空を見上げる"], selected: null });
  });

  it("選び方を変えて流し、選択肢の両側と @if の各枝を通る", async () => {
    const { s } = sweeper();
    const r = await s.sweep("start");
    // 望遠鏡・ラジオ・外へ、願う・見ている、結末の三つの枝
    for (const line of [60, 78, 86, 125, 135, 141, 146, 149]) expect(r.lines[line], String(line)).toBeDefined();
    const telescope = full(r, r.lines[65]!);
    expect(telescope.game.looked).toBe(true);
    expect(telescope.assigned["game.looked"]).toEqual({ file: "start", line: 59 });
    expect(telescope.stage.camera.zoom).toBe(1.6);
    expect(telescope.choices).toEqual([{ file: "start", line: 52, option: 0, text: "望遠鏡をのぞく" }]);
    // @call した部品の中の行は、初めて通ったとき（ラジオをつけたとき）の temp を持つ
    const radio = full(r, r.lines[159]!);
    expect(radio.temp.news).toBe("今夜の流星群は、午前零時ごろにもっとも多く見られる見込みです");
    expect(radio.assigned["temp.news"]).toEqual({ file: "start", line: 75 });
    expect(radio.stage.loopingSe).toEqual({});
  });

  it("行の save から再開すると、その行のページから本番どおりに出る", async () => {
    const { s } = sweeper();
    const r = await s.sweep("start");
    const state = full(r, r.lines[114]!);
    const host = new HeadlessHost({ loadSource: async (f) => readFileSync(join(TEMPLATE, "scenario", `${f}.lim`), "utf8"), maxPages: 1 });
    const runtime = new Runtime(host, { speakers, commands: implementations });
    host.onLimit = () => runtime.stop();
    runtime.state.temp = structuredClone(state.temp);
    await runtime.load(JSON.parse(JSON.stringify(state.save)));
    const page = host.trace.find((t) => t.type === "page");
    expect(page).toMatchObject({ file: "start", line: 114, speaker: "アカリ" });
    // ページの頭の状態（本文中の {@chara アカリ surprised} はまだ効いていない）
    expect(state.stage.sprites["アカリ"]?.variant).toBe("smile");
  });

  it("ファイルに入った時点（最初の命令の前）から流すので、ファイルの頭の命令の行も状態を持つ", async () => {
    const { s } = sweeper();
    const r = await s.sweep("epilogue");
    expect(r.base.game).toEqual({ looked: true, wished: true });
    const head = fullAfter(r, r.after[4]!).stage;
    // 前のファイルの終わりの背景のまま、立ち絵だけ下がっている
    expect(head.background).toBe("hill_night.webp");
    expect(head.sprites).toEqual({});
    expect(fullAfter(r, r.after[6]!).stage.background).toBe("hill_morning.webp");
    expect(fullAfter(r, r.after[6]!).stage.mask).not.toBeNull();
    expect(fullAfter(r, r.after[8]!).stage.mask).toBeNull();
    expect(fullAfter(r, r.after[6]!).choices).toEqual([]);
  });

  it("別のファイルは、はじめからそこに入るまでの道筋と、その時点の状態から流す", async () => {
    const { s } = sweeper();
    const r = await s.sweep("epilogue");
    expect(r.how).toBe("entry");
    expect(r.route.map((c) => c.text)).toEqual(["望遠鏡をのぞく", "ラジオをつける", "外で空を見上げる", "願いごとを言ってみる"]);
    expect(r.route[0]).toEqual({ file: "start", line: 52, option: 0, text: "望遠鏡をのぞく" });
    const first = Object.keys(r.lines).map(Number).sort((a, b) => a - b)[0]!;
    expect(first).toBe(10);
    expect(full(r, r.lines[first]!).game).toEqual({ looked: true, wished: true });
    expect(full(r, r.lines[first]!).assigned["game.wished"]).toEqual({ file: "start", line: 123 });
    expect(full(r, r.lines[first]!).stage.background).toBe("hill_morning.webp");
    expect(full(r, r.lines[first]!).stage.bgm).toBeNull();
  });

  it("道筋は覚えておき、reset で捨てる", async () => {
    const { s, loads } = sweeper();
    await s.entryOf("epilogue");
    const before = loads();
    await s.entryOf("epilogue");
    await s.entryOf("start");
    expect(loads()).toBe(before);
    s.reset();
    await s.entryOf("epilogue");
    expect(loads()).toBeGreaterThan(before);
  });

  it("入る道が見つからないファイルは、頭から空の状態で流す", async () => {
    const { s } = sweeper({ side: "@set game.side = 1\n寄り道の本文。\n@choice\n- A -> #a\n- B -> #b\n@end\n# a\nA の本文。\n@jump #end\n# b\nB の本文。\n# end\nおわり。" });
    const r = await s.sweep("side");
    expect(r.how).toBe("file-start");
    expect(r.route).toEqual([]);
    expect(Object.keys(r.lines).map(Number)).toEqual([2, 3, 8, 11, 13]);
    expect(full(r, r.lines[2]!).game).toEqual({ side: 1 });
    expect(full(r, r.lines[11]!).choices).toEqual([{ file: "side", line: 3, option: 1, text: "B" }]);
  });

  it("行の状態は、変数とその出どころを、ファイルに入った時点からの差分だけ持つ", async () => {
    const { s } = sweeper();
    const r = await s.sweep("epilogue");
    expect(r.base.game).toEqual({ looked: true, wished: true });
    expect(r.base.assigned["game.wished"]).toEqual({ file: "start", line: 123 });
    for (const state of Object.values(r.lines)) {
      expect(state.save.game).toEqual({});
      expect(state.assigned).toEqual({});
      expect(state).not.toHaveProperty("stage");
      expect(state).not.toHaveProperty("game");
      expect(state.choices.count).toBeLessThanOrEqual(r.runs[state.choices.run]!.length);
    }
    // 消えた変数は unset で持つ
    const { s: s2 } = sweeper({ side: "@set game.a = 1\n@set game.b = 2\n一つ目。\n@clear-vars game\n@set game.a = 3\n二つ目。" });
    const side = await s2.sweep("side");
    expect(side.how).toBe("file-start");
    expect(lineSave(side, side.lines[3]!).game).toEqual({ a: 1, b: 2 });
    expect(lineSave(side, side.lines[6]!).game).toEqual({ a: 3 });
    expect(lineAssigned(side, side.lines[6]!)["game.a"]).toEqual({ file: "side", line: 5 });
  });

  it("命令の行は、その行を実行した直後の状態を持つ（本文・選択肢の行は持たない）", async () => {
    const { s } = sweeper();
    const r = await s.sweep("start");
    for (const line of [23, 27, 52, 113]) expect(r.after[line], String(line)).toBeUndefined();
    // ラベルの行・@set・演出の命令
    for (const line of [15, 16, 17, 18, 19, 20, 26, 31, 32, 44, 99, 102]) expect(r.after[line], String(line)).toBeDefined();
    // @set の行で変数が変わる（17 行目はまだ）
    expect(fullAfter(r, r.after[16]!).game).toEqual({ looked: false });
    expect(fullAfter(r, r.after[16]!).assigned["game.looked"]).toEqual({ file: "start", line: 16 });
    expect(fullAfter(r, r.after[17]!).game).toEqual({ looked: false, wished: false });
    // 背景の命令の直後は背景が替わり、BGM はまだ
    expect(fullAfter(r, r.after[19]!).stage.background).toBe("hill_dusk.webp");
    expect(fullAfter(r, r.after[19]!).stage.bgm).toBeNull();
    expect(fullAfter(r, r.after[20]!).stage.bgm).toMatchObject({ file: "quiet_night.wav" });
    // 立ち絵の命令の直後は立ち絵が出ている
    expect(Object.keys(fullAfter(r, r.after[26]!).stage.sprites)).toEqual(["アカリ"]);
    expect(fullAfter(r, r.after[31]!).stage.sprites["アカリ"]).toMatchObject({ variant: "surprised", at: "left" });
    expect(Object.keys(fullAfter(r, r.after[31]!).stage.sprites)).toEqual(["アカリ"]);
    expect(Object.keys(fullAfter(r, r.after[32]!).stage.sprites)).toEqual(["アカリ", "ソウ"]);
    // @define の呼び出しは、呼んだ先から戻ってきた時点（場面転換が済んで、立ち絵は下がり背景は替わっている）
    const scene = fullAfter(r, r.after[44]!).stage;
    expect(scene.background).toBe("hill_night.webp");
    expect(scene.sprites).toEqual({});
    expect(scene.window).toBe(true);
    expect(scene.mask).toBeNull();
    // @call も戻ってきた時点（呼んだ先のループの音は止まり、temp は入っている）
    const call = fullAfter(r, r.after[99]!);
    expect(call.stage.loopingSe).toEqual({});
    expect(call.temp.news).toContain("午前零時");
    // @set temp.… の行で temp が変わる。呼んだ先の行も、その行を実行した直後を持つ
    expect(fullAfter(r, r.after[98]!).assigned["temp.news"]).toEqual({ file: "start", line: 98 });
    for (const line of [157, 158, 160, 161]) expect(r.after[line], String(line)).toBeDefined();
    // 同じ舞台の様子は一つにまとめる
    expect(new Set(r.stages.map((x) => JSON.stringify(x))).size).toBe(r.stages.length);
    expect(r.stages.length).toBeLessThan(Object.keys(r.after).length);
  });

  it("範囲に絞ると、命令の行の状態も絞り、舞台の様子は使うものだけにして番号を付け直す", async () => {
    const { s } = sweeper();
    const r = { ...(await s.sweep("start")), hash: "h" };
    const part = sweepRange(r, { from: 26, to: 33 });
    expect(Object.keys(part.lines).map(Number).every((l) => l >= 26 && l <= 33)).toBe(true);
    expect(Object.keys(part.after).map(Number).sort((a, b) => a - b)).toEqual([26, 29, 31, 32]);
    expect(part.stages.length).toBeLessThanOrEqual(4);
    for (const line of [26, 29, 31, 32]) expect(part.stages[part.after[line]!.stage]).toEqual(r.stages[r.after[line]!.stage]);
  });

  it("持続の帯の材料は、行ごとの背景・BGM・ループの音・立ち絵だけを、同じ様子をまとめて持つ", async () => {
    const { s } = sweeper();
    const r = { ...(await s.sweep("start")), hash: "h" };
    const track = stageTrack(r);
    expect(track).toMatchObject({ file: "start", hash: "h", how: "entry" });
    expect(Object.keys(track.lines)).toEqual(Object.keys(r.lines));
    expect(track.states.length).toBeLessThan(Object.keys(r.lines).length);
    expect(new Set(track.states.map((m) => JSON.stringify(m))).size).toBe(track.states.length);
    const first = track.states[track.lines[23]!]!;
    expect(first).toEqual({ background: "hill_dusk.webp", bgm: { file: "quiet_night.wav", volume: 60, loop: true }, loopingSe: {}, sprites: {} });
    const menu = track.states[track.lines[52]!]!;
    expect(Object.keys(menu.sprites)).toEqual(["アカリ", "ソウ"]);
    expect(Object.keys(menu.sprites["アカリ"]!).sort()).toEqual(["appearance", "at", "flip", "variant"]);
  });

  it("持続の帯の立ち絵の位置は、作品の自動配置の規則（人数ごとの位置、退場しても動かさない枠、定位置）で決める", () => {
    const stage = initialStage();
    stage.sprites = {
      A: { variant: "", appearance: "", at: "center", flip: false, autoLayout: true, autoSlot: { index: 0, count: 3 } },
      B: { variant: "", appearance: "", at: "center", flip: false, autoLayout: true, autoSlot: { index: 2, count: 3 } },
    };
    // 規則が無ければ前からの並べ方（二人は左右）
    expect(Object.fromEntries(Object.entries(stageMarks(stage).sprites).map(([who, m]) => [who, m.at]))).toEqual({ A: "left", B: "right" });
    // 退場しても動かさない規則なら残した枠（三人の左と右）、人数ごとの位置があればその名前
    const keep = { rules: { exit: "keep" as const, positions: { "3": ["far-left", "center", "far-right"] } } };
    expect(Object.fromEntries(Object.entries(stageMarks(stage, keep).sprites).map(([who, m]) => [who, m.at]))).toEqual({ A: "far-left", B: "far-right" });
    // 定位置が右の人物は右に寄せる
    const side = { rules: { positions: { "2": ["near", "far"] } }, side: (who: string) => (who === "A" ? ("right" as const) : undefined) };
    expect(Object.fromEntries(Object.entries(stageMarks(stage, side).sprites).map(([who, m]) => [who, m.at]))).toEqual({ A: "far", B: "near" });
  });

  it("byCount の読み替え先が差分の枠に無い人物は、描画（layoutSprites）と同じく書いた立ち位置のまま出す", () => {
    const frame = (names: string[]) => ({ width: 100, height: 200, positions: Object.fromEntries(names.map((n, i) => [n, { left: i * 100, top: 0 }])) });
    const cast: Cast = {
      A: { appearances: { default: { variants: { normal: { image: "a.png", frame: frame(["left", "center", "right"]) } } } } },
      B: { appearances: { default: { variants: { normal: { image: "b.png", frame: frame(["left", "center", "right", "right-wide"]) } } } } },
      C: { appearances: { default: { variants: { normal: { image: "c.png", frame: frame(["left", "center", "right"]) }, wide: { image: "c.png", frame: frame(["left", "center", "right", "center-wide"]) } } } } },
    };
    const stage = initialStage();
    stage.sprites = {
      A: { variant: "normal", appearance: "", at: "left", flip: false },
      B: { variant: "normal", appearance: "", at: "right", flip: false },
      C: { variant: "wide", appearance: "", at: "center", flip: false },
    };
    const layout = { rules: { byCount: { "3": { left: "left-wide", right: "right-wide", center: "center-wide" } } } };
    const at = Object.fromEntries(Object.entries(stageMarks(stage, layout, cast).sprites).map(([who, m]) => [who, m.at]));
    expect(at).toEqual({ A: "left", B: "right-wide", C: "center-wide" });
    // 描画の置く位置と、出した立ち位置の名前の枠の位置が同じ
    const variants = { A: cast.A!.appearances.default!.variants.normal!, B: cast.B!.appearances.default!.variants.normal!, C: cast.C!.appearances.default!.variants.wide! };
    const boxes = layoutSprites(Object.entries(stage.sprites).map(([who, sprite]) => [who, { sprite, variant: variants[who as keyof typeof variants], natural: { width: 0, height: 0 } }] as const), { width: 1280, height: 720 }, layout);
    for (const [who, variant] of Object.entries(variants)) expect(framePosition(variant.frame!, at[who]!).left, who).toBe(boxes.get(who)!.x);
  });

  it("cast から差分を引けない立ち絵も、描画（layoutSprites）と同じく byCount の人数に数える", () => {
    const frame = (names: string[]) => ({ width: 100, height: 200, positions: Object.fromEntries(names.map((n, i) => [n, { left: i * 100, top: 0 }])) });
    const cast: Cast = { A: { appearances: { default: { variants: { normal: { image: "a.png", frame: frame(["left", "center", "right", "left-wide"]) } } } } } };
    const stage = initialStage();
    stage.sprites = {
      A: { variant: "normal", appearance: "", at: "left", flip: false },
      // キャストに無い人物（描画は出さないが、人数には数える）
      B: { variant: "normal", appearance: "", at: "right", flip: false },
    };
    const layout = { rules: { byCount: { "2": { left: "left-wide" } } } };
    const at = Object.fromEntries(Object.entries(stageMarks(stage, layout, cast).sprites).map(([who, m]) => [who, m.at]));
    expect(at).toEqual({ A: "left-wide", B: "right" });
    // 描画の置く位置と、出した立ち位置の名前の枠の位置が同じ（描画は引けない人物を枠の無い差分として渡す。dom-host.ts の spriteBoxes）
    const variant = cast.A!.appearances.default!.variants.normal!;
    const boxes = layoutSprites([["A", { sprite: stage.sprites.A!, variant, natural: { width: 0, height: 0 } }], ["B", { sprite: stage.sprites.B!, variant: { image: "" }, natural: { width: 0, height: 0 } }]], { width: 1280, height: 720 }, layout);
    expect(framePosition(variant.frame!, at.A!).left).toBe(boxes.get("A")!.x);
  });

  it("ほかのファイルで決めた変数で分かれる先の行は、その行へ届く道筋を探して流し直す", async () => {
    const files = {
      start: ["@choice", "- 行く -> #go", "- 戻る -> #back", "@end", "# go", "@set game.v = 1", "@jump next", "# back", "@jump next"].join("\n"),
      next: ["一。", "@if game.v == 1", "@jump #secret", "@end", "@jump #plain", "# secret", "秘密の行。", "@stop", "# plain", "ふつうの行。", "@stop", "届かない行。"].join("\n"),
    };
    const loadSource = async (file: string) => files[file as keyof typeof files];
    const s = new Sweeper({ loadSource, runtime: { speakers, commands: implementations }, entry: "start" });
    const normal = await s.sweep("next");
    // ふつうの道筋（最初の選択肢）で game.v が 1 になる道を通るので、逆にふつうの行が届かない形にして確かめる
    const unreached = normal.lines[7] ? 10 : 7;
    expect(normal.lines[unreached]).toBeUndefined();
    const found = await s.entryReaching("next", unreached);
    expect(found.entry).not.toBeNull();
    const again = await s.sweep("next", found.entry!);
    expect(again.lines[unreached]).toBeDefined();
    expect(again.route.length).toBe(1);
    // どう流しても届かない行
    expect(await s.entryReaching("next", 12)).toMatchObject({ entry: null, reason: "unreachable" });
  });
});

describe("届かない行へ届く道筋の手がかり（routeGuide）", () => {
  it("条件が a && b でも、それぞれの変数を条件に合う値にする @set を中継点にする", () => {
    const text = [
      "# start",
      "@set game.met = false",
      "@set game.met = true",
      "@set game.trust = 1",
      "@set game.trust = 5",
      "@if game.met && game.trust >= 3",
      "  　届けたい行。",
      "@end",
    ].join("\n");
    const scripts = new Map([["a", { script: parse(text, "a"), text }]]);
    const map = buildStoryMap({ scripts, registry: createRegistry(CORE_COMMANDS, []), entry: "a", hooks: new Map(), data: () => undefined, variables: {} } as unknown as Parameters<typeof buildStoryMap>[0]);
    const guide = routeGuide(map, new Map([["a", scripts.get("a")!.script]]), "a", 7);
    expect(guide.waypoints).toEqual([
      { file: "a", line: 3 },
      { file: "a", line: 5 },
    ]);
  });
});
