import { describe, expect, it } from "vitest";
import { checkUi, initialFrameAlone, isPortrait, portraitSpriteScale, positionCenters, screenAspect, uiBaseSize, uiScale, uiSpace } from "../src/index.ts";

describe("作品の画面の大きさ", () => {
  it("縦長は高さが幅より大きいとき。正方形は横長として扱う", () => {
    expect(isPortrait({ width: 720, height: 1280 })).toBe(true);
    expect(isPortrait({ width: 1280, height: 720 })).toBe(false);
    expect(isPortrait({ width: 800, height: 800 })).toBe(false);
  });

  it("文字と枠の基準の大きさと拡大率", () => {
    expect(uiBaseSize({ width: 1920, height: 1080 })).toEqual({ width: 1280, height: 720 });
    expect(uiBaseSize({ width: 1080, height: 1920 })).toEqual({ width: 720, height: 1280 });
    expect(uiScale({ width: 1280, height: 720 })).toBe(1);
    expect(uiScale({ width: 720, height: 1280 })).toBe(1);
    expect(uiScale({ width: 1920, height: 1080 })).toBe(1.5);
    expect(uiScale({ width: 1080, height: 1920 })).toBe(1.5);
    expect(uiScale({ width: 1024, height: 768 })).toBe(0.8);
  });

  it("文字と枠の座標で測った舞台の大きさ", () => {
    expect(uiSpace({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
    expect(uiSpace({ width: 1920, height: 1080 })).toEqual({ width: 1280, height: 720 });
    expect(uiSpace({ width: 1024, height: 768 })).toEqual({ width: 1280, height: 960 });
  });

  it("CSS の縦横比", () => {
    expect(screenAspect({ width: 720, height: 1280 })).toBe("720 / 1280");
  });

  it("立ち位置の中心は、縦長では真ん中へ寄せる", () => {
    expect(positionCenters({ width: 1280, height: 720 })).toEqual({ left: 0.25, center: 0.5, right: 0.75 });
    expect(positionCenters({ width: 720, height: 1280 })).toEqual({ left: 0.3, center: 0.5, right: 0.7 });
  });

  it("縦長の立ち絵の倍率は、画面の高さの 7 割ほどと幅の 9 割ほどの小さい方", () => {
    expect(portraitSpriteScale({ width: 600, height: 900 }, { width: 720, height: 1280 })).toBeCloseTo((1280 * 0.72) / 900);
    expect(portraitSpriteScale({ width: 1200, height: 900 }, { width: 720, height: 1280 })).toBeCloseTo((720 * 0.92) / 1200);
  });

  it("差分の初めの枠: 横長は今までどおり、縦長は幅にも収めて寄せる", () => {
    expect(initialFrameAlone({ width: 500, height: 1440 }, { width: 1280, height: 720 })).toEqual({
      width: 250,
      height: 720,
      positions: { left: { left: 195, top: 0 }, center: { left: 515, top: 0 }, right: { left: 835, top: 0 } },
    });
    const f = initialFrameAlone({ width: 1000, height: 1500 }, { width: 720, height: 1280 });
    expect(f.height).toBe(922);
    expect(f.width).toBe(614);
    expect(f.positions.center).toEqual({ left: 360 - 307, top: 1280 - 922 });
    expect(f.positions.left!.left).toBe(Math.round(720 * 0.3 - 307));
  });

  it("ui.backgroundFocus の形を確かめる", () => {
    expect(checkUi({ backgroundFocus: { "*": "62% 50%", "a.webp": "0% 0%" } })).toEqual([]);
    expect(checkUi({ backgroundFocus: "62% 50%" })[0]?.code).toBe("bad-ui");
    expect(checkUi({ backgroundFocus: { "a.webp": 50 } })[0]?.code).toBe("bad-ui");
  });
});
