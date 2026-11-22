import { describe, expect, it } from "vitest";
import { CORE_COMMANDS, createRegistry } from "@liminalia/lang";
import { combinePlugins } from "@liminalia/plugin-host";
import std from "@liminalia/std/commands";
import { convert, resolveImportProfile, STD_IMPORT } from "../src/index.ts";

/** 標準の命令（@liminalia/std）の変換表（src/std-tags）。命令の仕様は std の命令の表から作った registry から引く。 */
const registry = createRegistry(CORE_COMMANDS, combinePlugins([std]).specs);
const { tags: profile } = resolveImportProfile(STD_IMPORT, registry);

const converted = (ks: string) => convert(ks, "t.ks", { profile });
const lim = (ks: string) => converted(ks).text;
const notes = (ks: string) =>
  converted(ks)
    .diagnostics.filter((d) => d.code === "lossy-param" || d.code === "unmapped-tag" || d.code === "unsupported-tag")
    .map((d) => d.message);

describe("標準の命令の変換", () => {
  it("[image] と tb_image_show は @image、layer を省いた [image] は @bg", () => {
    expect(
      lim(
        '[image  name="town_map"  layer="1"  page="fore"  zindex="9"  time="500"  wait="true"  storage="maps/town_map.svg"  folder="image"  visible="true"  width="1280"  height="720"  ]',
      ),
    ).toBe("@image maps/town_map.svg folder=image name=town_map width=1280 height=720 zindex=9 time=500ms\n");
    expect(lim('[tb_image_show  time="1000"  storage="items/apple.png"  width="386"  height="385"  x="423"  y="139"  _clickable_img=""  name="img_280"  ]')).toBe(
      "@image items/apple.png name=img_280 x=423 y=139 width=386 height=385 time=1s\n",
    );
    expect(lim('[image storage="room.jpg"]')).toBe("@bg room.jpg\n");
    expect(lim('[image storage="a.png" layer="2" left="10" top="20"]')).toBe("@image a.png layer=fg2 x=10 y=20\n");
  });

  it("[freeimage] / tb_image_hide / tb_clear_images は @free-image", () => {
    expect(lim('[freeimage  time="500"  layer="1"  ]')).toBe("@free-image fg1 time=500ms\n");
    expect(lim('[freeimage layer="0" ]')).toBe("@free-image fg0\n");
    expect(lim('[freeimage layer="base"]')).toBe("@free-image base\n");
    expect(lim("[freelayer layer=2]")).toBe("@free-image fg2\n");
    expect(lim('[tb_image_hide  time="300"  ]')).toBe("@free-image fg1 time=300ms\n");
    expect(lim("[tb_clear_images]")).toBe("@free-image fg1\n");
  });

  it("[layopt] はメッセージ枠なら @window、前景なら @layer", () => {
    expect(lim('[layopt layer="message0" visible=false]')).toBe("@window hide\n");
    expect(lim('[layopt  layer="message0"  visible="true"]')).toBe("@window show\n");
    expect(lim('[layopt layer="0" visible="true"  ]')).toBe("@layer fg0 visible=true\n");
    expect(lim('[layopt layer="message1" visible="false"]')).toBe("@layer message1 visible=false\n");
  });

    it("[layermode] / [free_layermode] は @blend / @blend-off", () => {
    expect(lim('[layermode  mode="screen"  color="0xff0000"  time="300"  wait="true"  ]')).toBe("@blend color=#ff0000 mode=screen time=300ms\n");
    expect(
      lim('[layermode  name="v"  graphic="effects/v.png"  folder="image"  mode="normal"  opacity="255"  time="500"  wait="false"  ]'),
    ).toBe("@blend name=v graphic=effects/v.png mode=normal wait=false\n");
    expect(lim('[free_layermode  name="v"  time="0"  wait="false"  ]')).toBe("@blend-off name=v time=0ms wait=false\n");
  });

  it("フィルタ・立ち絵の移動と揺らし", () => {
    expect(lim('[free_filter  layer="all"  ]')).toBe("@filter-off\n");
    expect(lim('[filter layer="1" grayscale="100"]')).toBe("@filter layer=fg1 grayscale=100\n");
    expect(
      lim('[chara_move  name="ユイカ"  time="260"  anim="true"  left="362.07"  top="39.2"  width="544.0"  height="966.5"  effect="easeOutQuad"  wait="false"  ]'),
    ).toBe("@chara-move ユイカ time=260ms anim=true left=362.07 top=39.2 width=544 height=966.5 ease=easeOutQuad wait=false\n");
    expect(lim('[tb_chara_shake  name="ユイカ"  direction="y"  count="1"  swing="20"  time="500"  ]')).toBe("@chara-shake ユイカ count=1 swing=20\n");
  });

  it("TyranoBuilder が書き出す引数はすべて変換する", () => {
    expect(notes('[image  name="n"  layer="1"  page="fore"  zindex="80"  time="140"  wait="true"  storage="a.svg"  folder="fgimage"  visible="true"  x="140"  y="168"  width="1000"  height="360"  ]')).toEqual([]);
    expect(notes('[layermode  name="b"  mode="multiply"  color="0x000000"  opacity="225"  time="60"  wait="true"  ]')).toEqual([]);
  });
});

