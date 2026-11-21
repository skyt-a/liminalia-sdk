import { endingKinds, endingLabel, endingMatches, endingRef, parse, parseExpr, parseTargetText, variablePaths, type Diagnostic, type EndingRef, type Expr, type ScenarioTest } from "@liminalia/lang";
import { HeadlessHost, type TraceEntry } from "./headless.ts";
import { Runtime, type RunResult, type RuntimeOptions } from "./runtime.ts";
import type { SaveData } from "./state.ts";
import { display, evaluate, EvalError, truthy, type Value } from "./value.ts";

/**
 * 台本の自動テスト（@liminalia/lang の ScenarioTest）を画面なしで流し、期待（expect）を確かめる。ブラウザでも Node でも動く（lim test）。
 * 実行時のエラーは、expect no-errors を書かなくても失敗にする。
 */

export interface ScenarioTestOptions {
  loadSource(file: string): Promise<string>;
  /** 実行器の設定（話者・作品の命令・変数の初期値など）。onStep はテストが使うので渡さない。 */
  runtime?: Omit<RuntimeOptions, "onStep" | "seed">;
  /** from を書かないテストの開始位置（liminalia.json の entry）。 */
  entry: string;
  /** from-state のファイルを読む（パスはテストのファイルに書いたまま）。読めなければ例外。 */
  readState?(path: string): unknown;
}

/** 失敗一つ。line はテストのファイルの行。diagnostic は実行時の診断から来たもの（英語にするため）。 */
export interface TestFailure {
  line: number;
  ja: string;
  en: string;
  diagnostic?: Diagnostic;
}

export interface ScenarioTestResult {
  name: string;
  line: number;
  ok: boolean;
  failures: TestFailure[];
  result: RunResult;
  /** 出したページの数と、選んだ選択肢（文の並びと選んだ番号。0 始まり）。 */
  pages: number;
  choices: { options: string[]; selected: number | null }[];
  /** 終わったときのゲームの変数。 */
  game: Record<string, Value>;
}

/** テストの既定のページ数の上限（これに達したら、終わらないテストとして失敗にする）。 */
export const DEFAULT_TEST_LIMIT = 5000;

