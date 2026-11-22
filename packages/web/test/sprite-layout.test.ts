import { describe, expect, it } from "vitest";
import type { CastFrame, CastVariant } from "@liminalia/lang";
import type { Sprite } from "@liminalia/runtime";
import { layoutSprites, spriteSize, type SpriteLayoutInput } from "../src/sprite-layout.ts";

const screen = { width: 1280, height: 720 };
const sprite = (at: string, extra: Partial<Sprite> = {}): Sprite => ({ variant: "normal", appearance: "", at, flip: false, ...extra });
/** 枠のない差分（画像の実寸で出す）。 */
const natural = (s: Sprite, width = 400, height = 600): SpriteLayoutInput => ({ sprite: s, variant: { image: "a.png" }, natural: { width, height } });
/** 枠のある差分。 */
const framed = (s: Sprite, frame: CastFrame): SpriteLayoutInput => ({ sprite: s, variant: { image: "a.png", frame }, natural: { width: 1, height: 1 } });
const xy = (m: Map<string, { x: number; y: number }>) => Object.fromEntries([...m].map(([k, b]) => [k, [b.x, b.y]]));

describe("立ち絵の自動配置", () => {
  it("一人なら画面下の中央", () => {
    expect(xy(layoutSprites([["ユイ", natural(sprite("auto"))]], screen))).toEqual({ ユイ: [440, 120] });
  });

  it("後から出したものほど左。画面の幅を（数 + 1）で等分した位置に中心を置く", () => {
    const out = layoutSprites(
      [
        ["ユイ", natural(sprite("auto"), 400)],
        ["レン", natural(sprite("auto"), 301, 500)],
        ["ハル", natural(sprite("auto"), 200)],
      ],
      screen,
    );
    // 1280 / 4 = 320 → 中心は 320・640・960
    expect(xy(out)).toEqual({ ハル: [220, 120], レン: [640 - 150, 220], ユイ: [960 - 200, 120] });
  });

  it("auto でない立ち絵は数に入れない。枠のある差分も auto なら枠の大きさで並べる", () => {
    const out = layoutSprites(
      [
        ["ユイ", natural(sprite("auto"))],
        ["レン", framed(sprite("left"), { width: 300, height: 700, positions: { left: { left: 10, top: 20 } } })],
        ["ハル", natural(sprite("center", { x: 5, y: 6 }))],
        ["ミオ", framed(sprite("auto"), { width: 300, height: 700 })],
      ],
      screen,
    );
    // auto は ユイ と ミオ の二人（1280 / 3 = 426）
    expect(xy(out)).toEqual({ ミオ: [426 - 150, 20], ユイ: [852 - 200, 120], レン: [10, 20], ハル: [5, 6] });
  });

  it("枠の立ち位置は tatie と同じ（無い名前は center、center も無ければ (0, 0)）。枠のない差分の名前の立ち位置は画面下の中央", () => {
    const frame: CastFrame = { positions: { center: { left: 300, top: 10 }, right: { left: 700, top: 10 } } };
    const out = layoutSprites(
      [
        ["a", framed(sprite("right"), frame)],
        ["b", framed(sprite("far"), frame)],
        ["c", framed(sprite("left"), {})],
        ["d", natural(sprite("right"))],
      ],
      screen,
    );
    expect(xy(out)).toEqual({ a: [700, 10], b: [300, 10], c: [0, 0], d: [440, 120] });
  });

  it("x / y はその軸だけ at より優先する", () => {
    const out = layoutSprites(
      [
        ["ユイ", natural(sprite("auto", { y: 30 }))],
        ["レン", framed(sprite("right", { x: 100 }), { positions: { right: { left: 700, top: 50 } } })],
      ],
      screen,
    );
    expect(xy(out)).toEqual({ ユイ: [440, 30], レン: [100, 50] });
  });

  it("状態だけから決まる（同じ状態なら同じ位置）", () => {
    const sprites: [string, SpriteLayoutInput][] = [
      ["ユイ", natural(sprite("auto"))],
      ["レン", natural(sprite("auto"))],
    ];
    expect(layoutSprites(sprites, screen)).toEqual(layoutSprites(structuredClone(sprites), screen));
  });
});

describe("登場順の自動配置", () => {
  const frame: CastFrame = { width: 400, height: 800, positions: { left: { left: 50, top: 31 }, center: { left: 400, top: 32 }, right: { left: 800, top: 33 } } };
  const managed = () => framed(sprite("center", { autoLayout: true }), frame);
  it("一人は中央、二人以上は登場順に左から、キャストの調整位置を使う", () => {
    expect(xy(layoutSprites([["a", managed()]], screen))).toEqual({ a: [400, 32] });
    expect(xy(layoutSprites([["a", managed()], ["b", managed()]], screen))).toEqual({ a: [50, 31], b: [800, 33] });
    expect(xy(layoutSprites([["a", managed()], ["b", managed()], ["c", managed()]], screen))).toEqual({ a: [50, 31], b: [400, 32], c: [800, 33] });
  });
  it("明示位置を固定して空いた位置へ置き、旧 at=auto は別に扱う", () => {
    expect(xy(layoutSprites([["fixed", framed(sprite("right"), frame)], ["a", managed()]], screen))).toEqual({ fixed: [800, 33], a: [50, 31] });
    expect(xy(layoutSprites([["left", framed(sprite("left"), frame)], ["a", managed()], ["right", framed(sprite("right"), frame)]], screen))).toEqual({ left: [50, 31], a: [400, 32], right: [800, 33] });
    expect(xy(layoutSprites([["legacy", natural(sprite("auto"))], ["a", managed()]], screen))).toEqual({ legacy: [440, 120], a: [400, 32] });
  });
});

