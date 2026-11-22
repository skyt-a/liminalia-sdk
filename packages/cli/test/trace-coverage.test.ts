import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scenarioEncoding } from "@liminalia/lang";
import { HeadlessHost, Runtime } from "@liminalia/runtime";
import { runCheck } from "../src/commands/check.ts";
import { runCoverage } from "../src/commands/coverage.ts";
import { parseChoose, runTrace } from "../src/commands/trace.ts";

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-trace-"));
  cpSync(TEMPLATE, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** console.log に書いたものを集めて fn を動かす。 */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const value = await fn();
    return { value, out: log.mock.calls.map((c) => String(c[0])).join("\n") };
  } finally {
    log.mockRestore();
  }
}

describe("lim trace", () => {
  it("--choose は番号と選択肢の文を受ける", () => {
    expect(parseChoose("1,北の道, 0")).toEqual([1, "北の道", 0]);
    expect(parseChoose(undefined)).toEqual([]);
  });

  it("選択肢の文でも選び、無い文は診断を残して決まりどおりに選ぶ", async () => {
    const host = new HeadlessHost({ loadSource: async () => "@choice\n- 北へ行く -> #n\n- 南へ行く -> #s\n@end\n# n\n北。\n@stop\n# s\n南。\n", choices: ["南", "無い"] });
    await new Runtime(host).start("a");
    expect(host.trace.flatMap((t) => (t.type === "page" ? [t.text] : []))).toEqual(["南。"]);
  });

  it("本文を挟まずに同じ選択肢へ戻り続ける輪は、選び方を一巡したら止めて知らせる（記録が膨らまない）", async () => {
    const host = new HeadlessHost({ loadSource: async () => "# loop\n@choice\n- 左 -> #loop\n- 右 -> #loop\n@end\n" });
    const runtime = new Runtime(host);
    host.onLimit = () => runtime.stop();
    host.where = () => runtime.at;
    await runtime.start("a");
    expect(host.trace.length).toBeLessThan(20);
    // 診断の場所は選択肢の行（lim trace の出力で `! :0` にならない）
    const loop = host.trace.find((t) => t.type === "diagnostic" && t.diagnostic.code === "choice-loop");
    expect(loop?.type === "diagnostic" ? { file: loop.diagnostic.file, line: loop.diagnostic.line } : null).toEqual({ file: "a", line: 2 });
  });

  it("同じ文の選択肢でも、台本の別の場所なら輪と見ない（「次へ」だけのメニューを本文なしで続けても止めない）", async () => {
    const menus = [1, 2, 3, 4, 5].map((n) => `# m${n}\n@choice\n- 次へ -> #${n < 5 ? `m${n + 1}` : "done"}\n@end\n`).join("");
    const host = new HeadlessHost({ loadSource: async () => `${menus}# done\nおわり。\n`, choices: [0, 0, 0, 0, 0] });
    const runtime = new Runtime(host);
    host.onLimit = () => runtime.stop();
    host.where = () => runtime.at;
    await runtime.start("a");
    expect(host.trace.some((t) => t.type === "diagnostic" && t.diagnostic.code === "choice-loop")).toBe(false);
    expect(host.trace.flatMap((t) => (t.type === "page" ? [t.text] : []))).toEqual(["おわり。"]);
  });

  it("終了の位置は最後に動かした行（命令の番号や、飛んだ元のラベルの行ではない）", async () => {
    // 命令の番号（ラベルと @if も数える）と行がずれる台本。結末は 12 行目の @title-screen
    const script = ["# start", "@set game.k = 0", "@choice", "- 寄る -> #a", "- 帰る -> #b", "@end", "", "# a", "寄った。", "@jump #end", "", "# b", "帰った。", "@jump #end", "", "# end", "@if game.k >= 2", "@jump #a", "@end", "おしまい。", '@title-screen ending="通り雨"', ""].join("\n");
    writeFileSync(join(dir, "scenario", "rain.lim"), script);
    const { out } = await captured(() => runTrace(dir, "rain", { choose: [1], json: false }));
    expect(out.split("\n").at(-1)).toBe("終了: stopped (rain:21)");
    const json = await captured(() => runTrace(dir, "rain", { choose: [1], json: true }));
    expect((JSON.parse(json.out) as { endedAt: unknown }).endedAt).toEqual({ file: "rain", line: 21 });
    // 台本の終わりまで流れたときも、最後に動かした行
    writeFileSync(join(dir, "scenario", "short.lim"), "# a\n一つめ。\n\n二つめ。\n");
    const short = await captured(() => runTrace(dir, "short", { choose: [], json: false, language: "en" }));
    expect(short.out.split("\n").at(-1)).toBe("End: end (short:4)");
  });

  it("実行時のエラーがあれば失敗（終了の値 1）", async () => {
    writeFileSync(join(dir, "scenario", "broken.lim"), "@set game.x = 1 / 0\n地の文。\n");
    const { value } = await captured(() => runTrace(dir, "broken", { choose: [], json: false }));
    expect(value).toBe(false);
    const ok = await captured(() => runTrace(dir, "start", { choose: [], json: false, maxPages: 3 }));
    expect(ok.value).toBe(true);
  });
});

