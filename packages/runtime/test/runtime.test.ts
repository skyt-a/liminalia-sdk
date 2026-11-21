import { describe, expect, it } from "vitest";
import { parse, updateVoiceLock } from "@liminalia/lang";
import { HeadlessHost, Runtime, type HeadlessOptions, type SaveData, type TraceEntry } from "../src/index.ts";

const speakers = ["ユイ", "レン", "ハル"];

function setup(files: Record<string, string>, options: Partial<HeadlessOptions> = {}) {
  const host = new HeadlessHost({
    loadSource: async (f) => {
      const src = files[f];
      if (src === undefined) throw new Error(`no file ${f}`);
      return src;
    },
    ...options,
  });
  const runtime = new Runtime(host, { speakers });
  return { host, runtime };
}

const pages = (trace: TraceEntry[]) => trace.flatMap((t) => (t.type === "page" ? [`${t.speaker ?? ""}:${t.text}`] : []));
const errors = (trace: TraceEntry[]) => trace.flatMap((t) => (t.type === "diagnostic" ? [t.diagnostic.message] : []));

describe("本文と制御", () => {
  it("@script は実行せず、通ったところで一度だけ script-skipped を知らせる（作品の allowScript を知らないので script-not-allowed は出さない）", async () => {
    const { host, runtime } = setup({ a: "はじめ\n@script\n  const a = 1;\n@end\nおわり" });
    await runtime.start("a");
    expect(host.trace.flatMap((t) => (t.type === "diagnostic" ? [`${t.diagnostic.code}:${t.diagnostic.line}`] : []))).toEqual(["script-skipped:2"]);
    expect(pages(host.trace)).toEqual([":はじめ", ":おわり"]);
  });

  it("台詞と地の文を順に出す", async () => {
    const { host, runtime } = setup({ a: "ユイ「おはよう」\n{r 黄昏|たそがれ}の声{br}が{click}消える。" });
    expect(await runtime.start("a")).toMatchObject({ reason: "end" });
    expect(pages(host.trace)).toEqual(["ユイ:「おはよう」", ":黄昏の声\nが消える。"]);
  });

  it("@if / @elif / @else と @set", async () => {
    const src = "@set game.trust = 1\n@if game.trust >= 2\nA\n@elif game.trust == 1\nB\n@else\nC\n@end\n@set game.trust += 2\n@if game.trust == 3\nD\n@end";
    const { host, runtime } = setup({ a: src });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual([":B", ":D"]);
    expect(runtime.state.game).toEqual({ trust: 3 });
  });

  it("== は型を比べる", async () => {
    const { host, runtime } = setup({ a: '@set game.v = "1"\n@if game.v == 1\n一致\n@else\n不一致\n@end' });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual([":不一致"]);
  });

  it("値の埋め込みと局所変数", async () => {
    const { host, runtime } = setup({ a: '@set game.name = "ハル"\n@let n = 2 * 3\n{= game.name}は{= n}歩進んだ。' });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual([":ハルは6歩進んだ。"]);
  });

  it("__proto__、constructor、prototype をたどる代入は実行時エラーにし、プロトタイプを汚さない。読み出しは null", async () => {
    const bad: [string, string][] = [
      ["@set game.__proto__.polluted = 1", "__proto__"],
      ['@set game["__proto__"]["polluted"] = 2', "__proto__"],
      ["@set game.constructor.prototype.polluted = 3", "constructor"],
      ['@set game.a["constructor"] = 4', "constructor"],
      ['@let k = "__proto__"\n@set game[k].polluted = 5', "__proto__"],
      ["@let __proto__ = 6", "__proto__"],
    ];
    for (const [line, key] of bad) {
      const { host, runtime } = setup({ a: `${line}\n届かない` });
      await runtime.start("a");
      const runtimeErrors = host.trace.flatMap((t) => (t.type === "diagnostic" && t.diagnostic.code === "runtime" ? [t.diagnostic.message] : []));
      expect(runtimeErrors).toEqual([`${key} は変数の名前やキーに使えません（代入しません）`]);
      expect(pages(host.trace)).toEqual([]);
      expect(Object.prototype).not.toHaveProperty("polluted");
    }
    const { host, runtime } = setup({ a: '@set game.ok = 1\n@let k = "constructor"\n{= game.__proto__ == null}{= game.constructor == null}{= game[k] == null}{= game.toString == null}{= game.ok}' });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual([":truetruetruetrue1"]);
    expect(runtime.state.game).toEqual({ ok: 1 });
    // 命令の結果を受け取る変数も同じ
    expect(() => runtime.setVariable("game.__proto__.polluted", 1)).toThrow(/__proto__ は変数の名前やキーに使えません/);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("別ファイルへの @jump と @call / @return", async () => {
    const { host, runtime } = setup({
      a: "A1\n@call b#sub\nA2\n@jump b",
      b: "B-top\n@jump #end\n# sub\nB-sub\n@return\n# end\nB-end",
    });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual([":A1", ":B-sub", ":A2", ":B-top", ":B-end"]);
  });

  it("選択肢", async () => {
    const src = "@choice\n- 左 -> #left\n- 右 -> #right\n@end\n# left\n左へ\n@jump #out\n# right\n右へ\n# out\n終わり";
    const { host, runtime } = setup({ a: src }, { choices: [1] });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual([":右へ", ":終わり"]);
    expect(host.trace.find((t) => t.type === "choice")).toEqual({ type: "choice", options: ["左", "右"], selected: 1 });
  });

  it("選択肢の if= が偽の項目は出さず、選んだ番号は出した中の番号", async () => {
    const src = [
      "@set game.asked_a = false",
      "@set game.asked_b = false",
      "# menu",
      "@choice",
      "- 話題A -> #a if=(game.asked_a == false)",
      "- 話題B -> #b if=(game.asked_b == false)",
      "- 終える -> #done if=(game.asked_a && game.asked_b)",
      "@end",
      "# a",
      "@set game.asked_a = true",
      "Aを聞いた",
      "@jump #menu",
      "# b",
      "@set game.asked_b = true",
      "Bを聞いた",
      "@jump #menu",
      "# done",
      "終わり",
    ].join("\n");
    const { host, runtime } = setup({ a: src }, { choices: [1, 0, 0] });
    expect(await runtime.start("a")).toMatchObject({ reason: "end" });
    expect(host.trace.filter((t) => t.type === "choice")).toEqual([
      { type: "choice", options: ["話題A", "話題B"], selected: 1 },
      { type: "choice", options: ["話題A"], selected: 0 },
      { type: "choice", options: ["終える"], selected: 0 },
    ]);
    expect(pages(host.trace)).toEqual([":Bを聞いた", ":Aを聞いた", ":終わり"]);
  });

  it("選択肢の if= がすべて偽なら、選択肢を出さずに警告して止まる", async () => {
    const { host, runtime } = setup({ a: "@choice\n- 北 -> #a if=(false)\n- 南 -> #a if=(1 > 2)\n@end\n# a\n着いた" });
    expect(await runtime.start("a")).toMatchObject({ reason: "stopped" });
    expect(host.trace.some((t) => t.type === "choice")).toBe(false);
    expect(pages(host.trace)).toEqual([]);
    expect(host.trace.flatMap((t) => (t.type === "diagnostic" ? [t.diagnostic.code] : []))).toEqual(["all-options-conditional", "no-choice-shown"]);
  });

  it("@define は呼び出し元の変数を壊さない", async () => {
    const src = "@define greet(name: string, times: int = 1)\n@let n = times * 2\n{= name}を{= n}回呼んだ。\n@end\n@let n = 100\n@greet name=レン\n@greet name=ハル times=3\n{= n}";
    const { host, runtime } = setup({ a: src });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual([":レンを2回呼んだ。", ":ハルを6回呼んだ。", ":100"]);
  });

  it("型の合わない式は位置付きのエラーで止まる", async () => {
    const { host, runtime } = setup({ a: '@set game.a = "x"\n@set game.b = game.a - 1\n届かない' });
    expect(await runtime.start("a")).toMatchObject({ reason: "error" });
    expect(errors(host.trace)).toEqual(['- は数値にだけ使えます（文字列 "x" - 数値 1）']);
    expect(pages(host.trace)).toEqual([]);
  });
});

describe("状態とセーブ", () => {
  it("命令は状態を更新し、描画側に引数（既定値込み）を渡す", async () => {
    const src = "@bg room.jpg time=1s\n@chara ユイカ serious at=left\n@bgm rain.ogg\nユイ「……」";
    const { host, runtime } = setup({ a: src });
    await runtime.start("a");
    expect(runtime.state.stage).toMatchObject({
      background: "room.jpg",
      sprites: { ユイカ: { variant: "serious", appearance: "", at: "left", flip: false } },
      bgm: { file: "rain.ogg", volume: 100, loop: true },
    });
    expect(host.trace[0]).toEqual({ type: "command", name: "bg", args: { image: "room.jpg", time: 1000, method: "crossfade", cross: false, wait: true, "hide-window": false, "keep-text": false, vague: 64, skip: true } });
  });

  it("@item-add・@item-remove は持ち物の数をゲームの変数に残し、式の item() で読める", async () => {
    const { runtime } = setup({ a: '@item-add key\n@item-add key count=2\n@item-add map\n@item-remove map\n@item-remove key count=1\n@set game.n = item("key")\n@set game.m = item("map")' });
    await runtime.start("a");
    expect(runtime.state.game["@items"]).toEqual({ key: 2 });
    expect([runtime.state.game.n, runtime.state.game.m]).toEqual([2, 0]);
  });

  it("@plane は奥行きの絵を状態に残し、@plane-hide と @bg で外す", async () => {
    const step = setup({ a: "@plane sky sky.png depth=0.9\n@plane grass grass.png depth=-0.3 front=true\n@plane-hide sky" });
    await step.runtime.start("a");
    expect(step.runtime.state.stage.planes).toEqual({ grass: { image: "grass.png", depth: -0.3, front: true } });
    const bg = setup({ a: "@plane sky sky.png\n@bg room.jpg" });
    await bg.runtime.start("a");
    expect(bg.runtime.state.stage.planes).toBeUndefined();
  });

  it("@dof はピントを合わせるところとぼかしの強さを状態に残し、who を書けば人物に合わせる。none で消す", async () => {
    const step = setup({ a: "@dof sprites blur=8\n@dof who=ユイカ" });
    await step.runtime.start("a");
    expect(step.runtime.state.stage.dof).toEqual({ on: "chara", who: "ユイカ", blur: 6 });
    const off = setup({ a: "@dof background\n@dof none" });
    await off.runtime.start("a");
    expect(off.runtime.state.stage.dof).toBeUndefined();
  });

  it("@tone は人物ごとか全員の色調を状態に残し、全員を替えると人物ごとのものを外す。none で消す", async () => {
    const step = setup({ a: "@tone night\n@tone sepia who=ユイカ" });
    await step.runtime.start("a");
    expect(step.runtime.state.stage.tones).toEqual({ "": "night", ユイカ: "sepia" });
    const all = setup({ a: "@tone sepia who=ユイカ\n@tone mono\n@tone none who=レン" });
    await all.runtime.start("a");
    expect(all.runtime.state.stage.tones).toEqual({ "": "mono" });
    const off = setup({ a: "@tone mono\n@tone none" });
    await off.runtime.start("a");
    expect(off.runtime.state.stage.tones).toBeUndefined();
  });

  it("@bg と @scene-change の tone= は、その背景の色調を状態に残す。書かずに背景を替えると外し、セーブとロードで戻る", async () => {
    const src = "@bg room.webp tone=night\n一\n@bg street.webp\n二\n@scene-change hall.webp tone=evening\n三\n@scene-change\n四\n@bg hall.webp tone=none\n五";
    const upTo = async (n: number) => {
      const s = setup({ a: src }, { maxPages: n });
      s.host.onLimit = () => s.runtime.stop();
      await s.runtime.start("a");
      return s.runtime;
    };
    const seen: unknown[] = [];
    for (const n of [1, 2, 3, 4, 5]) seen.push((await upTo(n)).state.stage.backgroundTone);
    // 書かずに替えた背景は外す、場面転換で背景を替えないなら残す、none も書いた値として残す（ui.backgroundTones より先）
    expect(seen).toEqual([{ image: "room.webp", tone: "night" }, undefined, { image: "hall.webp", tone: "evening" }, { image: "hall.webp", tone: "evening" }, { image: "hall.webp", tone: "none" }]);
    // セーブしてロードすると戻る（ロードした続きのページで止める）
    const save = JSON.parse(JSON.stringify((await upTo(3)).save()));
    const loaded = setup({ a: src }, { maxPages: 1 });
    loaded.host.onLimit = () => loaded.runtime.stop();
    await loaded.runtime.load(save);
    expect(pages(loaded.host.trace)).toEqual([":四"]);
    expect(loaded.runtime.state.stage.backgroundTone).toEqual({ image: "hall.webp", tone: "evening" });
  });

  it("@face は顔ウィンドウの表情を状態に残し、立ち絵を消すと消す前の差分を引き継ぐ", async () => {
    const { runtime } = setup({ a: "@face レン angry appearance=coat\n@chara ユイカ smile\n@chara-hide ユイカ\n@chara ユイカ normal\n@chara-hide-all" });
    await runtime.start("a");
    expect(runtime.state.stage.faces).toEqual({ レン: { appearance: "coat", variant: "angry" }, ユイカ: { appearance: "", variant: "normal" } });
  });

  it("@chara の solo=true はほかの人物を消し（顔ウィンドウの表情は引き継ぐ）、z は重なり順として残す（書かなければ今のまま）", async () => {
    const { runtime } = setup({ a: "@chara ユイカ smile z=2\n@chara レン angry\n@chara ハル solo=true time=300ms\n@chara ハル normal\n@chara ユイカ\n@chara ユイカ smile z=0" });
    await runtime.start("a");
    expect(runtime.state.stage.faces).toEqual({ ユイカ: { appearance: "", variant: "smile" }, レン: { appearance: "", variant: "angry" } });
    expect(Object.keys(runtime.state.stage.sprites)).toEqual(["ハル", "ユイカ"]);
    expect(runtime.state.stage.sprites.ユイカ!.z).toBeUndefined();
    const z = setup({ a: "@chara ユイカ smile z=2\n@chara ユイカ normal\n@chara レン z=-1" });
    await z.runtime.start("a");
    expect([z.runtime.state.stage.sprites.ユイカ!.z, z.runtime.state.stage.sprites.レン!.z]).toEqual([2, -1]);
  });

  it("真偽値の名前だけの指定は true と同じ動作をする", async () => {
    const prefix = "@chara ユイカ normal\n";
    const a = setup({ a: `${prefix}@chara レン solo smile at=left\n` });
    const b = setup({ a: `${prefix}@chara レン solo=true smile at=left\n` });
    await a.runtime.start("a");
    await b.runtime.start("a");
    expect(a.runtime.state.stage).toEqual(b.runtime.state.stage);
    expect(a.runtime.state.stage.sprites.レン?.variant).toBe("smile");
    expect(a.runtime.state.stage.sprites.ユイカ).toBeUndefined();
    expect(errors(a.host.trace)).toEqual([]);
  });

  it("省略できる最初の位置引数に読めない真偽値の名前だけの指定も、true と同じ動作をする", async () => {
    for (const [short, long] of [["@bg color=#000000 time=1s wait", "@bg color=#000000 time=1s wait=true"], ["@dof who=ユイカ wait", "@dof who=ユイカ wait=true"]] as const) {
      const a = setup({ a: `@chara ユイカ normal\n${short}\n本文` });
      const b = setup({ a: `@chara ユイカ normal\n${long}\n本文` });
      await a.runtime.start("a");
      await b.runtime.start("a");
      expect(errors(a.host.trace)).toEqual([]);
      expect(a.runtime.state.stage).toEqual(b.runtime.state.stage);
      expect(a.host.trace.filter((t) => t.type !== "diagnostic")).toEqual(b.host.trace.filter((t) => t.type !== "diagnostic"));
    }
  });

  it("省略形が実在する差分と衝突したら実行を止め、明示すれば使える", async () => {
    const cast = { ユイカ: { appearances: { default: { variants: { solo: { image: "solo.png" } } } } } };
    const run = async (source: string) => {
      const host = new HeadlessHost({ loadSource: async () => source });
      const runtime = new Runtime(host, { cast });
      return { result: await runtime.start("a"), runtime };
    };
    expect((await run("@chara ユイカ solo")).result).toMatchObject({ reason: "error" });
    expect((await run("@chara ユイカ solo=true")).result).toMatchObject({ reason: "end" });
    const variant = await run('@chara ユイカ "solo"');
    expect(variant.result).toMatchObject({ reason: "end" });
    expect(variant.runtime.state.stage.sprites.ユイカ?.variant).toBe("solo");
  });

  it("@chara clear は全消しの後に出した場合と同じ状態を作る", async () => {
    const before = "@chara ユイカ smile at=center flip=true appearance=coat z=2\n@chara レン angry at=right\n";
    const a = setup({ a: `${before}@chara-hide-all time=300ms\n@chara ユイカ at=left time=500ms\n@chara レン at=right time=500ms` });
    const b = setup({ a: `${before}@chara ユイカ at=left clear=300ms time=500ms\n@chara レン at=right time=500ms` });
    await a.runtime.start("a");
    await b.runtime.start("a");
    expect(b.runtime.state.stage).toEqual(a.runtime.state.stage);
  });

  it("自動配置は新規登場から記録し、表情替えで順番を変えず、明示位置を優先しセーブに残す", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@chara ユイカ normal\n@chara レン normal\n@chara ユイカ smile\n@chara レン at=right\n本文。" });
    const runtime = new Runtime(host, { commandDefaults: { chara: { "auto-layout": "true" } } });
    await runtime.start("a");
    expect(Object.keys(runtime.state.stage.sprites)).toEqual(["ユイカ", "レン"]);
    expect(runtime.state.stage.sprites.ユイカ).toMatchObject({ variant: "smile", autoLayout: true });
    expect(runtime.state.stage.sprites.レン).toMatchObject({ at: "right" });
    expect(runtime.state.stage.sprites.レン!.autoLayout).toBeUndefined();
    expect(runtime.save().stage.sprites.ユイカ?.autoLayout).toBe(true);
  });

  it.each(["ユイカ", "left"])("replace=%s は位置と順番を引き継ぎ、ほかの人物を保つ", async (target) => {
    const host = new HeadlessHost({ loadSource: async () => `@chara ユイカ normal\n@chara レン normal\n@chara ハル smile replace=${target}\n本文。` });
    const runtime = new Runtime(host, { commandDefaults: { chara: { "auto-layout": true } } });
    await runtime.start("a");
    expect(Object.keys(runtime.state.stage.sprites)).toEqual(["ハル", "レン"]);
    expect(runtime.state.stage.sprites.ハル?.autoLayout).toBe(true);
    expect(runtime.state.stage.faces?.ユイカ?.variant).toBe("normal");
    expect(host.trace.find((t) => t.type === "command" && t.name === "chara" && t.args["replace-who"] === "ユイカ")).toBeDefined();
  });

  it("自動配置の規則（入れる場所、退場しても動かさない、定位置）で、枠を状態とセーブに残す", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@chara ユイカ\n@chara レン\n@chara ハル\n@chara-hide レン\n@chara ソウ\n@chara ユイカ smile\n本文。" });
    const cast = { ハル: { appearances: {}, side: "left" as const } };
    const runtime = new Runtime(host, { commandDefaults: { chara: { "auto-layout": true } }, autoLayout: { enter: "start", exit: "keep" }, cast });
    await runtime.start("a");
    const slots = Object.fromEntries(Object.entries(runtime.state.stage.sprites).map(([who, s]) => [who, s.autoSlot]));
    // 入れる場所は左の端、ハルは定位置が左。レンが抜けた枠にソウが入り、ほかは動かない。表情替えで枠は変わらない
    expect(slots).toEqual({ ユイカ: { index: 2, count: 3 }, ハル: { index: 0, count: 3 }, ソウ: { index: 1, count: 3 } });
    expect(runtime.save().stage.sprites.ソウ?.autoSlot).toEqual({ index: 1, count: 3 });
  });

  it("規則の立ち位置の名前で replace できる", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@chara ユイカ\n@chara レン\n@chara ハル replace=near\n本文。" });
    const runtime = new Runtime(host, { commandDefaults: { chara: { "auto-layout": true } }, autoLayout: { positions: { "2": ["far", "near"] } } });
    await runtime.start("a");
    expect(Object.keys(runtime.state.stage.sprites)).toEqual(["ユイカ", "ハル"]);
  });

  it("規則の立ち位置が本人の立ち絵の枠に無ければ、実行時に知らせる", async () => {
    const frame = { positions: { left: { left: 0, top: 0 }, center: { left: 1, top: 0 }, right: { left: 2, top: 0 } } };
    const entry = { appearances: { default: { variants: { normal: { image: "a.png", frame } } } } };
    const host = new HeadlessHost({ loadSource: async () => "@chara ユイカ normal\n@chara レン normal\n本文。" });
    const runtime = new Runtime(host, { commandDefaults: { chara: { "auto-layout": true } }, autoLayout: { positions: { "2": ["left", "far"] } }, cast: { ユイカ: entry, レン: entry } });
    await runtime.start("a");
    expect(host.trace.filter((t) => t.type === "diagnostic").map((t) => t.type === "diagnostic" && t.diagnostic.message).join("\n")).toContain("far");
  });

  it("出し入れで並び直したほかの人物も、規則の立ち位置が本人の枠に無ければ知らせる", async () => {
    const frame = { positions: { left: { left: 0, top: 0 }, center: { left: 1, top: 0 }, right: { left: 2, top: 0 } } };
    const entry = { appearances: { default: { variants: { normal: { image: "a.png", frame } } } } };
    const messages = async (source: string) => {
      const host = new HeadlessHost({ loadSource: async () => source });
      const runtime = new Runtime(host, { commandDefaults: { chara: { "auto-layout": true } }, autoLayout: { positions: { "1": ["far"], "2": ["near", "right"] } }, cast: { ユイカ: entry, レン: entry } });
      await runtime.start("a");
      return host.trace.flatMap((t) => (t.type === "diagnostic" ? [t.diagnostic.message] : []));
    };
    // ユイカは一人なら far、レンが来ると near に動く（どちらも枠に無い）。レンは right で枠にある
    const entered = await messages("@chara ユイカ normal\n@chara レン normal\n本文。");
    expect(entered.filter((m) => m.includes("ユイカ"))).toEqual([expect.stringContaining("far"), expect.stringContaining("near")]);
    expect(entered.some((m) => m.includes("レン"))).toBe(false);
    // 退場で一人になったレンは far に動く
    const left = await messages("@chara ユイカ normal\n@chara レン normal\n@chara-hide ユイカ\n本文。");
    expect(left.filter((m) => m.includes("レン"))).toEqual([expect.stringContaining("far")]);
  });

  it("規則が無ければ自動配置の枠を状態に残さない（前と同じ状態）", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@chara ユイカ\n@chara レン\n本文。" });
    const runtime = new Runtime(host, { commandDefaults: { chara: { "auto-layout": true } }, autoLayout: { positions: { "2": ["left", "center"] } } });
    await runtime.start("a");
    expect(Object.values(runtime.state.stage.sprites).some((s) => s.autoSlot !== undefined)).toBe(false);
  });

  it("人数で読み替えたあとの立ち位置の名前（byCount）と、立ち絵の枠の立ち位置の名前でも replace できる", async () => {
    const cases: [string, Record<string, unknown> | undefined][] = [
      // 制作画面のシーンの情報は、二人のときのユイカを left-wide と出す
      ["@chara ユイカ at=left\n@chara レン at=right\n@chara ハル replace=left-wide\n本文。", { byCount: { "2": { left: "left-wide" } } }],
      // 書いた名前でも入れ替えられる
      ["@chara ユイカ at=left\n@chara レン at=right\n@chara ハル replace=left\n本文。", { byCount: { "2": { left: "left-wide" } } }],
      // 規則に無い、枠の立ち位置の名前（構文チェックは通す）
      ["@chara ユイカ at=far\n@chara ハル replace=far\n本文。", undefined],
      // 立ち位置の名前と同じ名前の人物がいても、立ち位置として扱う
      ["@chara ユイカ at=left\n@chara left at=right\n@chara ハル replace=left\n本文。", undefined],
    ];
    for (const [source, autoLayout] of cases) {
      const host = new HeadlessHost({ loadSource: async () => source });
      const runtime = new Runtime(host, autoLayout ? { autoLayout } : {});
      await runtime.start("a");
      expect(host.trace.filter((t) => t.type === "diagnostic").map((t) => t.type === "diagnostic" && t.diagnostic.message), source).toEqual([]);
      expect(runtime.state.stage.sprites.ユイカ, source).toBeUndefined();
      expect(runtime.state.stage.sprites.ハル?.at, source).toBe(source.includes("far") ? "far" : "left");
    }
  });

  it("枠の立ち位置の名前は、同じ名前の人物がいれば人物として読み、x で置いた人物は立ち位置の名前で選ばない（命令の表と format.md の説明。2026-11-19 の X2）", async () => {
    const run = async (source: string) => {
      const host = new HeadlessHost({ loadSource: async () => source });
      const runtime = new Runtime(host);
      await runtime.start("a");
      return { sprites: Object.keys(runtime.state.stage.sprites), codes: host.trace.flatMap((t) => (t.type === "diagnostic" ? [t.diagnostic.code] : [])) };
    };
    // far に立つユイカでなく、far という名前の人物と入れ替わる
    expect(await run("@chara ユイカ at=far\n@chara far at=right\n@chara ハル replace=far\n本文。")).toEqual({ sprites: ["ユイカ", "ハル"], codes: [] });
    expect((await run("@chara ユイカ x=100\n@chara ハル replace=center\n本文。")).codes).toEqual(["chara-replace-target"]);
  });

  it("replace の立ち位置の名前は、描画と同じく差分の枠を見て読み替えたあとの名前で選ぶ（枠に読み替え先の無い人物は書いた名前のまま）", async () => {
    const frame = (names: string[]) => ({ width: 100, height: 200, positions: Object.fromEntries(names.map((n, i) => [n, { left: i * 100, top: 0 }])) });
    const entry = (names: string[]) => ({ appearances: { default: { variants: { normal: { image: "x.png", frame: frame(names) } } } } });
    // ユイカの枠には left-wide が無いので、描画は left に置く。left-wide に立つのはレンだけ
    const cast = { ユイカ: entry(["left", "center", "right"]), レン: entry(["left", "center", "right", "left-wide"]), ハル: entry(["left", "center", "right", "left-wide"]) };
    const host = new HeadlessHost({ loadSource: async () => "@chara ユイカ normal at=left\n@chara レン normal at=left-wide\n@chara ハル normal replace=left-wide\n本文。" });
    const runtime = new Runtime(host, { cast, autoLayout: { byCount: { "2": { left: "left-wide" } } } });
    await runtime.start("a");
    expect(host.trace.filter((t) => t.type === "diagnostic").map((t) => t.type === "diagnostic" && t.diagnostic.message)).toEqual([]);
    expect(Object.keys(runtime.state.stage.sprites).sort()).toEqual(["ハル", "ユイカ"]);
    expect(runtime.state.stage.sprites.ハル?.at).toBe("left-wide");
  });

  it("replace の対象がいない・複数いる・登場済みなら変更せず実行時に知らせる", async () => {
    for (const [setupLines, target] of [["@chara ユイカ at=left\n", "right"], ["@chara ユイカ at=left\n@chara レン at=left\n", "left"], ["@chara ユイカ\n@chara ハル\n", "ユイカ"]]) {
      const host = new HeadlessHost({ loadSource: async () => `${setupLines}@chara ハル replace=${target}\n本文。` });
      const runtime = new Runtime(host);
      await runtime.start("a");
      expect(host.trace.some((t) => t.type === "diagnostic" && t.diagnostic.code === "chara-replace-target")).toBe(true);
      expect(runtime.state.stage.sprites.ユイカ).toBeDefined();
    }
  });

  it("明示座標の人物を名前で入れ替えると座標を引き継ぐ", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@chara ユイカ x=123 y=42\n@chara ハル replace=ユイカ\n本文。" });
    const runtime = new Runtime(host, { commandDefaults: { chara: { "auto-layout": true } } });
    await runtime.start("a");
    expect(runtime.state.stage.sprites.ハル).toMatchObject({ x: 123, y: 42 });
    expect(runtime.state.stage.sprites.ハル?.autoLayout).toBeUndefined();
  });

  it("@scene-change は一人だけを消す指定と暗転に重ねる指定を受け付ける", async () => {
    const { host, runtime } = setup({ a: "@chara ユイカ smile\n@chara レン angry\n@scene-change time=1s hide-who=ユイカ hide-at=start hide-fade=300ms\n" });
    await runtime.start("a");
    expect(Object.keys(runtime.state.stage.sprites)).toEqual(["レン"]);
    expect(runtime.state.stage.faces?.ユイカ).toEqual({ appearance: "", variant: "smile" });
    const scene = host.trace.find((t) => t.type === "command" && t.name === "scene-change");
    expect(scene).toMatchObject({ args: { "hide-who": "ユイカ", "hide-at": "start", "hide-fade": 300 } });
  });

  it("@scene-change hide-chara=false は一人指定があっても全員を残す", async () => {
    const { host, runtime } = setup({ a: "@chara ユイカ smile\n@chara レン angry\n@scene-change hide-chara=false hide-who=ユイカ hide-window-at=start\n" });
    await runtime.start("a");
    expect(Object.keys(runtime.state.stage.sprites)).toEqual(["ユイカ", "レン"]);
    expect(runtime.state.stage.faces?.ユイカ).toBeUndefined();
    expect(host.trace.find((t) => t.type === "command" && t.name === "scene-change")).toMatchObject({ args: { "hide-chara": false, "hide-window-at": "start" } });
  });

  it("@scene-change の既定は立ち絵を暗転後、枠を暗転開始時に隠す", async () => {
    const { host, runtime } = setup({ a: "@chara ユイカ\n@scene-change\n" });
    await runtime.start("a");
    expect(host.trace.find((t) => t.type === "command" && t.name === "scene-change")).toMatchObject({ args: { "hide-chara": true, "hide-chara-at": "covered", "hide-window": true, "hide-window-at": "start" } });
  });

  it("旧名の作品既定値より hide-chara-at の明示を優先する", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@scene-change hide-chara-at=covered" });
    const runtime = new Runtime(host, { commandDefaults: { "scene-change": { "hide-at": "start" } } });
    await runtime.start("a");
    const scene = host.trace.find((t) => t.type === "command" && t.name === "scene-change");
    expect(scene).toMatchObject({ args: { "hide-chara-at": "covered" } });
    if (scene?.type === "command") expect(scene.args["hide-at"]).toBeUndefined();
  });

  it("@chara は、出ている人物の書かなかった差分・立ち絵セット・位置・反転を保ち、出ていなければ既定にする。if-hidden=true は表示中なら何もしない", async () => {
    const src = [
      "@chara ユイカ normal",
      "@chara レン angry at=auto flip=true appearance=coat",
      "@chara レン smile",
      "@chara ユイカ serious x=100 y=50",
      "@chara レン normal if-hidden=true",
      "@chara-hide ユイカ",
      "@chara ユイカ normal at=right if-hidden=true",
    ].join("\n");
    const { host, runtime } = setup({ a: src });
    await runtime.start("a");
    // 表示中の差し替えは重なり順（挿入順）を変えない
    expect(Object.entries(runtime.state.stage.sprites)).toEqual([
      ["レン", { variant: "smile", appearance: "coat", at: "auto", flip: true }],
      ["ユイカ", { variant: "normal", appearance: "", at: "right", flip: false }],
    ]);
    // 何もしなかった @chara は描画側に知らせない
    expect(host.trace.filter((t) => t.type === "command" && t.name === "chara")).toHaveLength(5);

    const step = setup({ a: src.split("\n").slice(0, 4).join("\n") });
    await step.runtime.start("a");
    expect(step.runtime.state.stage.sprites).toEqual({
      ユイカ: { variant: "serious", appearance: "", at: "center", flip: false, x: 100, y: 50 },
      レン: { variant: "smile", appearance: "coat", at: "auto", flip: true },
    });
    // 位置を書けば、前の座標は引き継がない。消してから出し直すと既定から
    const moved = setup({ a: "@chara ユイカ smile x=100 y=50\n@chara ユイカ at=left\n@chara レン angry at=right flip=true\n@chara-hide レン\n@chara レン" });
    await moved.runtime.start("a");
    expect(moved.runtime.state.stage.sprites).toEqual({
      ユイカ: { variant: "smile", appearance: "", at: "left", flip: false },
      レン: { variant: "", appearance: "", at: "center", flip: false },
    });
  });

  it("セーブした位置から同じ続きになる", async () => {
    const src = "@set game.n = 1\n一\n@set game.n += 1\n二\n三は{= game.n}";
    const first = setup({ a: src }, { maxPages: 1 });
    first.host.onLimit = () => first.runtime.stop();
    await first.runtime.start("a");
    const save = JSON.parse(JSON.stringify(first.runtime.save()));

    const second = setup({ a: src });
    await second.runtime.load(save);
    expect(pages(second.host.trace)).toEqual([":二", ":三は2"]);
  });

  it("ページの途中でセーブしたら、そのページから再開する", async () => {
    const src = "一\n二\n三";
    let runtime!: Runtime;
    let saved: unknown;
    let clicks = 0;
    const host = new HeadlessHost({ loadSource: async () => src });
    host.waitClick = async () => {
      if (++clicks === 2) {
        saved = JSON.parse(JSON.stringify(runtime.save()));
        runtime.stop();
      }
    };
    runtime = new Runtime(host, { speakers });
    await runtime.start("a");

    const second = setup({ a: src });
    await second.runtime.load(saved as never);
    expect(pages(second.host.trace)).toEqual([":二", ":三"]);
  });

  it("ページの途中でセーブしても、本文中の命令はロードしたあと一度しか効かない", async () => {
    // 呼ぶたびに数を増やす命令（増減で動かす演出と同じ性質）
    const count = {
      spec: { name: "count", summary: "", positional: [], params: {}, example: "@count" },
      run: async (_a: unknown, ctx: { state: { stage: { extra: Record<string, unknown> } } }) => {
        ctx.state.stage.extra.n = Number(ctx.state.stage.extra.n ?? 0) + 1;
      },
    };
    const src = "一\n増える{@count}{click}ところ\n三";
    let runtime!: Runtime;
    let saved: unknown;
    let clicks = 0;
    const host = new HeadlessHost({ loadSource: async () => src });
    host.waitClick = async () => {
      // 二ページ目の {click}（{@count} を実行した後）でセーブする
      if (++clicks === 2) {
        saved = JSON.parse(JSON.stringify(runtime.save()));
        runtime.stop();
      }
    };
    runtime = new Runtime(host, { speakers, commands: [count as never] });
    await runtime.start("a");
    expect(runtime.state.stage.extra.n).toBe(1);
    expect((saved as { stage: { extra: Record<string, unknown> } }).stage.extra.n).toBeUndefined();

    const second = new Runtime(new HeadlessHost({ loadSource: async () => src }), { speakers, commands: [count as never] });
    await second.load(saved as never);
    expect(second.state.stage.extra.n).toBe(1);
  });

  it("start は始める前に入れた temp を引き継ぎ、game は空にする", async () => {
    const { host, runtime } = setup({ a: "@if temp.intro\n導入\n@end\n本文" });
    runtime.state.game.old = 1;
    runtime.state.temp.intro = true;
    await runtime.start("a");
    expect(pages(host.trace)).toEqual([":導入", ":本文"]);
    expect(runtime.state.game).toEqual({});
  });

  it("乱数はシードで決まる", async () => {
    const src = "@set game.r = [random(100), random(100), random(100)]";
    const a = setup({ a: src });
    const b = setup({ a: src });
    await a.runtime.start("a");
    await b.runtime.start("a");
    expect(a.runtime.state.game.r).toEqual(b.runtime.state.game.r);
  });

  it("実装のない命令は飛ばして報告する", async () => {
    const { host, runtime } = setup({ a: "@fx-speedline dir=left\n続き" });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual([":続き"]);
    expect(errors(host.trace)).toEqual(["@fx-speedline はこの環境では実装されていないため、スキップしました"]);
  });
});

