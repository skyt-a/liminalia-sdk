import { describe, expect, it } from "vitest";
import { applyCommandDefaults, check, checkCommandDefaults, CORE_COMMANDS, createRegistry, parse, projectMacros, withCommandDefaults, type CastEntry, type CommandSpec } from "../src/index.ts";

/** 章末の演出（プラグインのコマンド）。 */
const ENDING: CommandSpec = { name: "ending", summary: "章末", positional: [], params: { time: { type: { kind: "duration" }, default: "2s", doc: "時間" }, theme: { type: { kind: "enum", values: ["dark", "light"] }, default: "dark", doc: "色" } }, example: "@ending" };
const registry = createRegistry(CORE_COMMANDS, [ENDING]);
const messages = (defaults: unknown) => checkCommandDefaults(defaults, registry).map((d) => d.message);

describe("コマンドの既定値（commandDefaults）", () => {
  it("書かなければ何も言わず、正しい値なら何も言わない（組み込みとプラグインのコマンド）", () => {
    expect(messages(undefined)).toEqual([]);
    expect(messages({ chara: { time: "400ms", appearance: "default", wait: true }, bg: { time: "1s" }, ending: { time: "3s", theme: "light" } })).toEqual([]);
  });

  it("形の崩れ・無いコマンド・無いパラメータ・必須のパラメータ・式・型の誤りはエラー", () => {
    expect(messages([])).toEqual(["commandDefaults はコマンド名 → { パラメータ名: 値 } の形で書きます"]);
    expect(checkCommandDefaults({ chra: { time: "1s" } }, registry).map((d) => [d.code, d.message, d.hint])).toEqual([["bad-command-defaults", "commandDefaults のコマンド @chra はありません", "chara のことですか？"]]);
    expect(messages({ chara: "400ms" })).toEqual(["commandDefaults の chara はパラメータ名 → 値 の形で書きます"]);
    expect(messages({ chara: { fde: "1s" } })).toEqual(["commandDefaults の @chara に fde というパラメータはありません"]);
    expect(messages({ chara: { who: "ユイ" } })).toEqual(["commandDefaults の @chara の who は必須のパラメータなので、既定値を決められません"]);
    expect(messages({ chara: { time: "(game.t)" } })).toEqual(["commandDefaults の @chara の time の既定値に式は書けません"]);
    expect(messages({ chara: { time: 400 }, ending: { theme: "red" }, bg: { cross: "yes" } })).toEqual([
      "commandDefaults の @chara の time: 時間には単位が必要です",
      "commandDefaults の @ending の theme: dark / light のどれかを指定します",
      "commandDefaults の @bg の cross: true か false を指定します",
    ]);
  });

  it("@define のマクロ（projectMacros）の既定値のあるパラメータにも書ける", () => {
    const scripts = new Map([["common", parse("@define scene(image: string, time: duration = 800ms)\n@bg (image)\n@end", "common")]]);
    const macros = projectMacros(scripts);
    expect(macros.get("scene")!.params.time).toMatchObject({ default: "800ms" });
    expect(checkCommandDefaults({ scene: { time: "1500ms" } }, registry, undefined, macros)).toEqual([]);
    expect(checkCommandDefaults({ scene: { image: "a.png", time: "1" } }, registry, undefined, macros).map((d) => d.message)).toEqual([
      "commandDefaults の @scene の image は必須のパラメータなので、既定値を決められません",
      "commandDefaults の @scene の time: 時間には単位が必要です",
    ]);
    // マクロを渡さなければ無いコマンド
    expect(checkCommandDefaults({ scene: { time: "1500ms" } }, registry).map((d) => d.message)).toEqual(["commandDefaults のコマンド @scene はありません"]);
  });

  it("重ねた仕様は既定値を替え、元の既定値を残す。wait を替えれば待つかも替わる。使えない値は重ねない", () => {
    const chara = applyCommandDefaults(registry.get("chara")!, { chara: { time: "400ms", wait: "true", appearance: "school", x: "abc" } });
    expect(chara.params.time).toMatchObject({ default: "400ms", projectDefault: true, standardDefault: "0ms" });
    expect(chara.params.appearance).toMatchObject({ default: "school", projectDefault: true });
    expect(chara.params.appearance!.standardDefault).toBeUndefined();
    expect(chara.params.x!.default).toBeUndefined();
    expect(chara.waits).toBe(true);
    const bg = applyCommandDefaults(registry.get("bg")!, { bg: { wait: false } });
    expect(bg.waits).toBeUndefined();
    // 重ねるものが無ければ同じもの
    expect(applyCommandDefaults(registry.get("mask")!, { chara: { fade: "1s" } })).toBe(registry.get("mask"));
    expect(withCommandDefaults(registry, undefined)).toBe(registry);
  });

  it("書かなかった立ち絵セットは、既定値で決めたものとしてキャストと突き合わせる", () => {
    const castEntries: Record<string, CastEntry> = { ユイ: { appearances: { default: { variants: { normal: { image: "y.png" } } } } } as unknown as CastEntry };
    const script = parse("@chara ユイ\n@chara ユイ appearance=default", "s");
    const withDefaults = withCommandDefaults(registry, { chara: { appearance: "school" } });
    expect(check(script, { registry: withDefaults, castEntries }).map((d) => [d.code, d.line])).toEqual([["unknown-appearance", 1]]);
    expect(check(script, { registry, castEntries })).toEqual([]);
  });
});