describe("標準の命令の変換: 要素の動き", () => {
  it("[anim] の +=/-= は left-by などに、name が layer より優先", () => {
    expect(lim('[anim name="yuika" left="+=100" top="-=20" opacity="128" time="500" effect="easeOutQuad"]')).toBe(
      "@anim yuika left-by=100 top-by=-20 opacity=128 time=500ms ease=easeOutQuad\n",
    );
    expect(lim('[anim layer="1" left="300px"]')).toBe("@anim layer=fg1 left=300\n");
    expect(lim('[anim name="a" layer="1" width="200"]')).toBe("@anim a width=200\n");
    expect(notes('[anim layer="base" left="10"]')).toEqual(["[anim] layer=base は変換していません（前景レイヤー 0〜2 だけを動かせます）"]);
  });

  it("[stopanim] / [wa]", () => {
    expect(lim('[stopanim name="yuika"]')).toBe("@stop-anim yuika\n");
    expect(lim("[wa]")).toBe("@wait-anim\n");
  });

  it("[keyframe] 〜 [endkeyframe] は一行の @keyframe にまとまる", () => {
    const ks = ['[keyframe name="sway"]', '[frame p="0%" x="0"]', '[frame p="50%" x="40" rotate="15deg" opacity="0.5"]', '[frame p="100%" x="0" scaleX="1.2"]', "[endkeyframe]"].join("\n");
    expect(lim(ks)).toBe('@keyframe sway frames="0% x=0; 50% x=40 rotate=15deg opacity=0.5; 100% x=0 scale-x=1.2"\n');
    expect(notes(ks)).toEqual([]);
    expect(notes('[keyframe name="k"]\n[frame p="50%" x="&tf.x"]\n[endkeyframe]')).toEqual([
      "[endkeyframe] [frame p=50%] の x=&tf.x は変換していません（式やマクロの引数はフレームに書けません）",
    ]);
  });

  it("閉じずに終わった [keyframe] は次のファイルに持ち越さない", () => {
    // a.ks で閉じ忘れた [keyframe] が、b.ks の stray [frame]/[endkeyframe] の @keyframe に漏れない。
    convert('[keyframe name="a"]\n[frame p="0%" x="1"]', "a.ks", { profile });
    const b = convert('[frame p="0%" y="5"]\n[endkeyframe]', "b.ks", { profile });
    expect(b.text).not.toContain("@keyframe");
  });

  it("[kanim] の time の既定は 4 秒、count=infinite は loop=true、[xanim] は reset=true", () => {
    expect(lim('[kanim name="yuika" keyframe="sway"]')).toBe("@kanim yuika keyframe=sway time=4s\n");
    expect(lim('[kanim layer="0" keyframe="sway" time="600" count="infinite" easing="linear"]')).toBe("@kanim layer=fg0 keyframe=sway time=600ms easing=linear loop=true\n");
    expect(lim('[xanim name="a" keyframe="k" time="500" mode="none" wait="true"]')).toBe("@kanim a keyframe=k time=500ms keep=false reset=true wait=true\n");
    expect(notes('[xanim name="a" x="100" time="500"]')[0]).toContain("x=100 は変換していません");
    expect(lim('[stop_kanim name="a"]')).toBe("@stop-kanim a\n");
    expect(lim('[stop_xanim name="a" complete="true"]')).toBe("@stop-kanim a reset=false\n");
  });
});