describe("取り込みのために足した書き方と命令", () => {
  it("@use したファイルの @define を呼べる。ロードしたあとも呼べる", async () => {
    const files = {
      lib: "@define greet(first-name: string = \"誰か\")\n{= first_name}さん\n@end",
      a: "@use lib\n@greet first-name=ハル\n@greet\n終わり",
    };
    const first = setup(files, { maxPages: 1 });
    first.host.onLimit = () => first.runtime.stop();
    await first.runtime.start("a");
    expect(pages(first.host.trace)).toEqual([":ハルさん"]);
    const save = JSON.parse(JSON.stringify(first.runtime.save()));
    const second = setup(files);
    await second.runtime.load(save);
    expect(pages(second.host.trace)).toEqual([":誰かさん", ":終わり"]);
  });

  it("選択肢の見た目は描画側に渡り、文のない選択肢は画面なしでは画像の名前で記録する", async () => {
    const { host, runtime } = setup({ a: "@choice\n- 北 -> #a if=(true)\n- -> #a image=b.png x=(1 + 2)\n@end\n# a" });
    let seen: unknown;
    const choose = host.choose.bind(host);
    host.choose = async (o, s, looks) => {
      seen = looks;
      return choose(o, s, looks);
    };
    await runtime.start("a");
    expect(seen).toEqual([null, { image: "b.png", x: 3 }]);
    expect(host.trace.find((t) => t.type === "choice")).toMatchObject({ options: ["北", "b.png"] });
  });

  it("{size} と {mark} は文字の見た目として描画側に渡る", async () => {
    const { host, runtime } = setup({ a: "{size 32 {mark #ff0 大}}" });
    const styles: unknown[] = [];
    const present = host.present.bind(host);
    host.present = async (e) => {
      if (e.type === "text") styles.push(e.style);
      return present(e);
    };
    await runtime.start("a");
    expect(styles).toEqual([{ bold: false, italic: false, color: null, perChar: null, size: 32, mark: "#ff0" }]);
  });

  it("@sleep-game で寄り道し、@awake-game でその命令の次へ戻る（game. は今の値を残す）", async () => {
    const { host, runtime } = setup({
      a: "@bg room.jpg\n@sleep-game b#gallery\n戻った{= game.seen}\n@awake-game",
      b: "# gallery\n@bg gallery.jpg\n@set game.seen = 1\n鑑賞\n@awake-game",
    });
    expect(await runtime.start("a")).toMatchObject({ reason: "end" });
    expect(pages(host.trace)).toEqual([":鑑賞", ":戻った1"]);
    expect(runtime.state.stage.background).toBe("room.jpg");
    expect(runtime.state.sleep).toBeNull();
  });

  it("@checkpoint と @rollback", async () => {
    // keep-variables（既定 true）なので game.n は巻き戻らず、三回目で抜ける
    const { host, runtime } = setup({ a: "@checkpoint top\n@set game.n += 1\n{= game.n}\n@if game.n < 3\n@rollback top\n@end\n終わり" });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual([":1", ":2", ":3", ":終わり"]);
    const missing = setup({ a: "@rollback nowhere" });
    expect(await missing.runtime.start("a")).toMatchObject({ reason: "error" });
    expect(errors(missing.host.trace)).toEqual(["@checkpoint nowhere はまだ記録されていません"]);
  });

  it("@text-input と @dialog の結果", async () => {
    const { host, runtime } = setup({
      a: '@text-input game.name initial="ハル"\n@dialog "続ける？" type=confirm target=#yes cancel-target=#no\n# yes\nはい{= game.name}\n@jump #end\n# no\nいいえ{= game.name}\n# end',
    });
    // 遊ぶ人の画面の答えを真似る（自動確認ではない）
    host.automated = false;
    const present = host.present.bind(host);
    host.present = async (e) => {
      await present(e);
      if (e.type === "command" && e.name === "text-input") return "レン";
      if (e.type === "command" && e.name === "dialog") return false;
    };
    await runtime.start("a");
    expect(pages(host.trace)).toEqual([":いいえレン"]);
    // 画面なしでは入力は最初の文字、確認は OK
    const headless = setup({ a: '@text-input game.name initial="ハル"\n@dialog "続ける？" type=confirm target=#yes\n# no\nいいえ\n# yes\nはい{= game.name}' });
    await headless.runtime.start("a");
    expect(pages(headless.host.trace)).toEqual([":はいハル"]);
  });

  it("音・システム画面への要求・変数の消去が状態に残る", async () => {
    const src = "@bgm a.ogg\n@se b.ogg channel=1 loop=true\n@pause-bgm\n@bgm-volume 40\n@se-volume 30\n@menu-button hide\n@backlog off\n@set temp.x = 1\n@set game.y = 2\n@clear-vars temp";
    const { runtime } = setup({ a: src });
    await runtime.start("a");
    expect(runtime.state.stage.bgm).toEqual({ file: "a.ogg", volume: 40, loop: true, paused: true });
    expect(runtime.state.stage.loopingSe).toEqual({ "1": { file: "b.ogg", volume: 30 } });
    expect(runtime.state.stage.ui).toEqual({ menuButton: false, shortcuts: true, backlog: false });
    expect(runtime.state.temp).toEqual({});
    expect(runtime.state.game).toEqual({ y: 2 });
  });
});

