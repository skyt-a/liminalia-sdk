import { describe, expect, it } from "vitest";
import { check, CORE_COMMANDS, createRegistry, parse } from "@liminalia/lang";
import { HeadlessHost, Runtime } from "@liminalia/runtime";
import { combinePlugins, runPluginChecks } from "@liminalia/plugin-host";
import std, { effectState, oneshotState as O } from "../src/commands/index.ts";

/** 一回きりの演出（@notify・@flipbook・@flash・@blink・@cutin・@effect time=）の命令の側。 */

const { implementations, specs } = combinePlugins([std]);
const registry = createRegistry([...CORE_COMMANDS, ...specs]);

async function run(src: string) {
  const host = new HeadlessHost({ loadSource: async () => src });
  const runtime = new Runtime(host, { speakers: ["ユイ"], commands: implementations });
  const result = await runtime.start("a");
  return { result, stage: runtime.state.stage, host };
}

const errors = (src: string) =>
  check(parse(src, "a.lim", { speakers: ["ユイ"] }), { registry, speakers: ["ユイ"] })
    .filter((d) => d.severity === "error")
    .map((d) => d.code);

describe("一回きりの演出", () => {
  it("どれも状態に残さない（@effect も time= なら残さない）", async () => {
    const { stage, result } = await run(
      "@notify 手帳に書き足した kind=success\n@flipbook fx/s_{nn}.png frames=3 durations=30,40\n@flash invert count=2\n@blink count=2\n@cutin key.png from=left\n@effect glitch time=500ms\n本文",
    );
    expect(result.reason).toBe("end");
    expect(stage.extra).toEqual({});
    const kept = await run("@effect glitch\n本文");
    expect(Object.keys(effectState.readEffects(kept.stage.extra))).toEqual(["glitch"]);
  });

  it("@cutin stay=true は状態に残り、同じ名前は入れ替わり、@cutin-hide で名前ごと（省けばすべて）外れる", async () => {
    const a = await run("@cutin key.png stay=true name=key max-width=400 padding=12\n@cutin map.png stay=true\n@cutin key2.png stay=true name=key\n本文");
    expect(O.readCutins(a.stage.extra)).toEqual([
      // 層を書かなければ残さない（描画が stay=true の既定の hud に置く）
      { name: "", args: { stay: true, image: "map.png", padding: 0, frame: "#ffffff", border: 8, from: "right", rotate: 0, out: 250 } },
      { name: "key", args: { stay: true, image: "key2.png", padding: 0, frame: "#ffffff", border: 8, from: "right", rotate: 0, out: 250, name: "key" } },
    ]);
    const top = await run("@cutin key.png stay=true name=key layer=overlay\n本文");
    expect(O.readCutins(top.stage.extra)[0]!.args.layer).toBe("overlay");
    const b = await run("@cutin key.png stay=true name=key\n@cutin map.png stay=true\n@cutin-hide key\n本文");
    expect(O.readCutins(b.stage.extra).map((c) => c.name)).toEqual([""]);
    const c = await run("@cutin key.png stay=true name=key\n@cutin map.png stay=true\n@cutin-hide\n本文");
    expect(c.stage.extra).toEqual({});
  });

  it("引数の型と既定値は検査が知っている", () => {
    expect(errors("@notify こんにちは time=2s max=4\n@flash white count=2\n@blink close=90ms\n@cutin key.png rotate=-3\n@effect wave time=1s wait=true")).toEqual([]);
    expect(errors("@flash purple")).toEqual(["bad-value"]);
    expect(errors("@cutin")).toContain("missing-param");
    expect(errors("@blink count=many")).toEqual(["bad-value"]);
  });

  it("コマの並び: {n} の桁、durations（足りないコマは最後の値）、time、データ", () => {
    const a = O.flipbookFrames({ image: "fx/s_{nn}.png", frames: 4, durations: "30, 40" }, null);
    expect(a).toEqual({ folder: "image", frames: [{ path: "fx/s_01.png", ms: 30 }, { path: "fx/s_02.png", ms: 40 }, { path: "fx/s_03.png", ms: 40 }, { path: "fx/s_04.png", ms: 40 }] });
    const b = O.flipbookFrames({ image: "fx/{n}.png", frames: 2, time: 50 }, null);
    expect("frames" in b && b.frames).toEqual([{ path: "fx/1.png", ms: 50 }, { path: "fx/2.png", ms: 50 }]);
    // データ: frames を省くと durations の数
    const c = O.flipbookFrames({ data: "flipbooks#slash" }, { image: "slash/{nnn}.png", durations: [10, 20, 30], folder: "fgimage" });
    expect(c).toEqual({ folder: "fgimage", frames: [{ path: "slash/001.png", ms: 10 }, { path: "slash/002.png", ms: 20 }, { path: "slash/003.png", ms: 30 }] });
    expect("error" in O.flipbookFrames({}, null)).toBe(true);
    expect("error" in O.flipbookFrames({ image: "fx/{n}.png" }, null)).toBe(true);
    expect(O.splitDataRef("flipbooks#slash")).toEqual({ name: "flipbooks", key: "slash" });
    expect(O.parseDurations("32,28 、x,42")).toEqual([32, 28, 42]);
  });

  it("作品全体のチェック: image も data も無い・frames が無い・データが無い・コマの画像が無い", () => {
    const src = [
      "@flipbook",
      "@flipbook fx/s_{nn}.png",
      "@flipbook data=flipbooks#missing",
      "@flipbook fx/s_{nn}.png frames=3",
      "@if game.x",
      "  @flipbook data=flipbooks#slash",
      "@end",
      "@flipbook fx/s_{nn}.png frames=(game.n)",
    ].join("\n");
    const script = parse(src, "a.lim", { speakers: ["ユイ"] });
    const assets = new Set(["fx/s_01.png", "fx/s_02.png", "slash/1.png", "slash/2.png"]);
    const diagnostics = runPluginChecks([std], {
      root: "/",
      config: {},
      scripts: new Map([["a", script]]),
      text: () => src,
      cast: {},
      speakers: ["ユイ"],
      registry,
      data: (name) => (name === "flipbooks.json" ? { slash: { image: "slash/{n}.png", durations: [20, 20] } } : undefined),
      assetExists: (folder, path) => folder === "image" && assets.has(path),
    });
    expect(diagnostics.map((d) => [d.line, d.code, d.severity])).toEqual([
      [1, "flipbook-frames", "error"],
      [2, "flipbook-frames", "error"],
      [3, "flipbook-data", "error"],
      [4, "flipbook-missing", "warning"],
    ]);
    expect(diagnostics[3]!.message).toContain("fx/s_03.png");
    expect(diagnostics.every((d) => d.messageEn)).toBe(true);
  });

  it("止めるまで繰り返すコマ送り（loop=0）だけ状態に残し、同じ名前は置き換え、@flipbook-off で名前ごとかすべてを外す", async () => {
    const loops = async (src: string) => O.readFlipbookLoops((await run(`${src}\n本文`)).stage.extra).map((l) => [l.name, l.args.image]);
    expect(await loops("@flipbook a_{n}.png frames=2 loop=3")).toEqual([]);
    expect(await loops("@flipbook a_{n}.png frames=2 loop=0 name=rain\n@flipbook b_{n}.png frames=2 loop=0\n@flipbook c_{n}.png frames=2 loop=0 name=rain")).toEqual([
      ["", "b_{n}.png"],
      ["rain", "c_{n}.png"],
    ]);
    expect(await loops("@flipbook a_{n}.png frames=2 loop=0 name=rain\n@flipbook b_{n}.png frames=2 loop=0 name=fog\n@flipbook-off rain")).toEqual([["fog", "b_{n}.png"]]);
    expect(await loops("@flipbook a_{n}.png frames=2 loop=0 name=rain\n@flipbook b_{n}.png frames=2 loop=0\n@flipbook-off time=300ms")).toEqual([]);
    // 残すのは流し直すのに要る引数だけ
    const { stage } = await run("@flipbook a_{n}.png frames=2 loop=0 name=rain blend=screen speed=2 wait=false\n本文");
    expect(O.readFlipbookLoops(stage.extra)[0]!.args).toEqual({ loop: 0, image: "a_{n}.png", frames: 2, folder: "image", time: 80, speed: 2, layer: "fx", x: 0, y: 0, opacity: 1, blend: "screen", reflect: false, name: "rain" });
    expect(errors("@flipbook a_{n}.png frames=2 loop=0 name=rain\n@flipbook-off rain time=300ms\n@flipbook-off")).toEqual([]);
  });

  it("作品全体のチェック: loop=0 に wait=true を書いたもの、@flipbook-off の名前がどの loop=0 にも無いもの", () => {
    const src = ["@flipbook a.png loop=0 name=rain wait=true", "@flipbook-off rain", "@flipbook-off fog", "@flipbook-off"].join("\n");
    const diagnostics = runPluginChecks([std], {
      root: "/",
      config: {},
      scripts: new Map([["a", parse(src, "a.lim", { speakers: ["ユイ"] })]]),
      text: () => src,
      cast: {},
      speakers: ["ユイ"],
      registry,
      data: () => undefined,
      assetExists: () => true,
    });
    expect(diagnostics.map((d) => [d.line, d.code])).toEqual([
      [1, "flipbook-loop-wait"],
      [3, "flipbook-off-unknown"],
    ]);
  });
});
