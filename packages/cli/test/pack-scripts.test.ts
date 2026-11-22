import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCoverage } from "../src/commands/coverage.ts";
import { runFmt } from "../src/commands/fmt.ts";
import { runProseApply, runProseExtract, runScriptExport } from "../src/commands/proofread.ts";
import { runReach } from "../src/commands/reach.ts";
import { runStats } from "../src/commands/stats.ts";

/**
 * 台本を整える、数える、書き出す、流す道具が、パック（packs/<フォルダ>/scenario）の台本も読む（2026-11-19 の rest-p）。
 * 出力では、パックの台本を packs/<フォルダ>/scenario/<台本> の位置で出し、本体の台本と見分けられる。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;
const pack = () => join(dir, "packs", "extra");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-pack-scripts-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  rmSync(join(dir, "scenario"), { recursive: true, force: true });
  rmSync(join(dir, "tests"), { recursive: true, force: true });
  mkdirSync(join(dir, "scenario"), { recursive: true });
  // 本体の start から side へ。パック extra の side は本体の side を差し替え、パックだけの bonus へ進む
  writeFileSync(join(dir, "scenario", "start.lim"), "# start\nアカリ「はじめ」\n@jump side\n");
  writeFileSync(join(dir, "scenario", "side.lim"), "# side\nアカリ「本体の脇」\n@title-screen ending=bad\n");
  mkdirSync(join(pack(), "scenario"), { recursive: true });
  writeFileSync(join(pack(), "pack.json"), JSON.stringify({ id: "extra", title: "おまけ" }));
  writeFileSync(join(pack(), "scenario", "side.lim"), "# side\nアカリ「パックの脇」\n@choice\n- 進む -> bonus\n- 戻る -> start\n@end\n");
  writeFileSync(join(pack(), "scenario", "bonus.lim"), "# bonus\nアカリ「おまけの台詞」\n@title-screen ending=true title=\"おまけ\"\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function quiet<T>(run: () => Promise<T>): Promise<{ value: T; out: string }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    const value = await run();
    return { value, out: lines.join("\n") };
  } finally {
    log.mockRestore();
    write.mockRestore();
  }
}

describe("パックの台本も読む道具", () => {
  it("lim fmt --check はパックの台本の整っていない行を packs/<フォルダ>/scenario/<台本>.lim:<行> で出し、lim fmt はパックの台本も整える", async () => {
    writeFileSync(join(pack(), "scenario", "bonus.lim"), "# bonus\n@bg    hill_night.webp\nアカリ「おまけの台詞」\n");
    const check = await quiet(() => runFmt(dir, true));
    expect(check.value).toBe(false);
    expect(check.out).toContain("packs/extra/scenario/bonus.lim:2");
    await quiet(() => runFmt(dir, false));
    expect(readFileSync(join(pack(), "scenario", "bonus.lim"), "utf8")).toContain("@bg hill_night.webp\n");
  });

  it("lim fmt は、パックの台本が UTF-8 で読めなければ何も書かずに止める", async () => {
    writeFileSync(join(dir, "scenario", "start.lim"), "# start\n@bg    hill_night.webp\n");
    writeFileSync(join(pack(), "scenario", "bonus.lim"), Buffer.from([0x82, 0xa0, 0x82, 0xa2, 0x0a]));
    await expect(quiet(() => runFmt(dir, false))).rejects.toThrow(/packs\/extra\/scenario\/bonus/);
    expect(readFileSync(join(dir, "scenario", "start.lim"), "utf8")).toContain("@bg    hill_night.webp");
  });

  it("lim stats はパックの台本も数え、ファイル別に packs/<フォルダ>/scenario/<台本>.lim で並べる", async () => {
    const r = await quiet(() => runStats(dir, { json: true }));
    const json = JSON.parse(r.out) as { stats: { files: { file: string; say: { lines: number } }[]; total: { say: { lines: number } } } };
    expect(json.stats.files.map((f) => f.file)).toEqual(["side", "start", "packs/extra/scenario/bonus", "packs/extra/scenario/side"]);
    // 合計は、パックが差し替える本体の台本も、パックの台本も足したもの
    expect(json.stats.total.say.lines).toBe(4);
    await quiet(() => runStats(dir, { json: false }));
    expect(readFileSync(join(dir, "exports/stats/統計.md"), "utf8")).toContain("| packs/extra/scenario/bonus.lim | 1 |");
  });

  it("lim script-export と lim prose はパックの台本も書き出し、直した本文をパックの台本へ書き戻す", async () => {
    await quiet(() => runScriptExport(dir));
    expect(existsSync(join(dir, "exports/script/packs/extra/scenario/bonus.txt"))).toBe(true);
    const out = join(dir, "prose.txt");
    await quiet(() => runProseExtract(dir, [], { out }));
    const text = readFileSync(out, "utf8");
    expect(text).toMatch(/\[packs\/extra\/scenario\/bonus:2 [0-9a-f]{6}\]/);
    // パックの台本だけを選んで抜き出せる
    const only = await quiet(() => runProseExtract(dir, ["packs/extra/scenario/bonus.lim"]));
    expect(only.out).toContain("おまけの台詞");
    expect(only.out).not.toContain("本体の脇");
    writeFileSync(out, text.replace("おまけの台詞", "おまけの言葉"));
    expect((await quiet(() => runProseApply(dir, out))).value).toBe(true);
    expect(readFileSync(join(pack(), "scenario", "bonus.lim"), "utf8")).toContain("おまけの言葉");
    expect(readFileSync(join(dir, "scenario", "side.lim"), "utf8")).toContain("本体の脇");
  });

  it("lim coverage はパックの台本もファイルごとに流し、パックをすべて重ねた「はじめから」も流してパックのエンディングを数える", async () => {
    const r = await quiet(() => runCoverage(dir, 4, 1, 4, { json: true }));
    const json = JSON.parse(r.out) as { files: { file: string; reached: number; total: number }[]; route: { packs?: { endings: Record<string, number>; missedEndings: string[] } } };
    expect(json.files.map((f) => f.file)).toEqual(["side", "start", "packs/extra/scenario/bonus", "packs/extra/scenario/side"]);
    expect(json.files.find((f) => f.file === "packs/extra/scenario/side")).toMatchObject({ reached: 1, total: 1 });
    expect(Object.keys(json.route.packs?.endings ?? {})).toContain("true「おまけ」（packs/extra/scenario/bonus:3）");
    expect(json.route.packs?.missedEndings).toEqual([]);
  });

  it("ほかのパックにだけある台本へ飛ぶパックの台本も、すべてのパックを重ねて流すので止まらず、届く選び方も探せる", async () => {
    // パック more だけにある tail へ、extra の bonus が飛ぶ（extra だけを重ねると tail が無い）
    mkdirSync(join(dir, "packs", "more", "scenario"), { recursive: true });
    writeFileSync(join(dir, "packs", "more", "pack.json"), JSON.stringify({ id: "more", title: "続き" }));
    writeFileSync(join(dir, "packs", "more", "scenario", "tail.lim"), "# tail\nアカリ「続きの台詞」\n");
    writeFileSync(join(pack(), "scenario", "bonus.lim"), "# bonus\nアカリ「おまけの台詞」\n@jump tail\n");
    const cov = await quiet(() => runCoverage(dir, 4, 1, 4, { json: true }));
    const json = JSON.parse(cov.out) as { files: { file: string; reached: number; total: number }[] };
    expect(json.files.find((f) => f.file === "packs/extra/scenario/bonus")).toMatchObject({ reached: 1, total: 1 });
    const r = await quiet(() => runReach(dir, "packs/more/scenario/tail:2", { json: true }));
    expect(r.value).toBe(0);
    expect((JSON.parse(r.out) as { choices: { file: string; text: string }[] }).choices.map((c) => [c.file, c.text])).toEqual([["packs/extra/scenario/side", "進む"]]);
  });

  it("lim coverage と lim reach は、パックのデータ（packs/<フォルダ>/data）も重ねて流す（遊ぶ側と同じ）", async () => {
    // パックの side は、パックのデータにだけある地図から bonus へ進む
    mkdirSync(join(pack(), "data"), { recursive: true });
    const map = { title: "行き先", prompt: "どこへ？", file: "bonus", background: "town.png", spots: [{ id: "go", label: "おまけへ", rect: { x: 10, y: 10, width: 100, height: 50 }, target: "#bonus" }] };
    writeFileSync(join(pack(), "data", "investigation.json"), JSON.stringify({ maps: { town: map } }));
    writeFileSync(join(pack(), "scenario", "side.lim"), "# side\nアカリ「パックの脇」\n@map-choice town\n");
    const cov = await quiet(() => runCoverage(dir, 4, 1, 4, { json: true }));
    const json = JSON.parse(cov.out) as { diagnostics: { code: string; file: string }[]; route: { packs?: { missedEndings: string[]; diagnostics: { code: string }[] } } };
    expect(json.diagnostics.map((d) => d.code)).toEqual([]);
    expect(json.route.packs?.missedEndings).toEqual([]);
    const r = await quiet(() => runReach(dir, "packs/extra/scenario/bonus:2", { json: true }));
    expect(r.value).toBe(0);
  });

  it("lim reach はパックの台本の場所へ、本体にパックを重ねた（そのパックを一番後ろにした）「はじめから」から届く選び方を探す", async () => {
    const r = await quiet(() => runReach(dir, "packs/extra/scenario/bonus:2", { json: true }));
    expect(r.value).toBe(0);
    const json = JSON.parse(r.out) as { ok: boolean; file: string; choices: { file: string; text: string }[] };
    expect(json.ok).toBe(true);
    expect(json.file).toBe("packs/extra/scenario/bonus");
    expect(json.choices.map((c) => [c.file, c.text])).toEqual([["packs/extra/scenario/side", "進む"]]);
    // エンディングの一覧にもパックの結末が入る
    const all = await quiet(() => runReach(dir, "", { endings: true, json: true }));
    const endings = (JSON.parse(all.out) as { endings: { file: string; found: boolean }[] }).endings;
    expect(endings.map((e) => [e.file, e.found])).toEqual([["side", true], ["packs/extra/scenario/bonus", true]]);
  });
});
