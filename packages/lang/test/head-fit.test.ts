import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyHeadFrames, castProblems, estimateHead, fitFrameToHead, flipAxisRatio, imageContentHash, planHeadAlign, savedHeadMark, type CastEntry, type CastFrame, type HeadMark } from "../src/index.ts";

const frame = { width: 100, height: 200, positions: { left: { left: 0, top: 10 }, center: { left: 300, top: 10 }, right: { left: 600, top: 10 } } };

/** 頭（楕円）と首と肩の簡単な立ち絵を描く。 */
function figure(w: number, h: number, head: { cx: number; top: number; rx: number; ry: number }): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  const set = (x: number, y: number) => (px[(y * w + x) * 4 + 3] = 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x - head.cx) / head.rx;
    const dy = (y - (head.top + head.ry)) / head.ry;
    const inHead = dx * dx + dy * dy <= 1;
    const neck = y > head.top + head.ry * 2 && y < head.top + head.ry * 2.4 && Math.abs(x - head.cx) < head.rx * 0.3;
    const shoulders = y >= head.top + head.ry * 2.4 && Math.abs(x - head.cx) < head.rx * 2.2;
    if (inHead || neck || shoulders) set(x, y);
  }
  return px;
}

describe("estimateHead", () => {
  it("頭頂・顎・幅を推し量る", () => {
    const m = estimateHead(figure(200, 400, { cx: 100, top: 20, rx: 40, ry: 50 }), 200, 400)!;
    expect(m.top).toBe(20);
    expect(Math.abs(m.width - 80)).toBeLessThanOrEqual(2);
    expect(Math.abs(m.chinY - 120)).toBeLessThanOrEqual(12);
    expect(Math.abs(m.chinX - 100)).toBeLessThanOrEqual(2);
  });
  it("長い髪で首が見えなくても、顔の肌の中心を顎の X にし、顎を体の割合で推す", () => {
    const w = 400;
    const h = 800;
    const px = new Uint8ClampedArray(w * h * 4);
    const put = (x: number, y: number, c: [number, number, number]) => px.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    for (let y = 20; y < 780; y++) for (let x = 100; x < 300; x++) put(x, y, [40, 30, 30]);
    for (let y = 60; y < 170; y++) for (let x = 170; x < 270; x++) if (((x - 220) / 50) ** 2 + ((y - 115) / 55) ** 2 <= 1) put(x, y, [240, 205, 180]);
    const m = estimateHead(px, w, h)!;
    expect(m.top).toBe(20);
    expect(Math.abs(m.chinX - 220)).toBeLessThanOrEqual(2);
    expect(m.chinY).toBeGreaterThanOrEqual(138);
    expect(m.chinY).toBeLessThanOrEqual(155);
  });
  it("透明な画像は null", () => {
    expect(estimateHead(new Uint8ClampedArray(40 * 40 * 4), 40, 40)).toBeNull();
  });
});

const mark = (o: Partial<HeadMark>): HeadMark => ({ chinX: 100, chinY: 120, top: 20, width: 80, imageWidth: 200, imageHeight: 400, ...o });

/**
 * 顎の画面の X（描画と同じ: 絵は枠いっぱいに伸ばし、反転は枠の軸（flipAxisRatio。書かなければ中央）で裏返す）。
 * 測定点の imageWidth を絵の幅とする。
 */
function chinOnScreen(f: CastFrame & { width: number; positions: Record<string, { left: number; top: number }> }, at: string, m: HeadMark, flip: boolean): number {
  const x = (m.chinX * f.width) / m.imageWidth;
  const axis = flipAxisRatio(f, m.imageWidth) * f.width;
  return f.positions[at]!.left + (flip ? 2 * axis - x : x);
}

