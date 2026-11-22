import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { applyFix, CORE_COMMANDS, createRegistry, missingAssets, parse, type Diagnostic } from "@liminalia/lang";
import { applyFixesToText } from "../src/apply-fixes.ts";
import { runCheck } from "../src/commands/check.ts";
import { replaceFixCodes } from "../../lang/test/source-strings.ts";

/**
 * 行の一部を置き換える直し方（replace）が、診断の指す所にだけ当たることを、直し方を付ける診断の code を全部回して確かめる（2026-11-19 の L1）。
 * - 同じ行に同じ字面を二つ置き、桁のある診断の直しが、その診断の指す一つ目か二つ目にだけ当たる（地の文、台詞、字下げ、選択肢の中の {@…}）
 * - 桁の無い診断は、同じ行の同じ字面のどれに当てても同じになるもの（二つの診断が同じ）だけにする
 * - lim check --fix と同じ当て方（applyFixesToText）で当てたあと、検査し直して新しいエラーが出ない（L4、L7）
 * 直し方を付ける code は、ソースの `kind: "replace"` から集める（新しく足して見本を書き忘れると落ちる）。
 */

const REPO = resolve(import.meta.dirname, "../../..");
const TEMPLATE = join(REPO, "templates/default");
const work = mkdtempSync(join(tmpdir(), "liminalia-fix-targets-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** 見本。twice は同じ字面（snippet）を一行に二つ並べられるもの。place は並べる行の形（地の文、台詞、字下げ、選択肢）。 */
type Sample = { code: string; snippet: string; places?: readonly Place[] } | { code: string; line: string };
type Place = "prose" | "speech" | "indented" | "option";
const COMMAND: readonly Place[] = ["prose", "speech", "indented", "option"];
const TEXT: readonly Place[] = ["prose"];

/** 書式の版 4 の作品で見るもの。 */
const SAMPLES: readonly Sample[] = [
  { code: "renamed-param", snippet: "{@chara-hide アカリ fade=1s}", places: COMMAND },
  { code: "renamed-param", snippet: "{@chara-hide アカリ fade=( 1000 )}", places: TEXT },
  { code: "too-many-positional", snippet: "{@chara-hide アカリ 1s}", places: COMMAND },
  { code: "positional-by-name", snippet: "{@chara-hide who=アカリ}", places: COMMAND },
  { code: "bad-value", snippet: "{@chara-hide アカリ time=300}", places: COMMAND },
  // 名前なしの時間と前の名前（L7）。文の名前も書いたまま
  { code: "bad-value", snippet: "{@chara-hide-all 300}", places: COMMAND },
  { code: "bad-value", snippet: "{@chara-hide アカリ fade=300}", places: TEXT },
  { code: "same-as-default", snippet: "{@chara-hide アカリ time=1s}", places: COMMAND },
  // 直したあとの @bg が無い素材を指さないよう、ひな形にある背景にする（本文の中の命令の素材も検査する）
  { code: "unknown-command", snippet: "{@bgg hill_dusk.webp}", places: COMMAND },
  { code: "renamed-command", snippet: "{@hide アカリ}", places: COMMAND },
  { code: "unknown-param", snippet: "{@chara-hide アカリ tmie=1s}", places: COMMAND },
  { code: "unknown-variant", snippet: "{@chara アカリ smlie}", places: COMMAND },
  { code: "unknown-position", snippet: "{@chara アカリ normal at=lfet}", places: COMMAND },
  { code: "unknown-appearance", snippet: "{@chara アカリ normal appearance=defualt}", places: COMMAND },
  { code: "hide-name-unknown", snippet: "{@cutin-hide bannr}", places: TEXT },
  { code: "fullwidth-symbol", snippet: "{@chara-hide アカリ time＝2s}", places: COMMAND },
  { code: "bad-ruby", snippet: "{r 漢字｜かんじ}", places: TEXT },
  { code: "asset-case-mismatch", snippet: "{img Mark.png}", places: TEXT },
  { code: "unknown-function", snippet: '{= lenn("ab")}', places: TEXT },
  { code: "unset-variable", snippet: "{= game.scroe}", places: TEXT },
  { code: "doubled-punctuation", snippet: "あ。。", places: TEXT },
  { code: "space-after-exclamation", snippet: "あ！あ", places: TEXT },
  { code: "single-ellipsis", snippet: "あ…あ", places: TEXT },
  { code: "aozora-ruby", snippet: "、漢字《かんじ》", places: TEXT },
  { code: "tyrano-tag", snippet: "[p]", places: TEXT },
  // 一行に一つしか書けないもの
  { code: "fullwidth-symbol", line: "＠bg hill_dusk.webp" },
  // @define の中に後ろの行（# end など）が入らないよう、すぐ @end で閉じる
  { code: "unknown-type", line: "@define m(x: strin)\n@end" },
  { code: "unknown-label", line: "@jump #ende" },
  { code: "unknown-label", line: "@jump memo#b" },
  { code: "unknown-file", line: "@jump memoo#a" },
  { code: "asset-case-mismatch", line: "@bg Hill_Dusk.webp" },
  { code: "trailing-comment", line: "　地の文です // メモ" },
  { code: "trailing-comment", line: "@bg hill_dusk.webp // メモ" },
  { code: "bad-guard", line: "@set game.score = 1 if=game.score" },
  { code: "bad-guard", line: "@bg hill_dusk.webp if=game.score" },
  { code: "unknown-speaker", line: "アカリ：「こんにちは」" },
  { code: "unknown-ending-kind", line: "@title-screen ending=bda" },
  { code: "unknown-ending-kind", line: '@title-screen ending="BAD END"' },
];

/** 書式の版 2 の作品で見るもの（前の書き方の知らせ）。 */
const LEGACY: readonly Sample[] = [{ code: "legacy-ending", line: '@title-screen ending="BAD END"' }];

/** 直し方を付けるが、台本の行には当てないもの。 */
const NOT_SCRIPT: Record<string, string> = {
  "unknown-config-key": "liminalia.json と cast.json の行に当てる（台本の行ではない）",
  // lim check は素材の一覧を持たないので修正案を出さない。制作画面と VS Code の分は下の「無い素材」で見る
  "missing-asset": "下の「無い素材の近い名前」で確かめる",
  // 作品の入口（はじめから）の流れの音を見るので、作品の先頭のファイルで別に見る
  "redundant-stop": "下の「音の止め忘れ」で確かめる",
  "undeclared-variable": "check.variables が declared の作品で、下の「宣言していない変数」で確かめる",
};

/** 見本の行（並べる形ごと）。at は二つの字面の頭の位置。 */
function sampleLines(s: Sample): { place: Place | "once"; text: string; at: number[] }[] {
  if ("line" in s) return [{ place: "once", text: s.line, at: [] }];
  return (s.places ?? COMMAND).map((place) => {
    const head = place === "prose" ? "地の文" : place === "speech" ? "アカリ「声" : place === "indented" ? "  地の文" : "- 行く";
    const tail = place === "speech" ? "です」" : place === "option" ? " -> #end" : "です。";
    const text = `${head}${s.snippet}と${s.snippet}${tail}`;
    const first = text.indexOf(s.snippet);
    return { place, text, at: [first, text.indexOf(s.snippet, first + 1)] };
  });
}

/** 作品を作り、見本の行を一つのファイルに並べる。行番号 → 見本と行。 */
function makeProject(name: string, samples: readonly Sample[], format: number): { dir: string; rows: Map<number, { sample: Sample; text: string; place: Place | "once"; at: number[] }> } {
  const dir = join(work, name);
  cpSync(TEMPLATE, dir, { recursive: true });
  const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
  config.format = format;
  config.commandDefaults = { ...(config.commandDefaults as object), "chara-hide": { time: "1s" } };
  writeFileSync(join(dir, "liminalia.json"), JSON.stringify(config, null, 2));
  mkdirSync(join(dir, "assets", "image"), { recursive: true });
  writeFileSync(join(dir, "assets", "image", "mark.png"), readFileSync(join(dir, "icon.png")));
  const out = ["# fx", "@set game.score = 0", "@cutin x name=banner stay=true"];
  // 見本の行に改行が入っていても行番号がずれないよう、書き込んだ分の行数を数える
  const lineNo = () => out.reduce((n, s) => n + s.split("\n").length - 1, out.length) + 1;
  const rows = new Map<number, { sample: Sample; text: string; place: Place | "once"; at: number[] }>();
  for (const sample of samples) {
    for (const row of sampleLines(sample)) {
      if (row.place === "option") {
        out.push("@choice");
        rows.set(lineNo(), { sample, ...row });
        out.push(row.text, "- 戻る -> #end", "@end");
      } else {
        rows.set(lineNo(), { sample, ...row });
        out.push(row.text);
      }
    }
  }
  out.push("# end", "　おわり。", "");
  writeFileSync(join(dir, "scenario", "fx.lim"), out.join("\n"));
  writeFileSync(join(dir, "scenario", "memo.lim"), "# a\n　メモ。\n");
  return { dir, rows };
}

async function diagnosticsOf(dir: string, file = "fx"): Promise<Diagnostic[]> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await runCheck(dir, true);
    return (JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { diagnostics: Diagnostic[] }).diagnostics.filter((d) => d.file === file);
  } finally {
    log.mockRestore();
  }
}

