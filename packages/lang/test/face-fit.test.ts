import { describe, expect, it } from "vitest";
import { castProblems, estimateFace } from "../src/index.ts";

const SKIN = [250, 222, 205];
const HAIR = [20, 20, 24];
const CLOTH = [30, 30, 60];

/**
 * 黒い長い髪（頭の上と顔の両横に垂れる）、肌色の顔（楕円）と首、紺の服の立ち絵を描く。
 * 髪の輪郭は顔より下まで広いので、輪郭の幅だけでは顎が分からない。
 */
function figure(w: number, h: number, face: { cx: number; top: number; rx: number; ry: number }): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  const set = (x: number, y: number, c: number[]) => {
    const i = (y * w + x) * 4;
    px.set([c[0]!, c[1]!, c[2]!, 255], i);
  };
  const chin = face.top + face.ry * 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x - face.cx) / face.rx;
      const dy = (y - (face.top + face.ry)) / face.ry;
      const inFace = dx * dx + dy * dy <= 1 && y > face.top + face.ry * 0.4;
      const neck = y >= chin - 4 && y < chin + face.ry * 0.5 && Math.abs(x - face.cx) < face.rx * 0.45;
      const hair = y >= face.top - face.ry * 0.5 && y < chin + face.ry * 2 && Math.abs(x - face.cx) < face.rx * 1.5;
      const body = y >= chin + face.ry * 0.5 && Math.abs(x - face.cx) < face.rx * 2.4;
      if (inFace || neck) set(x, y, SKIN);
      else if (body) set(x, y, CLOTH);
      else if (hair) set(x, y, HAIR);
    }
  return px;
}

describe("estimateFace", () => {
  it("髪が顔の横まで垂れていても、肌の顔が細くなる所を顎にする", () => {
    const m = estimateFace(figure(300, 600, { cx: 150, top: 60, rx: 40, ry: 50 }), 300, 600)!;
    expect(m).not.toBeNull();
    expect(m.top).toBe(35);
    // 顎は顔の楕円の下端（160）の近く
    expect(Math.abs(m.chinY - 160)).toBeLessThanOrEqual(12);
    expect(Math.abs(m.chinX - 150)).toBeLessThanOrEqual(3);
  });

  it("肌が見つからない絵は null（輪郭からの推定に任せる）", () => {
    const px = figure(300, 600, { cx: 150, top: 60, rx: 40, ry: 50 });
    for (let i = 0; i < px.length; i += 4) if (px[i + 3]) px.set(HAIR, i);
    expect(estimateFace(px, 300, 600)).toBeNull();
  });
});

describe("人物ごとの model", () => {
  const entry = (model: unknown) => ({ ア: { model, appearances: { default: { variants: { normal: { image: "a.png" } } } } } });
  it("type があれば警告しない", () => {
    expect(castProblems(entry({ type: "sway" })).filter((w) => w.message.includes("model"))).toEqual([]);
  });
  it("type が無ければ警告する", () => {
    expect(castProblems(entry({ strength: 1 })).some((w) => w.message === "キャラクター ア の model に type がありません")).toBe(true);
  });
});