describe("ボイス", () => {
  const voices = (trace: TraceEntry[]) => trace.flatMap((t) => (t.type === "page" ? [t.voice ?? "-"] : []));

  it("@voice は次の台詞で鳴らし、一度で消える", async () => {
    const { host, runtime } = setup({ a: "@voice yui/1.ogg volume=80\nユイ「一」\nユイ「二」" });
    await runtime.start("a");
    expect(voices(host.trace)).toEqual(["voice/yui/1.ogg", "-"]);
  });

  it("@voice と台詞の間にメモ（//）があっても次の台詞で鳴らす", async () => {
    const { host, runtime } = setup({ a: "@voice yui/1.ogg\n// 怒って\n  // 小声で\nユイ「一」\nユイ「二」" });
    await runtime.start("a");
    expect(voices(host.trace)).toEqual(["voice/yui/1.ogg", "-"]);
  });

  it("@voice-auto は話者の台詞ごとに番号を進める。@voice を書いた台詞はそちらを鳴らし、番号は進めない", async () => {
    const src = ['@voice-auto ユイ pattern="yui_{n:3}.ogg" next=9', "ユイ「一」", "レン「二」", "@voice special.ogg folder=sound", "ユイ「三」", "ユイ「四」", "@voice-auto-off ユイ", "ユイ「五」"].join("\n");
    const { host, runtime } = setup({ a: src });
    await runtime.start("a");
    expect(voices(host.trace)).toEqual(["voice/yui_009.ogg", "-", "sound/special.ogg", "voice/yui_010.ogg", "-"]);
    expect(runtime.state.stage.voice?.auto?.ユイ).toMatchObject({ next: 11, off: true });
  });

  it("止めても番号は保ち、@voice-auto で再開する。start=false は設定だけ", async () => {
    const src = ['@voice-auto ユイ pattern="y{n}.ogg" start=false', "ユイ「一」", "@voice-auto", "ユイ「二」", "@voice-auto-off", "ユイ「三」", "@voice-auto ユイ", "ユイ「四」", "@voice-auto ユイ next=7", "ユイ「五」"].join("\n");
    const { host, runtime } = setup({ a: src });
    await runtime.start("a");
    expect(voices(host.trace)).toEqual(["-", "voice/y1.ogg", "-", "voice/y2.ogg", "voice/y7.ogg"]);
  });

  it("本文の中の @voice はその場で描画側へ送る（次の台詞には持ち越さない）", async () => {
    const { host, runtime } = setup({ a: "ユイ「一{@voice yui/1.ogg}」\nユイ「二」" });
    await runtime.start("a");
    expect(voices(host.trace)).toEqual(["-", "-"]);
    expect(host.trace.some((t) => t.type === "command" && t.name === "voice" && t.args.file === "yui/1.ogg")).toBe(true);
  });

  it("ページの途中でセーブしてロードすると、同じページで同じ番号のボイスを鳴らす", async () => {
    const files = { a: '@voice-auto ユイ pattern="y{n}.ogg"\nユイ「一」\nユイ「二」' };
    const first = setup(files, { maxPages: 1 });
    let save = first.runtime.save();
    // 一ページ目を出し始めたところ（ボイスの番号はもう進んでいる）でセーブする
    first.host.onLimit = () => {
      save = first.runtime.save();
      first.runtime.stop();
    };
    await first.runtime.start("a");
    const second = setup(files);
    await second.runtime.load(save);
    expect(voices(second.host.trace)).toEqual(["voice/y1.ogg", "voice/y2.ogg"]);
  });

  it("番号の固定があれば、台詞を足しても後ろの番号はずれない。固定に無い台詞は鳴らさない", async () => {
    const before = '@voice-auto ユイ pattern="y{n}.ogg"\nユイ「一」\n@if game.a\nユイ「分かれ道」\n@end\nユイ「二」';
    const scripts = new Map([["a", parse(before, "a", { speakers })]]);
    const { lock } = updateVoiceLock(null, scripts, new Set(["ユイ"]));
    expect(Object.values(lock.lines).map((e) => [e.source, e.n])).toEqual([["「一」", 1], ["「分かれ道」", 2], ["「二」", 3]]);
    // 数え方だけなら、分かれ道を通らないと「二」が 2 になる
    const counted = setup({ a: before });
    await counted.runtime.start("a");
    expect(voices(counted.host.trace)).toEqual(["voice/y1.ogg", "voice/y2.ogg"]);
    // 固定すれば、分かれ道を通らなくても、前に一行足しても「二」は 3
    const after = before.replace("ユイ「一」", "ユイ「零」\nユイ「一」");
    const host = new HeadlessHost({ loadSource: async () => after });
    await new Runtime(host, { speakers, voiceLock: lock }).start("a");
    expect(voices(host.trace)).toEqual(["-", "voice/y1.ogg", "voice/y3.ogg"]);
  });
});