describe("flipAxisRatio（描画が裏返す軸の、枠の幅に対する割合）", () => {
  it("軸が無い、数でない、絵の幅が分からないときは中央", () => {
    expect(flipAxisRatio(undefined, 600)).toBe(0.5);
    expect(flipAxisRatio({}, 600)).toBe(0.5);
    expect(flipAxisRatio({ flipAxis: Number.NaN }, 600)).toBe(0.5);
    expect(flipAxisRatio({ flipAxis: "150" as unknown as number }, 600)).toBe(0.5);
    expect(flipAxisRatio({ flipAxis: 150 }, 0)).toBe(0.5);
  });
  it("軸は絵の左端からの X（絵の px）", () => {
    expect(flipAxisRatio({ flipAxis: 150 }, 600)).toBe(0.25);
    expect(flipAxisRatio({ width: 300, flipAxis: 450 }, 600)).toBe(0.75);
  });
  it("cast の検査は、数でない軸を知らせる", () => {
    const entry = (flipAxis: unknown) => ({ a: { appearances: { default: { variants: { normal: { image: "a.png", frame: { width: 10, height: 10, flipAxis } } } } } } });
    expect(castProblems(entry(120))).toEqual([]);
    expect(castProblems(entry("120")).map((p) => p.message)).toEqual(["キャラクター a の default / normal の frame の flipAxis は、画像の左端からの X（px）の数で書きます"]);
    expect(castProblems(entry(Number.POSITIVE_INFINITY))).toHaveLength(1);
  });
});

describe("fitFrameToHead", () => {
  it("同じ頭なら同じ枠", () => {
    const f = fitFrameToHead({ frame, size: { width: 200, height: 400 }, mark: mark({}) }, { size: { width: 200, height: 400 }, mark: mark({}) })!;
    expect(f).toEqual(frame);
  });
  it("頭が大きい画像は縮め、顎を基準に合わせる", () => {
    const next = { size: { width: 200, height: 400 }, mark: mark({ top: 0, chinY: 200, width: 160, chinX: 90 }) };
    const f = fitFrameToHead({ frame, size: { width: 200, height: 400 }, mark: mark({}) }, next)!;
    expect(f.width).toBe(50);
    expect(f.height).toBe(100);
    // 基準の顎は center で (300+50, 10+60) = (350, 70)。新しい顎は (90*0.25, 200*0.25) = (22.5, 50)
    expect(f.positions.center).toEqual({ left: Math.round(350 - 22.5), top: 20 });
  });
  describe("反転（flip）して出しても顎が合う（2026-11-19 の S7）", () => {
    const size = { width: 600, height: 1000 };
    const at = { left: { left: 0, top: 0 }, center: { left: 340, top: 0 }, right: { left: 680, top: 0 } };
    const next = { size, mark: mark({ chinX: 250, chinY: 240, top: 40, width: 190, imageWidth: 600, imageHeight: 1000 }) };
    for (const [title, parentFrame] of [
      ["基準の顎が絵の中央から外れていて、基準に軸が無い（中央で裏返す）", { width: 600, height: 1000, positions: at }],
      ["基準に軸が書いてある", { width: 600, height: 1000, positions: at, flipAxis: 260 }],
      ["基準の枠が絵より小さい", { width: 450, height: 750, positions: at }],
    ] as const) {
      it(`${title}とき、反転しないときと反転したときの両方で、顎の画面の X が基準と合う`, () => {
        const parent = { frame: structuredClone(parentFrame) as typeof parentFrame & { flipAxis?: number }, size, mark: mark({ chinX: 200, chinY: 200, top: 40, width: 160, imageWidth: 600, imageHeight: 1000 }) };
        const f = fitFrameToHead(parent, next)!;
        expect(f.width).not.toBe(parent.frame.width);
        for (const name of ["left", "center", "right"]) {
          for (const flip of [false, true]) {
            expect(Math.abs(chinOnScreen(f, name, next.mark, flip) - chinOnScreen(parent.frame, name, parent.mark, flip)), `${name} ${flip}`).toBeLessThanOrEqual(1);
          }
        }
      });
    }
    it("基準と差分の顎がどちらも絵の中央なら、軸を書かない（前と同じく中央で裏返す）", () => {
      const parent = { frame: { width: 600, height: 1000, positions: at }, size, mark: mark({ chinX: 300, imageWidth: 600, imageHeight: 1000 }) };
      const f = fitFrameToHead(parent, { size, mark: mark({ chinX: 300, chinY: 240, width: 190, imageWidth: 600, imageHeight: 1000 }) })!;
      expect(f.flipAxis).toBeUndefined();
      expect(chinOnScreen(f, "center", mark({ chinX: 300, imageWidth: 600 }), true)).toBeCloseTo(chinOnScreen(f, "center", mark({ chinX: 300, imageWidth: 600 }), false), 5);
    });
  });
  it("基準の縦横比が歪んでいれば null", () => {
    expect(fitFrameToHead({ frame: { ...frame, height: 260 }, size: { width: 200, height: 400 }, mark: mark({}) }, { size: { width: 200, height: 400 }, mark: mark({}) })).toBeNull();
  });
});

