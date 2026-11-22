import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadContext } from "../src/context.ts";
import { findEndingReach, findReach, reachHints, reachPlace, reachTestText, readProjectScripts, runReach } from "../src/commands/reach.ts";
import { runTest } from "../src/commands/test.ts";
import { runNew } from "../src/commands/new.ts";
import { engineVersion } from "../src/version.ts";
import { parseSets, traceProject } from "../src/commands/trace.ts";

/** lim test、lim trace の --set と --from-state、lim reach（ひな形の物語で確かめる）。 */

const TEMPLATE = resolve(import.meta.dirname, "../../../templates/default");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-test-"));
  cpSync(TEMPLATE, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function quiet<T>(run: () => Promise<T>): Promise<{ value: T; out: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const value = await run();
    return { value, out: log.mock.calls.map((c) => String(c[0])).join("\n") };
  } finally {
    log.mockRestore();
  }
}

describe("lim test", () => {
  it("ひな形のテストはすべて通る", async () => {
    const r = await quiet(() => runTest(dir));
    expect(r.value).toBe(true);
    expect(r.out).toContain("3 件中 3 件が通りました");
  }, 60_000);

  it("期待と違えば、行と値を出して失敗にする（GitHub の注釈と英語も）", async () => {
    writeFileSync(
      join(dir, "tests", "fail.limtest"),
      [
        "# 違う",
        "choose 望遠鏡をのぞく",
        "choose 外で空を見上げる",
        "choose 黙って見ている",
        "expect game.wished == true",
        "expect not reach epilogue#dawn",
        'expect text "そんな文は無い"',
        "expect ending secret",
        "",
        "# 無い選択肢と使わなかった choose",
        "choose 宇宙へ行く",
        "choose 外で空を見上げる",
        "",
        "# 読めない行",
        "pick 1",
      ].join("\n"),
    );
    const json = await quiet(() => runTest(dir, { json: true, paths: [join(dir, "tests", "fail.limtest")] }));
    expect(json.value).toBe(false);
    const report = JSON.parse(json.out) as { files: { problems: { line: number }[]; tests: { name: string; ok: boolean; failures: { line: number; message: string }[] }[] }[] };
    const [f] = report.files;
    expect(f!.problems.map((p) => p.line)).toEqual([15]);
    const [wrong, missing] = f!.tests;
    expect(wrong!.failures.map((x) => [x.line, x.message])).toEqual([
      [5, "expect game.wished == true が偽です（game.wished = false）"],
      [6, "epilogue#dawn を通りました"],
      [7, "「そんな文は無い」はどのページにも出ませんでした"],
      [8, "エンディング secret で終わりませんでした"],
    ]);
    expect(missing!.failures.map((x) => x.line)).toEqual([11, 12]);
    expect(missing!.failures[0]!.message).toContain("宇宙へ行く");
    expect(missing!.failures[0]!.message).toContain("望遠鏡をのぞく / ラジオをつける / 外で空を見上げる");
    // 英語でも、並んでいた選択肢を出す
    const en = await quiet(() => runTest(dir, { json: true, language: "en", paths: [join(dir, "tests", "fail.limtest")] }));
    const enReport = JSON.parse(en.out) as typeof report;
    expect(enReport.files[0]!.tests[1]!.failures[0]!.message).toBe("The option to choose isn't there: 宇宙へ行く (望遠鏡をのぞく / ラジオをつける / 外で空を見上げる)");
    // GitHub の注釈はテストのファイルの行に付く
    const github = await quiet(() => runTest(dir, { github: true, language: "en", paths: [join(dir, "tests", "fail.limtest")] }));
    expect(github.out).toMatch(/::error file=[^,]*tests\/fail\.limtest,line=5,title=lim test::違う: expect game\.wished == true is false \(game\.wished = false\)/);
    expect(github.out).toContain("FAIL  違う");
  }, 60_000);

  it("読めない行のあるテストは通過にせず、ファイルを省いた reach #ラベル には entry か from のファイルを付けた書き方を出す", async () => {
    writeFileSync(
      join(dir, "tests", "label.limtest"),
      ["# ファイルを省いた", "choose 外で空を見上げる", "expect reach #dawn", "", "# from のファイル", "from epilogue", "expect not reach #dawn", "", "# 読める", "choose 外で空を見上げる"].join("\n"),
    );
    const r = await quiet(() => runTest(dir, { json: true, paths: [join(dir, "tests", "label.limtest")] }));
    expect(r.value).toBe(false);
    const report = JSON.parse(r.out) as { files: { problems: { line: number; message: string; hint?: string }[]; tests: { name: string; ok: boolean; failures: { line: number; message: string }[] }[] }[] };
    const [f] = report.files;
    expect(f!.problems.map((p) => [p.line, p.hint])).toEqual([
      [3, "expect reach start#dawn"],
      [7, "expect not reach epilogue#dawn"],
    ]);
    expect(f!.problems[0]!.message).toContain("ラベルのあるファイルの名前");
    expect(f!.tests.map((t) => [t.name, t.ok])).toEqual([
      ["ファイルを省いた", false],
      ["from のファイル", false],
      ["読める", true],
    ]);
    expect(f!.tests[0]!.failures[0]).toEqual({ line: 3, message: "読めない行があるため、このテストを確かめられません" });
  }, 60_000);

  it("実行時のエラーは expect no-errors を書かなくても失敗にし、--set に当たる set と from で始められる", async () => {
    const start = join(dir, "scenario", "start.lim");
    writeFileSync(start, `${readFileSync(start, "utf8")}\n# broken\n@set game.n = game.trust / 0\n`);
    writeFileSync(join(dir, "tests", "start.limtest"), ["# 壊れた場面", "from start#broken", "set game.trust = 2", "expect game.trust == 2"].join("\n"));
    const r = await quiet(() => runTest(dir, { json: true }));
    const report = JSON.parse(r.out) as { files: { tests: { failures: { message: string }[] }[] }[] };
    expect(report.files[0]!.tests[0]!.failures.map((x) => x.message)).toEqual([expect.stringMatching(/^実行時のエラー（start:\d+）: 0 で割る/)]);
  }, 60_000);

  it("テストが無ければ、その旨を出して通す", async () => {
    rmSync(join(dir, "tests"), { recursive: true, force: true });
    const r = await quiet(() => runTest(dir));
    expect(r.value).toBe(true);
    expect(r.out).toContain("テストがありません");
  });

  it("渡したパスは今のフォルダに無ければプロジェクトのフォルダから探し、どちらにも無ければ止め、.limtest が無ければ失敗にする", async () => {
    // 作品の外（今のフォルダが別の場所）から、作品の中のパスで渡す（docs/ci.md の書き方）
    const outside = await quiet(() => runTest(dir, { paths: ["tests/start.limtest"] }));
    expect(outside.value).toBe(true);
    expect(outside.out).toContain("3 件中 3 件が通りました");
    expect((await quiet(() => runTest(dir, { paths: ["tests"] }))).value).toBe(true);
    // 今のフォルダから（絶対パスも）
    expect((await quiet(() => runTest(dir, { paths: [join(dir, "tests", "start.limtest")] }))).value).toBe(true);
    // どちらにも無い（lim は終了の値 2）
    await expect(runTest(dir, { paths: ["tests/nothing.limtest"] })).rejects.toThrow("テストのファイルかフォルダが見つかりません: tests/nothing.limtest");
    await expect(runTest(dir, { paths: ["nothing.limtest"], language: "en" })).rejects.toThrow("Test file or folder not found: nothing.limtest");
    // .limtest の無いフォルダとファイル（終了の値 1）
    const none = await quiet(() => runTest(dir, { paths: ["scenario"] }));
    expect(none.value).toBe(false);
    expect(none.out).toContain(".limtest のファイルがありません: scenario");
    expect((await quiet(() => runTest(dir, { paths: ["liminalia.json"], json: true }))).value).toBe(false);
  }, 60_000);
});

