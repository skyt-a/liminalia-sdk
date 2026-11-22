import { describe, expect, it } from "vitest";
import type { SaveData, Value } from "@liminalia/runtime";
import { StageVariables, type VariableScopes } from "../src/studio-vars.ts";

const runtime = (): VariableScopes => ({ state: { game: { x: 1, deep: { a: 1 } }, temp: { t: 1 } }, system: { s: 1 } });

describe("プレビューの実行器の値を変える（stage-set-var）", () => {
  it("game・temp・system と入れ子に入れる", () => {
    const rt = runtime();
    const v = new StageVariables();
    expect(v.set(rt, "game.x", 2)).toBeNull();
    expect(v.set(rt, "game.deep.a", 3)).toBeNull();
    expect(v.set(rt, "temp.t", "あ")).toBeNull();
    expect(v.set(rt, "system.s", true)).toBeNull();
    expect(rt.state.game).toEqual({ x: 2, deep: { a: 3 } });
    expect(rt.state.temp).toEqual({ t: "あ" });
    expect(rt.system).toEqual({ s: true });
  });

  it("変数のパスでないもの・__proto__ は入れない", () => {
    const rt = runtime();
    const v = new StageVariables();
    expect(v.set(rt, "x", 1)).not.toBeNull();
    expect(v.set(rt, "other.x", 1)).not.toBeNull();
    expect(v.set(rt, "game.__proto__.polluted", 1)).not.toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ページの頭で作ったセーブに、変えた値を足して返す（元のセーブは変えない）", () => {
    const rt = runtime();
    const v = new StageVariables();
    const save = { game: { x: 1, deep: { a: 1 } } } as unknown as SaveData;
    expect(v.patch(rt, save)).toBe(save);
    v.set(rt, "game.deep.a", 9);
    const out = v.patch(rt, save);
    expect((out.game as Record<string, Value>).deep).toEqual({ a: 9 });
    expect(save.game).toEqual({ x: 1, deep: { a: 1 } });
  });

  it("system は実行器をまたいで残るので、組み立て直すときに元の値へ戻す", () => {
    const rt = runtime();
    const v = new StageVariables();
    v.set(rt, "system.s", 5);
    v.set(rt, "system.s", 6);
    v.set(rt, "system.fresh", 7);
    v.restore();
    expect(rt.system).toEqual({ s: 1 });
  });
});