describe("多言語", () => {
  it("訳の口があれば、本文の行・選択肢・話者名を訳に替える（無い行は原文）", async () => {
    const { host, runtime } = setup({ a: "ユイ「おはよう」\n　朝だ。\n@choice\n  - 行く -> #x\n@end\n# x\n　着いた。" });
    const { parseInline } = await import("@liminalia/lang");
    const lines: Record<string, string> = { "「おはよう」": "“{r Morning|モーニング}.”", 行く: "Go" };
    runtime.translator = {
      line: (_f, source) => (lines[source] ? parseInline(lines[source]).content : null),
      option: (_f, source) => (lines[source] ? parseInline(lines[source]).content : null),
      speaker: (name) => (name === "ユイ" ? "Yui" : null),
    };
    await runtime.start("a");
    expect(pages(host.trace)).toEqual(["ユイ:“Morning.”", ":　朝だ。", ":　着いた。"]);
    expect(host.trace.find((t) => t.type === "choice")).toMatchObject({ options: ["Go"] });
  });

  it("訳す印のある文字の引数は、書いたファイルと原文で訳を引いて替える（式の値も同じ。印の無い引数と訳の無い文字はそのまま）", async () => {
    const { host, runtime } = setup({ a: '@set game.t = "題"\n@backlog-add "扉の音"\n@backlog-add "足音"\n@window-title (game.t)\n@open-url "扉の音"\n本文' });
    const seen: string[] = [];
    runtime.translator = {
      line: () => null,
      option: () => null,
      speaker: () => null,
      arg: (file, source) => (seen.push(`${file}:${source}`), source === "扉の音" ? "Door" : source === "題" ? "Title" : null),
    };
    await runtime.start("a");
    const args = host.trace.filter((t) => t.type === "command" && ["backlog-add", "window-title", "open-url"].includes(t.name)).map((t) => (t.type === "command" ? Object.values(t.args)[0] : null));
    expect(args).toEqual(["Door", "足音", "Title", "扉の音"]);
    // @set の文字は入れるときに訳す（変数には訳が入り、@window-title は訳を原文として引く）
    expect(seen).toEqual(["a:題", "a:扉の音", "a:足音", "a:Title"]);
  });

  it("`@set 変数 = \"文字\"` の文字は、訳があれば訳を入れる（式で作る文字、+= で足す文字、文字の無いものは訳さない）", async () => {
    const { runtime } = setup({ a: '# one\n@set game.name = "ユイ"\n@set game.full = "名前は" + "ユイ"\n@set game.log = "あ"\n@set game.log += "ユイ"\n@set game.code = "42"\n@set game.other = "ほか"\n本文' });
    const seen: string[] = [];
    runtime.translator = {
      line: () => null,
      option: () => null,
      speaker: () => null,
      arg: (file, source, context) => (seen.push(`${file}:${source}:${context}`), source === "ユイ" ? "Yui" : null),
    };
    await runtime.start("a");
    expect(runtime.state.game).toMatchObject({ name: "Yui", full: "名前はユイ", log: "あユイ", code: "42", other: "ほか" });
    expect(seen).toEqual(["a:ユイ:one", "a:あ:one", "a:ほか:one"]);
  });

  it("訳の口に、実行している場面（直前のラベル。@define の中とラベルの前は空）を渡す", async () => {
    const { runtime } = setup({ a: "@define m()\n　中。\n@end\n　前。\n# one\n　はい。\n@m\n@choice\n  - 行く -> #two\n@end\n# two\n　はい。{@backlog-add \"音\"}" });
    const seen: string[] = [];
    runtime.translator = {
      line: (_f, source, context) => (seen.push(`line ${source} ${context}`), null),
      option: (_f, source, context) => (seen.push(`option ${source} ${context}`), null),
      speaker: () => null,
      arg: (_f, source, context) => (seen.push(`arg ${source} ${context}`), null),
    };
    await runtime.start("a");
    expect(seen).toEqual(["line 　前。 ", "line 　はい。 one", "line 　中。 ", "option 行く one", "line 　はい。{@backlog-add \"音\"} two", "arg 音 two"]);
  });
});