describe("UTF-8 でない台本", () => {
  // 「あいう」の Shift_JIS
  const sjis = Uint8Array.from([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4, 0x0a]);

  it("Shift_JIS と UTF-16 を見分ける", () => {
    expect(scenarioEncoding(new TextEncoder().encode("あいう\n"))).toBeNull();
    expect(scenarioEncoding(sjis)).toBe("Shift_JIS");
    expect(scenarioEncoding(Uint8Array.from([0xff, 0xfe, 0x42, 0x30]))).toBe("UTF-16");
  });

  it("lim check は bad-encoding のエラーにし、化けた中身からの診断は出さない", async () => {
    writeFileSync(join(dir, "scenario", "sjis.lim"), sjis);
    const { value, out } = await captured(() => runCheck(dir, false));
    expect(value).toBe(false);
    expect(out).toContain("sjis:1 error [bad-encoding] このファイルは UTF-8 で読めません（Shift_JIS で保存されているようです）");
    expect(out.split("\n").filter((l) => l.startsWith("sjis:"))).toHaveLength(1);
  });
});

describe("lim coverage の CI の基準", () => {
  it("--json で結果を出し、--min-lines と --require-endings で失敗にする", async () => {
    const json = await captured(() => runCoverage(dir, 2, 1, 2, { json: true }));
    const report = JSON.parse(json.out) as { ok: boolean; lines: { percent: number }; route: { missedEndings: string[] } };
    expect(report.lines.percent).toBeGreaterThan(0);
    expect(json.value).toBe(report.ok);
    const strict = await captured(() => runCoverage(dir, 2, 1, 2, { minLines: 101 }));
    expect(strict.value).toBe(false);
    expect(strict.out).toContain("--min-lines 101");
    // エンディングを一つ足し、届かないようにする
    const start = join(dir, "scenario", "start.lim");
    writeFileSync(start, `${readFileSync(start, "utf8")}\n# never\n@title-screen ending=bad title="never"\n`);
    const endings = await captured(() => runCoverage(dir, 2, 1, 2, { requireEndings: true, github: true }));
    expect(endings.value).toBe(false);
    expect(endings.out).toContain("::error title=lim coverage::届かなかったエンディング: bad「never」");
  }, 120_000);
});

describe("lim coverage の選び方（分岐の見本）", () => {
  /** 選択肢の入れ子、合流、変数で分かれる結末の見本（packages/runtime/test/fixtures/branching。選び方は 7 通り）。 */
  const BRANCHING = resolve(import.meta.dirname, "../../runtime/test/fixtures/branching");

  it("既定の回数で本文をすべて通り、すべてのエンディングに届き、選び方を試し終えたと出す", async () => {
    const own = mkdtempSync(join(tmpdir(), "liminalia-branching-"));
    try {
      cpSync(BRANCHING, own, { recursive: true });
      const json = await captured(() => runCoverage(own, 8, 1, 8, { json: true, requireEndings: true }));
      const report = JSON.parse(json.out) as { ok: boolean; lines: { percent: number }; files: { complete: boolean }[]; route: { complete: boolean; runs: number; lines: { percent: number }; endings: Record<string, number>; missedEndings: string[] } };
      expect(report.ok).toBe(true);
      expect(report.lines.percent).toBe(100);
      expect(report.files.every((f) => f.complete)).toBe(true);
      expect(report.route).toMatchObject({ complete: true, runs: 7, lines: { percent: 100 }, missedEndings: [] });
      // 見本は前の書き方（ending= に文言）のまま。種類の分からない文言は other とその名前で数える
      expect(Object.keys(report.route.endings).sort()).toEqual(["other「勇気」（start:50）", "other「帰り道」（start:56）", "other「真実」（epilogue:2）", "other「落とし物」（start:53）"].sort());
      const text = await captured(() => runCoverage(own, 8, 1, 8));
      expect(text.out).toContain("7 回流しました（変数を引き継ぐ。選び方をすべて試しました）");
      // 上限で打ち切ったときはそう出す
      const cut = await captured(() => runCoverage(own, 2, 1, 3));
      expect(cut.out).toContain("選び方を試し切る前に上限（--runs 2）で打ち切ったファイル: 1 件（start）");
      expect(cut.out).toContain("上限の 3 回で打ち切り、まだ試していない選び方があります。--route-runs で増やせます");
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  }, 120_000);
});
