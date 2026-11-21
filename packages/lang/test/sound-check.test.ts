import { describe, expect, it } from "vitest";
import { checkSound, CORE_COMMANDS, createRegistry, englishDiagnostic, parse, type CommandSpec } from "../src/index.ts";

/** 音の抜けの検査（check.sound）。流れをたどり、どこから来ても同じと言えるときだけ知らせる。 */

const registry = createRegistry(CORE_COMMANDS);

/** 本文を n 行。 */
const lines = (n: number, word = "本文") => Array.from({ length: n }, (_, i) => `${word}${i + 1}。`).join("\n");

const run = (files: Record<string, string>, o: { config?: unknown; entry?: string; fresh?: string[]; references?: string[]; promised?: Map<string, string[]>; registry?: typeof registry } = {}) =>
  checkSound({
    scripts: new Map(Object.entries(files).map(([f, t]) => [f, parse(t, f, { speakers: ["ユイ"] })])),
    registry: o.registry ?? registry,
    entry: o.entry ?? "a",
    ...(o.config !== undefined ? { config: o.config } : {}),
    ...(o.fresh ? { fresh: o.fresh } : {}),
    ...(o.references ? { references: o.references } : {}),
    ...(o.promised ? { promised: o.promised } : {}),
  });
const brief = (d: ReturnType<typeof run>) => d.map((x) => `${x.file}:${x.line} ${x.code}`);

