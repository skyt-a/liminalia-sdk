import { describe, expect, it } from "vitest";
import { Runtime } from "../src/index.ts";

const speakers = ["ユイ"];

/** 命令の名前と afterPage の印を順に集める。 */
async function marks(src: string): Promise<string[]> {
  const events: string[] = [];
  const host = {
    loadSource: async () => src,
    present: async (e: { type: string; name?: string; afterPage?: boolean }) => {
      if (e.type === "command") events.push(`${e.name}${e.afterPage ? " afterPage" : ""}`);
    },
    waitClick: async () => {},
    choose: async () => 0,
  };
  await new Runtime(host, { speakers }).start("a");
  return events;
}

describe("送ったページのあとの最初の命令（TyranoScript の [p] の改ページ）", () => {
  it("クリックで送ったページのあとに描画側へ渡す最初の命令にだけ afterPage を付ける", async () => {
    expect(await marks("一。\n@chara-hide-all time=300ms\n@bg room.png\n@wait 500ms\n二。\n@bg hall.png")).toEqual([
      "window",
      "chara-hide-all afterPage",
      "bg",
      "wait",
      "bg afterPage",
    ]);
  });

  it("{noclick} のページと NVL のページのあとには付けない", async () => {
    expect(await marks("一。{noclick}\n@bg room.png")).toEqual(["window", "bg"]);
    expect(await marks("@nvl on\n一。\n@bg room.png")).toEqual(["nvl", "window", "bg"]);
  });

  it("ページの途中の命令には付けない", async () => {
    expect(await marks("一{@bg room.png}二。")).toEqual(["window", "bg"]);
  });
});
