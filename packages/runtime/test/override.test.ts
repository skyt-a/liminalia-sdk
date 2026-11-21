import { describe, expect, it } from "vitest";
import { combinePlugins, runPluginChecks, undeclaredOverrides, type CommandPlugin } from "@liminalia/sdk";
import { createRegistry, CORE_COMMANDS } from "@liminalia/lang";
import { HeadlessHost } from "../src/headless.ts";
import { Runtime } from "../src/runtime.ts";

const cutin = (replaces?: boolean): CommandPlugin => ({ name: "mine", commands: [{ name: "cutin", summary: "", params: {}, example: "@cutin", ...(replaces ? { replaces } : {}) }] });
const std: CommandPlugin = { name: "std", commands: [{ name: "cutin", summary: "", params: {}, example: "@cutin" }] };

describe("同じ名前の命令の上書き", () => {
  it("組み込みか先に読んだプラグインの命令を、replaces の宣言なしに上書きしていれば知らせる", () => {
    expect(undeclaredOverrides([std, cutin()])).toEqual([{ plugin: "mine", name: "cutin", over: "std" }]);
    expect(undeclaredOverrides([std, cutin(true)])).toEqual([]);
    // 組み込みの命令（CORE_COMMANDS）も
    const wait: CommandPlugin = { name: "mine", commands: [{ name: "wait", summary: "", params: {}, example: "@wait" }] };
    expect(undeclaredOverrides([wait])).toEqual([{ plugin: "mine", name: "wait", over: null }]);
    // 後に読んだものが使われる（今までどおり）
    expect(combinePlugins([std, cutin(true)]).commands.at(-1)).toMatchObject({ name: "cutin" });
  });

  it("lim check と制作画面のチェック（runPluginChecks）が警告にする", () => {
    const d = runPluginChecks([std, cutin()], {
      root: "/x",
      config: {},
      scripts: new Map(),
      text: () => "",
      cast: {},
      speakers: [],
      registry: createRegistry(CORE_COMMANDS),
      data: () => undefined,
      assetExists: () => true,
    });
    expect(d.map((x) => [x.severity, x.code, x.message])).toEqual([["warning", "plugin-replaces-command", "プラグイン mine の @cutin が、std の @cutin を上書きしています（置き換えの宣言がありません）"]]);
  });
});

describe("組み込みのコマンドと同じ名前のマクロ", () => {
  it("実行器はマクロを先に探す（検査の警告の「作品のマクロを使います」と同じ）", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@define wait(n: number)\n地の文{= n}\n@end\n@wait n=3\n" });
    const runtime = new Runtime(host, {});
    await runtime.start("main");
    expect(host.trace.filter((t) => t.type === "page").map((t) => (t as { text: string }).text)).toEqual(["地の文3"]);
  });
});