export async function runScenarioTest(test: ScenarioTest, o: ScenarioTestOptions): Promise<ScenarioTestResult> {
  const failures: TestFailure[] = [];
  const fail = (line: number, ja: string, en: string, diagnostic?: Diagnostic) => failures.push({ line, ja, en, ...(diagnostic ? { diagnostic } : {}) });
  const limit = test.limit ?? DEFAULT_TEST_LIMIT;
  const host = new HeadlessHost({ loadSource: (f) => o.loadSource(f), choices: test.choices.map((c) => c.pick), whenChoicesRunOut: test.rest, maxPages: limit });
  const reached = new Set<string>();
  const files = new Set<string>();
  const runtime = new Runtime(host, {
    ...o.runtime,
    seed: test.seed ?? 1,
    onStep: (at) => {
      reached.add(`${at.file}:${at.line}`);
      files.add(at.file);
    },
  });
  let limited = false;
  host.onLimit = () => {
    limited = true;
    runtime.stop();
  };
  const value = (src: { value: Expr; source: string; line: number }): Value | undefined => {
    try {
      return evaluate(src.value, { lookup: () => null, random: () => 0 });
    } catch (e) {
      fail(src.line, `set の式を求められません: ${e instanceof Error ? e.message : String(e)}`, `Can't evaluate the set expression: ${src.source}`);
      return undefined;
    }
  };
  // 始める前の値（system は実行器に、game と temp は始めるときに入れる）
  const start: Record<string, Value> = {};
  for (const s of test.sets) {
    const v = value(s);
    if (v === undefined) continue;
    if (s.path.startsWith("system.")) runtime.setVariable(s.path, v);
    else start[s.path] = v;
  }
  let result: RunResult;
  if (test.fromState !== undefined) {
    let save: SaveData;
    try {
      const raw = o.readState?.(test.fromState) as { save?: SaveData } & Partial<SaveData>;
      save = structuredClone((raw && typeof raw === "object" && raw.save ? raw.save : raw) as SaveData);
      if (!save || typeof save !== "object" || !save.position) throw new Error("セーブの形ではありません");
    } catch (e) {
      fail(test.line, `from-state ${test.fromState} を読めません（${e instanceof Error ? e.message : String(e)}）`, `Can't read from-state ${test.fromState}`);
      return { name: test.name, line: test.line, ok: false, failures, result: { reason: "error", at: { unit: "", index: 0 }, message: "from-state" }, pages: 0, choices: [], game: {} };
    }
    for (const [path, v] of Object.entries(start)) {
      if (path.startsWith("temp.")) runtime.setVariable(path, v);
      else setPath(save.game, path.slice("game.".length), v);
    }
    result = await runtime.load(save);
  } else {
    result = await runtime.start(test.from ?? o.entry, { variables: start });
  }

  const trace = host.trace;
  const pages = trace.flatMap((t) => (t.type === "page" ? [t] : []));
  const choices = trace.flatMap((t) => (t.type === "choice" ? [{ options: t.options, selected: t.selected }] : []));
  // 選ぶ文が無かった選択肢と、使わなかった choose の行
  let made = 0;
  for (const [i, t] of trace.entries()) {
    if (t.type === "choice") made++;
    if (t.type === "diagnostic" && t.diagnostic.code === "unknown-option") {
      const c = test.choices[made];
      // 並んでいた選択肢（診断のすぐ後の選択の記録）。日本語の文は診断に入っている
      const shown = trace.slice(i + 1).find((x) => x.type === "choice");
      const options = shown?.type === "choice" ? ` (${shown.options.join(" / ")})` : "";
      fail(c?.line ?? test.line, t.diagnostic.message, `The option to choose isn't there: ${String(c?.pick ?? "")}${options}`);
    }
  }
  const unused = test.choices[Math.min(made, test.choices.length)];
  if (made < test.choices.length && unused) fail(unused.line, `この choose を使う前に終わりました（選択肢は ${made} 回）`, `It ended before using this choose (${made} choices made)`);
  // 実行時のエラーは、書かなくても失敗にする
  const diagnostics = trace.flatMap((t) => (t.type === "diagnostic" && t.diagnostic.code !== "unknown-option" ? [t.diagnostic] : []));
  for (const d of diagnostics.filter((x) => x.severity === "error")) fail(test.line, `実行時のエラー（${d.file}:${d.line}）: ${d.message}`, `Runtime error (${d.file}:${d.line})`, d);
  if (result.reason === "max-steps") fail(test.line, "命令の数の上限に達しました（終わらない繰り返しがないか確かめます）", "Reached the step limit (check for an endless loop)");
  if (limited && test.limit === undefined) fail(test.line, `ページの数の上限（${limit}）に達しました。終わらないなら choose を足すか、limit を書きます`, `Reached the page limit (${limit}). Add choose lines or write limit`);

  for (const e of test.expects) {
    switch (e.kind) {
      case "expr": {
        let v: Value;
        try {
          v = runtime.eval(e.expr);
        } catch (err) {
          if (!(err instanceof EvalError)) throw err;
          fail(e.line, `expect ${e.source} を求められません: ${err.message}`, `Can't evaluate expect ${e.source}`);
          break;
        }
        if (!truthy(v)) {
          const values = [...new Set(variablePaths(e.expr))].map((p) => `${p} = ${shown(runtime.eval(parseExpr(p)))}`);
          fail(e.line, `expect ${e.source} が偽です${values.length > 0 ? `（${values.join("、")}）` : ""}`, `expect ${e.source} is false${values.length > 0 ? ` (${values.join(", ")})` : ""}`);
        }
        break;
      }
      case "reach": {
        const hit = await reachedPlace(e.place, reached, files, o.loadSource);
        if (hit === null) fail(e.line, `${e.place} はありません`, `${e.place} doesn't exist`);
        else if (hit === e.not) fail(e.line, e.not ? `${e.place} を通りました` : `${e.place} を通りませんでした`, e.not ? `Went through ${e.place}` : `Didn't go through ${e.place}`);
        break;
      }
      case "text": {
        const found = pages.some((p) => p.text.includes(e.text) || (p.label ?? p.speaker ?? "").includes(e.text));
        if (found === e.not) fail(e.line, e.not ? `「${e.text}」が出ました` : `「${e.text}」はどのページにも出ませんでした`, e.not ? `"${e.text}" was shown` : `"${e.text}" wasn't shown on any page`);
        break;
      }
      case "ending": {
        // 種類（bad など）で引く。種類でない文字は、エンディングの名前（title=。前の書き方なら書いた文言）に含むもの
        const kinds = endingKinds(o.runtime?.endingKinds);
        const endings = trace.flatMap((t): EndingRef[] => {
          if (t.type !== "command" || runtime.registry.get(t.name)?.ends !== true) return [];
          const ref = endingRef(t.args.ending, t.args.title, kinds);
          return ref ? [ref] : [];
        });
        const seen = endings.map(endingLabel);
        if (!endings.some((r) => endingMatches(r, e.name, kinds))) fail(e.line, `エンディング ${e.name} で終わりませんでした${seen.length > 0 ? `（${seen.join("、")}）` : ""}`, `Didn't end with the ending ${e.name}${seen.length > 0 ? ` (${seen.join(", ")})` : ""}`);
        break;
      }
      case "end": {
        // プレイを終えるコマンド（@title-screen など）で止まったのも終わり（選択肢を使い切ったり、ページの上限で止めたりしたのとは分ける）
        const last = trace.findLast((t) => t.type !== "diagnostic");
        const endedByCommand = result.reason === "stopped" && !limited && last?.type === "command" && runtime.registry.get(last.name)?.ends === true;
        if (result.reason !== "end" && !endedByCommand) fail(e.line, `台本の終わりまで流れませんでした（${result.reason}）`, `Didn't run to the end of the script (${result.reason})`);
        break;
      }
      case "no-errors":
        // エラーは上で知らせている
        break;
      case "no-warnings":
        for (const d of diagnostics.filter((x) => x.severity === "warning")) fail(e.line, `実行時の警告（${d.file}:${d.line}）: ${d.message}`, `Runtime warning (${d.file}:${d.line})`, d);
        break;
    }
  }
  return { name: test.name, line: test.line, ok: failures.length === 0, failures, result, pages: pages.length, choices, game: structuredClone(runtime.state.game) };
}

