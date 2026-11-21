import { describe, expect, it } from "vitest";
import { HeadlessHost, Runtime, type TraceEntry } from "../src/index.ts";

const pages = (trace: TraceEntry[]) => trace.flatMap((t) => (t.type === "page" ? [`${t.speaker ?? ""}:${t.text}`] : []));

describe("場面の呼び出し（callScene）と作品のデータ（ctx.data）", () => {
  // @visit 場面: 場面を呼び、次のラベルで戻ってこの命令をやり直す。game.n が 2 になったら何もしない
  const visit = {
    spec: { name: "visit", summary: "", positional: ["target"], params: { target: { type: { kind: "string" }, doc: "" } }, example: "@visit #a" },
    run: async (a: { target: string }, ctx: { runtime: Runtime; state: { game: Record<string, number> } }) => {
      if ((ctx.state.game.n ?? 0) >= 2) return;
      await ctx.runtime.callScene(a.target, true);
    },
  };
  const run = async (src: string) => {
    const host = new HeadlessHost({ loadSource: async () => src });
    const runtime = new Runtime(host, { commands: [visit as never] });
    const result = await runtime.start("a");
    return { pages: pages(host.trace), result, runtime };
  };

  it("次のラベルで @return を書かずに戻り、命令をやり直す", async () => {
    const { pages: p, runtime } = await run("@visit #spot\n終わり\n@stop\n# spot\n@set game.n += 1\n調べた\n# other\nほか");
    expect(p).toEqual([":調べた", ":調べた", ":終わり"]);
    expect(runtime.state.callStack).toEqual([]);
  });

  it("ファイルの終わりでも戻る", async () => {
    const { pages: p } = await run("@visit #spot\n終わり\n@stop\n# spot\n@set game.n += 1\n調べた");
    expect(p).toEqual([":調べた", ":調べた", ":終わり"]);
  });

  it("場面の中で @jump したら戻らない", async () => {
    const { pages: p, runtime } = await run("@visit #spot\n終わり\n@stop\n# spot\n@jump #away\n# away\n離れた");
    expect(p).toEqual([":離れた"]);
    expect(runtime.state.callStack).toEqual([]);
  });

  it("ctx.data は作品のデータを一度だけ読む", async () => {
    let reads = 0;
    const show = {
      spec: { name: "show", summary: "", positional: [], params: {}, example: "@show" },
      run: async (_a: unknown, ctx: { data(name: string): Promise<unknown>; runtime: Runtime }) => {
        const a = (await ctx.data("x")) as { v: number };
        const b = (await ctx.data("x.json")) as { v: number };
        ctx.runtime.setVariable("game.v", a.v + b.v);
      },
    };
    const runtime = new Runtime(new HeadlessHost({ loadSource: async () => "@show" }), {
      commands: [show as never],
      loadData: (name) => {
        reads++;
        return name === "x.json" ? { v: 2 } : undefined;
      },
    });
    await runtime.start("a");
    expect(runtime.state.game.v).toBe(4);
    expect(reads).toBe(1);
  });
});
