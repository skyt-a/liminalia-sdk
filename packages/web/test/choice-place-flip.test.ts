import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Cast } from "@liminalia/lang";
import type { StageState } from "@liminalia/runtime";
import { faceBoxes } from "../src/choice-place.ts";

/**
 * 選択肢が避ける顔の範囲は、反転した立ち絵では絵を裏返す軸（描画が絵の変形の起点に書く。cast.json の frame の flipAxis）で
 * 鏡に映す（2026-11-19 の S7）。軸が無ければ前と同じく枠の中央で映す。
 */
describe("faceBoxes と反転の軸", () => {
  /** 枠（左 100、幅 400、高さ 600）の中に、600×900 の絵が一枚ある立ち絵。顔は絵の x 60〜180（割合 0.1〜0.3）。 */
  const boxes = (style: { transform: string; transformOrigin: string }) => {
    const img = { style, naturalWidth: 600, naturalHeight: 900 };
    const el = { getBoundingClientRect: () => ({ left: 100, top: 0, width: 400, height: 600 }), querySelectorAll: () => [img] } as unknown as HTMLElement;
    const cast = { a: { appearances: { default: { face: { x: 60, y: 0, width: 120, height: 90 }, variants: { normal: { image: "a.png" } } } } } } as Cast;
    const state = { sprites: { a: { appearance: "", variant: "", at: "center", flip: style.transform !== "" } } } as unknown as StageState;
    return faceBoxes({ sprites: [{ who: "a", el }], cast, state }).map((b) => [b.left, b.right]);
  };

  it("反転しなければ、顔は絵のとおり", () => {
    expect(boxes({ transform: "", transformOrigin: "" })).toEqual([[140, 220]]);
  });
  it("軸の無い反転は、枠の中央で映す（前と同じ）", () => {
    expect(boxes({ transform: "scaleX(-1)", transformOrigin: "" })).toEqual([[380, 460]]);
  });
  it("軸のある反転は、その軸で映す", () => {
    // 軸は枠の 25%: 顔 0.1〜0.3 は 0.2〜0.4 になる
    expect(boxes({ transform: "scaleX(-1)", transformOrigin: "25% 50%" })).toEqual([[180, 260]]);
  });
});

describe("反転した立ち絵を中央で鏡に映す計算が残っていない", () => {
  it("反転を読む所は、どれも裏返す軸で映す（flip ? 1 - x の形を書かない）", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.ts$/.test(name) && /flip\w*\s*\?\s*1\s*-/.test(readFileSync(path, "utf8"))) found.push(relative(root, path));
      }
    };
    for (const pkg of readdirSync(join(root, "packages"))) {
      const src = join(root, "packages", pkg, "src");
      if (statSync(join(root, "packages", pkg)).isDirectory() && readdirSync(join(root, "packages", pkg)).includes("src")) walk(src);
    }
    expect(found).toEqual([]);
  });
});
