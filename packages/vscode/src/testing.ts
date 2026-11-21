import { dirname, join } from "node:path";
import { parseScenarioTests } from "@liminalia/lang";
import { limCommand, type Launch, type LaunchContext } from "./studio-launch.ts";

/**
 * 台本のテスト（tests/*.limtest）を VS Code の Testing の口に載せるための、VS Code に触らない部分（extension-tests.ts が使う）。
 * - 一覧: .limtest の `# 名前` の行ごとにテストを並べる（@liminalia/lang の parseScenarioTests。読めない行は problems）
 * - 流す: 作品の lim で `lim test <作品> <ファイル…> --json` を動かす（lim の探し方は lim studio と同じ。studio-launch.ts の limCommand）
 * - 結果: lim test --json を、ファイルとテストの行で引ける形にする
 */

/** テストのファイルの中のテスト（行は 1 始まり）。 */
export interface TestEntry {
  name: string;
  line: number;
}

/** .limtest の中のテストと、読めない行。 */
export function testItemsOf(text: string, file: string, entry?: string): { tests: TestEntry[]; problems: { line: number; message: string }[] } {
  const r = parseScenarioTests(text, file, entry !== undefined ? { entry } : {});
  return { tests: r.tests.map((t) => ({ name: t.name, line: t.line })), problems: r.diagnostics.map((d) => ({ line: d.line, message: d.message })) };
}

/** lim test を動かす方法（root は作品のフォルダ。files を省くと tests/ のすべて）。lim が見つからなければ null。 */
export function limTestLaunch(c: LaunchContext, files: readonly string[]): Launch | null {
  return limCommand(c, ["test", c.root, ...files, "--json"]);
}

/** 一つのテストの結果。 */
export interface TestOutcome {
  name: string;
  ok: boolean;
  failures: { line: number; message: string }[];
  pages: number;
  end: string;
}

/** lim test --json の結果（ファイルは作品からのパス、テストは `# 名前` の行で引く）。 */
export interface LimTestResults {
  ok: boolean;
  files: Map<string, { problems: { line: number; message: string }[]; tests: Map<number, TestOutcome> }>;
}

/** lim test --json の出力を読む（JSON の前に出た行は飛ばす）。読めなければ null。 */
export function parseLimTestJson(out: string): LimTestResults | null {
  const at = out.search(/^\{/m);
  if (at < 0) return null;
  let json: { ok?: unknown; files?: unknown };
  try {
    json = JSON.parse(out.slice(at)) as typeof json;
  } catch {
    // JSON でなければ（lim の誤りの文など）読めないとする
    return null;
  }
  if (!Array.isArray(json.files)) return null;
  const files: LimTestResults["files"] = new Map();
  for (const f of json.files as { file: string; problems?: { line: number; message: string }[]; tests?: (TestOutcome & { line: number })[] }[]) {
    const tests = new Map<number, TestOutcome>();
    for (const t of f.tests ?? []) tests.set(t.line, { name: t.name, ok: t.ok, failures: t.failures ?? [], pages: t.pages, end: t.end });
    files.set(f.file, { problems: (f.problems ?? []).map((p) => ({ line: p.line, message: p.message })), tests });
  }
  return { ok: json.ok === true, files };
}

/** ファイルから上へたどって、作品のフォルダ（liminalia.json のあるところ）を探す。無ければ null。 */
export function projectRootOf(file: string, exists: (path: string) => boolean): string | null {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (exists(join(dir, "liminalia.json"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}