describe("おまけ", () => {
  it("@achieve ははじめて解放したときだけ描画側へ知らせ、日時をシステム変数に残す。@bgm は鳴らした曲を残す", async () => {
    const { host, runtime } = setup({ a: "@achieve star\n@achieve star\n@bgm night.ogg\n本文" });
    await runtime.start("a");
    expect(host.trace.filter((t) => t.type === "command" && t.name === "achieve")).toHaveLength(1);
    expect(typeof (runtime.system.achievements as Record<string, unknown>).star).toBe("string");
    expect(runtime.system.bgm_heard).toEqual({ "night.ogg": true });
  });

  it("@achieve-progress は数を残し、目標に届いたときだけ解除して知らせる（set は減らさない）", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@achieve-progress reads add=2\n@achieve-progress reads set=1\n@achieve-progress reads set=3\n@achieve-progress reads\n@achieve-progress free\n本文" });
    const runtime = new Runtime(host, { achievementGoals: { reads: 4 } });
    await runtime.start("a");
    const sent = host.trace.filter((t) => t.type === "command" && t.name === "achieve-progress").map((t) => (t.type === "command" ? t.args : null));
    expect(sent).toEqual([
      { id: "reads", value: 2, goal: 4, unlocked: false },
      { id: "reads", value: 3, goal: 4, unlocked: false },
      { id: "reads", value: 4, goal: 4, unlocked: true },
      { id: "free", value: 1, unlocked: false },
    ]);
    expect(runtime.system.achievement_progress).toEqual({ reads: 4, free: 1 });
    expect(typeof (runtime.system.achievements as Record<string, unknown>).reads).toBe("string");
  });
});

describe("変数に入れたときの知らせ（onAssign）", () => {
  it("@set・@let・命令の結果（setVariable）のどれでも、パスと値と行を知らせる", async () => {
    const pick = {
      spec: { name: "pick", summary: "", positional: [], params: {}, example: "@pick" },
      run: async (_a: unknown, ctx: { runtime: Runtime }) => ctx.runtime.setVariable("game.picked", "b"),
    };
    const files: Record<string, string> = {
      a: '@set game.trust = 1\n@set game.trust += 2\n@let n = 3\n@set temp.flags.seen = true\n@set game.list = [1, 2]\n@set game.list[1] = 5\n@pick\n@call b',
      b: "@set system.cleared = true\n@return",
    };
    const seen: [string, unknown, string][] = [];
    const runtime = new Runtime(new HeadlessHost({ loadSource: async (f) => files[f]! }), {
      speakers,
      commands: [pick as never],
      onAssign: (path, value, at) => seen.push([path, value, `${at.file}:${at.line}`]),
    });
    await runtime.start("a");
    expect(seen).toEqual([
      ["game.trust", 1, "a:1"],
      ["game.trust", 3, "a:2"],
      ["n", 3, "a:3"],
      ["temp.flags.seen", true, "a:4"],
      ["game.list", [1, 5], "a:5"],
      ["game.list.1", 5, "a:6"],
      ["game.picked", "b", "a:7"],
      ["system.cleared", true, "b:1"],
    ]);
  });

  it("実行中の命令の位置（at）は、@define の中ならその行", async () => {
    const src = "@define mark()\n@set game.m = 1\n@end\n@mark";
    const at: string[] = [];
    const runtime = new Runtime(new HeadlessHost({ loadSource: async () => src }), { speakers, onAssign: (_p, _v, a) => at.push(`${a.file}:${a.line}`) });
    expect(runtime.at).toBeNull();
    await runtime.start("a");
    expect(at).toEqual(["a:2"]);
  });

  it("今いるラベル（label）は、そのページより前で最後のラベル。@define の中なら呼び出したところ", async () => {
    const src = "@define say()\n@set game.x = 1\n@end\nはじめ。\n# one\nいち。\n@say\n# two\nに。\n";
    const labels: string[] = [];
    const runtime: Runtime = new Runtime(new HeadlessHost({ loadSource: async () => src }), {
      speakers,
      onAssign: () => labels.push(`set:${runtime.label?.label ?? ""}`),
    });
    const host = (runtime as unknown as { host: { present(e: { type: string }): unknown } }).host;
    const present = host.present.bind(host);
    host.present = (e) => {
      if (e.type === "page") labels.push(`${runtime.label?.file}#${runtime.label?.label ?? ""}`);
      return present(e);
    };
    await runtime.start("a");
    expect(labels).toEqual(["a#", "a#one", "set:one", "a#two"]);
  });
});

describe("捨てた実行器", () => {
  it("ページの途中で dispose すると、残りの本文を送らず、クリックも待たず、ふたたび動かない", async () => {
    const events: string[] = [];
    let runtime: Runtime;
    const host = {
      loadSource: async () => "A{b B}C\n次のページ。",
      present: async (e: { type: string; text?: string; name?: string }) => {
        events.push(e.type === "text" ? `text:${e.text}` : e.type === "command" ? `command:${e.name}` : e.type);
        if (e.type === "text" && e.text === "A") runtime.dispose();
      },
      waitClick: async () => void events.push("click"),
      choose: async () => null,
    };
    runtime = new Runtime(host, { speakers });
    expect(await runtime.start("a")).toMatchObject({ reason: "stopped" });
    // 最初の本文の前に、メッセージウィンドウを出す
    expect(events).toEqual(["command:window", "page", "text:A"]);
    // 捨てたあとのロードは、画面を組み立て直さず、進めもしない
    expect(await runtime.load(runtime.save())).toMatchObject({ reason: "stopped" });
    expect(events).toEqual(["command:window", "page", "text:A"]);
  });

  it("@window で消していなければ、最初の本文の前にメッセージウィンドウを出す。消したあとは出さない", async () => {
    const shown: boolean[] = [];
    const host = new HeadlessHost({ loadSource: async () => "一。\n@window hide\n二。\n@window show\n三。" });
    const rt: Runtime = new Runtime(host, { speakers, onStep: () => void shown.push(rt.state.stage.window) });
    await rt.start("a");
    // 一の前は閉じている → 一で出る → hide → 二は消えたまま → show → 三
    expect(shown).toEqual([false, true, false, false, true]);
  });

  it("onStep は命令ごとに、実行する直前に呼ぶ", async () => {
    const steps: [number, unknown][] = [];
    const host = new HeadlessHost({ loadSource: async () => "# top\n@set game.x = 1\n一。\n@set game.x = 2\n二。" });
    const rt: Runtime = new Runtime(host, { speakers, onStep: (at) => void steps.push([at.line, rt.state.game.x]) });
    await rt.start("a");
    expect(steps).toEqual([
      [1, undefined],
      [2, undefined],
      [3, 1],
      [4, 1],
      [5, 2],
    ]);
  });
});

describe("変数の初期値（options.variables）", () => {
  it("game は「はじめから」のたびに初期値で始まり、system は値が無いときだけ初期値になる。ロードしたセーブに無い game の変数も補う", async () => {
    const src = "@set game.n += 1\n@set system.seen += 1\n# end\nおわり";
    const runtime = new Runtime(new HeadlessHost({ loadSource: async () => src }), { variables: { "game.n": 10, "game.tag": "a", "system.seen": 0 } });
    await runtime.start("a");
    expect(runtime.state.game).toEqual({ n: 11, tag: "a" });
    // 既読のラベル（式の read()）も全セーブ共通の変数に入る
    expect(runtime.system).toEqual({ seen: 1, "@read": { a: true, "a#end": true } });
    await runtime.start("a");
    expect(runtime.state.game.n).toBe(11);
    expect(runtime.system.seen).toBe(2);
    const save = runtime.save();
    delete save.game.tag;
    await runtime.load(save);
    expect(runtime.state.game.tag).toBe("a");
  });
});

describe("立ち絵の振る舞い（@chara-config）", () => {
  it("@chara-config は書いた項目だけ変えて状態に残す", async () => {
    const r = new Runtime(new HeadlessHost({ loadSource: async () => "@chara-config focus=dim\n@chara-config jump=true\n# end\nおわり" }), {});
    await r.start("a");
    expect(r.state.stage.spriteConfig).toEqual({ focus: "dim", jump: true });
    // 下げる見せ方と、その量
    const lower = new Runtime(new HeadlessHost({ loadSource: async () => "@chara-config focus=dim-lower lower=8\n# end\nおわり" }), {});
    await lower.start("a");
    expect(lower.state.stage.spriteConfig).toEqual({ focus: "dim-lower", lower: 8 });
  });

  it("@text-sound は話者ごと、@balloon は幅つきで状態に残る", async () => {
    const src = '@text-sound pop.wav who=ユイ every=3\n@text-sound tick.wav\n@text-sound-off who=ユイ\n@balloon on width=600\n# end\nおわり';
    const host = new HeadlessHost({ loadSource: async () => src });
    const r = new Runtime(host, {});
    await r.start("a");
    expect(r.state.stage.textSound).toEqual({ "": { file: "tick.wav", volume: 100, every: 2 } });
    expect(r.state.stage.balloon).toEqual({ width: 600 });
  });
});

describe("セーブの目印（作品の更新で台本がずれたとき）", () => {
  it("セーブしたページの前に行が増えても、同じ文のページから再開する", async () => {
    const v1 = "@set game.n = 1\n　一ページ目\n　二ページ目\n　三ページ目";
    const host = new HeadlessHost({ loadSource: async () => v1, clicks: 2 } as never);
    const r = new Runtime(host, {});
    await r.start("a");
    // 二ページ目を出したところでセーブした、とする
    const save = r.save();
    save.position = { unit: "a", index: 2, anchor: { line: 3, key: (r as unknown as { anchorOf(p: unknown): { key: string } }).anchorOf({ unit: "a", index: 2 }).key } };
    const v2 = "@set game.n = 1\n　足した前置き\n　もう一つ足した\n　一ページ目\n　二ページ目\n　三ページ目";
    const seen: string[] = [];
    const host2 = new HeadlessHost({ loadSource: async () => v2, onDiagnostic: (d: { code: string }) => seen.push(d.code) } as never);
    const r2 = new Runtime(host2, {});
    await r2.load(save);
    const pages = host2.trace.filter((e) => e.type === "page").map((e) => (e as { line: number }).line);
    expect(pages[0]).toBe(5);
  });

  /** v1 で「サブの一」を出したところのセーブ（@call の中）。 */
  const callSave = async (v1: Record<string, string>) => {
    let saved: SaveData | null = null;
    const first = setup(v1);
    first.host.waitClick = async () => {
      if (!saved && first.runtime.at?.file === "b") saved = JSON.parse(JSON.stringify(first.runtime.save())) as SaveData;
    };
    await first.runtime.start("a");
    return saved! as SaveData;
  };
  const B = "# sub\n　サブの一\n　サブの二\n@return";
  const V1 = { a: "　はじめ\n@call b#sub\n　戻った先\n　終わり", b: B };
  const V2 = { a: "　足した\n　はじめ\n@call b#sub\n　戻った先\n　終わり", b: B };

  it("@call の中のセーブは、呼んだ側のファイルに行が増えても、呼んだ命令の次へ戻る", async () => {
    const save = await callSave(V1);
    expect(save.callStack[0]?.return.anchor).toBeTruthy();
    const second = setup(V2);
    await second.runtime.load(save);
    expect(pages(second.host.trace)).toEqual([":　サブの一", ":　サブの二", ":　戻った先", ":　終わり"]);
    expect(second.host.trace.some((t) => t.type === "diagnostic" && t.diagnostic.code === "save-relocated")).toBe(true);
  });

  it("戻り先の目印の無い前の版のセーブも、呼んだ先から @call の位置を探して戻る", async () => {
    const save = await callSave(V1);
    for (const f of save.callStack) delete f.return.anchor;
    const second = setup(V2);
    await second.runtime.load(save);
    expect(pages(second.host.trace)).toEqual([":　サブの一", ":　サブの二", ":　戻った先", ":　終わり"]);
  });

  it("マクロの中のセーブも、呼んだ側の行がずれたら同じ命令の次へ戻る", async () => {
    const macro = "@define twice()\n　マクロの一\n　マクロの二\n@end\n";
    const m1 = { a: `${macro}　はじめ\n@twice\n　戻った先` };
    const m2 = { a: `${macro}　足した\n　はじめ\n@twice\n　戻った先` };
    let saved: SaveData | null = null;
    const first = setup(m1);
    first.host.waitClick = async () => {
      if (!saved && first.runtime.state.position.unit !== "a") saved = JSON.parse(JSON.stringify(first.runtime.save())) as SaveData;
    };
    await first.runtime.start("a");
    const second = setup(m2);
    await second.runtime.load(saved!);
    expect(pages(second.host.trace)).toEqual([":　マクロの一", ":　マクロの二", ":　戻った先"]);
  });

  it("台本が変わっていなければ、戻り先はそのまま", async () => {
    const save = await callSave(V1);
    const second = setup(V1);
    await second.runtime.load(save);
    expect(pages(second.host.trace)).toEqual([":　サブの一", ":　サブの二", ":　戻った先", ":　終わり"]);
    expect(second.host.trace.some((t) => t.type === "diagnostic" && t.diagnostic.code === "save-relocated")).toBe(false);
  });
});

