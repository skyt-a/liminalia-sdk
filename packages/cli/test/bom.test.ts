import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { BOM, formatLim, isDraftSource, parse, setDraftSource, type Diagnostic } from "@liminalia/lang";
import { runCheck } from "../src/commands/check.ts";
import { traceProject } from "../src/commands/trace.ts";

/**
 * 頭に BOM のある台本（Windows のメモ帳などが UTF-8 で保存すると付く）を、BOM の無い台本と同じに読むことを確かめる（2026-11-19 の L2、L5）。
 * 遊ぶ側（ブラウザの fetch の text()）は BOM を外して読むので、検査、下書きの見分け（lim build が書き出しから外すもの）、lim trace、整形も外して読む。
 * 1 行目の桁は、元の字面（BOM を数える）の桁のままにする（修正案を元の行に当てる）。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
const work = mkdtempSync(join(tmpdir(), "liminalia-bom-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** 構文木から桁を外したもの（1 行目の桁だけ BOM の分ずれる）。 */
const shape = (source: string) => JSON.parse(JSON.stringify(parse(source, "a", { speakers: ["アカリ"] }), (k, v: unknown) => (k === "column" ? undefined : v)));

async function checked(dir: string): Promise<string[]> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await runCheck(dir, true);
    const ds = (JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { diagnostics: Diagnostic[] }).diagnostics;
    return ds.map((d) => `${d.file}:${d.line} ${d.severity} ${d.code}`).sort();
  } finally {
    log.mockRestore();
  }
}

/** 作品を作る（bom なら台本のすべてに BOM を付ける）。 */
function project(name: string, files: Record<string, string>, bom: boolean, config: Record<string, unknown> = {}): string {
  const dir = join(work, `${name}-${bom ? "bom" : "plain"}`);
  cpSync(TEMPLATE, dir, { recursive: true });
  rmSync(join(dir, "scenario"), { recursive: true });
  mkdirSync(join(dir, "scenario"));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, "scenario", `${file}.lim`), (bom ? BOM : "") + text);
  const base = JSON.parse(readFileSync(join(TEMPLATE, "liminalia.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...base, format: 4, ...config }, null, 2));
  return dir;
}

describe("頭に BOM のある台本", () => {
  it("parse: 1 行目の命令、ラベル、下書きの印を BOM の無いときと同じに読み、BOM を見えない文字として知らせない", () => {
    for (const text of ["// lim: draft\n# memo\n　メモ。\n", "@bgg hill_dusk.webp\n# a\n", "# intro\nアカリ「やあ」\n", "@bg hill_dusk.webp fade=1s\n"]) {
      expect(shape(BOM + text), text).toEqual(shape(text));
      expect(isDraftSource(BOM + text), text).toBe(parse(BOM + text, "a").draft === true);
      expect(isDraftSource(BOM + text), text).toBe(isDraftSource(text));
    }
    // 1 行目の桁は元の字面の桁（BOM を数える）
    const [d] = parse(`${BOM}@bg x if=game.a`, "a").diagnostics;
    expect(d).toMatchObject({ code: "bad-guard", column: 8 });
    // 行の途中の BOM は今までどおり知らせる
    expect(parse(`あ${BOM}い`, "a").diagnostics.map((x) => x.code)).toEqual(["invisible-space"]);
  });

  it("lim check: 下書きへのジャンプ、下書きの入口、1 行目のラベル、1 行目の命令の書き損じが BOM の無いときと同じに出る", async () => {
    const files = {
      start: "# start\n@bg hill_dusk.webp\n　はじまり。\n@jump memo\n@jump chapter#intro\n",
      memo: "// lim: draft\n# memo\n　メモ。\n",
      chapter: "# intro\n@bgg hill_dusk.webp\n@bg hill_dusk.webp fade=1s\n　続き。\n",
    };
    const plain = await checked(project("check", files, false));
    expect(plain).toEqual(expect.arrayContaining(["start:4 warning draft-target", "chapter:2 error unknown-command", "chapter:3 warning renamed-param"]));
    expect(await checked(project("check", files, true))).toEqual(plain);
    // 1 行目に置いたもの
    const first = { start: "# start\n　はじまり。\n@jump chapter#intro\n", chapter: "@bgg hill_dusk.webp\n# intro\n　続き。\n" };
    const firstPlain = await checked(project("first", first, false));
    expect(firstPlain).toContain("chapter:1 error unknown-command");
    expect(await checked(project("first", first, true))).toEqual(firstPlain);
    // 下書きを「はじめから」にした
    const entry = await checked(project("entry", files, false, { entry: "memo" }));
    expect(entry.some((d) => /^liminalia\.json:\d+ error draft-entry$/.test(d))).toBe(true);
    expect(await checked(project("entry", files, true, { entry: "memo" }))).toEqual(entry);
  }, 60_000);

  it("lim trace: 1 行目の命令とラベルを BOM の無いときと同じに流す", async () => {
    const files = { start: "@bg hill_dusk.webp\n# start\n　一つめ。\n@jump chapter#intro\n", chapter: "# intro\n　二つめ。\n" };
    const run = async (bom: boolean) => (await traceProject(project("trace", files, bom), "start")).trace.map((t) => JSON.stringify(t));
    const plain = await run(false);
    expect(plain.some((t) => t.includes('"name":"bg"'))).toBe(true);
    expect(await run(true)).toEqual(plain);
  }, 60_000);

  it("lim check --fix は 1 行目にも当て、BOM を残す。整形と下書きの印も BOM を頭に残す", async () => {
    const dir = project("fix", { start: "@bg hill_dusk.webp fade=1s\n# start\n　はじまり。\n" }, true);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runCheck(dir, false, "ja", { fix: ["renamed-param"] });
    } finally {
      log.mockRestore();
    }
    expect(readFileSync(join(dir, "scenario", "start.lim"), "utf8")).toBe(`${BOM}@bg hill_dusk.webp time=1s\n# start\n　はじまり。\n`);
    const formatted = formatLim(`${BOM}@bg   hill_dusk.webp   time=1s\n`, "a");
    expect(formatted).toMatchObject({ ok: true, text: `${BOM}@bg hill_dusk.webp time=1s\n` });
    expect(setDraftSource(`${BOM}# a\n`, true)).toBe(`${BOM}// lim: draft\n# a\n`);
    expect(setDraftSource(`${BOM}// lim: draft\n# a\n`, false)).toBe(`${BOM}# a\n`);
  }, 60_000);
});
