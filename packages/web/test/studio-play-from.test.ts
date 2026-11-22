import { describe, expect, it } from "vitest";
import { createState } from "@liminalia/runtime";
import { PLAY_FROM_KEY, type PlayFrom } from "@liminalia/studio/protocol";
import { readPlayFrom } from "../src/studio-play-from.ts";

const store = (value: unknown) => ({ getItem: (key: string) => (key === PLAY_FROM_KEY ? JSON.stringify(value) : null) });

describe("ここから遊ぶ（?play=1&from=）", () => {
  const { temp: _temp, ...save } = createState("start");
  const entry: PlayFrom = { id: "a1", save, file: "start", line: 97 };

  it("制作画面と同じ鍵から、id の合うセーブだけを読む", () => {
    expect(readPlayFrom("a1", store(entry))).toEqual(save);
    expect(readPlayFrom("b2", store(entry))).toBeNull();
    expect(readPlayFrom(null, store(entry))).toBeNull();
  });

  it("無い・壊れているときは null（?start= から始める）", () => {
    expect(readPlayFrom("a1", { getItem: () => null })).toBeNull();
    expect(readPlayFrom("a1", { getItem: () => "{" })).toBeNull();
    expect(readPlayFrom("a1", null)).toBeNull();
  });
});