describe("無音の長い区間（long-silence）", () => {
  it("BGM も環境音も無いまま本文が既定の 30 行続いたら、数え始めた行に警告する。29 行なら黙る", () => {
    const d = run({ a: `@bg room.png\n${lines(30)}` });
    expect(brief(d)).toEqual(["a:2 long-silence"]);
    expect(d[0]).toMatchObject({ severity: "warning", message: "ここから BGM も環境音も鳴らないまま、本文が 30 行続きます（a:31 まで）" });
    expect(d[0]!.hint).toContain('check.sound.quiet に "a"');
    expect(englishDiagnostic(d[0]!).message).toBe("From here, there's no BGM or ambient sound for 30 lines of text (until a:31)");
    expect(run({ a: lines(29) })).toEqual([]);
  });

  it("BGM か環境音（ループの効果音）が鳴っていれば数えない。止めたところから数え直す", () => {
    expect(run({ a: `@bgm theme.ogg\n${lines(40)}` })).toEqual([]);
    expect(run({ a: `@se rain.ogg loop=true channel=1\n${lines(40)}` })).toEqual([]);
    // 一回きりの効果音は環境音ではない
    expect(brief(run({ a: `@se door.ogg\n${lines(30)}` }))).toEqual(["a:2 long-silence"]);
    // 止めた後の 30 行
    expect(brief(run({ a: `@bgm theme.ogg\n${lines(10)}\n@stop-bgm\n${lines(30, "後")}` }))).toEqual(["a:13 long-silence"]);
    // 一時停止も無音
    expect(brief(run({ a: `@bgm theme.ogg\n@pause-bgm\n${lines(30)}` }))).toEqual(["a:3 long-silence"]);
  });

  it("@jump と選択肢をたどって、ファイルをまたいで数える", () => {
    const d = run({ a: `${lines(20)}\n@jump b`, b: lines(15) });
    expect(d.map((x) => [x.file, x.line, x.message])).toEqual([["a", 1, "ここから BGM も環境音も鳴らないまま、本文が 35 行続きます（b:15 まで）"]]);
    const choice = run({ a: `${lines(20)}\n@choice\n- 行く -> b\n- 戻る -> #c\n@end\n# c\n@bgm x.ogg\n${lines(20)}`, b: lines(15) });
    expect(brief(choice)).toEqual(["a:1 long-silence"]);
  });

  it("分岐で鳴るかどうかが決まらないところからは数えない（誤って知らせない）", () => {
    const src = `@if game.x\n  @bgm theme.ogg\n@end\n${lines(40)}`;
    expect(run({ a: src })).toEqual([]);
    // 片方の道からだけ鳴っている BGM が届くラベル
    const merge = { a: `@choice\n- 鳴らす -> #on\n- 鳴らさない -> #off\n@end\n# on\n@bgm x.ogg\n@jump #after\n# off\n@jump #after\n# after\n${lines(40)}` };
    expect(run(merge)).toEqual([]);
  });

  it("どこからも入らない所と、外から呼ぶ所（afterLoad など）は分からないので数えない。回想は何も鳴っていない所から", () => {
    expect(run({ a: "@bgm x.ogg\n本文", b: lines(40) })).toEqual([]);
    expect(run({ a: "@bgm x.ogg\n本文\n@jump b", b: lines(40) }, { references: ["b"] })).toEqual([]);
    expect(brief(run({ a: "本文", r: lines(30) }, { fresh: ["r"] }))).toEqual(["r:1 long-silence"]);
  });

  it("マクロの中をたどる（パラメータの値も読む）。@call の先が音を変えなければそのまま", () => {
    const macro = "@define ambience(file: asset, ch: int = 1)\n  @se (file) loop=true channel=(ch)\n@end\n";
    expect(run({ a: `${macro}@ambience rain.ogg\n${lines(40)}` })).toEqual([]);
    expect(brief(run({ a: `@define quiet-room()\n  @stop-bgm\n@end\n@bgm x.ogg\n@quiet-room\n${lines(30)}` }))).toEqual(["a:6 long-silence"]);
    // 音を変えない @call の先: 戻ったあとも無音のまま数える
    expect(brief(run({ a: `${lines(20)}\n@call #sub\n${lines(15, "後")}\n@jump #end\n# sub\n@chara ユイ smile\n@return\n# end` }))).toEqual(["a:1 long-silence"]);
    // BGM を鳴らす @call の先: 戻ったあとは分からない
    expect(run({ a: `${lines(20)}\n@call #sub\n${lines(15, "後")}\n@jump #end\n# sub\n@bgm x.ogg\n@return\n# end` })).toEqual([]);
  });

  it("check.sound.silence で行数を、check.sound.quiet でわざと無音にした場面を決める。off と false で外す", () => {
    expect(brief(run({ a: lines(12) }, { config: { silence: 10 } }))).toEqual(["a:1 long-silence"]);
    expect(run({ a: `${lines(5)}\n@jump #dream\n# dream\n${lines(40, "夢")}\n@bgm x.ogg\n本文` }, { config: { quiet: ["a#dream"] } })).toEqual([]);
    expect(run({ a: lines(40) }, { config: { quiet: ["a"] } })).toEqual([]);
    expect(run({ a: lines(40) }, { config: { off: ["long-silence"] } })).toEqual([]);
    expect(run({ a: `${lines(40)}\n@stop-bgm` }, { config: false })).toEqual([]);
  });

  it("check.sound の形の誤りは bad-config", () => {
    const d = run({ a: "本文" }, { config: { silence: 0, quiet: "a", off: ["nope"] } });
    expect(d.map((x) => [x.code, x.severity, x.message])).toEqual([
      ["bad-config", "error", "check.sound.silence は 1 以上の整数で書きます"],
      ["bad-config", "error", "check.sound.quiet は文字列の並びで書きます"],
      ["bad-config", "error", 'check.sound.off の "nope" は外せる診断ではありません（long-silence、redundant-stop、loop-across-files）'],
    ]);
    expect(run({ a: "本文" }, { config: { quiet: ["a#nope", "zz"] } }).map((x) => x.message)).toEqual(["check.sound.quiet の a#nope の場面がシナリオにありません", "check.sound.quiet の zz の場面がシナリオにありません"]);
    expect(run({ a: "本文" }, { config: [] }).map((x) => x.code)).toEqual(["bad-config"]);
  });
});