describe("標準の命令の変換: 画面", () => {
  it("[backlay] [image page=back] [trans] [wt] は @freeze 〜 @transition", () => {
    const ks = ['[backlay]', '[image layer="base" page="back" storage="room.jpg"]', '[trans layer="base" method="crossfade" children="false" time="2000"]', "[wt]"].join("\n");
    expect(lim(ks)).toBe("@freeze\n@bg room.jpg\n@transition time=2s wait=false\n@wait-transition\n");
    expect(notes(ks)).toEqual([]);
    expect(lim('[trans layer="0" method="fadeInLeft" time="500"]')).toBe("@transition method=fadeInLeft time=500ms wait=false\n");
    expect(notes('[trans layer="base" method="rotateIn" time="500"]')).toEqual(["[trans] method=rotateIn は変換していません（crossfade で切り替えます）"]);
  });

  it("[bg2] は @bg-place（time の既定は 3 秒）", () => {
    expect(lim('[bg2 storage="wide.jpg" width="1920" height="720" left="-320"]')).toBe("@bg-place wide.jpg left=-320 width=1920 height=720 time=3s\n");
  });

  it("[quake2] / [vibrate] / [vibrate_stop]", () => {
    expect(lim("[quake2]")).toBe("@quake-decay\n");
    expect(lim('[quake2 time="500" hmax="30" vmax="0" copybase="false" wait="false"]')).toBe("@quake-decay time=500ms horizontal=30 vertical=0 fill-edges=false wait=false\n");
    expect(lim('[vibrate time="200" count="3"]')).toBe("@vibrate time=200ms count=3\n");
    expect(notes('[vibrate time="200,100,300"]')).toEqual(["[vibrate] time=200,100,300 は最初の値だけ変換しました（振動の並びは書けません）"]);
    expect(lim("[vibrate_stop]")).toBe("@vibrate-stop\n");
  });

  it("[camera] は layer_camera なら組み込みの @camera、レイヤー指定なら @layer-camera", () => {
    expect(lim('[camera zoom="1.5" x="100" y="50" time="800"]')).toBe("@camera zoom=1.5 x=100 y=-50 time=800ms\n");
    expect(lim('[camera layer="base" zoom="1.5" x="100" y="50" time="800" wait="false"]')).toBe("@layer-camera base zoom=1.5 x=100 y=-50 time=800ms wait=false\n");
    expect(lim('[camera layer="1" from_x="10" x="0"]')).toBe("@layer-camera fg1 x=0 from-zoom=1 from-x=10 from-y=0 from-rotate=0\n");
    expect(lim('[reset_camera layer="0" time="300"]')).toBe("@reset-layer-camera fg0 time=300ms\n");
    expect(lim("[reset_camera]")).toBe("@reset-camera\n");
    expect(lim('[camera layer="message0" zoom="2"]')).toBe("\n");
    expect(notes('[camera layer="message0" zoom="2"]')).toEqual(["[camera] layer=message0 は動かせないので変換していません（base と 0〜2 だけ）"]);
    expect(lim("[wait_camera]")).toBe("@wait-camera\n");
  });

  it("[mask] / [mask_off] の effect は method", () => {
    expect(lim('[mask time="500" effect="fadeInDown"]')).toBe("@mask time=500ms method=fadeInDown\n");
    expect(lim('[mask_off time="500" effect="slideOutLeft"]')).toBe("@mask-off time=500ms method=slideInLeft\n");
    expect(lim('[mask_off time="500" effect="fadeOut"]')).toBe("@mask-off time=500ms\n");
    expect(notes('[mask effect="rotateIn"]')).toEqual(["mask の effect=rotateIn は変換していません（fade / slide / puff / vanish の In と Out だけを変換します）"]);
  });

  it("[bgcamera] 系は汎用の形にせず、理由付きのエラーにする", () => {
    const r = converted('[bgcamera qrcode="on"]');
    expect(r.text).toBe('// TODO ks: [bgcamera qrcode="on"]\n');
    expect(r.diagnostics.map((d) => [d.severity, d.code])).toEqual([["error", "unsupported-tag"]]);
    expect(r.stats.byTag.bgcamera).toEqual({ manual: 1 });
  });
});

