import { describe, expect, it } from "vitest";
import type { CommandSpec, ParamType } from "@liminalia/lang";
import { HeadlessHost, Runtime, type PresentEvent } from "@liminalia/runtime";
import { combinePlugins } from "@liminalia/plugin-host";
import std from "../src/commands/index.ts";

/**
 * 標準の命令の仕様の「終わるまで待つか」（toSpec が作る CommandSpec.waits）が、実装が描画側に渡す待ちと合っているか。
 * 必須の引数だけを書いた一行を実際に流して確かめる（組み込みの命令は runtime の waits.test.ts）。
 */

const { specs, implementations } = combinePlugins([std]);

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
    default:
      return "a";
  }
}

function commandLine(spec: CommandSpec, extra = ""): string {
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

async function presented(spec: CommandSpec, extra = ""): Promise<boolean | null> {
  // @kanim は名前の付いた @keyframe を引くので、先に一つ作っておく
  const source = `@keyframe a frames="0% x=0; 100% x=10"\n${commandLine(spec, extra)}\nおわり。\n`;
  const host = new Recorder({ loadSource: async () => source });
  await new Runtime(host, { onError: "continue", commands: implementations }).start("main");
  return host.waits.find((w) => w.name === spec.name)?.wait ?? null;
}

describe("標準の命令の仕様の waits", () => {
  it("実装が描画側に渡す待ちと同じで、wait を書けばそれが優先する", async () => {
    let checked = 0;
    for (const spec of specs) {
      const wait = await presented(spec);
      if (wait === null) continue;
      checked++;
      expect(wait, `@${spec.name}`).toBe(spec.waits ?? false);
      if (spec.params.wait) {
        expect(await presented(spec, "wait=false"), `@${spec.name} wait=false`).toBe(false);
        expect(await presented(spec, "wait=true"), `@${spec.name} wait=true`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});
