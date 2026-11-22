import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHOICE_OPTION, CORE_COMMANDS, type CommandSpec, type Diagnostic } from "@liminalia/lang";
import { combinePlugins } from "@liminalia/plugin-host";
import std from "@liminalia/std/commands";
import { runCheck } from "../src/commands/check.ts";

/**
 * コマンドの英語の例（exampleEn）が lim check を通るか。
 * 見本は templates/default を写し、cast.json の人物の ID を英語（アカリ → Akari、ソウ → Sou）にしたもの。
 * サイトの英語版のリファレンスは、同じ英語の ID の例を見本の作品の ID（アカリ、ソウ）に置き換えて再生する。
 * 英語の例の素材の名前は templates/default にあるものだけを使う（ボイスの連番の pattern は見本に無いが、lim check は見ない）。
 * 例は一つずつ、コマンドの名前のラベルの下に置く。例の前には背景と Akari の立ち絵、@kanim が使う動き（sway）を置く。
 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
/** ひな形の人物の ID → 英語の ID。 */
const RENAME: Readonly<Record<string, string>> = { アカリ: "Akari", ソウ: "Sou" };
const STAGE = ["@bg hill_dusk.webp", "@chara Akari normal at=center", '@keyframe sway frames="0% rotate=0; 50% rotate=8 x=12; 100% rotate=0"'];

const { specs: stdSpecs } = combinePlugins([std]);
const withExample = [...CORE_COMMANDS, CHOICE_OPTION, ...stdSpecs].filter((c): c is CommandSpec & { exampleEn: string } => c.exampleEn !== undefined);

let dir: string;
let diagnostics: Diagnostic[] = [];
/** 例ごとの ref.lim の行の範囲。 */
const ranges = new Map<string, [number, number]>();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-example-en-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  const cast = JSON.parse(readFileSync(join(dir, "cast.json"), "utf8")) as { speakers: string[]; cast: Record<string, unknown> };
  cast.cast = Object.fromEntries(Object.entries(cast.cast).map(([who, entry]) => [RENAME[who] ?? who, entry]));
  cast.speakers = cast.speakers.map((who) => RENAME[who] ?? who);
  expect(Object.keys(cast.cast)).toEqual(["Akari", "Sou"]);
  writeFileSync(join(dir, "cast.json"), JSON.stringify(cast, null, 2));
  // ひな形の物語は日本語の ID で書いてあるので、入口だけの短いものに替える
  rmSync(join(dir, "scenario"), { recursive: true });
  mkdirSync(join(dir, "scenario"));
  writeFileSync(join(dir, "scenario/start.lim"), "@bg hill_dusk.webp\n@stop\n");

  const out = ["@stop"];
  for (const c of withExample) {
    const example = c === CHOICE_OPTION ? ["@choice", c.exampleEn, "- Go back -> #market", "@end"] : c.exampleEn.split("\n");
    const start = out.length + 1;
    out.push("", `# ex_${c.name}`, ...STAGE, ...example, "@stop");
    ranges.set(c.name, [start, out.length]);
  }
  // @choice の選択肢の行の #door と、@html の data-jump="#market" の行き先
  out.push("", "# door", "@stop", "", "# market", "@stop", "");
  writeFileSync(join(dir, "scenario/ref.lim"), out.join("\n"));
  // @dialog の target=title の行き先
  writeFileSync(join(dir, "scenario/title.lim"), "@bg hill_morning.webp\n@stop\n");

  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await runCheck(dir, true);
    diagnostics = (JSON.parse(String(log.mock.calls[0]![0])) as { diagnostics: Diagnostic[] }).diagnostics;
  } finally {
    log.mockRestore();
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("コマンドの英語の例", () => {
  it("例に日本語がある組み込みと標準のコマンドに英語の例がある（数は englishGaps でも見る）", () => {
    expect(withExample.map((c) => c.name)).toEqual(expect.arrayContaining(["chara", "face", "choice", "chara-move", "html", "staff-roll", "notify"]));
    expect(withExample.length).toBeGreaterThanOrEqual(27);
  });

  it("英語の例は、人物の ID を英語にしたひな形で lim check のエラーも警告も出さない（ひな形に無い素材も指さない）", () => {
    const problems = diagnostics
      // 消すコマンドの例（@cutin-hide key）は例の外で出した名前を指す。例は一つずつ置くので、出す例との突き合わせは見ない
      .filter((d) => d.severity !== "info" && d.code !== "hide-name-unknown")
      .map((d) => {
        const hit = d.file === "ref" ? [...ranges].find(([, [a, b]]) => d.line >= a && d.line <= b)?.[0] : undefined;
        return `${hit ? `@${hit}` : `${d.file}:${d.line}`} ${d.code}: ${d.message}`;
      });
    expect(problems).toEqual([]);
  });
});
