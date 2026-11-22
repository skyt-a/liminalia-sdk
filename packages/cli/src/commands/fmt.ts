import { renameSync, writeFileSync } from "node:fs";
import { formatLim, indentUnit, type FormatOptions, type Registry } from "@liminalia/lang";
import { assertProjectScenariosUtf8, listPackScenarioFiles, listScenarioFiles, readScenarioFile } from "@liminalia/project";
import { loadContext } from "../context.ts";

/** --check で、ファイルごとに前と後を見せる行の数（ほかは数だけ）。 */
const SHOWN_CHANGES = 10;

/** 整えると変わる行（formatLim は行の数を変えないので、同じ行どうしを比べる）。 */
export function changedLines(before: string, after: string): { line: number; before: string; after: string }[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const out: { line: number; before: string; after: string }[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push({ line: i + 1, before: a[i] ?? "", after: b[i] ?? "" });
  return out;
}

/** 整える台本の一つ。name は台本の名前（解析と鍵の名前）、place は出力の位置（パックの台本は packs/<フォルダ>/scenario/<台本>）、pack はパックのフォルダ。 */
export interface FmtTarget {
  name: string;
  path: string;
  place: string;
  speakers: readonly string[];
  pack?: string;
}

/**
 * 整える台本（本体の台本、続けてパック（packs/<フォルダ>/scenario）の台本）。lim fmt と MCP の fmt が同じものを整える。
 * speakers は本体の話者（パックの台本はパックの cast.json の話者も足して読む）。
 */
export function fmtTargets(project: { root: string; paths: { scenario: string } }, speakers: readonly string[]): FmtTarget[] {
  return [
    ...listScenarioFiles(project.paths.scenario).map((x) => ({ ...x, place: x.name, speakers })),
    ...listPackScenarioFiles(project.root).map((x) => ({ name: x.name, path: x.path, place: x.place, pack: x.pack, speakers: [...new Set([...speakers, ...x.speakers])] })),
  ];
}

/** 一つの台本を整える（lim fmt と MCP の fmt が同じ整え方をする）。fmt は liminalia.json の fmt（indent と expressions）。 */
export function formatTarget(source: string, t: FmtTarget, o: { registry: Registry; fmt?: { indent?: number | "tab"; expressions?: boolean } | undefined }) {
  const options: FormatOptions = { registry: o.registry, speakers: t.speakers, ...(o.fmt?.indent !== undefined ? { indent: o.fmt.indent } : {}), ...(o.fmt?.expressions === false ? { expressions: false } : {}) };
  return formatLim(source, t.name, options);
}

/**
 * lim fmt [プロジェクト] [--check] [--indent 2|tab|keep] — シナリオの命令の行と式を整える（本文は変えない。整え方は @liminalia/lang の formatLim）。
 * --check は書き換えず、整っていないファイルがあれば false。直す所をファイルと行と、前と後の行で示す（ファイルごとに 10 か所まで。ほかは数だけ）。
 * 構文の誤りがあるファイルは整えずに知らせる。
 * 字下げは --indent か liminalia.json の fmt.indent（ブロックの深さ一つにつき空白の数か tab。keep と省いたときは変えない）。
 * パック（packs/<フォルダ>/scenario）の台本も整え、packs/<フォルダ>/scenario/<台本>.lim の位置で出す（パックの cast.json の話者も足して読む）。
 * UTF-8 で読めないシナリオファイル（Shift_JIS など。パックのものも）があれば、何も書かずに止める（化けた字面を書き戻さない）。
 */
export async function runFmt(dir: string, check: boolean, indentFlag?: string): Promise<boolean> {
  const ctx = await loadContext(dir);
  const indent = indentFlag === undefined ? ctx.project.config.fmt?.indent : indentFlag === "keep" ? undefined : indentFlag === "tab" ? "tab" : Number(indentFlag);
  if (indentFlag !== undefined && indentFlag !== "keep" && indentUnit(indent) === null) throw new Error("--indent には 0 から 8 の空白の数か、tab か keep を指定してください");
  const scenario = ctx.project.paths.scenario;
  assertProjectScenariosUtf8(ctx.project.root, scenario);
  const changed: string[] = [];
  /** --check で出す、直す所（ファイルごと）。 */
  const diffs: string[] = [];
  const skipped: string[] = [];
  // 本体の台本、続けてパックの台本（位置は packs/<フォルダ>/scenario/<台本>）
  const fmt = { ...(indent !== undefined ? { indent } : {}), ...(ctx.project.config.fmt?.expressions === false ? { expressions: false } : {}) };
  for (const t of fmtTargets(ctx.project, ctx.cast.speakers)) {
    const { path, place } = t;
    const f = `${place}.lim`;
    const source = readScenarioFile(path).text;
    const r = formatTarget(source, t, { registry: ctx.registry, fmt });
    if (!r.ok) {
      skipped.push(`  ${f}: ${r.reason}`);
      continue;
    }
    if (!r.changed) continue;
    changed.push(f);
    if (check) {
      const lines = changedLines(source, r.text);
      for (const d of lines.slice(0, SHOWN_CHANGES)) diffs.push(`  ${f}:${d.line}`, `    - ${d.before}`, `    + ${d.after}`);
      if (lines.length > SHOWN_CHANGES) diffs.push(`  ${f}: ほか ${lines.length - SHOWN_CHANGES} か所`);
    }
    if (!check) {
      // 一時ファイルに書いてから置き換える
      writeFileSync(`${path}.tmp`, r.text);
      renameSync(`${path}.tmp`, path);
    }
  }
  if (check && changed.length > 0) {
    console.log("整形されていないファイル:");
    for (const line of diffs) console.log(line);
    console.log("lim fmt で整形します（--check を外すと書き換えます）");
  } else if (!check && changed.length > 0) console.log(`整形しました: ${changed.join("、")}`);
  else if (skipped.length === 0) console.log(check ? "すべて整形済みです" : "変更はありませんでした");
  if (skipped.length) console.log(`構文エラーがあるため整形しなかったファイル:\n${skipped.join("\n")}`);
  return check ? changed.length === 0 && skipped.length === 0 : skipped.length === 0;
}