describe("空振りの停止（redundant-stop）", () => {
  it("どこから来ても鳴っていない所の @stop-bgm と @stop-se を、行を消す直し方つきで知らせる", () => {
    const d = run({ a: "@stop-bgm time=1s\n本文\n@stop-se channel=2" });
    expect(d.map((x) => [x.line, x.code, x.severity, x.fix])).toEqual([
      [1, "redundant-stop", "info", { kind: "delete-line", text: "@stop-bgm time=1s" }],
      [3, "redundant-stop", "info", { kind: "delete-line", text: "@stop-se channel=2" }],
    ]);
    expect(d[1]!.message).toBe("@stop-se の時点でチャンネル 2 の効果音は鳴っていません（どの流れから来ても止める音がありません）");
  });

  it("鳴っているか分からない所、一回きりの効果音のあと、一時停止中は知らせない", () => {
    expect(run({ a: "@if game.x\n  @bgm x.ogg\n@end\n@stop-bgm" })).toEqual([]);
    expect(run({ a: "@se boom.ogg\n@stop-se" })).toEqual([]);
    expect(run({ a: "@bgm x.ogg\n@pause-bgm\n@stop-bgm" })).toEqual([]);
    expect(run({ a: "本文", b: "@stop-bgm" })).toEqual([]);
    // 止めたあとにもう一度止める
    expect(brief(run({ a: "@bgm x.ogg\n@stop-bgm\n@stop-bgm" }))).toEqual(["a:3 redundant-stop"]);
  });

  it("@scene-change stop-bgm=true も、書いたときだけ知らせる（作品の既定値で止めるものは知らせない）", () => {
    const d = run({ a: "@scene-change hill.webp stop-bgm=true\n本文" });
    expect(d.map((x) => [x.code, x.fix])).toEqual([["redundant-stop", { kind: "replace", find: " stop-bgm=true", with: "" }]]);
    const withDefault = createRegistry(CORE_COMMANDS.map((c): CommandSpec => (c.name === "scene-change" ? { ...c, params: { ...c.params, "stop-bgm": { ...c.params["stop-bgm"]!, default: "true" } } } : c)));
    expect(run({ a: "@scene-change hill.webp\n本文" }, { registry: withDefault })).toEqual([]);
    // 既定で止めるので、その後は鳴っていない
    expect(brief(run({ a: "@bgm x.ogg\n@scene-change hill.webp\n@stop-bgm" }, { registry: withDefault }))).toEqual(["a:3 redundant-stop"]);
  });

  it("マクロの中の停止は、呼ぶ所によって違うので知らせない", () => {
    expect(run({ a: "@define fade-out()\n  @stop-bgm time=1s\n@end\n@fade-out\n本文" })).toEqual([]);
  });
});

describe("ファイルをまたいで鳴り続けるループ（loop-across-files）", () => {
  it("ほかのファイルで鳴らしたループの効果音が、移った先の本文でも鳴っていたら、その最初の本文に知らせる", () => {
    const d = run({ a: "@bgm x.ogg\n@se rain.ogg loop=true channel=1\n本文\n@jump b", b: "@bg room.png\n部屋の中。\n二行目。" });
    expect(d.map((x) => [x.file, x.line, x.code, x.severity, x.message])).toEqual([["b", 2, "loop-across-files", "info", "a:2 で鳴らしたループの効果音 rain.ogg（チャンネル 1）が、b でも鳴り続けています"]]);
    expect(d[0]!.hint).toContain("@stop-se channel=1");
  });

  it("移る前か移った先の頭で止めれば知らせない。carry に書いた音と、どこで鳴らしたか決まらないものも知らせない", () => {
    expect(run({ a: "@se rain.ogg loop=true channel=1\n本文\n@stop-se channel=1\n@jump b", b: "本文" })).toEqual([]);
    expect(run({ a: "@se rain.ogg loop=true channel=1\n本文\n@jump b", b: "@stop-se channel=1\n本文" })).toEqual([]);
    expect(run({ a: "@se rain.ogg loop=true channel=1\n本文\n@jump b", b: "本文" }, { config: { carry: ["rain.ogg"] } })).toEqual([]);
    expect(run({ a: "@if game.x\n  @se rain.ogg loop=true channel=1\n@end\n本文\n@jump b", b: "本文" })).toEqual([]);
  });

  it("@call で呼んだ先のファイルでは知らせない（移ったのではない）", () => {
    expect(run({ a: "@se rain.ogg loop=true channel=1\n@call c\n本文", c: "呼ばれた所\n@return" })).toEqual([]);
    // 呼んだ先から @jump でほかのファイルへ移ったときも、どこで鳴らしたかは決めない（知らせない）
    expect(run({ a: "@se rain.ogg loop=true channel=1\n@call c\n本文", c: "呼ばれた所\n@jump d", d: "本文" })).toEqual([]);
  });
});

