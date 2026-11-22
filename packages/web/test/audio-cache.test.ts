import { describe, expect, it } from "vitest";
import { AudioCache } from "../src/audio-cache.ts";

describe("展開した音の控え", () => {
  it("上限を超えたら長く使っていないものから捨て、使ったものは残す", async () => {
    const cache = new AudioCache<number>(10, (n) => n);
    let loads = 0;
    const load = (n: number) => () => (loads++, Promise.resolve(n));
    await cache.get("a", load(4));
    await cache.get("b", load(4));
    await cache.get("a", load(4)); // a を使う → b が一番古い
    expect(loads).toBe(2);
    await cache.get("c", load(4));
    expect([cache.has("a"), cache.has("b"), cache.has("c")]).toEqual([true, false, true]);
    expect(cache.size).toBe(8);
    // 上限より大きいものも、読んだばかりなら残す
    await cache.get("big", load(30));
    expect([cache.has("a"), cache.has("c"), cache.has("big")]).toEqual([false, false, true]);
  });

  it("捨てたものでも、ほかが持っていれば読み直さずに控えに戻す", async () => {
    const cache = new AudioCache<{ n: number }>(10, (v) => v.n);
    let loads = 0;
    const load = (n: number) => () => (loads++, Promise.resolve({ n }));
    const playing = await cache.get("bgm", load(8));
    await cache.get("voice", load(8));
    expect(cache.has("bgm")).toBe(false);
    // 鳴っている BGM（playing が持っている）は、同じものが返り、読み直さない
    expect(await cache.get("bgm", load(8))).toBe(playing);
    expect([loads, cache.has("bgm"), cache.size]).toEqual([2, true, 8]);
  });

  it("読めなかったものは控えない", async () => {
    const cache = new AudioCache<number>(10, (n) => n);
    await expect(cache.get("x", () => Promise.reject(new Error("404")))).rejects.toThrow("404");
    await Promise.resolve();
    expect(cache.has("x")).toBe(false);
    expect(await cache.get("x", () => Promise.resolve(1))).toBe(1);
  });
});
