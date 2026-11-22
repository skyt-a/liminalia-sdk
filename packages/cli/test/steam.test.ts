import { afterEach, describe, expect, it } from "vitest";
import { steamFor } from "../src/commands/build.ts";

describe("書き出しの Steam の版（--steam）", () => {
  const steam = { appId: 100, achievements: { a: "ACH_A" }, variants: { demo: 200, global: 300 } };
  afterEach(() => {
    delete process.env.LIMINALIA_STEAM;
  });

  it("省くと既定の App ID、名前なら variants、数字ならその App ID、off ならつながない", () => {
    expect(steamFor(steam, undefined)).toEqual({ appId: 100, achievements: { a: "ACH_A" } });
    expect(steamFor(steam, "demo")).toEqual({ appId: 200, achievements: { a: "ACH_A" } });
    expect(steamFor(steam, "480")).toEqual({ appId: 480, achievements: { a: "ACH_A" } });
    expect(steamFor(steam, "off")).toBeNull();
    expect(steamFor(undefined, undefined)).toBeNull();
    expect(() => steamFor(steam, "beta")).toThrow(/variants に beta がありません/);
  });

  it("環境変数 LIMINALIA_STEAM でも選べる（引数が優先）", () => {
    process.env.LIMINALIA_STEAM = "global";
    expect(steamFor(steam, undefined)?.appId).toBe(300);
    expect(steamFor(steam, "demo")?.appId).toBe(200);
  });
});
