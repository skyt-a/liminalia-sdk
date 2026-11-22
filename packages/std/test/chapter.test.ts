import { describe, expect, it } from "vitest";
import { HeadlessHost, Runtime, type Value } from "@liminalia/runtime";
import { combinePlugins } from "@liminalia/plugin-host";
import std from "../src/commands/index.ts";

/** 章の扉と章末（@chapter-card・@chapter-end）と、演出の終わりに暗転を残す leave=mask の命令の側。 */

const { implementations } = combinePlugins([std]);
const chapters = [{ id: "ep1", number: "第一章", title: "雨の駅", subtitle: "RAINY STATION", files: ["a"] }];

async function run(src: string) {
  const shown: [string, Record<string, Value>][] = [];
  const masks: (string | null)[] = [];
  let runtime: Runtime | null = null;
  class H extends HeadlessHost {
    override async present(event: Parameters<HeadlessHost["present"]>[0]) {
      if (event.type === "command" && event.name.startsWith("chapter-")) shown.push([event.name, event.args]);
      if (event.type === "page") masks.push(runtime!.state.stage.mask);
      return super.present(event);
    }
  }
  const host = new H({ loadSource: async () => src });
  runtime = new Runtime(host, { speakers: ["ユイ"], commands: implementations, chapters });
  await runtime.start("a");
  return { shown, masks };
}

describe("章の扉と章末", () => {
  it("省いた番号、題、副題を今の章から補い、書いたものはそのまま", async () => {
    const { shown } = await run("@chapter-card\n@chapter-end title=別の題 text=つづく\n本文");
    expect(shown.map(([n, a]) => [n, a.number, a.title, a.subtitle, a.text ?? null])).toEqual([
      ["chapter-card", "第一章", "雨の駅", "RAINY STATION", null],
      ["chapter-end", "第一章", "別の題", "RAINY STATION", "つづく"],
    ]);
  });

  it("leave=mask（@chapter-end の既定）は暗転を状態に残し、待たないときは残さない", async () => {
    const a = await run("@chapter-card\n一\n@chapter-end\n二\n@mask-off\n三\n@chapter-card leave=mask wait=false\n四\n@staff-roll leave=mask\n# x\n@end\n五");
    expect(a.masks).toEqual([null, "#000000", null, null, "#000000"]);
  });
});
