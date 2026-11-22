import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/** lim stats をプロセスとして動かし、書き出した表と JSON を確かめる。 */

const LIM = resolve(import.meta.dirname, "../bin/lim.mjs");
const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");

function lim(args: string[]) {
  const r = spawnSync(process.execPath, [LIM, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const work = mkdtempSync(join(tmpdir(), "liminalia-stats-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("lim stats", { timeout: 60_000 }, () => {
  it("文字数の表と表記ゆれの候補を書き出し、辞書で外せる", () => {
    const dir = join(work, "p");
    cpSync(TEMPLATE, dir, { recursive: true });
    writeFileSync(join(dir, "scenario/extra_notes.lim"), "# notes\nアカリ「わたしにも出来るかな」\nソウ「できるよ」\n");
    const r = lim(["stats", dir]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("表記ゆれの候補 1 組");
    const folder = join(dir, "exports/stats");
    for (const f of ["統計.md", "ファイル別.csv", "シーン別.csv", "話者別.csv", "表記ゆれ.csv"]) expect(existsSync(join(folder, f)), f).toBe(true);
    const md = readFileSync(join(folder, "統計.md"), "utf8");
    expect(md).toContain("| extra_notes.lim | 2 |");
    expect(md).toMatch(/- (出来る|できる): extra_notes\.lim:[23] /);
    expect(readFileSync(join(folder, "話者別.csv"), "utf8").startsWith("﻿話者,台詞の行")).toBe(true);

    const json = JSON.parse(lim(["stats", dir, "--json"]).out) as { stats: { total: { say: { lines: number } } }; variants: { id: string }[] };
    expect(json.stats.total.say.lines).toBeGreaterThan(2);
    expect(json.variants.map((v) => v.id)).toEqual(["kana:できる"]);

    // 手元の辞書（.liminalia/variants.json）で外す
    mkdirSync(join(dir, ".liminalia"), { recursive: true });
    writeFileSync(join(dir, ".liminalia/variants.json"), JSON.stringify({ ignore: ["できる"] }));
    expect((JSON.parse(lim(["stats", dir, "--json"]).out) as { variants: unknown[] }).variants).toEqual([]);
  });

  it("--lang en は英語の名前のファイルに英語の見出しで書き、要約も英語（数が 1 なら単数）", () => {
    const dir = join(work, "en");
    mkdirSync(join(dir, "scenario"), { recursive: true });
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ id: "en", title: "En", entry: "start#start", languages: ["en"] }));
    writeFileSync(join(dir, "cast.json"), JSON.stringify({ speakers: ["Akari"], cast: {} }));
    writeFileSync(join(dir, "scenario/start.lim"), '# start\nAkari "Hi."\nThe end.\n');
    const r = lim(["stats", dir, "--lang", "en"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Dialogue: 1 line, ");
    expect(r.out).toContain("narration: 1 line, 7 characters");
    expect(r.out).toContain("1 speaker; 1 scene");
    expect(r.out).toContain("Spelling variants: 0 groups");
    const folder = join(dir, "exports/stats");
    for (const f of ["stats.md", "files.csv", "scenes.csv", "speakers.csv", "variants.csv"]) expect(existsSync(join(folder, f)), f).toBe(true);
    expect(existsSync(join(folder, "統計.md"))).toBe(false);
    expect(readFileSync(join(folder, "speakers.csv"), "utf8").startsWith("\uFEFFSpeaker,Dialogue lines")).toBe(true);
    expect(readFileSync(join(folder, "stats.md"), "utf8")).toContain("## By file");

    // lim check --lang en の数も、1 なら単数
    const c = lim(["check", dir, "--lang", "en"]);
    expect(c.code, c.err).toBe(0);
    expect(c.out).toContain("1 file, 0 errors, 0 warnings");
    // lim trace --lang en
    const t = lim(["trace", dir, "start", "--lang", "en"]);
    expect(t.code, t.err).toBe(0);
    expect(t.out).toContain('Akari: "Hi."');
    expect(t.out).toMatch(/\nEnd: end /);
  });
});