/** 場所を通ったか（`ファイル`、`ファイル#ラベル`、`ファイル:行`）。ファイルかラベルが無ければ null。 */
async function reachedPlace(place: string, reached: ReadonlySet<string>, files: ReadonlySet<string>, loadSource: (file: string) => Promise<string>): Promise<boolean | null> {
  const line = /^(.+):(\d+)$/.exec(place);
  if (line) return reached.has(`${line[1]}:${line[2]}`);
  const target = parseTargetText(place);
  if (!target?.file) return null;
  if (target.label === null) {
    try {
      await loadSource(target.file);
    } catch {
      return null;
    }
    return files.has(target.file);
  }
  let source: string;
  try {
    source = await loadSource(target.file);
  } catch {
    return null;
  }
  const label = parse(source, target.file).body.find((s) => s.kind === "label" && s.name === target.label);
  return label ? reached.has(`${target.file}:${label.line}`) : null;
}

function setPath(root: Record<string, Value>, path: string, value: Value): void {
  const parts = path.split(".");
  let o = root;
  for (const p of parts.slice(0, -1)) o = (o[p] && typeof o[p] === "object" && !Array.isArray(o[p]) ? o[p] : (o[p] = {})) as Record<string, Value>;
  o[parts.at(-1)!] = value;
}

function shown(v: Value): string {
  return typeof v === "string" ? JSON.stringify(v) : v === null ? "null" : display(v);
}

export type { TraceEntry };
