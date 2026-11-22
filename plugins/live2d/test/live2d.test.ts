import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Cast } from "@liminalia/sdk";
import { checkLive2d, live2dModels } from "../src/commands.ts";
import { globalCore, type CoreModel, type CubismCore } from "../src/core.ts";
import { easeSine, evaluateCurve, parseSegments, type Exp3Json, type Model3Json, type Motion3Json, type Physics3Json } from "../src/files.ts";
import { fitRect, pickIdle, pickState, readOptions, resolvePath } from "../src/model.ts";
import { normalizeParameter, Physics } from "../src/physics.ts";
import { Puppet, type PuppetOptions } from "../src/puppet.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "model");
const json = <T>(rel: string): T => JSON.parse(readFileSync(join(FIXTURES, rel), "utf8")) as T;

let core: CubismCore;
beforeAll(async () => {
  // 偽の Core（本物は同梱できない）。読み込むと globalThis.Live2DCubismCore を置く
  await import("./fixtures/fake-cubism-core.js");
  core = globalCore()!;
});

function makeModel(): CoreModel {
  const moc = core.Moc.fromArrayBuffer(new Uint8Array(readFileSync(join(FIXTURES, "fake.moc3"))).buffer);
  return core.Model.fromMoc(moc!)!;
}

function makePuppet(o: Partial<PuppetOptions> = {}): { puppet: Puppet; model: CoreModel; value(id: string): number } {
  const model = makeModel();
  const model3 = json<Model3Json>("fake.model3.json");
  const puppet = new Puppet(
    model,
    {
      model3,
      expressions: new Map([["smile", json<Exp3Json>("expressions/smile.exp3.json")]]),
      physics: json<Physics3Json>("fake.physics3.json"),
      loadMotion: async (group, index) => json<Motion3Json>(model3.FileReferences.Motions![group]![index]!.File),
    },
    { idle: null, breath: false, blink: false, random: () => 0, ...o },
  );
  const value = (id: string) => model.parameters.values[model.parameters.ids.indexOf(id)]!;
  return { puppet, model, value };
}

const tick = async (puppet: Puppet, seconds: number, mouth = 0, step = 1 / 30) => {
  for (let t = 0; t < seconds - 1e-9; t += step) {
    puppet.update(step, mouth);
    await Promise.resolve();
  }
};

describe("Live2D: モーションの曲線", () => {
  it("直線、階段、逆の階段、ベジェの区間を読み、時間の値を出す", () => {
    const linear = parseSegments([0, 0, 0, 1, 10]);
    expect(evaluateCurve(linear, -1)).toBe(0);
    expect(evaluateCurve(linear, 0.5)).toBeCloseTo(5);
    expect(evaluateCurve(linear, 2)).toBe(10);
    const stepped = parseSegments([0, 1, 2, 1, 5]);
    expect(evaluateCurve(stepped, 0.5)).toBe(1);
    expect(evaluateCurve(stepped, 1)).toBe(5);
    expect(evaluateCurve(parseSegments([0, 1, 3, 1, 5]), 0.5)).toBe(5);
    // 制御点が直線の上にあるベジェは直線と同じ
    const bezier = parseSegments([0, 0, 1, 1 / 3, 10 / 3, 2 / 3, 20 / 3, 1, 10]);
    expect(evaluateCurve(bezier, 0.25, true)).toBeCloseTo(2.5);
    expect(evaluateCurve(bezier, 0.25, false)).toBeCloseTo(2.5);
    // 二つの区間を続けて読む
    const two = parseSegments([0, 0, 0, 1, 10, 0, 2, 0]);
    expect(two).toHaveLength(2);
    expect(evaluateCurve(two, 1.5)).toBeCloseTo(5);
  });

  it("フェードは 0〜1 をなめらかにつなぐ", () => {
    expect(easeSine(0)).toBe(0);
    expect(easeSine(0.5)).toBeCloseTo(0.5);
    expect(easeSine(2)).toBe(1);
  });
});