describe("lim trace の --set と --from-state", () => {
  it("--set は始める前に入れ、--json の save から続けられる", async () => {
    const sets = parseSets(['game.looked=true', 'game.name="アカリ"', "system.cleared=1"]);
    expect(sets.map((s) => s.value)).toEqual([true, "アカリ", 1]);
    expect(() => parseSets(["looked=true"])).toThrow(/変数=式/);
    const first = await traceProject(dir, "start#ending", { sets: [...sets, { path: "game.wished", value: true }], maxPages: 2 });
    expect(first.trace.some((t) => t.type === "page" && t.text.includes("レンズのふた"))).toBe(true);
    expect(first.runtime.system.cleared).toBe(1);
    const state = join(dir, "state.json");
    writeFileSync(state, JSON.stringify({ save: first.runtime.save() }));
    const next = await traceProject(dir, "", { fromState: state, maxPages: 3 });
    expect(next.trace.find((t) => t.type === "page")).toBeDefined();
    expect(next.runtime.state.game).toMatchObject({ looked: true, wished: true, name: "アカリ" });
  }, 60_000);
});

describe("lim reach", () => {
  it("届く選び方と、届いた時点の条件の変数、テストの書き方を出す", async () => {
    const ctx = await loadContext(dir);
    const p = readProjectScripts(ctx);
    const r = (await findReach(ctx, p, "start:141", 30_000))!;
    expect(r.found).toBe(true);
    expect(r.choices.map((c) => c.text)).toEqual(expect.arrayContaining(["望遠鏡をのぞく", "願いごとを言ってみる"]));
    expect(r.variables.map((v) => [v.path, v.value])).toEqual([
      ["game.looked", true],
      ["game.wished", true],
    ]);
    expect(r.hints.conditions).toEqual([{ text: "game.wished && game.looked", file: "start", line: 140 }]);
    // テストの書き方はそのまま通る
    writeFileSync(join(dir, "tests", "reach.limtest"), reachTestText(r));
    const t = await quiet(() => runTest(dir, { paths: [join(dir, "tests", "reach.limtest")] }));
    expect(t.value).toBe(true);
    expect(await findReach(ctx, p, "start#nowhere", 1000)).toBeNull();
  }, 90_000);

  it("見つけた選び方から、到達に要らない選択を除いて出す（同じ選択肢へ戻る回り道を残さない）", async () => {
    const ctx = await loadContext(dir);
    const p = readProjectScripts(ctx);
    const r = (await findReach(ctx, p, "start:142", 30_000))!;
    expect(r.found).toBe(true);
    expect(r.choices.map((c) => c.text)).toEqual(["望遠鏡をのぞく", "外で空を見上げる", "願いごとを言ってみる"]);
    expect(r.variables.map((v) => [v.path, v.value])).toEqual([
      ["game.looked", true],
      ["game.wished", true],
    ]);
    // 縮めたテストの書き方もそのまま通る
    writeFileSync(join(dir, "tests", "reach.limtest"), reachTestText(r));
    expect((await quiet(() => runTest(dir, { paths: [join(dir, "tests", "reach.limtest")] }))).value).toBe(true);
  }, 90_000);

  it("範囲の外の行はすぐ止め（終了の値 2）、コメントと空行は次の文の行で探す", async () => {
    const ctx = await loadContext(dir);
    const p = readProjectScripts(ctx);
    expect(reachPlace("start:9999", p)).toEqual({ problem: "outside", file: "start", lines: 161 });
    expect(reachPlace("start:0", p)).toEqual({ problem: "outside", file: "start", lines: 161 });
    expect(reachPlace("start:155", p)).toEqual({ file: "start", line: 156, from: 155 });
    expect(reachPlace("start:12", p)).toEqual({ file: "start", line: 15, from: 12 });
    expect(reachPlace("start:141", p)).toEqual({ file: "start", line: 141 });
    expect(reachPlace("start#nowhere", p)).toEqual({ problem: "missing" });
    writeFileSync(join(dir, "scenario", "tail.lim"), "# tail\n地の文\n\n// おわり\n");
    expect(reachPlace("tail:4", readProjectScripts(await loadContext(dir)))).toEqual({ problem: "after-last", file: "tail", line: 4 });
    // 探さずにすぐ止める
    const started = Date.now();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await quiet(() => runReach(dir, "start:9999", { timeoutSeconds: 30 }))).value).toBe(2);
      expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain("start:9999 は start.lim の行の範囲（1〜161 行）の外です");
      expect((await quiet(() => runReach(dir, "start:9999", { timeoutSeconds: 30, language: "en" }))).value).toBe(2);
      expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain("start:9999 is outside the lines of start.lim (1 to 161)");
    } finally {
      err.mockRestore();
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    // コメントの行は次の文の行（テストの書き方もその行で書く）
    const moved = await quiet(() => runReach(dir, "start:155", { timeoutSeconds: 30 }));
    expect(moved.value).toBe(0);
    expect(moved.out).toContain("start:155 はコメントか空行なので、次の文の行 start:156 で探します");
    expect(moved.out).toContain("expect reach start:156");
    const json = await quiet(() => runReach(dir, "start:12", { json: true, timeoutSeconds: 30 }));
    expect(JSON.parse(json.out)).toMatchObject({ ok: true, target: "start:15", requested: "start:12", line: 15 });
  }, 90_000);

  it("--lang en はテストの書き方の見出しも英語にする", async () => {
    const ctx = await loadContext(dir);
    const r = (await findReach(ctx, readProjectScripts(ctx), "start:141", 30_000))!;
    expect(reachTestText(r, "en").split("\n")[0]).toBe("# Reaches start:141");
    expect(reachTestText(r).split("\n")[0]).toBe("# start:141 へ届く");
    const out = await quiet(() => runReach(dir, "start:141", { language: "en", timeoutSeconds: 30 }));
    expect(out.out).toContain("  # Reaches start:141");
    expect(out.out).not.toContain("へ届く");
  }, 90_000);

  /** 願わなければ BAD、夜明けは TRUE で終わる形にする（ひな形の物語はエンディングを書いていない）。 */
  function withEndings() {
    const start = join(dir, "scenario", "start.lim");
    writeFileSync(start, readFileSync(start, "utf8").replace("@stop-bgm time=2s\n@jump epilogue", '@stop-bgm time=2s\n@if !game.wished\n@title-screen ending=bad title="流れ星を見送る"\n@end\n@jump epilogue'));
    const epilogue = join(dir, "scenario", "epilogue.lim");
    writeFileSync(epilogue, `${readFileSync(epilogue, "utf8").trimEnd()}\n@title-screen ending=true title="夜明け"\n`);
  }

  it("--ending はエンディングの種類か名前で探し、テストの書き方は expect ending で書く", async () => {
    withEndings();
    const bad = await quiet(() => runReach(dir, "", { ending: "bad", timeoutSeconds: 30 }));
    expect(bad.value).toBe(0);
    expect(bad.out).toContain("bad「流れ星を見送る」");
    expect(bad.out).toContain("expect ending bad");
    const ctx = await loadContext(dir);
    const r = (await findEndingReach(ctx, readProjectScripts(ctx), "夜明け", 30_000))!;
    expect(r.found).toBe(true);
    expect(r.ending).toMatchObject({ query: "夜明け", kind: "true", title: "夜明け" });
    expect(reachTestText(r)).toContain("expect ending 夜明け");
    writeFileSync(join(dir, "tests", "reach.limtest"), reachTestText(r));
    expect((await quiet(() => runTest(dir, { paths: [join(dir, "tests", "reach.limtest")] }))).value).toBe(true);
    // 当たるエンディングが無ければ探さずに 2
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await quiet(() => runReach(dir, "", { ending: "secret", timeoutSeconds: 30 }))).value).toBe(2);
      expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain("secret に当たるエンディングがありません");
    } finally {
      err.mockRestore();
    }
  }, 120_000);

  it("--endings はすべてのエンディングについて届くかを出す", async () => {
    withEndings();
    const out = await quiet(() => runReach(dir, "", { endings: true, json: true, timeoutSeconds: 30 }));
    expect(out.value).toBe(0);
    const j = JSON.parse(out.out) as { ok: boolean; endings: { kind: string; title?: string; found: boolean; test?: string }[] };
    expect(j.ok).toBe(true);
    expect(j.endings.map((e) => [e.kind, e.title, e.found])).toEqual([
      ["true", "夜明け", true],
      ["bad", "流れ星を見送る", true],
    ]);
    expect(j.endings[1]!.test).toContain("expect ending 流れ星を見送る");
  }, 180_000);

  it("条件の変数を決める行を手がかりにする（lim coverage の届かないエンディングにも出す）", async () => {
    const ctx = await loadContext(dir);
    const h = reachHints(readProjectScripts(ctx), "start", 141);
    expect(h.setters.map((s) => `${s.path} ${s.file}:${s.line}`)).toEqual(expect.arrayContaining(["game.looked start:59", "game.wished start:123"]));
  });
});