describe("飛び先を式で決める・選択肢から呼び出す・ロードの直後", () => {
  it("@jump (式) と @call (式) は値の `ファイル#ラベル` へ飛ぶ。形が違えばエラー", async () => {
    const { host, runtime } = setup({
      a: '@set game.next = "b#two"\n@call ("b#one")\n@jump (game.next)',
      b: "# one\n　ひとつ\n@return\n# two\n　ふたつ",
    });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual([":　ひとつ", ":　ふたつ"]);
    const bad = setup({ a: "@jump (1 + 1)" });
    await bad.runtime.start("a");
    expect(errors(bad.host.trace).join("\n")).toMatch(/ジャンプ先の式の値 2/);
  });

  it("選択肢の call=true は呼び出し、@return でその選択肢をもう一度出す", async () => {
    const src = [
      "@set game.on = false",
      "# menu",
      "@choice",
      "- 切り替える -> #toggle call=true",
      "- 進む -> #go",
      "@end",
      "# toggle",
      "@set game.on = !game.on",
      "@return",
      "# go",
      "　{= game.on}",
    ].join("\n");
    const { host, runtime } = setup({ a: src }, { choices: [0, 0, 0, 1] });
    await runtime.start("a");
    expect(host.trace.filter((t) => t.type === "choice").length).toBe(4);
    expect(pages(host.trace)).toEqual([":　true"]);
  });

  it("afterLoad はロードの直後に呼び出し、@return でロードしたページへ戻る", async () => {
    const files = { a: "@set temp.x = 1\n@choice\n- 見る -> #p\n@end\n# p\n{= temp.x}", common: "# after\n@set temp.x = 5\n@return" };
    // 選択肢で止めてセーブする（temp はセーブに入らない）
    const first = setup(files, { whenChoicesRunOut: "stop" });
    await first.runtime.start("a");
    const save = first.runtime.save();
    const host = new HeadlessHost({ loadSource: async (f) => files[f as keyof typeof files] });
    await new Runtime(host, { afterLoad: "common#after" }).load(save);
    expect(pages(host.trace)).toEqual([":5"]);
  });

  it("セーブに作品の版を入れ、afterLoad で save.version を見て前の版の変数を付け替えられる", async () => {
    const files = {
      a: "@set game.affection = 3\n@choice\n- 見る -> #p\n@end\n# p\n{= game.love}:{= save.version}",
      common: '# after\n@if save.version == "" || save.version == "1.0.0"\n@set game.love = game.affection\n@end\n@return',
    };
    // 版を入れる前のエンジンのセーブ（gameVersion が無い）
    const old = setup(files, { whenChoicesRunOut: "stop" });
    await old.runtime.start("a");
    const before = old.runtime.save();
    expect(before.gameVersion).toBeUndefined();
    // 1.1.0 のゲームでロードすると、afterLoad で付け替える。本文の save.version はロードしたセーブの版（空）
    const host = new HeadlessHost({ loadSource: async (f) => files[f as keyof typeof files], whenChoicesRunOut: "stop" });
    const now = new Runtime(host, { afterLoad: "common#after", gameVersion: "1.1.0" });
    await now.load(before);
    expect(now.state.game.love).toBe(3);
    // セーブし直すと今の版が入る
    expect(now.save().gameVersion).toBe("1.1.0");
    // 新しく始めたプレイは今の版で、ローカル変数の save はそちらが勝つ
    const fresh = new HeadlessHost({ loadSource: async () => '{= save.version}\n@let save = "x"\n{= save}' });
    await new Runtime(fresh, { gameVersion: "1.1.0" }).start("a");
    expect(pages(fresh.trace)).toEqual([":1.1.0", ":x"]);
    // version_before で「1.10.0 より前のセーブ」を一度に書ける（1.9.2 は前。文字の順なら後になる。空の版も前とみなす）
    const compare = { ...files, common: '# after\n@if version_before(save.version, "1.10.0")\n@set game.love = game.affection\n@end\n@return' };
    const later = new Runtime(new HeadlessHost({ loadSource: async (f) => compare[f as keyof typeof compare], whenChoicesRunOut: "stop" }), { afterLoad: "common#after", gameVersion: "1.10.0" });
    await later.load({ ...before, gameVersion: "1.9.2" });
    expect(later.state.game.love).toBe(3);
    const current = new Runtime(new HeadlessHost({ loadSource: async (f) => compare[f as keyof typeof compare], whenChoicesRunOut: "stop" }), { afterLoad: "common#after", gameVersion: "1.10.0" });
    await current.load({ ...before, gameVersion: "1.10.0" });
    expect(current.state.game.love).toBeUndefined();
  });
});

describe("命令の前で待つ（beforeStep）", () => {
  it("Promise を返すと、解決するまでその命令を実行しない", async () => {
    let release: (() => void) | null = null;
    const host = new HeadlessHost({ loadSource: async () => "　一\n@set game.x = 1\n　二" });
    const runtime = new Runtime(host, {
      beforeStep: (at) => (at.line === 2 ? new Promise<void>((r) => (release = r)) : undefined),
    });
    const done = runtime.start("a");
    await new Promise((r) => setTimeout(r, 20));
    expect(pages(host.trace)).toEqual([":　一"]);
    expect(runtime.state.game.x).toBeUndefined();
    release!();
    await done;
    expect(runtime.state.game.x).toBe(1);
    expect(pages(host.trace)).toEqual([":　一", ":　二"]);
  });
});

describe("式の飛び先の to=", () => {
  it("値が候補に無ければエラーで止まる", async () => {
    const { host, runtime } = setup({ a: '@set game.n = "#c"\n@jump (game.n) to=#b\n# b\n　b\n# c\n　c' });
    await runtime.start("a");
    expect(errors(host.trace).join("\n")).toMatch(/候補（to=#b）にありません/);
  });
});

describe("制限時間つきの選択肢と押せない選択肢", () => {
  /** 選ばずに待つ（制限時間で止められるまで）。渡された見た目を控える。 */
  class WaitingHost extends HeadlessHost {
    looks: unknown;
    override async choose(_texts: string[], signal?: AbortSignal, looks?: unknown[]): Promise<number | null> {
      this.looks = looks;
      return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(null), { once: true }));
    }
  }
  const run = async (head: string, second = "- 二 -> #b") => {
    const src = `${head}\n- 一 -> #a\n${second}\n@end\n落ちた。\n@stop\n# a\n選んだ一。\n@stop\n# b\n選んだ二。\n`;
    const host = new WaitingHost({ loadSource: async () => src });
    const runtime = new Runtime(host, { speakers });
    await runtime.start("s");
    return { pages: pages(host.trace), looks: host.looks, timer: host.trace.some((t) => t.type === "command" && t.name === "choice-timer") };
  };

  it("時間切れなら default の選択肢を選び、default が無ければ @end の後へ進む", async () => {
    expect((await run("@choice timeout=30ms default=2")).pages).toEqual([":選んだ二。"]);
    const fell = await run("@choice timeout=30ms");
    expect(fell.pages).toEqual([":落ちた。"]);
    expect(fell.timer).toBe(true);
  });

  it.each(["call=true", "call"])("時間切れの default が %s なら @return で選択肢を出し直す", async (call) => {
    const src = `@choice timeout=20ms default=1\n- 設定 -> #opt ${call}\n@end\n@stop\n# opt\n設定。\n@return\n`;
    const shown: string[][] = [];
    class ReturningHost extends WaitingHost {
      override async choose(texts: string[], signal?: AbortSignal): Promise<number | null> {
        shown.push(texts);
        return shown.length === 1 ? super.choose(texts, signal) : null;
      }
    }
    const host = new ReturningHost({ loadSource: async () => src });
    await new Runtime(host, { speakers }).start("s");
    expect(errors(host.trace)).toEqual([]);
    expect(pages(host.trace)).toEqual([":設定。"]);
    expect(shown).toEqual([["設定"], ["設定"]]);
  });

  it("locked= が真の選択肢は押せない印を付けて出し、時間切れの default に選ばない", async () => {
    const r = await run("@choice timeout=30ms default=2", "- 二 -> #b locked=(true)");
    expect(r.looks).toEqual([null, { locked: true }]);
    expect(r.pages).toEqual([":落ちた。"]);
  });

  it("描画側が時間を計るなら、描画側が経ったと知らせるまで時間切れにしない（画面を開いている間は止めるため）", async () => {
    const src = "@choice timeout=10ms default=2\n- 一 -> #a\n- 二 -> #b\n@end\n@stop\n# a\n選んだ一。\n@stop\n# b\n選んだ二。\n";
    let elapse: (() => void) | undefined;
    const asked: number[] = [];
    class CountingHost extends WaitingHost {
      countdown(ms: number): Promise<void> {
        asked.push(ms);
        return new Promise((resolve) => (elapse = resolve));
      }
    }
    const host = new CountingHost({ loadSource: async () => src });
    const runtime = new Runtime(host, { speakers });
    const done = runtime.start("s");
    await new Promise((r) => setTimeout(r, 60));
    expect(pages(host.trace)).toEqual([]);
    expect(asked).toEqual([10]);
    elapse!();
    await done;
    expect(pages(host.trace)).toEqual([":選んだ二。"]);
  });

  it("制限時間つきの選択肢を選び終えたら、実行器の abort の受け口を外す（選択肢の数だけたまらない）", async () => {
    const choice = (to: string) => `@choice timeout=1000ms\n- 一 -> #${to}\n- 二 -> #${to}\n@end\n`;
    const src = (n: number) => Array.from({ length: n }, (_, i) => `# c${i}\n${choice(`c${i + 1}`)}`).join("") + `# c${n}\n終わり。\n@stop\n`;
    // 一番多く受け口が残った signal の、残った数
    const leftAfter = async (n: number): Promise<number> => {
      const net = new Map<AbortSignal, number>();
      const add = AbortSignal.prototype.addEventListener;
      const remove = AbortSignal.prototype.removeEventListener;
      AbortSignal.prototype.addEventListener = function (this: AbortSignal, ...a: Parameters<AbortSignal["addEventListener"]>) {
        if (a[0] === "abort") net.set(this, (net.get(this) ?? 0) + 1);
        return add.apply(this, a);
      } as AbortSignal["addEventListener"];
      AbortSignal.prototype.removeEventListener = function (this: AbortSignal, ...a: Parameters<AbortSignal["removeEventListener"]>) {
        if (a[0] === "abort") net.set(this, (net.get(this) ?? 0) - 1);
        return remove.apply(this, a);
      } as AbortSignal["removeEventListener"];
      try {
        const host = new (class extends HeadlessHost {
          override async choose(): Promise<number | null> {
            return 0;
          }
        })({ loadSource: async () => src(n) });
        await new Runtime(host, { speakers }).start("s");
        expect(pages(host.trace)).toEqual([":終わり。"]);
      } finally {
        AbortSignal.prototype.addEventListener = add;
        AbortSignal.prototype.removeEventListener = remove;
      }
      return Math.max(0, ...net.values());
    };
    expect(await leftAfter(10)).toBe(await leftAfter(1));
  });

  it("選んだ選択肢と時間切れで選んだ default を描画側へ知らせる（call=true の選択肢は知らせない）", async () => {
    const src = "@choice\n- 設定 -> #opt call=true\n- 進む -> #go\n@end\n# go\n@choice timeout=10ms default=2\n- 一 -> #end\n- 二 -> #end\n@end\n# end\n終わり。\n@stop\n# opt\n@return\n";
    const told: { text: string; index: number }[] = [];
    const picks = [0, 1];
    class ChoosingHost extends HeadlessHost {
      override async choose(_texts: string[], signal?: AbortSignal): Promise<number | null> {
        const pick = picks.shift();
        if (pick !== undefined) return pick;
        return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(null), { once: true }));
      }
      chosen(option: { text: string; index: number }): void {
        told.push(option);
      }
    }
    const host = new ChoosingHost({ loadSource: async () => src });
    await new Runtime(host, { speakers }).start("s");
    expect(told).toEqual([
      { text: "進む", index: 1 },
      { text: "二", index: 1 },
    ]);
  });
});

