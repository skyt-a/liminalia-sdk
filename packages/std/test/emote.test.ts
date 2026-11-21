import { describe, expect, it } from "vitest";
import { HeadlessHost, Runtime, type StageState } from "@liminalia/runtime";
import { combinePlugins } from "@liminalia/sdk";
import std, { emoteState as E } from "../src/commands/index.ts";

/** 立ち絵に付いて動く漫符（@emote）の命令の側。 */

const { implementations } = combinePlugins([std]);

async function pagesOf(src: string): Promise<StageState[]> {
  const stages: StageState[] = [];
  let runtime: Runtime | null = null;
  class H extends HeadlessHost {
    override async present(event: Parameters<HeadlessHost["present"]>[0]) {
      if (event.type === "page") stages.push(structuredClone(runtime!.state.stage));
      return super.present(event);
    }
  }
  const host = new H({ loadSource: async () => src });
  runtime = new Runtime(host, { speakers: ["ユイ"], commands: implementations });
  await runtime.start("a");
  return stages;
}

describe("漫符", () => {
  it("立ち絵の extra に残り、表情を替えても残り、立ち絵を消すと一緒に消え、出し直しても戻らない", async () => {
    const pages = await pagesOf("@chara ユイ normal\n@emote ユイ anger at=head-left size=48\n一\n@chara ユイ smile\n二\n@chara-hide ユイ\n三\n@chara ユイ normal\n四");
    expect(pages.map((s) => E.emoteOf(s.sprites.ユイ))).toEqual([{ type: "anger", at: "head-left", size: 48 }, { type: "anger", at: "head-left", size: 48 }, null, null]);
  });

  it("time= は状態に残さず、@emote-off で外れる。出ていない人物には付けない", async () => {
    const pages = await pagesOf("@chara ユイ normal\n@emote ユイ sweat time=500ms\n一\n@emote ユイ heart\n@emote-off ユイ\n二\n@emote レン sweat\n三");
    expect(pages.map((s) => s.sprites.ユイ?.extra ?? null)).toEqual([null, null, null]);
  });
});