describe("Live2D: 物理演算", () => {
  it("パラメーターを正規化の幅に移す（reflect でなければ向きが逆）", () => {
    const norm = { Minimum: -10, Default: 0, Maximum: 10 };
    expect(normalizeParameter(30, -30, 30, norm, true)).toBeCloseTo(10);
    expect(normalizeParameter(-15, -30, 30, norm, true)).toBeCloseTo(-5);
    expect(normalizeParameter(15, -30, 30, norm, false)).toBeCloseTo(-5);
    expect(normalizeParameter(0, -30, 30, norm, true)).toBe(0);
  });

  it("頭を振ると髪のパラメーターが揺れ、止めると落ち着く", () => {
    const model = makeModel();
    const physics = new Physics(json<Physics3Json>("fake.physics3.json"), model.parameters);
    const p = model.parameters;
    const angle = p.ids.indexOf("ParamAngleX");
    const hair = p.ids.indexOf("ParamHair");
    for (let i = 0; i < 60; i++) physics.evaluate(p, 1 / 60);
    const rest = p.values[hair]!;
    p.values[angle] = 30;
    let moved = 0;
    for (let i = 0; i < 20; i++) {
      physics.evaluate(p, 1 / 60);
      moved = Math.max(moved, Math.abs(p.values[hair]! - rest));
    }
    expect(moved).toBeGreaterThan(0.01);
    p.values[angle] = 0;
    for (let i = 0; i < 600; i++) physics.evaluate(p, 1 / 60);
    expect(Math.abs(p.values[hair]! - rest)).toBeLessThan(0.05);
    expect(Number.isFinite(p.values[hair]!)).toBe(true);
  });
});

describe("Live2D: モデルを動かす", () => {
  it("差分の名前と同じ名前の表情を、フェードしながら重ねる。instant なら一気に", async () => {
    const { puppet, value } = makePuppet();
    puppet.setState(pickState("smile", {}, puppet.expressionNames, puppet.motionGroups), false);
    puppet.update(0.1, 0);
    expect(value("ParamSmile")).toBeGreaterThan(0);
    expect(value("ParamSmile")).toBeLessThan(0.5);
    await tick(puppet, 1.2);
    expect(value("ParamSmile")).toBeCloseTo(1);
    // 表情の無い差分に替えると消えていく。スキップ中（instant）なら一気に
    puppet.setState({ expression: null, motion: null }, true);
    puppet.update(0, 0);
    expect(value("ParamSmile")).toBe(0);
    expect(puppet.expression).toBeNull();
  });

  it("差分と同じ名前のモーションのグループを流し、別の差分にすると消していく", async () => {
    const { puppet, value } = makePuppet();
    puppet.setState(pickState("surprised", {}, puppet.expressionNames, puppet.motionGroups), false);
    expect(puppet.busy).toBe(true);
    await tick(puppet, 0.5);
    expect(puppet.busy).toBe(false);
    expect(value("ParamAngleX")).toBeCloseTo(30);
    puppet.setState({ expression: null, motion: null }, false);
    await tick(puppet, 0.5);
    expect(value("ParamAngleX")).toBeCloseTo(0);
  });

  it("待機のモーション（Idle）は流れ続ける", async () => {
    const { puppet, value } = makePuppet({ idle: "Idle" });
    await tick(puppet, 1);
    expect(Math.abs(value("ParamAngleX"))).toBeGreaterThan(0.3);
  });

  it("口の開きを口パクのパラメーター（Groups の LipSync）に足し、まばたきで目の開きを閉じる", async () => {
    const { puppet, value } = makePuppet({ blink: true });
    puppet.update(1 / 30, 0.8);
    expect(value("ParamMouthOpenY")).toBeCloseTo(0.8);
    puppet.update(1 / 30, 0);
    expect(value("ParamMouthOpenY")).toBe(0);
    // 乱数 0 なら 2.2 秒ごとにまばたきする
    let closed = false;
    for (let t = 0; t < 3; t += 1 / 60) {
      puppet.update(1 / 60, 0);
      if (value("ParamEyeLOpen") < 0.05) closed = true;
    }
    expect(closed).toBe(true);
  });

  it("書いた表情とモーションは差分の名前より先。\"\" は無し", () => {
    const names = { expressions: ["smile", "Angry"], motions: ["Idle", "surprised"] };
    expect(pickState("smile", {}, names.expressions, names.motions)).toEqual({ expression: "smile", motion: null });
    expect(pickState("angry", {}, names.expressions, names.motions)).toEqual({ expression: "Angry", motion: null });
    expect(pickState("smile", { expression: "Angry", motion: "surprised" }, names.expressions, names.motions)).toEqual({ expression: "Angry", motion: "surprised" });
    expect(pickState("smile", { expression: "" }, names.expressions, names.motions)).toEqual({ expression: null, motion: null });
    expect(pickIdle(undefined, names.motions)).toBe("Idle");
    expect(pickIdle("", names.motions)).toBeNull();
    expect(pickIdle(undefined, ["TapBody"])).toBeNull();
  });
});