/** 見本ごとに、直しが指す所にだけ当たり、当てたあとに新しいエラーが出ないことを確かめる。 */
async function verify(name: string, samples: readonly Sample[], format: number): Promise<Set<string>> {
  const { dir, rows } = makeProject(name, samples, format);
  const before = await diagnosticsOf(dir);
  const seen = new Set<string>();
  for (const [line, row] of rows) {
    const code = row.sample.code;
    const where = `${code} ${row.place}: ${row.text}`;
    const ds = before.filter((d) => d.line === line && d.code === code && d.fix?.kind === "replace");
    expect(ds.length, where).toBeGreaterThan(0);
    seen.add(code);
    if (row.place === "once") {
      for (const d of ds) expect(applyFix(row.text, d.fix!, d.column), where).not.toBeNull();
      continue;
    }
    if (ds.every((d) => d.column === undefined)) {
      // 桁の無い直し方は、どれに当てても同じになるものだけ（二つの診断を見分けられない）
      for (const d of ds) expect(d, where).toEqual(ds[0]);
      continue;
    }
    // 桁のある直し方: 一つ目の診断は一つ目の字面に、二つ目は二つ目に当たる
    const sorted = [...ds].sort((a, b) => a.column! - b.column!);
    expect(sorted.length, where).toBe(2);
    const length = "snippet" in row.sample ? row.sample.snippet.length : 0;
    sorted.forEach((d, k) => {
      const r = applyFix(row.text, d.fix!, d.column);
      expect(r, where).not.toBeNull();
      if (!r || r.remove) return;
      expect(r.at >= row.at[k]! && r.at < row.at[k]! + length, `${where} の ${k + 1} つ目（${r.text}）`).toBe(true);
    });
  }
  // lim check --fix と同じ当て方で code ごとに当て、検査し直す。前に無かったエラーが出ない
  const errors = (list: readonly Diagnostic[]) => new Set(list.filter((d) => d.severity === "error").map((d) => `${d.line} ${d.code}`));
  const was = errors(before);
  const text = readFileSync(join(dir, "scenario", "fx.lim"), "utf8");
  for (const code of new Set([...rows.values()].map((r) => r.sample.code))) {
    const fixed = applyFixesToText(text, before.filter((d) => d.code === code));
    expect(fixed.applied.length, code).toBeGreaterThan(0);
    writeFileSync(join(dir, "scenario", "fx.lim"), fixed.text);
    const now = [...errors(await diagnosticsOf(dir))].filter((e) => !was.has(e));
    expect(now, `${code} を当てたあとの新しいエラー`).toEqual([]);
  }
  writeFileSync(join(dir, "scenario", "fx.lim"), text);
  return seen;
}