describe("標準の命令の変換: 文字と動画", () => {
  it("[ptext] は @layer-text、[mtext] は @motion-text", () => {
    expect(lim('[ptext layer="1" x="80" y="300" text="第一章" size="48" color="0xffcc00" bold="bold" edge="3px 0x000000" time="600" name="chapter"]')).toBe(
      "@layer-text 第一章 x=80 y=300 layer=fg1 name=chapter size=48 color=#ffcc00 bold=true edge=#000000 edge-width=3 time=600ms\n",
    );
    expect(lim('[mtext text="そして" x="200" y="300" in_effect="fadeInUp" out_effect="fadeOutDown" fadeout="false"]')).toBe(
      "@motion-text そして x=200 y=300 stay=true in=fadeInUp out=fadeOutDown\n",
    );
    expect(notes('[mtext text="a" x="0" y="0" in_effect="bounceIn"]')).toEqual(["[mtext] in_effect=bounceIn は変換していません（fadeIn で出します）"]);
    expect(lim('[ptext layer="message0" text="名前" x="0" y="0"]')).toBe("\n");
  });

  it("TyranoBuilder の tb_ptext_show / tb_ptext_hide", () => {
    expect(lim('[tb_ptext_show  x="100"  y="200"  size="30"  color="0xffffff"  time="1000"  anim="false"  text="駅前"  fadeout="false"  wait="true"  in_effect="fadeIn"  out_effect="fadeOut"  edge=""  shadow=""  ]')).toBe(
      "@layer-text 駅前 x=100 y=200 layer=fg2 size=30 time=1s\n",
    );
    expect(lim('[tb_ptext_show  x="100"  y="200"  anim="true"  text="駅前"  fadeout="true"  wait="true"  in_effect="fadeInLeft"  out_effect="fadeOut"  ]')).toBe(
      "@motion-text 駅前 x=100 y=200 layer=fg2 in=fadeInLeft\n",
    );
    expect(lim('[tb_ptext_hide  time="500"  ]')).toBe("@free-image fg2 time=500ms\n");
  });

  it("[bgmovie] 系と [layermode_movie]", () => {
    expect(lim('[bgmovie storage="rain.webm" volume="50" time="300"]')).toBe("@bg-movie rain.webm volume=50\n");
    expect(lim('[stop_bgmovie time="1000" wait="false"]')).toBe("@stop-bg-movie time=1s wait=false\n");
    expect(lim("[wait_bgmovie]")).toBe("@wait-bg-movie\n");
    expect(lim('[layermode_movie video="dust.webm" name="dust" mode="screen" mute="true" loop="false" speed="0.5"]')).toBe(
      "@blend-movie dust.webm name=dust mode=screen loop=false speed=0.5\n",
    );
  });
});
