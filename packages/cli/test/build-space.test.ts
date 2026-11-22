import { describe, expect, it } from "vitest";
import { ELECTRON_BYTES, ENGINE_BYTES, estimateBuildSpace, type BuildSpaceInput } from "../src/build-space.ts";

/** 書き出しに要る空きの見込み（lim build が組み立てる前に確かめる）。 */

const GB = 1024 ** 3;
const base: BuildSpaceInput = { targets: [], assets: 2 * GB, copyToOut: false, copyToWork: false, sameDisk: true, asar: true, encrypt: false, browserEncrypt: false, browserZip: false, zip: false, macZip: false, macDmg: false, installer: false, macUniversal: false };

describe("書き出しの空きの見込み", () => {
  it("ブラウザ版は、素材を複製できれば素材の分を数えない（写すなら数え、zip と暗号化は中身を書くので数える）", () => {
    expect(estimateBuildSpace({ ...base, targets: ["browser"] })).toEqual({ out: ENGINE_BYTES, work: 0 });
    expect(estimateBuildSpace({ ...base, targets: ["browser"], copyToOut: true }).out).toBe(ENGINE_BYTES + 2 * GB);
    expect(estimateBuildSpace({ ...base, targets: ["browser"], browserEncrypt: true }).out).toBe(ENGINE_BYTES + 2 * GB);
    expect(estimateBuildSpace({ ...base, targets: ["browser"], browserZip: true }).out).toBe(2 * ENGINE_BYTES + 2 * GB);
  });

  it("デスクトップ版の asar は、複製できるディスクでも素材の分を書く。Electron の本体と、zip とインストーラーの分も数える", () => {
    const plain = estimateBuildSpace({ ...base, targets: ["windows"], asar: false });
    expect(plain.out).toBe(ENGINE_BYTES + ELECTRON_BYTES.windows);
    const asar = estimateBuildSpace({ ...base, targets: ["windows"] });
    expect(asar.out).toBe(ENGINE_BYTES + ELECTRON_BYTES.windows + 2 * GB);
    const packed = estimateBuildSpace({ ...base, targets: ["windows"], zip: true, installer: true });
    // zip とインストーラーは、それぞれ素材の分と縮めた本体の分
    expect(packed.out - asar.out).toBe(2 * (ENGINE_BYTES + ELECTRON_BYTES.windows * 0.5 + 2 * GB));
  });

  it("Mac の universal は本体が二倍。dmg は作るときにアプリの写しを作業の場所に置く", () => {
    const one = estimateBuildSpace({ ...base, targets: ["mac"] });
    const universal = estimateBuildSpace({ ...base, targets: ["mac"], macUniversal: true });
    expect(universal.out - one.out).toBe(ELECTRON_BYTES.mac);
    const dmg = estimateBuildSpace({ ...base, targets: ["mac"], macDmg: true });
    expect(dmg.work).toBe(one.out);
  });

  it("暗号化は素材の写しを作業の場所に置き、別のディスクの作業の場所にはアプリも組み立てる", () => {
    expect(estimateBuildSpace({ ...base, targets: ["linux"], encrypt: true }).work).toBe(2 * GB);
    // 素材を集めるフォルダも、複製できなければ素材の分
    expect(estimateBuildSpace({ ...base, targets: ["linux"], encrypt: true, copyToWork: true }).work).toBe(4 * GB);
    const apart = estimateBuildSpace({ ...base, targets: ["linux", "windows"], sameDisk: false });
    // 作業の場所は、いちばん大きいアプリの分（一つずつ組み立てて書き出し先へ動かす）
    expect(apart.work).toBe(ENGINE_BYTES + ELECTRON_BYTES.windows + 2 * GB);
  });
});
