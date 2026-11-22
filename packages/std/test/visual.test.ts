import { describe, expect, it } from "vitest";
import { HeadlessHost, Runtime } from "@liminalia/runtime";
import { combinePlugins } from "@liminalia/plugin-host";
import std, { animState as A, imageState as S, movieState as M, screenState as C } from "../src/commands/index.ts";

const { implementations } = combinePlugins([std]);

async function run(src: string) {
  const host = new HeadlessHost({ loadSource: async () => src });
  const runtime = new Runtime(host, { speakers: ["ユイ"], commands: implementations, onError: "continue" });
  const diagnostics: string[] = [];
  host.onDiagnostic = (d) => void diagnostics.push(d.message);
  const result = await runtime.start("a");
  return { result, stage: runtime.state.stage, diagnostics };
}

describe("状態（セーブに残るもの）", () => {
  it("@anim は対象の項目に最後の姿を残し、増減は重ねて数える", async () => {
    const { stage } = await run(
      ["@image a.png name=pic x=10", "@image b.png name=other", "@anim pic left-by=100 opacity=128", "@anim pic left-by=50", "@anim layer=fg1 top=40", "本文"].join("\n"),
    );
    const [a, b] = S.readExtra(stage.extra, "images")!.fg1!;
    expect(a!.look).toEqual({ box: { left: { to: null, by: 150 }, top: { to: 40, by: 0 } }, style: { opacity: String(128 / 255) } });
    expect(b!.look).toEqual({ box: { top: { to: 40, by: 0 } } });
  });

  it("@anim の立ち絵は表示が替わったら位置・大きさ・不透明度が無効（変形は残る）、@chara-move で書き直した項目は消える", async () => {
    const a = await run("@chara ユイカ normal\n@anim ユイカ left-by=100 top=20\n@chara-move ユイカ top=5\n本文");
    expect(A.spriteLooks(a.stage.extra)["ユイカ"]!.look).toEqual({ box: { left: { to: null, by: 100 } } });
    const b = await run("@chara ユイカ normal\n@anim ユイカ left-by=100 opacity=51\n@chara ユイカ smile\n@anim ユイカ top-by=10\n本文");
    expect(A.spriteLooks(b.stage.extra)["ユイカ"]!.look).toEqual({ box: { top: { to: null, by: 10 } } });
    const c = await run('@keyframe k frames="100% rotate=10"\n@chara ユイカ normal\n@kanim ユイカ keyframe=k\n@chara ユイカ smile\n@anim ユイカ top-by=10\n本文');
    expect(A.spriteLooks(c.stage.extra)["ユイカ"]!.look).toMatchObject({ transform: { rotate: "10deg" } });
  });

  it("@anim は名前とレイヤーのどちらか一方が要る", async () => {
    const { diagnostics } = await run("@anim left=1\n本文");
    expect(diagnostics[0]).toContain("どちらか一方");
  });

  it("@keyframe はコマを読んで残し、@kanim は最後の姿を、loop=true は繰り返しを残す", async () => {
    const { stage } = await run(
      [
        '@keyframe sway frames="0% x=0; 50% x=40 rotate=15; 100% x=10 opacity=0.5"',
        '@keyframe spin frames="100% rotate=360deg"',
        "@image a.png name=pic",
        "@image b.png name=loop",
        "@kanim pic keyframe=sway",
        "@kanim pic keyframe=spin",
        "@kanim loop keyframe=spin loop=true time=2s",
        "本文",
      ].join("\n"),
    );
    expect(A.keyframes(stage.extra).sway).toEqual([
      { at: 0, transform: { "translate-x": "0px" }, style: {} },
      { at: 50, transform: { "translate-x": "40px", rotate: "15deg" }, style: {} },
      { at: 100, transform: { "translate-x": "10px" }, style: { opacity: "0.5" } },
    ]);
    const [pic, loop] = S.readExtra(stage.extra, "images")!.fg1!;
    // spin は 0% がないので sway の最後の姿から続ける（x=10 と rotate=15deg を引き継ぎ、rotate だけ替わる）。
    expect(pic!.look).toEqual({ transform: { "translate-x": "10px", rotate: "360deg" }, style: { opacity: "0.5" } });
    expect((loop!.look as A.Look).loop?.options).toMatchObject({ loop: true, time: 2000 });
    expect(A.transformCss((pic!.look as A.Look).transform)).toBe("rotate(360deg) translate(10px, 0px)");
  });

  it("@kanim の向きと回数で最後の姿が決まり、keep=false なら変わらない", () => {
    const frames = A.parseFrames("0% x=0; 100% x=100");
    const o = { time: 1000, easing: "ease", count: 2, loop: false, delay: 0, direction: "alternate", keep: true, reset: false };
    expect(A.planKanim({}, frames, o).final.transform).toEqual({ "translate-x": "0px" });
    expect(A.planKanim({}, frames, { ...o, count: 3 }).final.transform).toEqual({ "translate-x": "100px" });
    expect(A.planKanim({ transform: { scale: "2" } }, frames, { ...o, keep: false }).final).toEqual({ transform: { scale: "2" } });
  });

  it("@keyframe の書き方の誤りは実行時に位置付きで出る", async () => {
    const { diagnostics } = await run('@keyframe k frames="50 x=1"\n本文');
    expect(diagnostics[0]).toContain("割合% 項目=値");
    expect(() => A.parseFrames("10% x=abc")).toThrow("px の数値");
    expect(() => A.parseFrames("10% x=1; 10% x=2")).toThrow("重複しています");
  });

  it("@stop-kanim は繰り返しを止め、reset なら変形も消す", async () => {
    const { stage } = await run(['@keyframe spin frames="100% rotate=360"', "@image a.png name=pic", "@kanim pic keyframe=spin", "@kanim pic keyframe=spin loop=true", "@stop-kanim pic", "本文"].join("\n"));
    expect(S.readExtra(stage.extra, "images")!.fg1![0]!.look).toBeUndefined();
  });

  it("@layer-text は前景の項目になり、overwrite=true は同じ名前を書き換え、@free-image で消える", async () => {
    const a = await run('@layer-text "一" name=t x=10 layer=fg2\n@layer-text "二" name=t overwrite=true y=50\n本文');
    expect(S.readExtra(a.stage.extra, "images")!.fg2).toMatchObject([{ kind: "text", name: "t", text: "二", x: 10, y: 50 }]);
    const b = await run('@layer-text "一" layer=fg2\n@free-image fg2\n本文');
    expect(S.readExtra(b.stage.extra, "images")).toBeUndefined();
  });

  it("@motion-text は stay=true のときだけ残る", async () => {
    const { stage } = await run('@motion-text "消える"\n@motion-text "残る" stay=true\n本文');
    expect(S.readExtra(stage.extra, "images")!.fg0!.map((i) => (i as { text?: string }).text)).toEqual(["残る"]);
  });

  it("@bg-place は背景と位置を残す", async () => {
    const { stage } = await run("@bg-place wide.jpg width=1920 left=-100\n本文");
    expect(stage.background).toBe("wide.jpg");
    expect(C.bgPlace(stage.extra)).toEqual({ image: "wide.jpg", left: -100, top: 0, width: 1920, height: null });
  });

  it("@layer-camera はレイヤーごとに残り、@reset-layer-camera で消える", async () => {
    const { stage } = await run("@layer-camera base zoom=1.5 x=100\n@layer-camera fg1 rotate=10\n@reset-layer-camera fg1\n本文");
    expect(C.layerCameras(stage.extra)).toEqual({ base: { zoom: 1.5, x: 100, y: 0, rotate: 0 } });
  });

  it("@bg-movie は流している動画を残し、@wait-bg-movie は繰り返しをやめ、@stop-bg-movie で消える", async () => {
    const a = await run("@bg-movie rain.webm mute=true\n@wait-bg-movie\n本文");
    expect(M.bgMovie(a.stage.extra)).toEqual({ file: "rain.webm", volume: 100, loop: false, mute: true });
    const b = await run("@bg-movie rain.webm\n@stop-bg-movie\n本文");
    expect(M.bgMovie(b.stage.extra)).toBeUndefined();
  });

  it("@blend-movie は繰り返すものだけ @blend の一覧に積まれ、@blend-off で消える", async () => {
    const a = await run("@blend-movie dust.webm name=dust mode=screen\n@blend-movie once.webm loop=false\n本文");
    expect(S.readExtra(a.stage.extra, "blends")).toMatchObject([{ name: "dust", mode: "screen", movie: { file: "dust.webm", volume: 0 } }]);
    const b = await run("@blend-movie dust.webm name=dust\n@blend-off name=dust\n本文");
    expect(S.readExtra(b.stage.extra, "blends")).toBeUndefined();
  });

  it("@freeze / @transition / @quake-decay / @vibrate は状態を変えない", async () => {
    const { stage } = await run("@freeze\n@bg room.jpg\n@transition method=slideInLeft\n@quake-decay\n@vibrate\n本文");
    expect(stage.background).toBe("room.jpg");
    expect(stage.extra).toEqual({});
  });
});