describe("名前欄の表示名", () => {
  it("{name …} はその行だけ、@name は @name-off まで名前欄の名前を替える。話者（ボイスなど）はそのまま。訳があれば訳す", async () => {
    const src = '@set game.player = "タロウ"\nユイ{name ？？？}「一」\nユイ「二」\n@name ユイ as=謎の少女\nユイ「三」\nユイ{name {= game.player}}「四」\n@name-off ユイ\nユイ「五」\n@name レン as=(game.player)\nレン「六」\n@name-off\nレン「七」';
    const { host, runtime } = setup({ a: src });
    runtime.translator = { line: () => null, option: () => null, speaker: (name) => (name === "謎の少女" ? "Mystery girl" : null) };
    await runtime.start("a");
    const shown = host.trace.flatMap((t) => (t.type === "page" ? [[t.speaker, t.label ?? null]] : []));
    expect(shown).toEqual([
      ["ユイ", "？？？"],
      ["ユイ", null],
      ["ユイ", "Mystery girl"],
      ["ユイ", "タロウ"],
      ["ユイ", null],
      ["レン", "タロウ"],
      ["レン", null],
    ]);
    expect(runtime.state.stage.names).toBeUndefined();
  });
});

describe("行の最後の {noclick}", () => {
  it("クリックを待たずに次へ進み、本文を残したまま（セーブにも残し）選択肢を出す。次のページや @clear で消える", async () => {
    const src = "前。\nユイ「どっちにする？」{noclick}\n@choice\n- 右 -> #r\n@end\n# r\n選んだ。\n";
    const clicks: number[] = [];
    let saved: ReturnType<Runtime["save"]> | null = null;
    class Host extends HeadlessHost {
      override async waitClick(): Promise<void> {
        clicks.push(this.trace.filter((t) => t.type === "page").length);
      }
      override async choose(texts: string[]): Promise<number | null> {
        saved = runtime.save();
        return super.choose(texts);
      }
    }
    const host = new Host({ loadSource: async () => src });
    const runtime = new Runtime(host, { speakers });
    await runtime.start("s");
    // クリックを待つのは「前。」と「選んだ。」のページだけ
    expect(clicks).toEqual([1, 3]);
    expect(saved!.stage.noclickPage).toMatchObject({ speaker: "ユイ", parts: [{ text: "「どっちにする？」" }] });
    expect(runtime.state.stage.noclickPage).toBeUndefined();
    const cleared = setup({ a: "問い{noclick}\n@clear\n@stop" });
    await cleared.runtime.start("a");
    expect(cleared.runtime.state.stage.noclickPage).toBeUndefined();
  });
});

describe("演出の早送り", () => {
  it("演出の命令には早送りできるか（skip）を添え、音や演出でない命令には添えない", async () => {
    const src = "@bg a.png time=1s\n@bg a.png time=1s skip=false\n@wait 1s\n@se x.ogg time=1s\n@chara-config focus=dim\n@window show time=200ms\n";
    const host = new HeadlessHost({ loadSource: async () => src });
    const seen: [string, boolean | undefined][] = [];
    const present = host.present.bind(host);
    host.present = async (event) => {
      if (event.type === "command") seen.push([event.name, event.skip]);
      return present(event);
    };
    await new Runtime(host, { speakers }).start("s");
    expect(seen).toEqual([
      ["bg", true],
      ["bg", false],
      ["wait", true],
      ["se", undefined],
      ["chara-config", undefined],
      ["window", true],
    ]);
  });
});

describe("ページの鍵", () => {
  it("ページを出すとき、行を足しても変わらない鍵を添える（既読を覚えるため）", async () => {
    const keysOf = async (src: string) => {
      const events: { line: number; key?: string }[] = [];
      const host = new HeadlessHost({ loadSource: async () => src });
      const present = host.present.bind(host);
      host.present = async (event) => {
        if (event.type === "page") events.push({ line: event.at.line, ...(event.key ? { key: event.key } : {}) });
        return present(event);
      };
      const runtime = new Runtime(host, { speakers });
      await runtime.start("s");
      expect(runtime.pageKeysOf("s")?.size).toBe(events.length);
      return events;
    };
    const before = await keysOf("ユイ「一」\n地の文。");
    const after = await keysOf("@wait 1ms\nユイ「一」\n\n地の文。");
    expect(after.map((e) => e.line)).toEqual([2, 4]);
    expect(after.map((e) => e.key)).toEqual(before.map((e) => e.key));
    expect(before.every((e) => e.key?.startsWith("p"))).toBe(true);
  });
});

describe("CG の自動の解放（options.cg）", () => {
  const cg = (folder: string, image: string) => folder === "bgimage" && (image === "cg/a.png" || image.startsWith("stills/"));
  const plugin = {
    spec: { name: "ending", summary: "章末", positional: [], params: { image: { type: { kind: "asset" as const, folder: "bgimage", cg: true }, doc: "扉絵" } }, example: "@ending image=a.png" },
    run: async () => {},
  };

  it("@bg と CG の印の付いたパラメータで出した、一覧にある画像を解放する（画面なしの実行でも）", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@bg cg/a.png\n@bg room.png\n{@bg stills/in.png}本文\n@ending image=stills/end.png\n@ending image=other.png" });
    const runtime = new Runtime(host, { speakers, cg, commands: [plugin] });
    await runtime.start("a");
    expect(runtime.system.cg_unlocked).toEqual({ "cg/a.png": true, "stills/in.png": true, "stills/end.png": true });
  });

  it("一覧を渡さなければ @bg では解放しない（@cg-unlock は解放する）", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@bg cg/a.png\n@cg-unlock cg/b.png" });
    const runtime = new Runtime(host, { speakers });
    await runtime.start("a");
    expect(runtime.system.cg_unlocked).toEqual({ "cg/b.png": true });
  });

  it("命令の ctx.unlockCg で解放できる（system を直に触らない。空の名前は何もしない）", async () => {
    const exam = {
      spec: { name: "exam", summary: "調べる", positional: [], params: {}, example: "@exam" },
      run: async (_a: unknown, ctx: { unlockCg(image: string): void }) => {
        ctx.unlockCg("stills/view.png");
        ctx.unlockCg("");
      },
    };
    const host = new HeadlessHost({ loadSource: async () => "@exam" });
    const runtime = new Runtime(host, { speakers, commands: [exam as never] });
    await runtime.start("a");
    expect(runtime.system.cg_unlocked).toEqual({ "stills/view.png": true });
  });
});

describe("作品のコマンドの既定値（options.commandDefaults）", () => {
  it("省いたパラメータに使い、書いたものはそのまま。プラグインのコマンドにも効く", async () => {
    const plugin = {
      spec: { name: "ending", summary: "章末", positional: [], params: { time: { type: { kind: "duration" as const }, default: "2s", doc: "時間" } }, example: "@ending" },
      run: async () => {},
    };
    const host = new HeadlessHost({ loadSource: async () => "@bg a.png\n@bg b.png time=0ms\n@ending\n@mask" });
    // 前の版の "fade" も time の既定値として効く
    const runtime = new Runtime(host, { speakers, commands: [plugin], commandDefaults: { bg: { fade: "1s" }, mask: { color: "#ffffff" } } });
    await runtime.start("a");
    const commands = host.trace.flatMap((t) => (t.type === "command" ? [[t.name, t.name === "mask" ? t.args.color : (t.args.time ?? null)]] : []));
    expect(commands).toEqual([["bg", 1000], ["bg", 0], ["mask", "#ffffff"]]);
    expect(runtime.state.stage.mask).toBe("#ffffff");
  });

  it("@define のマクロの、既定値のあるパラメータにも効く（型の合わない値は使わない）", async () => {
    const src = "@define scene(image: string, time: duration = 800ms, tint: color = #000000)\n@mask time=(time) color=(tint)\n@bg (image)\n@end\n@scene image=a.png\n@scene image=b.png time=0ms";
    const host = new HeadlessHost({ loadSource: async () => src });
    const runtime = new Runtime(host, { speakers, commandDefaults: { scene: { time: "1500ms", tint: "white" } } });
    await runtime.start("a");
    expect(host.trace.flatMap((t) => (t.type === "command" && t.name === "mask" ? [[t.args.time, t.args.color]] : []))).toEqual([[1500, "#000000"], [0, "#000000"]]);
  });

  it("版 4: 前の版の fade= と、対象を取らない命令の名前なしの時間は、描画側に time として渡す", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@bg a.png fade=1s\n@chara ユイカ fade=300ms\n@chara-hide-all 300ms\n@mask 600ms\n@mask-off fade=200ms\n@stop-bgm 1s" });
    const runtime = new Runtime(host, { speakers });
    await runtime.start("a");
    expect(host.trace.flatMap((t) => (t.type === "command" ? [[t.name, t.args.time, "fade" in t.args]] : []))).toEqual([
      ["bg", 1000, false],
      ["chara", 300, false],
      ["chara-hide-all", 300, false],
      ["mask", 600, false],
      ["mask-off", 200, false],
      ["stop-bgm", 1000, false],
    ]);
  });

  it("使えない値は使わない（標準の既定値のまま）", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@bg a.png" });
    const runtime = new Runtime(host, { speakers, commandDefaults: { bg: { time: "abc" } } });
    await runtime.start("a");
    expect(host.trace.flatMap((t) => (t.type === "command" ? [t.args.time] : []))).toEqual([0]);
  });
});

describe("ページから場面を呼ぶ（load の call）", () => {
  it("再開したページから場面を呼び、@return か次のラベルで戻ってそのページを出し直す。afterLoad: false なら作品の afterLoad を呼ばない", async () => {
    const src = "一ページ目\n二ページ目\n三ページ目\n@stop\n# memo\nメモ\n@set game.memo = 1\n# after\n後の処理";
    const { host, runtime } = setup({ a: src });
    let save: SaveData | null = null;
    host.onLimit = () => {
      save = runtime.save();
      runtime.stop();
    };
    (host as unknown as { options: HeadlessOptions }).options.maxPages = 2;
    await runtime.start("a");
    const h2 = new HeadlessHost({ loadSource: async () => src });
    const r2 = new Runtime(h2, { speakers, afterLoad: "#after" });
    await r2.load(save!, { call: "#memo", afterLoad: false });
    expect(pages(h2.trace)).toEqual([":メモ", ":二ページ目", ":三ページ目"]);
    expect(r2.state.game.memo).toBe(1);
  });

  it("式で書いた引数の元の文字を命令に渡す（ctx.sources）", async () => {
    let seen: Record<string, string> | undefined;
    const host = new HeadlessHost({ loadSource: async () => "@probe a=(1 + 2) b=3\n本文" });
    const spec = { name: "probe", summary: "", positional: [], params: { a: { type: { kind: "number" as const }, doc: "" }, b: { type: { kind: "number" as const }, doc: "" } }, example: "" };
    const runtime = new Runtime(host, { speakers, commands: [{ spec, run: (args, ctx) => void (seen = { ...ctx.sources, value: String(args.a) }) }] });
    await runtime.start("a");
    expect(seen).toEqual({ a: "1 + 2", value: "3" });
  });
});

