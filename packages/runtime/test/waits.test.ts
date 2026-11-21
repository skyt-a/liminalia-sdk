import { describe, expect, it } from "vitest";
import { CORE_COMMANDS, type CommandSpec, type ParamType } from "@liminalia/lang";
import { HeadlessHost, Runtime, type PresentEvent } from "../src/index.ts";

/**
 * 命令の仕様の「終わるまで待つか」（CommandSpec.waits）が、組み込みの命令の実装が描画側に渡す待ちと合っているか。
 * 必須の引数だけを書いた一行を実際に流し、描画側に届いた待ちを見る。wait を持つ命令は、書いた wait が優先することも見る。
 */

function sample(t: ParamType): string {
  switch (t.kind) {
    case "number":
    case "int":
      return String(t.min ?? 1);
    case "bool":
      return "true";
    case "duration":
      return "10ms";
    case "color":
      return "#000000";
    case "enum":
      return t.values[0]!;
    case "asset":
      return "x.png";
    case "cast":
      return "A";
    case "variant":
      return "normal";
    case "position":
      return "center";
    case "target":
      return "#end";
    case "variable":
      return "game.v";
    default:
      return "a";
  }
}

/** 必須の引数だけを書いた一行（extra は足す引数）。 */
export function commandLine(spec: CommandSpec, extra = ""): string {
  const parts = [`@${spec.name}`];
  for (const name of spec.positional) if (spec.params[name]?.required) parts.push(sample(spec.params[name]!.type));
  for (const [name, p] of Object.entries(spec.params)) if (p.required && !spec.positional.includes(name)) parts.push(`${name}=${sample(p.type)}`);
  if (extra) parts.push(extra);
  return parts.join(" ");
}

class Recorder extends HeadlessHost {
  readonly waits: { name: string; wait: boolean }[] = [];
  override async present(event: PresentEvent) {
    if (event.type === "command") this.waits.push({ name: event.name, wait: event.wait });
    return super.present(event);
  }
}

/** 一行を流し、その命令が描画側に渡した待ち（渡さなければ null）。 */
async function presented(spec: CommandSpec, extra = ""): Promise<boolean | null> {
  const source = `${commandLine(spec, extra)}\n# end\nおわり。\n`;
  const host = new Recorder({ loadSource: async () => source });
  await new Runtime(host, { onError: "continue" }).start("main");
  return host.waits.find((w) => w.name === spec.name)?.wait ?? null;
}

describe("命令の仕様の waits", () => {
  it("組み込みの命令の実装が描画側に渡す待ちと同じ", async () => {
    let checked = 0;
    for (const spec of CORE_COMMANDS) {
      const wait = await presented(spec);
      if (wait === null) continue;
      checked++;
      expect(wait, `@${spec.name}`).toBe(spec.waits ?? false);
      if (spec.params.wait) {
        expect(spec.waits ?? false, `@${spec.name} の wait の既定値`).toBe(spec.params.wait.default === "true");
        expect(await presented(spec, "wait=false"), `@${spec.name} wait=false`).toBe(false);
        expect(await presented(spec, "wait=true"), `@${spec.name} wait=true`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(30);
  });
});