describe("立ち絵の大きさ", () => {
  it("枠があれば枠の大きさ（書いていなければ 632×843）、なければ画像の実寸", () => {
    const size = { width: 400, height: 800 };
    const variant = (frame?: CastFrame): CastVariant => (frame ? { image: "a.png", frame } : { image: "a.png" });
    expect(spriteSize(variant(), size)).toEqual(size);
    expect(spriteSize(variant({}), size)).toEqual({ width: 632, height: 843 });
    expect(spriteSize(variant({ width: 300 }), size)).toEqual({ width: 300, height: 843 });
    expect(spriteSize(variant({ width: 10, height: 20 }), size)).toEqual({ width: 10, height: 20 });
  });
});

describe("縦長の舞台", () => {
  const tall = { width: 720, height: 1280 };

  it("枠に立ち位置が書いてあれば、書いてある位置（既定の置き方を当てない）", () => {
    const frame: CastFrame = { width: 400, height: 800, positions: { left: { left: 10, top: 20 }, center: { left: 30, top: 40 } } };
    expect(xy(layoutSprites([["a", framed(sprite("left"), frame)]], tall))).toEqual({ a: [10, 20] });
  });

  it("枠に立ち位置が無ければ、画面の下の left / center / right に置く", () => {
    const frame: CastFrame = { width: 400, height: 800 };
    expect(xy(layoutSprites([["a", framed(sprite("left"), frame)]], tall))).toEqual({ a: [720 * 0.3 - 200, 480] });
    expect(xy(layoutSprites([["a", framed(sprite("center"), frame)]], tall))).toEqual({ a: [160, 480] });
    expect(xy(layoutSprites([["a", framed(sprite("right"), frame)]], tall))).toEqual({ a: [720 * 0.7 - 200, 480] });
  });

  it("横長は枠に立ち位置が無ければ今までどおり (0, 0)", () => {
    expect(xy(layoutSprites([["a", framed(sprite("left"), { width: 400, height: 800 })]], screen))).toEqual({ a: [0, 0] });
  });

  it("auto は舞台の幅で等分する", () => {
    expect(xy(layoutSprites([["a", natural(sprite("auto"), 200, 800)]], tall))).toEqual({ a: [260, 480] });
  });

describe("自動配置の規則", () => {
  const managed = (index: number, count: number): Sprite => sprite("center", { autoLayout: true, autoSlot: { index, count } });
  it("画面の幅の割合で書いた位置に、立ち絵の中心を置く", () => {
    const rules = { positions: { "2": ["30%", "70%"] } };
    const out = layoutSprites([["A", natural(sprite("center", { autoLayout: true }), 200)], ["B", natural(sprite("center", { autoLayout: true }), 200)]], screen, { rules });
    expect(xy(out)).toEqual({ A: [1280 * 0.3 - 100, 120], B: [1280 * 0.7 - 100, 120] });
  });
  it("枠のある差分は、規則に書いた立ち位置の名前の位置に置く", () => {
    const frame: CastFrame = { width: 100, height: 200, positions: { left: { left: 10, top: 5 }, center: { left: 500, top: 5 }, right: { left: 900, top: 5 }, far: { left: 50, top: 7 } } };
    const out = layoutSprites([["A", framed(managed(0, 2), frame)], ["B", framed(managed(1, 2), frame)]], screen, { rules: { exit: "keep", positions: { "2": ["far", "center"] } } });
    expect(xy(out)).toEqual({ A: [50, 7], B: [500, 5] });
  });
});
});

describe("人数による立ち位置の読み替え（autoLayout の byCount）", () => {
  const frame: CastFrame = { width: 300, height: 700, positions: { left: { left: 100, top: 20 }, center: { left: 490, top: 20 }, right: { left: 880, top: 20 }, "left-wide": { left: 40, top: 20 }, "right-wide": { left: 940, top: 20 } } };
  /** 読み替え先の位置が無い枠。 */
  const plain: CastFrame = { width: 300, height: 700, positions: { left: { left: 100, top: 20 }, center: { left: 490, top: 20 }, right: { left: 880, top: 20 } } };
  const layout = { rules: { byCount: { "3": { left: "left-wide", right: "right-wide" } } } };

  it("ちょうどその人数のときだけ、名前で明示した位置を読み替え先に置く", () => {
    const three = layoutSprites([["ユイ", framed(sprite("left"), frame)], ["レン", framed(sprite("center"), frame)], ["ハル", framed(sprite("right"), frame)]], screen, layout);
    expect(xy(three)).toEqual({ ユイ: [40, 20], レン: [490, 20], ハル: [940, 20] });
    const two = layoutSprites([["ユイ", framed(sprite("left"), frame)], ["ハル", framed(sprite("right"), frame)]], screen, layout);
    expect(xy(two)).toEqual({ ユイ: [100, 20], ハル: [880, 20] });
  });

  it("枠に読み替え先が無い差分と、x を書いた立ち絵は、書いた位置のまま", () => {
    const out = layoutSprites([["ユイ", framed(sprite("left"), plain)], ["レン", framed(sprite("center"), frame)], ["ハル", framed(sprite("right", { x: 700 }), frame)]], screen, layout);
    expect(xy(out)).toEqual({ ユイ: [100, 20], レン: [490, 20], ハル: [700, 20] });
  });
});
