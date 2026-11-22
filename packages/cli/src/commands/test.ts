import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseScenarioTests, SCENARIO_TEST_EXTENSION, type Diagnostic } from "@liminalia/lang";
import { listScenarioTestFiles, loadScenarioSource, projectTestFiles, SCENARIO_TESTS_FOLDER } from "@liminalia/project";
import { runScenarioTest, type ScenarioTestResult, type TestFailure } from "@liminalia/runtime";
import { loadContext, runtimeOptionsOf } from "../context.ts";
import { githubAnnotation, inEnglish } from "./check.ts";

/** テストを置くフォルダ（プロジェクトの直下。@liminalia/project の SCENARIO_TESTS_FOLDER）。 */
export const TESTS_FOLDER = SCENARIO_TESTS_FOLDER;

export interface TestCliOptions {
  /**
   * 流すテストのファイルかフォルダ。今のフォルダから探し、無ければプロジェクトのフォルダから探す（作品の外から `lim test game tests/a.limtest` と打てる）。
   * 省くとプロジェクトの tests/ の下のすべて。
   */
  paths?: string[];
  json?: boolean;
  /** GitHub Actions の注釈（::error 形式）でも出す。 */
  github?: boolean;
  language?: "ja" | "en";
}

/** テストのファイル一つの結果。problems は読めなかった行（bad-test）。 */
export interface TestFileResult {
  file: string;
  problems: Diagnostic[];
  tests: ScenarioTestResult[];
}

/**
 * 渡したテストのファイルかフォルダの .limtest。今のフォルダから探し、無ければプロジェクトのフォルダ（root）から探す。
 * どちらにも無いパスがあれば、流さずに止める（lim は終了の値 2）。黙って「テストが無い」として通すと、CI が何も確かめずに通る。
 */
function givenTestFiles(root: string, paths: readonly string[], language: "ja" | "en"): string[] {
  const missing: string[] = [];
  const files = paths.flatMap((p) => {
    const found = [resolve(p), resolve(root, p)].find((x) => existsSync(x));
    if (found === undefined) missing.push(p);
    return found === undefined ? [] : listScenarioTestFiles(found);
  });
  if (missing.length > 0) {
    throw new Error(
      language === "en"
        ? `Test file or folder not found: ${missing.join(", ")} (looked in the current folder and in the project folder)`
        : `テストのファイルかフォルダが見つかりません: ${missing.join("、")}（今のフォルダと、プロジェクトのフォルダから探しました）`,
    );
  }
  return [...new Set(files)];
}

/** 作品のテストを流す（lim test の中身。書き出しはしない）。paths の見つからないものがあれば例外。 */
export async function runProjectTests(dir: string, paths?: readonly string[], language: "ja" | "en" = "ja"): Promise<TestFileResult[]> {
  const ctx = await loadContext(dir);
  const scenario = ctx.project.paths.scenario;
  const files = paths && paths.length > 0 ? givenTestFiles(ctx.project.root, paths, language) : projectTestFiles(ctx.project.root);
  const loadSource = async (file: string) => loadScenarioSource(scenario, file);
  const out: TestFileResult[] = [];
  for (const path of files) {
    const name = relative(ctx.project.root, path).split(sep).join("/");
    const { tests, diagnostics } = parseScenarioTests(readFileSync(path, "utf8"), name, { entry: ctx.project.config.entry });
    const results: ScenarioTestResult[] = [];
    for (const [i, test] of tests.entries()) {
      const result = await runScenarioTest(test, {
          loadSource,
          entry: ctx.project.config.entry,
          runtime: { ...runtimeOptionsOf(ctx), onError: "continue" },
          readState: (p) => JSON.parse(readFileSync(resolve(dirname(path), p), "utf8")),
        });
      // そのテストの中に読めない行があれば、確かめていないことがあるので通過にしない（読めない expect を飛ばして「通過」と出ていた）
      const end = tests[i + 1]?.line ?? Number.POSITIVE_INFINITY;
      const unread = diagnostics.filter((d) => d.line !== undefined && d.line > test.line && d.line < end);
      if (unread.length > 0) {
        result.ok = false;
        result.failures.unshift(...unread.map((d) => ({ line: d.line ?? test.line, ja: "読めない行があるため、このテストを確かめられません", en: "This test can't be checked because this line is unreadable" })));
      }
      results.push(result);
    }
    out.push({ file: name, problems: diagnostics, tests: results });
  }
  return out;
}