describe("planHeadAlign", () => {
  const entry: CastEntry = {
    appearances: {
      default: { variants: { normal: { image: "a/normal.png", frame }, smile: { image: "a/smile.png" }, cry: { image: "a/cry.png" } } },
    },
  };
  const sizes = { "a/normal.png": { width: 200, height: 400 }, "a/smile.png": { width: 200, height: 400 }, "a/cry.png": { width: 200, height: 400 } };
  it("基準を動かさず、測定点の無い差分は飛ばす", () => {
    const r = planHeadAlign(entry, { "a/normal.png": mark({}), "a/smile.png": mark({ width: 160, chinY: 220, top: 20 }) }, sizes);
    expect(Object.keys(r.frames)).toEqual(["default/smile"]);
    expect(r.frames["default/smile"]!.width).toBe(Math.round(100 * Math.exp(0.565 * Math.log(100 / 200) + 0.435 * Math.log(80 / 160))));
    expect(r.skipped.map((s) => s.key)).toEqual(["default/cry"]);
  });
});


describe("planHeadAlign と applyHeadFrames（書いたあとの cast）", () => {
  const box = (width: number, height: number, left = 0) => ({ width, height, positions: { left: { left, top: 0 }, center: { left: left + 300, top: 0 }, right: { left: left + 600, top: 0 } } });
  const sizes = { "u.png": { width: 600, height: 1000 }, "c.png": { width: 600, height: 1000 } };
  const marks = { "u.png": mark({ chinX: 300, chinY: 200, top: 40, width: 160, imageWidth: 600, imageHeight: 1000 }), "c.png": mark({ chinX: 300, chinY: 240, top: 40, width: 190, imageWidth: 600, imageHeight: 1000 }) };
  const framesOf = (entry: CastEntry) => Object.fromEntries(Object.entries(entry.appearances).flatMap(([a, set]) => Object.entries(set.variants).map(([v, x]) => [`${a}/${v}`, x.frame])));

  it("パーツ合成の既定でない立ち絵セットで、基準と同じ絵の差分も基準と同じ枠になる", () => {
    const entry: CastEntry = {
      appearances: {
        default: { variants: { normal: { image: "u.png", frame: box(600, 1000) } } },
        casual: {
          layers: [{ name: "body", options: { b: "c.png" }, default: "b" }, { name: "face", options: { n: "n.png", s: "s.png" } }],
          variants: { normal: { image: "", parts: { face: "n" }, frame: box(600, 1000) }, sad: { image: "", parts: { face: "s" }, frame: box(600, 1000) } },
        },
      },
    };
    const plan = planHeadAlign(entry, marks, sizes);
    expect(plan.skipped).toEqual([]);
    applyHeadFrames(entry, plan.frames);
    const after = framesOf(entry);
    expect(after["casual/normal"]!.width).not.toBe(600);
    expect(after["casual/sad"]).toEqual(after["casual/normal"]);
    // 既定の基準は動かさない
    expect(after["default/normal"]).toEqual(box(600, 1000));
  });

  it("一枚絵でも、基準と同じ画像の差分は基準の枠を写す。枠が同じなら書かない", () => {
    const entry: CastEntry = {
      appearances: {
        default: { variants: { normal: { image: "u.png", frame: box(600, 1000) }, smile: { image: "u.png", frame: box(600, 1000) }, odd: { image: "u.png", frame: box(500, 833, 40) } } },
        casual: { variants: { normal: { image: "c.png", frame: box(600, 1000) }, sad: { image: "c.png" } } },
      },
    };
    const plan = planHeadAlign(entry, marks, sizes);
    expect(Object.keys(plan.frames).sort()).toEqual(["casual/normal", "casual/sad", "default/odd"]);
    applyHeadFrames(entry, plan.frames);
    const after = framesOf(entry);
    expect(after["default/odd"]).toEqual(box(600, 1000));
    expect(after["casual/sad"]).toEqual(after["casual/normal"]);
  });

  it("差分にだけある立ち位置は、その差分の前の枠での顎の位置を保って大きさに合わせる", () => {
    const entry: CastEntry = {
      appearances: {
        default: { variants: { normal: { image: "u.png", frame: box(600, 1000) }, far: { image: "c.png", frame: { ...box(600, 1000), positions: { ...box(600, 1000).positions, far: { left: 900, top: 50 } } } } } },
      },
    };
    const plan = planHeadAlign(entry, marks, sizes);
    const f = plan.frames["default/far"]!;
    const scale = f.width / 600;
    // 前の枠（倍率 1）での顎の画面位置は (900 + 300, 50 + 240)。新しい枠でも同じ所に顎が来る
    expect(Math.abs(f.positions.far!.left + 300 * scale - 1200)).toBeLessThanOrEqual(1);
    expect(Math.abs(f.positions.far!.top + 240 * scale - 290)).toBeLessThanOrEqual(1);
    applyHeadFrames(entry, plan.frames);
    expect(entry.appearances.default!.variants.far!.frame!.positions!.far).toEqual(f.positions.far);
  });

  it("left と right を書いていない基準の枠は、描画と同じく center にあるものとして合わせる", () => {
    const entry: CastEntry = {
      appearances: {
        default: { variants: { normal: { image: "u.png", frame: { width: 600, height: 1000, positions: { center: { left: 300, top: 0 } } } }, sad: { image: "c.png" } } },
      },
    };
    const f = planHeadAlign(entry, marks, sizes).frames["default/sad"]!;
    expect(f.positions.left).toEqual(f.positions.center);
    expect(f.positions.right).toEqual(f.positions.center);
  });

  it("基準の顎が絵の中央から外れていても、書いたあとの cast でどの差分も反転しないときと反転したときの両方で顎が基準と合う（S7）", () => {
    const sizesOff = { "u.png": { width: 600, height: 1000 }, "s.png": { width: 500, height: 900 }, "c.png": { width: 600, height: 1000 } };
    const marksOff = {
      "u.png": mark({ chinX: 220, chinY: 200, top: 40, width: 160, imageWidth: 600, imageHeight: 1000 }),
      "s.png": mark({ chinX: 330, chinY: 230, top: 30, width: 180, imageWidth: 500, imageHeight: 900 }),
      "c.png": mark({ chinX: 280, chinY: 240, top: 40, width: 190, imageWidth: 600, imageHeight: 1000 }),
    };
    const entry: CastEntry = {
      appearances: {
        default: { variants: { normal: { image: "u.png", frame: box(600, 1000) }, smile: { image: "s.png", frame: box(500, 900) } } },
        casual: { variants: { normal: { image: "c.png", frame: box(600, 1000, 30) }, sad: { image: "c.png" } } },
      },
    };
    const plan = planHeadAlign(entry, marksOff, sizesOff);
    expect(plan.skipped).toEqual([]);
    applyHeadFrames(entry, plan.frames);
    const ref = entry.appearances.default!.variants.normal!;
    // 基準は動かさない（軸も書かない）
    expect(ref.frame).toEqual(box(600, 1000));
    for (const [key, v] of Object.entries(framesOf(entry))) {
      const image = Object.values(entry.appearances).flatMap((a) => Object.values(a.variants)).find((x) => x.frame === v)!.image;
      for (const name of ["left", "center", "right"]) {
        for (const flip of [false, true]) {
          const got = chinOnScreen(v as Parameters<typeof chinOnScreen>[0], name, marksOff[image as keyof typeof marksOff], flip);
          const want = chinOnScreen(ref.frame as Parameters<typeof chinOnScreen>[0], name, marksOff["u.png"], flip);
          expect(Math.abs(got - want), `${key} ${name} ${flip}`).toBeLessThanOrEqual(1);
        }
      }
    }
    // 合わせた差分には軸が入る。もう一度合わせても、書くものは無い
    expect(entry.appearances.default!.variants.smile!.frame!.flipAxis).toBeTypeOf("number");
    expect(entry.appearances.casual!.variants.sad!.frame).toEqual(entry.appearances.casual!.variants.normal!.frame);
    expect(planHeadAlign(entry, marksOff, sizesOff).frames).toEqual({});
  });

  it("前の版で位置だけ合わせた差分（軸が無い）にも、合わせ直すと軸が入る。合わない古い軸は外す", () => {
    const sizesOff = { "u.png": { width: 600, height: 1000 }, "c.png": { width: 600, height: 1000 } };
    const marksOff = { "u.png": mark({ chinX: 220, chinY: 200, top: 40, width: 160, imageWidth: 600, imageHeight: 1000 }), "c.png": mark({ chinX: 220, chinY: 200, top: 40, width: 160, imageWidth: 600, imageHeight: 1000 }) };
    // c.png は u.png と同じ頭（位置は今のままで合う）。顎が中央から外れているが、倍率も顎の位置も同じなので、軸は基準と同じ中央でよい
    const same: CastEntry = { appearances: { default: { variants: { normal: { image: "u.png", frame: box(600, 1000) }, sad: { image: "c.png", frame: box(600, 1000) } } } } };
    expect(planHeadAlign(same, marksOff, sizesOff).frames).toEqual({});
    // 合わない古い軸があれば外す
    const stale: CastEntry = { appearances: { default: { variants: { normal: { image: "u.png", frame: box(600, 1000) }, sad: { image: "c.png", frame: { ...box(600, 1000), flipAxis: 400 } } } } } };
    const plan = planHeadAlign(stale, marksOff, sizesOff);
    expect(Object.keys(plan.frames)).toEqual(["default/sad"]);
    applyHeadFrames(stale, plan.frames);
    expect(stale.appearances.default!.variants.sad!.frame).toEqual(box(600, 1000));
    // 頭の大きさが違う差分は、位置がすでに合っていても軸だけ書く
    const marksBig = { ...marksOff, "c.png": mark({ chinX: 250, chinY: 240, top: 40, width: 190, imageWidth: 600, imageHeight: 1000 }) };
    const first: CastEntry = { appearances: { default: { variants: { normal: { image: "u.png", frame: box(600, 1000) }, sad: { image: "c.png", frame: box(600, 1000) } } } } };
    const aligned = planHeadAlign(first, marksBig, sizesOff).frames["default/sad"]!;
    const { flipAxis, ...positionsOnly } = aligned;
    expect(flipAxis).toBeTypeOf("number");
    const old: CastEntry = { appearances: { default: { variants: { normal: { image: "u.png", frame: box(600, 1000) }, sad: { image: "c.png", frame: positionsOnly } } } } };
    expect(planHeadAlign(old, marksBig, sizesOff).frames).toEqual({ "default/sad": aligned });
  });

  it("合わせられなかった差分は、理由の種類と基準を返す", () => {
    const entry: CastEntry = {
      appearances: {
        default: { variants: { normal: { image: "u.png" }, sad: { image: "c.png" }, cry: { image: "x.png" } } },
      },
    };
    const plan = planHeadAlign(entry, marks, sizes);
    expect(plan.skipped).toEqual([
      { key: "default/sad", reason: "no-reference", reference: "default/normal" },
      { key: "default/cry", reason: "no-mark" },
    ]);
  });
});

