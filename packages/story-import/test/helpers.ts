import { checkProject, CORE_COMMANDS, createRegistry, parse, type Cast, type Script } from "@liminalia/lang";
import { HeadlessHost, Runtime, type TraceEntry, type Value } from "@liminalia/runtime";
import { recheck, type StoryImportResult } from "../src/index.ts";

export const registry = createRegistry(CORE_COMMANDS);

/** 変換した .lim を画面なしで流し、ページの文・出した選択肢・診断・game. の変数を返す。 */
export async function play(r: StoryImportResult, entry: string, choices: number[], maxPages = 200) {
  const files = Object.fromEntries(r.files.map((f) => [f.name, f.text]));
  const host = new HeadlessHost({ loadSource: async (f) => files[f] ?? "", choices, whenChoicesRunOut: "stop", maxPages });
  const runtime = new Runtime(host, { speakers: r.speakers, variables: r.variables as Record<string, Value> });
  host.onLimit = () => runtime.stop();
  await runtime.start(entry);
  const pages = (t: TraceEntry[]) => t.flatMap((e) => (e.type === "page" ? [`${e.speaker ?? ""}${e.text}`] : []));
  const shown = host.trace.flatMap((e) => (e.type === "choice" ? [e.options] : []));
  const diagnostics = host.trace.flatMap((e) => (e.type === "diagnostic" ? [e.diagnostic.message] : []));
  return { pages: pages(host.trace), shown, diagnostics, game: runtime.state.game };
}

/** lim check と同じ、読み直しの検査とプロジェクト全体の検査（checkProject）のエラー。 */
export function limCheckErrors(r: StoryImportResult & { cast?: Record<string, unknown> }): string[] {
  const again = recheck(r, registry, []);
  const scripts = new Map<string, Script>(r.files.map((f) => [f.name, parse(f.text, f.name, { speakers: r.speakers })]));
  // 立ち絵を出す変換（Ren'Py）は、作ったキャストで lim check と同じに確かめる
  const cast = r.cast ? { cast: new Set(Object.keys(r.cast)), castEntries: r.cast as unknown as Cast } : {};
  const diags = [...[...scripts.values()].flatMap((s) => s.diagnostics), ...checkProject(scripts, { registry, speakers: r.speakers, variables: r.variables, ...cast })];
  return [...again.syntaxErrors, ...again.checkErrors, ...diags.filter((d) => d.severity === "error").map((d) => `${d.file}:${d.line} ${d.message}`)];
}