/**
 * lim test [プロジェクト] [テストのファイルかフォルダ…] [--json] [--github] [--lang en] — 台本の自動テスト（tests/*.limtest）を流す。
 * 書き方は @liminalia/lang の scenario-test.ts と docs/design/format.md の「台本のテスト」。失敗か読めない行があれば false。
 * パスを渡さずにテストが一つも無ければ、その旨を出して true（CI のひな形がテストの無い作品で止まらないように）。
 * パスを渡して .limtest が一つも無ければ false、見つからないパスがあれば例外（lim は終了の値 2）。
 */
export async function runTest(dir: string, o: TestCliOptions = {}): Promise<boolean> {
  const en = o.language === "en";
  const files = await runProjectTests(dir, o.paths, en ? "en" : "ja");
  const count = files.reduce((n, f) => n + f.tests.length, 0);
  const failed = files.reduce((n, f) => n + f.tests.filter((t) => !t.ok).length, 0);
  const problems = files.reduce((n, f) => n + f.problems.length, 0);
  // パスを渡したのに .limtest が一つも無ければ失敗（打ち間違いや、テストでないファイルを渡したまま CI が通らないように）
  const given = (o.paths?.length ?? 0) > 0;
  const ok = failed === 0 && problems === 0 && !(given && files.length === 0);
  const message = (x: TestFailure) => (en ? (x.diagnostic ? `${x.en}: ${inEnglish(x.diagnostic).message}` : x.en) : x.ja);
  if (o.json) {
    console.log(
      JSON.stringify(
        {
          ok,
          tests: count,
          failed,
          files: files.map((f) => ({
            file: f.file,
            problems: (en ? f.problems.map(inEnglish) : f.problems).map((d) => ({ line: d.line, message: d.message, ...(d.hint ? { hint: d.hint } : {}) })),
            tests: f.tests.map((t) => ({ name: t.name, line: t.line, ok: t.ok, failures: t.failures.map((x) => ({ line: x.line, message: message(x) })), pages: t.pages, end: t.result.reason, choices: t.choices, game: t.game })),
          })),
        },
        null,
        2,
      ),
    );
  } else if (files.length === 0 && given) {
    const list = o.paths!.join(en ? ", " : "、");
    console.log(en ? `No ${SCENARIO_TEST_EXTENSION} files in: ${list}` : `${SCENARIO_TEST_EXTENSION} のファイルがありません: ${list}`);
  } else if (files.length === 0) {
    console.log(en ? `No tests (${TESTS_FOLDER}/*${SCENARIO_TEST_EXTENSION})` : `テストがありません（${TESTS_FOLDER}/*${SCENARIO_TEST_EXTENSION}）`);
  } else {
    for (const f of files) {
      console.log(f.file);
      for (const d of en ? f.problems.map(inEnglish) : f.problems) console.log(`  ${f.file}:${d.line} ${d.message}${d.hint ? `\n    → ${d.hint}` : ""}`);
      for (const t of f.tests) {
        console.log(`  ${t.ok ? (en ? "pass" : "通過") : en ? "FAIL" : "失敗"}  ${t.name}${en ? ` (${t.pages} ${t.pages === 1 ? "page" : "pages"})` : `（${t.pages} ページ）`}`);
        for (const x of t.failures) console.log(`        ${f.file}:${x.line} ${message(x)}`);
      }
    }
    console.log(en ? `\n${count - failed} of ${count} ${count === 1 ? "test" : "tests"} passed${problems > 0 ? `, ${problems} unreadable ${problems === 1 ? "line" : "lines"}` : ""}` : `\n${count} 件中 ${count - failed} 件が通りました${problems > 0 ? `。読めない行が ${problems} 行あります` : ""}`);
  }
  if (o.github) {
    const ctxRoot = resolve(dir);
    const pathOf = (file: string) => relative(process.cwd(), join(ctxRoot, file)).split(sep).join("/");
    for (const f of files) {
      for (const d of f.problems) console.log(githubAnnotation(en ? inEnglish(d) : d, pathOf(f.file)));
      for (const t of f.tests) for (const x of t.failures) console.log(githubAnnotation({ severity: "error", code: "test", message: `${t.name}: ${message(x)}`, file: f.file, line: x.line }, pathOf(f.file), "lim test"));
    }
  }
  return ok;
}