describe("覚えた測定点と差し替えた絵（2026-11-19 の X4）", () => {
  const size = { width: 200, height: 400 };
  const bytes = (fill: number) => Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + fill) & 0xff);
  const before = imageContentHash(bytes(1));
  const saved = mark({ imageHash: before });

  it("中身の印は、同じ長さでも中身が違えば違い、同じ中身なら同じ", () => {
    expect(imageContentHash(bytes(1))).toBe(before);
    expect(imageContentHash(bytes(2))).not.toBe(before);
    const one = bytes(1);
    one[40] = one[40]! ^ 1;
    expect(imageContentHash(one)).not.toBe(before);
    expect(imageContentHash(new Uint8Array(0))).not.toBe(imageContentHash(new Uint8Array(1)));
  });

  it("同じパス、同じ大きさで中身の違う絵に差し替えると、確認済みでなくなり、前の測定点も使わない", () => {
    expect(savedHeadMark(saved, size, before)).toEqual({ mark: saved, confirmed: true });
    expect(savedHeadMark(saved, size, imageContentHash(bytes(2)))).toEqual({ mark: null, confirmed: false });
  });

  it("中身の印の無い前の形の測定点と、今の絵の中身が分からないときは、測定点から始めて確かめ直す", () => {
    const old = mark({});
    expect(savedHeadMark(old, size, before)).toEqual({ mark: old, confirmed: false });
    expect(savedHeadMark(saved, size, null)).toEqual({ mark: saved, confirmed: false });
    expect(savedHeadMark(old, size, null)).toEqual({ mark: old, confirmed: false });
  });

  it("中身の印は SHA-256（依存を足さない自前の実装。node:crypto と同じ値）で、詰め物の境目の長さでも合う（2026-11-19 の rest-q）", () => {
    for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_001]) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 31 + length) & 0xff);
      expect(imageContentHash(data), `${length} バイト`).toBe(`sha256-${createHash("sha256").update(data).digest("hex")}`);
    }
    expect(imageContentHash(new TextEncoder().encode("abc"))).toBe("sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("前の形の印（長さと 32bit のハッシュ二通り）なら、同じ絵の印でも確認済みにせず、測定点から始めて確かめ直す（偶然同じになる絵を見分けられないため）", () => {
    // 前の版の imageContentHash
    const legacy = (data: Uint8Array) => {
      let a = 0x811c9dc5;
      let b = 0x01000193 ^ data.length;
      for (let i = 0; i < data.length; i++) {
        a = Math.imul(a ^ data[i]!, 0x01000193);
        b = Math.imul(b ^ data[data.length - 1 - i]!, 0x01000193);
      }
      const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
      return `${data.length.toString(36)}-${hex(a)}${hex(b)}`;
    };
    const old = mark({ imageHash: legacy(bytes(1)) });
    expect(old.imageHash).toMatch(/^[0-9a-z]+-[0-9a-f]{16}$/);
    expect(savedHeadMark(old, size, imageContentHash(bytes(1)))).toEqual({ mark: old, confirmed: false });
    expect(savedHeadMark(old, size, null)).toEqual({ mark: old, confirmed: false });
  });

  it("大きさの合わない測定点と、無い測定点は使わない", () => {
    expect(savedHeadMark(saved, { width: 201, height: 400 }, before)).toEqual({ mark: null, confirmed: false });
    expect(savedHeadMark(undefined, size, before)).toEqual({ mark: null, confirmed: false });
  });
});
