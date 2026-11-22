import { describe, expect, it } from "vitest";
import type { Cast } from "@liminalia/sdk";
import { checkSpine, spineModels } from "../src/commands.ts";
import { atlasFor, fitRect, folderOf, pickRole, pickState, readOptions } from "../src/model.ts";

describe("Spine: 項目", () => {
  it("model の項目を読み、.atlas は骨格の名前から決める", () => {
    expect(readOptions({ type: "spine", src: "hero/hero.skel" })).toMatchObject({ src: "hero/hero.skel", atlas: "hero/hero.atlas", loop: true, mix: 0.2, scale: 1, runtime: "spine/spine-webgl.min.js" });
    expect(readOptions({ type: "spine", src: "hero/hero-pro.json", atlas: "hero/pages.atlas", loop: false }).atlas).toBe("hero/pages.atlas");
    expect(atlasFor("a/b.json")).toBe("a/b.atlas");
    expect(folderOf("a/b/c.atlas")).toBe("a/b/");
    expect(folderOf("c.atlas")).toBe("");
  });

  it("差分の名前と同じ名前の動きとスキンを選び、書いたものが先", () => {
    const animations = ["idle", "Smile", "mouth", "blink"];
    const skins = ["default", "smile", "winter"];
    expect(pickState("smile", {}, animations, skins)).toEqual({ animation: "Smile", skin: "smile" });
    expect(pickState("normal", {}, animations, skins)).toEqual({ animation: null, skin: null });
    expect(pickState("smile", { animation: "idle", skin: "winter" }, animations, skins)).toEqual({ animation: "idle", skin: "winter" });
    expect(pickState("smile", { animation: "" }, animations, skins).animation).toBeNull();
    // 無い名前は使わない
    expect(pickState("smile", { animation: "dance", skin: "summer" }, animations, skins)).toEqual({ animation: null, skin: null });
    expect(pickRole(undefined, "mouth", animations)).toBe("mouth");
    expect(pickRole("", "blink", animations)).toBeNull();
    expect(pickRole("talk", "mouth", animations)).toBeNull();
  });

  it("枠に縦横比を保って収める", () => {
    expect(fitRect({ width: 100, height: 200 }, { x: 0, y: 0, width: 200, height: 200 }, { scale: 1, x: 0, y: 0 })).toEqual({ x: 50, y: 0, width: 100, height: 200 });
  });
});

describe("Spine: 作品の確かめ", () => {
  const cast = (model: Record<string, unknown>): Cast => ({
    B: { model: { type: "spine", ...model }, appearances: { default: { variants: { normal: { image: "b.png" }, wave: { image: "b.png", model: { type: "spine", animation: "wave" } } } } } },
  });
  const has = (files: string[]) => (folder: string, path: string) => files.includes(`${folder}/${path}`);

  it("人物の model に差分の model を重ねて読む", () => {
    expect(spineModels(cast({ src: "b/b.skel" }))[1]).toEqual({ where: "B / default / wave", model: { type: "spine", src: "b/b.skel", animation: "wave" } });
  });

  it("骨格と .atlas とランタイムが無いことを、一度ずつ知らせる", () => {
    expect(checkSpine({ cast: cast({}), assetExists: has([]) }).map((d) => d.code)).toEqual(["spine-no-src", "spine-no-src"]);
    expect(checkSpine({ cast: cast({ src: "b/b.skel" }), assetExists: has([]) }).map((d) => d.code)).toEqual(["spine-missing-file", "spine-missing-file", "spine-no-runtime"]);
    expect(checkSpine({ cast: cast({ src: "b/b.skel" }), assetExists: has(["fgimage/b/b.skel", "fgimage/b/b.atlas", "others/spine/spine-webgl.min.js"]) })).toEqual([]);
  });
});