describe("直し方の当たる所（L1）", () => {
  it("直し方を付ける code の全部に見本がある（ソースの kind: \"replace\" から集める）", () => {
    const root = join(REPO, "packages");
    const files = ["lang", "std", "project", "sdk"].flatMap((p) =>
      readdirSync(join(root, p, "src"), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => `${p}/src/${f}`),
    );
    const codes = [...replaceFixCodes(root, files).keys()];
    expect(codes.length).toBeGreaterThan(30);
    const covered = new Set([...SAMPLES, ...LEGACY].map((s) => s.code));
    expect(codes.filter((c) => !covered.has(c) && !(c in NOT_SCRIPT)).sort()).toEqual([]);
  });

  it("同じ行の同じ字面のうち、診断の指す所にだけ当たり、当てたあとに新しいエラーが出ない", async () => {
    const seen = await verify("now", SAMPLES, 4);
    const legacy = await verify("legacy", LEGACY, 2);
    expect([...new Set([...SAMPLES, ...LEGACY].map((s) => s.code))].filter((c) => !seen.has(c) && !legacy.has(c))).toEqual([]);
  }, 120_000);

  it("無い素材の近い名前（制作画面と VS Code が素材の一覧を渡す）も、指す所にだけ当たる", () => {
    const registry = createRegistry(CORE_COMMANDS);
    const line = "地の文{img mak.png}と{img mak.png}です。";
    const script = parse(line, "a");
    const ds = missingAssets({ scripts: new Map([["a", script]]), registry, cast: {}, castFile: "cast.json", exists: () => false, files: () => ["mark.png"] }).filter((d) => d.code === "missing-asset");
    expect(ds.map((d) => d.column)).toEqual([9, 23]);
    expect(ds.map((d) => {
      const r = applyFix(line, d.fix!, d.column);
      return r && !r.remove ? r.at : null;
    })).toEqual([8, 22]);
  });

  it("中身を持つ命令（@staff-roll の {img}、@html の <img src>）の中の素材の名前にも当たる", async () => {
    const dir = join(work, "blocks");
    cpSync(TEMPLATE, dir, { recursive: true });
    mkdirSync(join(dir, "assets", "image"), { recursive: true });
    writeFileSync(join(dir, "assets", "image", "mark.png"), readFileSync(join(dir, "icon.png")));
    // 引用の中で値の前に空白があっても当たる（2026-11-19 の rest-q）
    const lines = ["# x", "@staff-roll", "  {img Mark.png}", "  作 ゆい", "@end", "@html", '  <p><img src="Mark.png"></p>', '  <p><img src=" Mark.png"></p>', "@end", "　おわり。", ""];
    writeFileSync(join(dir, "scenario", "fx.lim"), lines.join("\n"));
    const ds = (await diagnosticsOf(dir)).filter((d) => d.code === "asset-case-mismatch");
    expect(ds.map((d) => d.line)).toEqual([3, 7, 8]);
    for (const d of ds) {
      const r = applyFix(lines[d.line - 1]!, d.fix!, d.column);
      expect(r && !r.remove ? r.text : null, `${d.line} 行目`).toBe(lines[d.line - 1]!.replace("Mark.png", "mark.png"));
    }
  }, 60_000);

  it("音の止め忘れ（redundant-stop）と宣言していない変数（undeclared-variable）も、当てたあとの行が通る", async () => {
    const dir = join(work, "start-file");
    cpSync(TEMPLATE, dir, { recursive: true });
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, format: 4, variables: { "game.trust": 0 }, check: { variables: "declared" } }, null, 2));
    rmSync(join(dir, "scenario"), { recursive: true });
    mkdirSync(join(dir, "scenario"));
    const text = ["@scene-change hill_dusk.webp stop-bgm=true", "@set game.trust = 1", "@set game.trsut += 1", "　本文。", ""].join("\n");
    writeFileSync(join(dir, "scenario", "start.lim"), text);
    const before = await diagnosticsOf(dir, "start");
    for (const code of ["redundant-stop", "undeclared-variable"]) {
      const d = before.find((x) => x.code === code);
      expect(d?.fix?.kind, code).toBe("replace");
      const fixed = applyFixesToText(text, [d!]);
      expect(fixed.applied.length, code).toBe(1);
      writeFileSync(join(dir, "scenario", "start.lim"), fixed.text);
      expect((await diagnosticsOf(dir, "start")).filter((x) => x.severity === "error"), code).toEqual([]);
      writeFileSync(join(dir, "scenario", "start.lim"), text);
    }
  }, 60_000);

  it("lim check --fix は、同じ行のほかの命令の同じ字面を書き換えない（報告の三つの行）", async () => {
    const dir = join(work, "check-fix");
    cpSync(TEMPLATE, dir, { recursive: true });
    const config = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "liminalia.json"), JSON.stringify({ ...config, format: 4, commandDefaults: { bg: { time: "1s" } } }, null, 2));
    const lines = ["# x", "地の文{@flash fade=200ms}と{@bg hill_night.webp fade=200ms}です。", "地の文{@flash time=1s}と{@bg hill_night.webp time=1s}です。", "地の文{@wait 1s}です{@bg hill_night.webp 1s}。", ""];
    writeFileSync(join(dir, "scenario", "fx.lim"), lines.join("\n"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runCheck(dir, false, "ja", { fix: ["renamed-param", "same-as-default", "too-many-positional"] });
    } finally {
      log.mockRestore();
    }
    expect(readFileSync(join(dir, "scenario", "fx.lim"), "utf8").split("\n")).toEqual([
      "# x",
      "地の文{@flash fade=200ms}と{@bg hill_night.webp time=200ms}です。",
      "地の文{@flash time=1s}と{@bg hill_night.webp}です。",
      "地の文{@wait 1s}です{@bg hill_night.webp}。",
      "",
    ]);
  }, 60_000);
});
