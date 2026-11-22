import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { check, CORE_COMMANDS, createRegistry, parse, PLUGIN_API_VERSION } from "@liminalia/lang";
import { HeadlessHost, Runtime, type Value } from "@liminalia/runtime";
import { apiSatisfies, checkPluginManifest, engineMismatches, combinePlugins, dataKeys, defineCommandPlugin, defineState, runPluginChecks, t, type CommandPlugin } from "../src/index.ts";

/** プラグインの口（t の型、命令ごとの validate、診断の修正案、式の関数、型付きの状態、版の宣言）を確かめる。 */

const DATA = { maps: { town: { spots: [{ id: "station" }, { id: "park" }] } }, places: { room: {}, hall: {} } };

const plugin: CommandPlugin = defineCommandPlugin({
  name: "demo",
  apiVersion: PLUGIN_API_VERSION,
  commands: [
    {
      name: "go",
      summary: "地点へ行く",
      positional: ["place"],
      params: {
        place: t.required(t.dataKey("demo.json", "places", "行き先")),
        spot: t.dataKey("demo.json", "maps/town/spots", "地点"),
        speed: t.int("速さ", "1", { min: 1, max: 3 }),
        result: t.variable("結果を入れる変数"),
        next: t.target("次の場面"),
        who: t.cast("連れ"),
        guide: t.cast("案内する人（表示中の人物）", undefined, { shown: true }),
        when: t.condition("行く条件"),
      },
      example: "@go room",
      validate(args, ctx) {
        // 連れと地点は一緒に書かない（例の決まり）
        if (args.who !== undefined && args.spot !== undefined) return [{ severity: "warning", code: "demo-both", message: "連れと地点は一緒に書きません", fix: { kind: "replace", find: ` spot=${args.spot}`, with: "" } }];
        if (args.next !== undefined && !ctx.targetExists(args.next)) return [{ severity: "error", code: "demo-next", message: `次の場面 ${args.next} がありません`, fixes: [{ kind: "add-label", file: ctx.file, label: args.next.replace(/^#/, "") }] }];
      },
    },
  ],
  functions: {
    double: { args: 1, doc: "二倍にする", run: ([v]) => (typeof v === "number" ? v * 2 : null) },
    pickOne: { args: [1, 1], doc: "一つ選ぶ", run: ([xs], env) => (Array.isArray(xs) && xs.length > 0 ? xs[Math.floor(env.random() * xs.length)]! : null) },
    random: { args: 0, doc: "組み込みとぶつかる", run: () => 42 },
  },
});

const checkAll = (source: string, data: unknown = DATA) => {
  const { specs } = combinePlugins([plugin]);
  const registry = createRegistry(CORE_COMMANDS, specs);
  const scripts = new Map([["a", parse(source, "a")]]);
  return runPluginChecks([plugin], { root: "/", config: {}, scripts, text: () => source, cast: { ユイ: { appearances: {} } as never }, speakers: [], registry, data: (name) => (name === "demo.json" ? data : undefined), assetExists: () => true });
};

afterEach(() => {
  // 式の関数は lang と runtime に入れたままにしない（ほかのテストに漏らさない）
  combinePlugins([{ ...plugin, functions: {} }]);
});

describe("SDK の引数の型", () => {
  it("variable・target・cast・condition・dataKey と数の幅を仕様に写す", () => {
    const { specs } = combinePlugins([plugin]);
    const p = specs[0]!.params;
    expect(p.result!.type).toEqual({ kind: "variable" });
    expect(p.next!.type).toEqual({ kind: "target" });
    expect(p.who!.type).toEqual({ kind: "cast" });
    // 表示中の人物に効く引数（制作画面の補完が、表示中の人物を上に並べる）。JSON を通しても残る（開発サーバーが仕様を送る道）
    expect(p.guide!.type).toEqual({ kind: "cast", shown: true });
    expect(JSON.parse(JSON.stringify(p.guide!.type))).toEqual({ kind: "cast", shown: true });
    expect(p.when!.type).toEqual({ kind: "condition" });
    expect(p.place!.type).toEqual({ kind: "string", data: { file: "demo.json", path: "places" } });
    expect(p.speed!.type).toEqual({ kind: "int", min: 1, max: 3 });
    expect(p.speed!.default).toBe("1");
  });

  it("数の幅は lim check の検査に効く", () => {
    const { specs } = combinePlugins([plugin]);
    const registry = createRegistry(CORE_COMMANDS, specs);
    const d = check(parse("@go room speed=9", "a"), { registry });
    expect(d.map((x) => x.code)).toContain("bad-value");
  });

  it("データの名前（dataKey）は辞書の鍵と並びの id を読む", () => {
    expect(dataKeys(DATA, "places")).toEqual(["room", "hall"]);
    expect(dataKeys(DATA, "maps/town/spots")).toEqual(["station", "park"]);
    expect(dataKeys(DATA, "maps/none")).toBeNull();
  });
});

describe("命令ごとの検査と修正案", () => {
  it("データに無い名前を知らせ、書ける名前を添える", () => {
    const d = checkAll("@go kitchen\n@go room spot=bench");
    const keys = d.filter((x) => x.code === "unknown-data-key");
    expect(keys.map((x) => x.line)).toEqual([1, 2]);
    expect(keys[0]!.hint).toContain("room、hall");
    expect(keys[0]!.plugin).toBe("demo");
  });

  it("名前なしで書いた bare の引数のデータの名前も確かめる（検査と同じ読み方。2026-11-19 の疑い）", () => {
    const shelf: CommandPlugin = defineCommandPlugin({
      name: "shelf",
      apiVersion: PLUGIN_API_VERSION,
      commands: [{ name: "open-place", summary: "地点を開く", positional: [], bare: "place", params: { place: t.dataKey("demo.json", "places", "行き先"), wait: t.bool("待つ", false) }, example: "@open-place room" }],
    });
    const source = "@open-place kitchen\n@open-place room\n@open-place wait place=hall\n";
    const { specs } = combinePlugins([shelf]);
    const registry = createRegistry(CORE_COMMANDS, specs);
    const d = runPluginChecks([shelf], { root: "/", config: {}, scripts: new Map([["a", parse(source, "a")]]), text: () => source, cast: {}, speakers: [], registry, data: (name) => (name === "demo.json" ? DATA : undefined), assetExists: () => true });
    expect(d.filter((x) => x.code === "unknown-data-key").map((x) => x.line)).toEqual([1]);
  });

  it("validate の診断に行と修正案が付く（形の合わない修正案は落とす）", () => {
    const d = checkAll("@go room\n@go room who=ユイ spot=park\n@go hall next=#later");
    const both = d.find((x) => x.code === "demo-both")!;
    expect(both).toMatchObject({ file: "a", line: 2, plugin: "demo", fix: { kind: "replace", find: " spot=park", with: "" } });
    expect(both.fixes).toEqual([{ kind: "replace", find: " spot=park", with: "" }]);
    const next = d.find((x) => x.code === "demo-next")!;
    expect(next).toMatchObject({ line: 3, fixes: [{ kind: "add-label", file: "a", label: "later" }] });
  });

  it("validate が投げても全体は止まらず、そのプラグインの診断になる", () => {
    const broken: CommandPlugin = { ...plugin, commands: [{ ...plugin.commands[0]!, validate: () => { throw new Error("壊れた"); } }] };
    const { specs } = combinePlugins([broken]);
    const d = runPluginChecks([broken], { root: "/", config: {}, scripts: new Map([["a", parse("@go room", "a")]]), text: () => "", cast: {}, speakers: [], registry: createRegistry(CORE_COMMANDS, specs), data: () => DATA, assetExists: () => true });
    expect(d.find((x) => x.code === "plugin-check-failed")).toMatchObject({ file: "a", line: 1, plugin: "demo" });
  });
});

describe("式の関数", () => {
  it("lim check は足した関数を知っていて、引数の数を確かめる", () => {
    combinePlugins([plugin]);
    // ほかのプラグインだけをまとめ直しても、入れた関数は残る（VS Code と制作画面は何度もまとめる）
    combinePlugins([{ name: "other", commands: [] }]);
    const d = check(parse("@set game.x = double(2)\n@set game.y = double(1, 2)\n@set game.z = nothing(1)", "a"));
    expect(d.filter((x) => x.code === "bad-arguments").map((x) => x.line)).toEqual([2]);
    expect(d.filter((x) => x.code === "unknown-function").map((x) => x.line)).toEqual([3]);
  });

  it("実行器が呼び、乱数は作品のシードに従う。組み込みと同じ名前は使わず警告する", async () => {
    const { implementations } = combinePlugins([plugin]);
    const source = "@set game.x = double(21)\n@set game.p = pickOne([1, 2, 3])\n@set game.r = random()";
    const run = async () => {
      const host = new HeadlessHost({ loadSource: async () => source });
      const rt = new Runtime(host, { commands: implementations, seed: 7 });
      await rt.start("a");
      return rt.state.game;
    };
    const a = await run();
    const b = await run();
    expect(a.x).toBe(42);
    expect(a.p).toBe(b.p);
    expect(a.r).not.toBe(42);
    expect(checkAll("@go room").map((x) => x.code)).toContain("plugin-function-clash");
  });
});

describe("型付きの状態", () => {
  interface Stamps {
    list: { image: string; x: number }[];
  }
  it("as unknown as Value と書かずに読み書きし、写しを入れる", () => {
    const stamps = defineState<Stamps>("demo.stamps", () => ({ list: [] }));
    const extra: Record<string, Value> = {};
    expect(stamps.get(extra)).toBeUndefined();
    expect(stamps.read(extra)).toEqual({ list: [] });
    stamps.update(extra, (s) => void s.list.push({ image: "a.png", x: 10 }));
    const read = stamps.read(extra);
    read.list.push({ image: "b.png", x: 0 });
    expect(stamps.get(extra)).toEqual({ list: [{ image: "a.png", x: 10 }] });
    stamps.clear(extra);
    expect(Object.keys(extra)).toEqual([]);
  });

  it("初めの値を渡さなければ、read と update の型も undefined を含む（値が無いとき undefined を返す）", () => {
    const count = defineState<number>("demo.count");
    const extra: Record<string, Value> = {};
    expectTypeOf(count.read(extra)).toEqualTypeOf<number | undefined>();
    expect(count.read(extra)).toBeUndefined();
    expect(count.update(extra, (n) => (n ?? 0) + 1)).toBe(1);
    expect(count.read(extra)).toBe(1);
    expectTypeOf(defineState<Stamps>("demo.stamps", () => ({ list: [] })).read(extra)).toEqualTypeOf<Stamps>();
  });
});

describe("プラグインの口の版", () => {
  it("新しい口を使う CommandPlugin を知らせる", () => {
    const newer = { ...plugin, functions: {}, apiVersion: PLUGIN_API_VERSION + 1 };
    const { specs } = combinePlugins([newer]);
    const d = runPluginChecks([newer], { root: "/", config: {}, scripts: new Map(), text: () => "", cast: {}, speakers: [], registry: createRegistry(CORE_COMMANDS, specs), data: () => undefined, assetExists: () => true });
    expect(d.map((x) => x.code)).toEqual(["plugin-api-version"]);
  });

  it("package.json の liminalia.api と engines.liminalia を比べる", () => {
    expect(checkPluginManifest("./plugins/a", { liminalia: { api: PLUGIN_API_VERSION } })).toEqual([]);
    expect(checkPluginManifest("./plugins/a", { liminalia: { api: PLUGIN_API_VERSION + 1 } }).map((d) => d.code)).toEqual(["plugin-engine-version"]);
    expect(checkPluginManifest("./plugins/a", { engines: { liminalia: `>=${PLUGIN_API_VERSION + 1}` } }).map((d) => d.code)).toEqual(["plugin-engine-version"]);
    expect(checkPluginManifest("./plugins/a", { engines: { liminalia: `>=1 <${PLUGIN_API_VERSION + 1}` } })).toEqual([]);
    expect(apiSatisfies(2, "^2")).toBe(true);
    expect(apiSatisfies(2, "1 - 3")).toBe(true);
    expect(apiSatisfies(2, "3 || 4")).toBe(false);
    expect(apiSatisfies(2, "*")).toBe(true);
  });

  it("テーマ、作品、ひな形も同じ形の宣言を読む（合わない宣言を書いたままの形で返す）", () => {
    expect(engineMismatches({ engines: { liminalia: `>=${PLUGIN_API_VERSION}` } })).toEqual([]);
    expect(engineMismatches({ engines: { liminalia: " >=99 " }, liminalia: { api: 99 } })).toEqual(["99", ">=99"]);
    expect(engineMismatches({ engines: { node: ">=22" } })).toEqual([]);
    expect(engineMismatches(null)).toEqual([]);
    expect(engineMismatches({ engines: { liminalia: "<2" } }, 1)).toEqual([]);
  });
});
