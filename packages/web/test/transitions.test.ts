import { describe, expect, it } from "vitest";
import { CORE_COMMANDS, type ParamType } from "@liminalia/lang";
import { TRANSITION_METHODS, transitionKeyframes } from "../src/transitions.ts";

describe("背景の切り替え方", () => {
  it("@bg・@mask・@mask-off の method の値はすべて動きを持つ", () => {
    for (const name of ["bg", "mask", "mask-off"]) {
      const type = CORE_COMMANDS.find((c) => c.name === name)!.params.method!.type as Extract<ParamType, { kind: "enum" }>;
      expect([...type.values].sort()).toEqual([...TRANSITION_METHODS].sort());
    }
  });

  it("出てくる動きは素の見た目で終わり、消えていく動きは素の見た目から始まる", () => {
    for (const m of TRANSITION_METHODS) {
      expect(transitionKeyframes(m, "show").at(-1)).toMatchObject({ opacity: 1 });
      expect(transitionKeyframes(m, "hide")[0]).toMatchObject({ opacity: 1 });
    }
  });

  it("fadeInUp は下から入って上へ抜ける（animate.css の fadeInUp / fadeOutUp）", () => {
    expect(transitionKeyframes("fadeInUp", "show")[0]).toMatchObject({ transform: "translate3d(0, 100%, 0)" });
    expect(transitionKeyframes("fadeInUp", "hide")[1]).toMatchObject({ transform: "translate3d(0, -100%, 0)" });
  });
});