describe("lim new --ci", () => {
  it("CI のひな形を .github/workflows/ に置き、白紙にははじめから終わりまで流れるテストを置く", async () => {
    const sample = join(dir, "sample");
    const blank = join(dir, "blank");
    const made = await quiet(async () => {
      runNew(sample, { ci: true });
      runNew(blank, { ci: true, blank: true });
      runNew(join(dir, "plain"), { blank: true });
    });
    expect(made.out).toContain(".github/workflows/liminalia-check.yml");
    expect(made.out).not.toContain("OWNER");
    const workflow = readFileSync(join(sample, ".github/workflows/liminalia-check.yml"), "utf8");
    expect(workflow).toContain("lim.mjs test . --github");
    // エンジンのリポジトリの名前は書き換えなくてよい（OWNER を書き換えるようには言わない）
    expect(workflow).toContain("repository: skyt-a/liminalia");
    expect(workflow).toContain("lfs: true");
    // エンジンは main ではなく、作ったときの lim の版のタグで取る（エンジンの変更で作品の CI が予告なく落ちない）
    expect(workflow).toContain(`LIMINALIA_ENGINE_REF: v${engineVersion()}`);
    expect(workflow).not.toContain("ref: main");
    expect(existsSync(join(sample, "tests/start.limtest"))).toBe(true);
    expect(readFileSync(join(blank, "tests/start.limtest"), "utf8")).toContain("expect end");
    expect(existsSync(join(dir, "plain", "tests"))).toBe(false);
    expect(existsSync(join(dir, "plain", ".github"))).toBe(false);
    expect((await quiet(() => runTest(blank))).value).toBe(true);
    // プレイを終えるコマンド（@title-screen）で終えても「終わりまで流れる」（選択肢を使い切って止まったのとは分ける）
    writeFileSync(join(blank, "scenario", "start.lim"), `${readFileSync(join(blank, "scenario", "start.lim"), "utf8")}@title-screen ending=good\n`);
    expect((await quiet(() => runTest(blank))).value).toBe(true);
    writeFileSync(join(blank, "scenario", "start.lim"), "# start\n@choice\n- 左 -> #left\n- 右 -> #left\n@end\n# left\n@title-screen\n");
    const stopped = await quiet(() => runTest(blank, { json: true }));
    expect(stopped.value).toBe(false);
    expect(JSON.parse(stopped.out).files[0].tests[0].failures[0].message).toBe("台本の終わりまで流れませんでした（stopped）");
  }, 60_000);
});
