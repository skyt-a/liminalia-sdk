import { describe, expect, it } from "vitest";
import { checkProject, CORE_COMMANDS, createRegistry, englishDiagnostic, FILTER_ONLY_EFFECTS, parse, type Diagnostic } from "@liminalia/lang";
import { combinePlugins } from "@liminalia/plugin-host";
import std from "../src/commands/index.ts";
import { FILTER_EFFECTS } from "../src/commands/effect.ts";

/**
 * 標準のコマンドの書き損じ（lang の command-lint.ts。構文チェックが checkProject で見る）を、本物の標準のコマンドの仕様で確かめる。
 * 前は実行して初めて分かった（名前の無い @cutin-hide は何も引かず、wave の mask= は黙って全体にかかり、速い @flash はそのまま点滅した）。
 */

const { specs } = combinePlugins([std]);
const registry = createRegistry([...CORE_COMMANDS, ...specs]);
const run = (files: Record<string, string>): Diagnostic[] => checkProject(new Map(Object.entries(files).map(([name, src]) => [name, parse(src, name)])), { registry });
const codes = ["hide-name-unknown", "effect-mask-ignored", "flash-rate"];
const show = (files: Record<string, string>) => run(files).filter((d) => codes.includes(d.code)).map((d) => `${d.file}:${d.line} ${d.severity} ${d.code}`);

describe("消す名前を、どこでも出していない", () => {
  it("@cutin-hide、@hud-text-off、@hud-button-off の名前が、どの @cutin stay=true、@hud-text、@hud-button にも無ければ警告", () => {
    const a = ["@cutin key.png stay=true name=key", '@hud-text day text="1 日目"', "@hud-button memo call=#memo label=メモ", "@cutin-hide key", "@hud-text-off day", "@hud-button-off memo", "@cutin-hide nobody", "@hud-text-off nobody", "@hud-button-off nobody", "# memo", "@return"].join("\n");
    expect(show({ a })).toEqual(["a:7 warning hide-name-unknown", "a:8 warning hide-name-unknown", "a:9 warning hide-name-unknown"]);
    const d = run({ a }).find((x) => x.code === "hide-name-unknown")!;
    expect(d.message).toBe("@cutin-hide の nobody を、どの @cutin stay=true も名前に書いていません");
    expect(englishDiagnostic(d).message).toBe("No @cutin stay=true has the name nobody given to @cutin-hide");
  });

  it("ほかのファイルで出した名前、名前を省いたもの（すべて）、式の名前は知らせない。綴りの近い名前を修正案に出す", () => {
    expect(show({ a: "@cutin-hide key\n@hud-text-off\n@hud-text-off (temp.n)", b: "@cutin key.png stay=true name=key" })).toEqual([]);
    // 名前を式で出すものがあれば、その種類は見ない
    expect(show({ a: "@hud-text (temp.n) text=x\n@hud-text-off day" })).toEqual([]);
    // stay=true でない @cutin は残らないので、引く名前に数えない
    expect(show({ a: "@cutin key.png name=key\n@cutin-hide key" })).toEqual(["a:2 warning hide-name-unknown"]);
    const near = run({ a: '@hud-text day text="1 日目"\n@hud-text-off dya' }).find((x) => x.code === "hide-name-unknown")!;
    expect(near.hint).toBe("day のことですか？");
    expect(near.fix).toEqual({ kind: "replace", find: "dya", with: "day" });
  });
});

describe("範囲を決められない @effect の mask=", () => {
  it("wave、glitch、chromatic の mask= は全体にかかることを警告し、範囲を決められる種類は知らせない", () => {
    expect(show({ a: '@effect wave mask="radial 0 0 100 100"\n@effect glitch mask="radial 0 0 10 10" time=1s\n@effect mosaic mask="radial 0 0 100 100"\n@effect wave' })).toEqual([
      "a:1 warning effect-mask-ignored",
      "a:2 warning effect-mask-ignored",
    ]);
    const d = run({ a: '@effect wave mask="radial 0 0 100 100"' }).find((x) => x.code === "effect-mask-ignored")!;
    expect(d.message).toBe("@effect wave は範囲（mask=）を決められず、画面全体にかかります");
    expect(englishDiagnostic(d).message).toBe("@effect wave can't be limited to an area (mask=), so it covers the whole screen");
  });

  it("lang の種類の表は、標準の @effect のフィルタの種類と同じ", () => {
    expect([...FILTER_ONLY_EFFECTS].sort()).toEqual([...FILTER_EFFECTS].sort());
  });
});

describe("速い点滅の @flash", () => {
  it("1 秒に 3 回を超えて点滅するものを警告する（既定の time=60ms gap=60ms なら 4 回から）", () => {
    expect(show({ a: "@flash count=3\n@flash count=4\n@flash count=10 time=50ms gap=50ms\n@flash count=10 time=60ms gap=274ms\n@flash count=(temp.n)" })).toEqual(["a:2 warning flash-rate", "a:3 warning flash-rate"]);
    const d = run({ a: "@flash count=10 time=50ms gap=50ms" }).find((x) => x.code === "flash-rate")!;
    expect(d.message).toBe("@flash が 1 秒に 10 回点滅します（光の点滅で発作を起こすおそれがあるため、1 秒に 3 回までにします）");
    expect(d.hint).toBe("gap=284ms 以上にするか、count=3 にします");
    expect(englishDiagnostic(d).message).toBe("@flash flashes 10 times in one second (flashing light can cause seizures, so keep it to 3 times a second)");
  });

  it("作品の既定値（commandDefaults）を重ねた仕様で読む", () => {
    const slow = createRegistry([...CORE_COMMANDS, ...specs.map((s) => (s.name === "flash" ? { ...s, params: { ...s.params, gap: { ...s.params.gap!, default: "400ms" } } } : s))]);
    expect(checkProject(new Map([["a", parse("@flash count=5", "a")]]), { registry: slow }).filter((d) => d.code === "flash-rate")).toEqual([]);
  });
});