describe("Live2D: 項目とパス", () => {
  it("model の項目を読み、既定を補う", () => {
    const o = readOptions({ type: "live2d", src: "a/a.model3.json", scale: 1.2, breath: false });
    expect(o).toMatchObject({ src: "a/a.model3.json", scale: 1.2, x: 0, y: 0, breath: false, blink: true, core: "live2d/live2dcubismcore.min.js" });
  });

  it("model3.json からの相対パスをたどり、枠に縦横比を保って収める", () => {
    expect(resolvePath("chara/a/a.model3.json", "a.2048/texture_00.png")).toBe("chara/a/a.2048/texture_00.png");
    expect(resolvePath("chara/a/a.model3.json", "../shared/m.motion3.json")).toBe("chara/shared/m.motion3.json");
    expect(resolvePath("a.model3.json", "./a.moc3")).toBe("a.moc3");
    const r = fitRect({ width: 400, height: 600 }, { x: 10, y: 0, width: 200, height: 600 }, { scale: 1, x: 0, y: 0 });
    expect(r).toEqual({ x: 10, y: 150, width: 200, height: 300 });
    expect(fitRect({ width: 400, height: 600 }, { x: 0, y: 0, width: 400, height: 600 }, { scale: 0.5, x: 0.1, y: 0 })).toEqual({ x: 140, y: 150, width: 200, height: 300 });
  });
});

describe("Live2D: 作品の確かめ", () => {
  const cast = (model: Record<string, unknown>): Cast => ({
    A: { model: { type: "live2d", ...model }, appearances: { default: { variants: { normal: { image: "a.png" }, smile: { image: "b.png", model: { type: "live2d", expression: "f01" } } } } } },
  });

  it("人物の model に差分の model を重ねて読む", () => {
    expect(live2dModels(cast({ src: "a/a.model3.json" }))).toEqual([
      { where: "A", model: { type: "live2d", src: "a/a.model3.json" } },
      { where: "A / default / smile", model: { type: "live2d", src: "a/a.model3.json", expression: "f01" } },
    ]);
  });

  it("src が無い、モデルが無い、Core が無いことを知らせる", () => {
    const has = (files: string[]) => (folder: string, path: string) => files.includes(`${folder}/${path}`);
    expect(checkLive2d({ cast: cast({}), assetExists: has([]) }).map((d) => d.code)).toEqual(["live2d-no-src", "live2d-no-src"]);
    expect(checkLive2d({ cast: cast({ src: "a/a.model3.json" }), assetExists: has([]) }).map((d) => d.code)).toEqual(["live2d-missing-model", "live2d-missing-model", "live2d-no-core"]);
    expect(checkLive2d({ cast: cast({ src: "a/a.model3.json" }), assetExists: has(["fgimage/a/a.model3.json", "others/live2d/live2dcubismcore.min.js"]) })).toEqual([]);
    expect(checkLive2d({ cast: cast({ src: "a/a.json" }), assetExists: has(["others/live2d/live2dcubismcore.min.js"]) })[0]!.code).toBe("live2d-src-kind");
  });
});