describe("プラグインの命令", () => {
  it("BGM の素材を受ける命令は BGM を分からないものにし、飛び先へはその時の音で入る", () => {
    const custom = createRegistry([...CORE_COMMANDS, { name: "music", summary: "", positional: ["file"], params: { file: { type: { kind: "asset", folder: "bgm" }, doc: "" } }, example: "" }, { name: "map", summary: "", positional: [], params: {}, example: "" }]);
    expect(run({ a: `@music theme.ogg\n${lines(40)}` }, { registry: custom })).toEqual([]);
    const promised = new Map([["a:21", ["b"]]]);
    expect(brief(run({ a: `${lines(20)}\n@map`, b: lines(15) }, { registry: custom, promised }))).toEqual(["a:1 long-silence"]);
  });

  it("行き先が最後に @jump で命令の頭へ戻る（調べる画面の形）なら、行き先の様子を命令のあとに重ねず、無音を数え続ける", () => {
    const custom = createRegistry([...CORE_COMMANDS, { name: "exam", summary: "", positional: [], params: {}, example: "" }]);
    // a:3 の @exam は #desk と #door へ飛ぶ。どちらも最後に #look（命令の頭）へ戻るので、命令のあとへは戻らない
    const src = `@bg room.png\n# look\n@exam\n${lines(30, "後")}\n# desk\n机だ。\n@jump #look\n# door\n扉だ。\n@jump #look`;
    const promised = new Map([["a:3", ["#desk", "#door"]]]);
    expect(brief(run({ a: src }, { registry: custom, promised }))).toEqual(["a:4 long-silence"]);
    // 行き先の中の @if で @return して戻ることがあれば、その行き先の様子は重ねる（音を鳴らしていれば数えない）
    const back = `@bg room.png\n# look\n@exam\n${lines(30, "後")}\n# desk\n@bgm theme.ogg\n@if game.done\n  @return\n@end\n@jump #look`;
    expect(run({ a: back }, { registry: custom, promised: new Map([["a:3", ["#desk"]]]) })).toEqual([]);
  });
});

describe("分からなくなったあと", () => {
  it("作品でループに使うチャンネルがどれも止まっていて BGM も止めていれば、ほかのチャンネルが分からなくても無音と数える", () => {
    // b は外から呼ばれる（分からない様子から始まる）。ループは channel=1 だけなので、それを止めれば環境音は無い
    const files = { a: "@se rain.ogg loop=true channel=1\n本文。", b: `@stop-bgm\n@stop-se channel=1\n${lines(30)}` };
    expect(brief(run(files, { references: ["b"] }))).toEqual(["b:3 long-silence"]);
    // ループに使うチャンネルが式で決まるときは言い切らない
    const dynamic = { a: "@se rain.ogg loop=true channel=(game.ch)\n本文。", b: `@stop-bgm\n@stop-se channel=1\n${lines(30)}` };
    expect(run(dynamic, { references: ["b"] })).toEqual([]);
  });
});
