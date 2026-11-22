import { describe, expect, it } from "vitest";
import { inputActionTarget } from "../src/store-input.ts";

describe("Steam Input のアクションの行き先", () => {
  it("ゲームパッドのボタン（advance は a、back は b）と、システム画面の操作に分ける", () => {
    expect(inputActionTarget("a")).toEqual({ pad: "a" });
    expect(inputActionTarget("advance")).toEqual({ pad: "a" });
    expect(inputActionTarget("back")).toEqual({ pad: "b" });
    expect(inputActionTarget("rb")).toEqual({ pad: "rb" });
    expect(inputActionTarget("auto")).toEqual({ system: "auto" });
    expect(inputActionTarget("quick-save")).toEqual({ system: "quick-save" });
    expect(inputActionTarget("fly")).toBeNull();
  });
});