describe("行って戻るカメラ（@camera yoyo=true）", () => {
  it("カメラの状態は変えずに描画側へ送る", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@camera zoom=1.2 x=40\n@camera zoom=1.5 y=-30 yoyo=true time=400ms\n終わり" });
    const runtime = new Runtime(host, { speakers });
    await runtime.start("a");
    expect(runtime.state.stage.camera).toEqual({ zoom: 1.2, x: 40, y: 0, rotate: 0 });
    expect(host.trace.flatMap((t) => (t.type === "command" && t.name === "camera" ? [t.args.yoyo] : []))).toEqual([false, true]);
  });
});

describe("場面転換（@scene-change）", () => {
  it("立ち絵をすべて消し、背景を替え、覆いを外した様子にしてから、暗転と明転の時間を決めて描画側に送る", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@bg a.png\n@chara ユイ\n@mask\n@scene-change b.png time=500ms fade-in=2s\n@chara ユイ\n@scene-change\n終わり" });
    const runtime = new Runtime(host, { speakers });
    await runtime.start("a");
    const scenes = host.trace.flatMap((t) => (t.type === "command" && t.name === "scene-change" ? [[t.args.image ?? null, t.args["fade-out"], t.args["fade-in"], t.args.hold, t.args.color]] : []));
    expect(scenes).toEqual([
      ["b.png", 500, 2000, 0, "#000000"],
      [null, 1000, 1000, 0, "#000000"],
    ]);
    expect(runtime.state.stage.sprites).toEqual({});
    expect(runtime.state.stage.background).toBe("b.png");
    expect(runtime.state.stage.mask).toBeNull();
  });

  it("暗転の後ろで BGM を止める（stop-bgm）・替える（bgm。おまけの音楽にも数える）", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@bgm day.ogg\n@scene-change b.png stop-bgm=true\n本文\n@scene-change c.png bgm=night.ogg bgm-fade=1s\n終わり" });
    const runtime = new Runtime(host, { speakers });
    await runtime.start("a");
    const bgms: unknown[] = [];
    host.trace.forEach((t) => t.type === "command" && t.name === "scene-change" && bgms.push([t.args["stop-bgm"], t.args.bgm ?? null, t.args["bgm-fade"]]));
    expect(bgms).toEqual([[true, null, 0], [false, "night.ogg", 1000]]);
    expect(runtime.state.stage.bgm).toEqual({ file: "night.ogg", volume: 100, loop: true });
    expect(runtime.system.bgm_heard).toEqual({ "day.ogg": true, "night.ogg": true });
  });

  it("単色の背景（@bg color=、@scene-change bg-color=）は色のまま状態に残り、絵の背景で外れる", async () => {
    const seen: [string | null, string | undefined, boolean][] = [];
    let runtime: Runtime | null = null;
    class Watch extends HeadlessHost {
      override present(event: Parameters<HeadlessHost["present"]>[0]) {
        const stage = runtime!.state.stage;
        if (event.type === "page") seen.push([stage.background, stage.backgroundColor, stage.planes !== undefined]);
        return super.present(event);
      }
    }
    const host = new Watch({ loadSource: async () => "@bg a.png\n@plane far p.png depth=0.5\n@bg color=#000000\n本文\n@bg b.png\n本文\n@scene-change bg-color=#ffffff\n終わり" });
    runtime = new Runtime(host, { speakers });
    await runtime.start("a");
    expect(seen).toEqual([
      [null, "#000000", false],
      ["b.png", undefined, false],
      [null, "#ffffff", false],
    ]);
    const bgs = host.trace.flatMap((t) => (t.type === "command" && t.name === "bg" ? [t.args.color ?? null] : []));
    expect(bgs).toEqual([null, "#000000", null]);
  });

  it("流す BGM の音量は bgm-volume（既定 100）", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@scene-change b.png bgm=night.ogg bgm-volume=40\n終わり" });
    const runtime = new Runtime(host, { speakers });
    await runtime.start("a");
    expect(runtime.state.stage.bgm).toEqual({ file: "night.ogg", volume: 40, loop: true });
  });

  it("枠を隠す暗転（@scene-change・@mask、@bg hide-window=true）は NVL で積んだ段落を捨て、次の本文を新しいページから積む", async () => {
    const src = "@nvl on\n一行目。\n@scene-change\n二行目。\n@mask\n@mask-off\n三行目。\n@bg b.png hide-window=true\n四行目。\n@scene-change hide-window=false\n五行目。\n";
    const host = new HeadlessHost({ loadSource: async () => src });
    const runtime = new Runtime(host, { speakers });
    const pages: string[][] = [];
    const seen = host.present.bind(host);
    host.present = async (e) => {
      if (e.type === "page") pages.push((runtime.state.stage.nvlPages ?? []).map((p) => p.parts.map((x) => ("text" in x ? x.text : "")).join("")));
      return seen(e);
    };
    await runtime.start("a");
    // ページを出すときの、それまでに積んだ段落（五行目の前だけ、hide-window=false なので四行目が残る）
    expect(pages).toEqual([[], [], [], [], ["四行目。"]]);
  });

  it("ひな形の場面転換のマクロ（@define scene）とは重ならず、マクロはそのまま動く", async () => {
    const src = "@define scene(image: string, time: duration = 800ms)\n@chara-hide-all time=(time)\n@mask time=(time)\n@bg (image)\n@mask-off time=(time)\n@end\n@chara ユイ\n@scene image=night.png\n夜。";
    const host = new HeadlessHost({ loadSource: async () => src });
    const runtime = new Runtime(host, { speakers });
    await runtime.start("a");
    expect(errors(host.trace)).toEqual([]);
    expect(host.trace.flatMap((t) => (t.type === "command" ? [t.name] : [])).slice(0, 5)).toEqual(["chara", "chara-hide-all", "mask", "bg", "mask-off"]);
    expect(runtime.state.stage.background).toBe("night.png");
  });
});

describe("繰り返し（@while）と、マクロの中身（@with・@content）と戻り値（@return (式)）", () => {
  it("@while は条件が真の間くり返す", async () => {
    const { host, runtime } = setup({ a: "@let i = 0\n@while i < 3\n  {= i} 回目\n  @let i = i + 1\n@end\n終わり" });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual([":0 回目", ":1 回目", ":2 回目", ":終わり"]);
  });

  it("@with で渡した中身を、マクロの中の @content で呼んだ側の局所変数のまま実行する", async () => {
    const src = [
      "@define frame(title: string)",
      "【{= title}】",
      "@content",
      "@content",
      "（おわり）",
      "@end",
      "@let who = \"ユイ\"",
      "@with frame title=回想",
      "  {= who} の話",
      "@end",
      "@frame title=中身なし",
      "次",
    ].join("\n");
    const { host, runtime } = setup({ a: src });
    await runtime.start("a");
    expect(errors(host.trace)).toEqual([]);
    expect(pages(host.trace)).toEqual([":【回想】", ":ユイ の話", ":ユイ の話", ":（おわり）", ":【中身なし】", ":（おわり）", ":次"]);
  });

  it("@return (式) はマクロの variable 型のパラメータに渡した変数に値を入れる", async () => {
    const src = "@define double(x: number, into: variable)\n@return (x * 2)\n本文に来ない\n@end\n@double x=21 into=temp.r\n{= temp.r}";
    const { host, runtime } = setup({ a: src });
    await runtime.start("a");
    expect(pages(host.trace)).toEqual([":42"]);
  });
});

describe("進み具合と遊んでいる環境の関数", () => {
  it("visits はこのプレイでラベルに入った回数（入った行の中では 1 から）。ファイルの頭とほかのファイルのラベルも数える", async () => {
    const main = [
      "# look",
      '@if visits("#look") == 1',
      "初めて調べた",
      "@else",
      'もう {= visits("#look")} 回目',
      "@end",
      '@if visits("#look") < 3',
      "@jump #look",
      "@end",
      '{= visits("main")}/{= visits("other#end")}/{= visits("other")}',
      "@jump other#end",
    ].join("\n");
    const { host, runtime } = setup({ main, other: '# end\n{= visits("#end")}/{= visits("other")}' });
    await runtime.start("main");
    expect(pages(host.trace)).toEqual([":初めて調べた", ":もう 2 回目", ":もう 3 回目", ":1/0/0", ":1/0"]);
    expect(errors(host.trace)).toEqual([]);
    // セーブに入る
    expect(runtime.save().visits).toEqual({ main: 1, "main#look": 3, "other#end": 1 });
  });

  it("read はどのプレイでも入ったか（全セーブ共通）、chosen はこのプレイで選んだか", async () => {
    const main = ['{= read("#b")}/{= chosen("北へ")}', "@choice", "- {r 北|きた}へ -> #b", "- 南へ -> #b", "@end", "# b", '{= read("#b")}/{= chosen("北へ")}/{= chosen("南へ")}'].join("\n");
    const { host, runtime } = setup({ main }, { choices: [0] });
    await runtime.start("main");
    expect(pages(host.trace).slice(-1)).toEqual([":true/true/false"]);
    // 新しいプレイ: chosen はまた false、read は system に残る
    const again = new Runtime(new HeadlessHost({ loadSource: async () => main, choices: [1] }), { speakers });
    again.system = runtime.system;
    await again.start("main");
    expect(again.save().chosen).toEqual({ 南へ: 1 });
    expect(runtime.system["@read"]).toEqual({ main: true, "main#b": true });
  });

  it("lang・platform・app は描画側が入れたもの、replaying は回想として始めたときだけ真。回想には変数を渡せる", async () => {
    const src = '{= lang()}/{= platform()}/{= app()}/{= replaying()}/{= game.route}';
    const host = new HeadlessHost({ loadSource: async () => src });
    const runtime = new Runtime(host, { speakers, language: "en", platform: { device: "mobile", app: true }, variables: { "game.route": "none" } });
    await runtime.start("a");
    await runtime.start("a", { replay: "ending_a", variables: { "game.route": "a", "system.x": 1 } });
    expect(pages(host.trace)).toEqual([":en/mobile/true/false/none", ":en/mobile/true/true/a"]);
    expect(runtime.system.x).toBeUndefined();
    // 何も入れなければ ""・pc・false
    const plain = setup({ a: src });
    await plain.runtime.start("a");
    expect(pages(plain.host.trace)).toEqual([":/pc/false/false/"]);
  });

  it("chapter() と runtime.chapter は今のシナリオファイルの章（liminalia.json の chapters）", async () => {
    const seen: (string | null)[] = [];
    const plugin = { spec: { name: "card", summary: "扉", positional: [], params: {}, example: "@card" }, run: (_a: unknown, ctx: { runtime: Runtime }) => void seen.push(ctx.runtime.chapter?.title ?? null) };
    const host = new HeadlessHost({ loadSource: async (f) => (f === "ep1_a" ? '@card\n{= chapter()}\n@jump other' : '@card\n[{= chapter()}]') });
    const runtime = new Runtime(host, { speakers, commands: [plugin], chapters: [{ id: "ep1", title: "雨の駅", files: ["ep1_*"] }] });
    await runtime.start("ep1_a");
    expect(pages(host.trace)).toEqual([":ep1", ":[]"]);
    expect(seen).toEqual(["雨の駅", null]);
  });

  it("引数がジャンプ先の形でなければ実行時のエラー", async () => {
    const { host, runtime } = setup({ a: '{= visits("bad target")}' });
    await runtime.start("a");
    expect(errors(host.trace)).toEqual(['ジャンプ先（#ラベル、ファイル、ファイル#ラベル）を渡します（"bad target"）']);
  });
});

describe("実行器をまたぐ台本の控え（programCache）", () => {
  it("本文が同じなら作り直した実行器でも読み解き直さず、本文が変われば読み直す", async () => {
    let text = "一。\n二。";
    const cache: import("../src/index.ts").ProgramCache = new Map();
    const play = async () => {
      const host = new HeadlessHost({ loadSource: async () => text });
      await new Runtime(host, { speakers, programCache: cache }).start("s");
      return pages(host.trace);
    };
    expect(await play()).toEqual([":一。", ":二。"]);
    const first = cache.get("s")!.program;
    expect(await play()).toEqual([":一。", ":二。"]);
    expect(cache.get("s")!.program).toBe(first);
    text = "三。";
    expect(await play()).toEqual([":三。"]);
    expect(cache.get("s")!.program).not.toBe(first);
  });
});
