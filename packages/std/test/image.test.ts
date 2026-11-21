import { describe, expect, it } from "vitest";
import { CORE_COMMANDS, createRegistry, parse } from "@liminalia/lang";
import { HeadlessHost, Runtime } from "@liminalia/runtime";
import { combinePlugins, runPluginChecks } from "@liminalia/sdk";
import std, { effectState as E, imageState as S } from "../src/commands/index.ts";

const { implementations, specs } = combinePlugins([std]);
const registry = createRegistry(CORE_COMMANDS, specs);

async function run(src: string) {
  const host = new HeadlessHost({ loadSource: async () => src });
  const runtime = new Runtime(host, { speakers: ["ユイ"], commands: implementations });
  const result = await runtime.start("a");
  return { result, stage: runtime.state.stage, host };
}

describe("状態（セーブに残るもの）", () => {
  it("@image は stage.extra に積まれ、@free-image で消える", async () => {
    const { stage } = await run("@image a.png zindex=9\n@image b.png layer=fg2 depth=back\n@free-image fg2\n本文");
    const images = S.readExtra(stage.extra, "images");
    expect(images?.fg1?.map((i) => i.file)).toEqual(["a.png"]);
    expect(images?.fg2).toBeUndefined();
  });

  it("@free-image name= はその名前の画像だけを消す（最後の一枚ならレイヤーごと外す）", async () => {
    const { stage } = await run("@image a.png name=map\n@image b.png name=pin\n@image c.png layer=fg2 name=map\n@free-image fg1 name=map\n@free-image fg2 name=map\n本文");
    const images = S.readExtra(stage.extra, "images");
    expect(images?.fg1?.map((i) => i.file)).toEqual(["b.png"]);
    expect(images?.fg2).toBeUndefined();
  });

  it("@free-image base は背景を消す", async () => {
    const { stage } = await run("@bg room.jpg time=0ms\n@free-image base\n本文");
    expect(stage.background).toBeNull();
  });

      it("@blend は名前ごとに消せ、名前なしの @blend-off はすべて消す", async () => {
    const a = await run("@blend name=x color=#000000 opacity=155\n@blend name=y color=#ffffff\n@blend-off name=x\n本文");
    expect(S.readExtra(a.stage.extra, "blends")).toEqual([{ name: "y", graphic: "", folder: "image", color: "#ffffff", mode: "multiply", opacity: 1 }]);
    const b = await run("@blend name=x color=#000000\n@blend color=#ffffff\n@blend-off\n本文");
    expect(S.readExtra(b.stage.extra, "blends")).toBeUndefined();
  });

  it("@filter と @filter-off", async () => {
    const a = await run("@filter grayscale=100 blur=2\n@filter-off layer=base\n本文");
    expect(S.readExtra(a.stage.extra, "filters")).toEqual({ fg0: "grayscale(100%) blur(2px)", fg1: "grayscale(100%) blur(2px)", fg2: "grayscale(100%) blur(2px)" });
  });

  it("@filter mask= は範囲を決めたフィルタとして残り、そのレイヤーの普通のフィルタを外す。all は fg2 に一つ置く", async () => {
    const a = await run('@filter grayscale=100\n@filter blur=4 layer=fg1 mask="radial 640 360 400 200"\n本文');
    expect(S.readExtra(a.stage.extra, "filters")).toEqual({ base: "grayscale(100%)", fg0: "grayscale(100%)", fg2: "grayscale(100%)" });
    expect(S.readExtra(a.stage.extra, "filterMasks")).toEqual({ fg1: { shape: "radial", x: 640, y: 360, width: 400, height: 200, soft: 50, css: "blur(4px)" } });
    const b = await run('@filter sepia=80 mask="radial-out 100 100 300 300 20"\n本文');
    expect(S.readExtra(b.stage.extra, "filters")).toBeUndefined();
    expect(S.readExtra(b.stage.extra, "filterMasks")).toEqual({ fg2: { shape: "radial-out", x: 100, y: 100, width: 300, height: 300, soft: 20, css: "sepia(80%)" } });
    // @filter-off は範囲のフィルタも外す
    const c = await run('@filter sepia=80 mask="radial 1 1 2 2"\n@filter-off time=300ms\n本文');
    expect([S.readExtra(c.stage.extra, "filters"), S.readExtra(c.stage.extra, "filterMasks")]).toEqual([undefined, undefined]);
  });

  it("mask= の読み方と、読めない書き方の検査", () => {
    expect(S.parseMask("radial 10 20 30 40")).toEqual({ shape: "radial", x: 10, y: 20, width: 30, height: 40, soft: 7.5 });
    expect(S.parseMask("box 10 20 30 40")).toBeNull();
    expect(S.parseMask("radial 10 20 0 40")).toBeNull();
    expect(S.maskImage({ shape: "radial", x: 100, y: 50, width: 200, height: 100, soft: 25 })).toBe("radial-gradient(100px 50px at 100px 50px, #000 50.0%, transparent 100%)");
    expect(S.maskImage({ shape: "radial-out", x: 0, y: 0, width: 10, height: 10, soft: 0 })).toBe("radial-gradient(5px 5px at 0px 0px, transparent 100.0%, #000 100%)");
    // WebGL の効果の元の絵は、効果の絵が覆いきる所だけ隠す（縁は残す）
    expect(S.coverMask({ shape: "radial", x: 100, y: 50, width: 200, height: 100, soft: 25 })).toBe("radial-gradient(100px 50px at 100px 50px, transparent 50.0%, #000 50.0%)");
    expect(S.coverMask({ shape: "radial-out", x: 100, y: 50, width: 200, height: 100, soft: 25 })).toBe("radial-gradient(100px 50px at 100px 50px, #000 100%, transparent 100%)");
    const src = '@filter grayscale=100 mask="radial 1 2"\n@effect noise mask="radial 640 360 200 200"\n@effect noise mask=square';
    const scripts = new Map([["a", parse(src, "a")]]);
    const d = runPluginChecks([std], { root: "/", config: {}, scripts, text: () => src, cast: {}, speakers: [], registry, data: () => undefined, assetExists: () => true });
    expect(d.filter((x) => x.code === "bad-effect-mask").map((x) => x.line)).toEqual([1, 3]);
  });

  it("@effect mask= は重ねる種類と WebGL の種類にだけ残る", () => {
    expect(E.effectFrom({ type: "vignette", mask: "radial 640 360 400 400" }).mask).toEqual({ shape: "radial", x: 640, y: 360, width: 400, height: 400, soft: 100 });
    expect(E.effectFrom({ type: "mosaic", mask: "radial-out 1 2 3 4 0" }).mask).toEqual({ shape: "radial-out", x: 1, y: 2, width: 3, height: 4, soft: 0 });
    expect(E.effectFrom({ type: "wave", mask: "radial 640 360 400 400" }).mask).toBeUndefined();
  });

  it("@layer は書いた項目だけ変える", async () => {
    const { stage } = await run("@layer fg2 visible=false\n@layer fg2 opacity=128\n@layer message1 visible=false\n本文");
    expect(S.readExtra(stage.extra, "layerOptions")).toEqual({ fg2: { visible: false, opacity: 128 / 255 } });
  });

  it("@chara-move は表示中の立ち絵だけ、重ねて指定した項目を残す", async () => {
    const { stage } = await run("@chara-move ユイカ left=1\n@chara ユイカ guard\n@chara-move ユイカ left=10 top=20\n@chara-move ユイカ width=300\n本文");
    const move = S.readExtra(stage.extra, "spriteMoves")?.["ユイカ"];
    expect(move).toMatchObject({ left: 10, top: 20, width: 300 });
    expect(move?.sprite).toBe(S.spriteKey(stage.sprites["ユイカ"]));
  });
});
