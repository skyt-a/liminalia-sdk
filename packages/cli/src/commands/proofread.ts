import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { applyProse, proseDocument, proseEntries, readProseDocument, type ProseEntry, type ProseRuby } from "@liminalia/lang";
import { assertProjectScenariosUtf8, exportScriptText, listPackScenarioFiles, listScenarioFiles, readScenarioFile } from "@liminalia/project";
import type { Context } from "../context.ts";
import { loadContext } from "../context.ts";

/**
 * 校正の道具が読む台本（本体の台本、続けてパック（packs/<フォルダ>/scenario）の台本）。name は出力と行の鍵に使う名前
 * （パックの台本は packs/<フォルダ>/scenario/<台本>）、speakers は読む話者（パックはパックの cast.json の話者も足す）。
 */
function proofreadFiles(ctx: Context): { name: string; path: string; speakers: readonly string[] }[] {
  return [
    ...listScenarioFiles(ctx.project.paths.scenario).map((f) => ({ name: f.name, path: f.path, speakers: ctx.cast.speakers })),
    ...listPackScenarioFiles(ctx.project.root).map((f) => ({ name: f.place, path: f.path, speakers: [...new Set([...ctx.cast.speakers, ...f.speakers])] })),
  ];
}

/**
 * lim script-export [プロジェクト] [--format text|html] [--out フォルダ] [--lines] [--lang en] — 校正用の台本を書き出す
 * （本文とシーンの見出しだけをファイルごとに。話者名を添え、ルビはテキストなら ｜親文字《よみ》、HTML なら <ruby>）。
 * パックの台本も packs/<フォルダ>/scenario/<台本> に書き出す。
 */
export async function runScriptExport(dir: string, o: { format?: string; out?: string; lines?: boolean; language?: "ja" | "en" } = {}): Promise<boolean> {
  const format = o.format ?? "text";
  if (format !== "text" && format !== "html") throw new Error("--format には text か html を指定してください");
  const ctx = await loadContext(dir);
  assertProjectScenariosUtf8(ctx.project.root, ctx.project.paths.scenario, o.language);
  const r = exportScriptText(ctx.project,{ format, lines: o.lines === true, ...(o.out ? { folder: resolve(o.out) } : {}), ...(o.language ? { language: o.language } : {}) });
  const where = relative(process.cwd(), r.folder) || ".";
  console.log(o.language === "en" ? `Exported the script for proofreading: ${where} (${r.files} files, ${r.lines} lines)` : `校正用の台本を書き出しました: ${where}（${r.files} ファイル、${r.lines} 行）`);
  return true;
}

/**
 * lim prose extract [プロジェクト] [ファイル…] [--out ファイル] [--ruby aozora|lim] — 本文（台詞・地の文・選択肢の文）だけを、
 * 行の鍵（[ファイル:行 hash]）付きで一つの文書に抜き出す。ファイルを省くとすべて。--ruby aozora（既定）はルビを ｜親文字《よみ》 で出す。
 * パックの台本も抜き出す（ファイルは packs/<フォルダ>/scenario/<台本>。そのまま指定もできる）。
 */
export async function runProseExtract(dir: string, files: readonly string[], o: { out?: string; ruby?: string; language?: "ja" | "en" } = {}): Promise<boolean> {
  const ruby = (o.ruby ?? "aozora") as ProseRuby;
  if (ruby !== "aozora" && ruby !== "lim") throw new Error("--ruby には aozora か lim を指定してください");
  const ctx = await loadContext(dir);
  // 化けた本文を抜き出さない（直して書き戻すと元の文字に戻せない）
  assertProjectScenariosUtf8(ctx.project.root, ctx.project.paths.scenario, o.language);
  const all = proofreadFiles(ctx);
  const wanted = files.map((f) => f.replace(/\.lim$/, ""));
  const unknown = wanted.filter((f) => !all.some((x) => x.name === f));
  if (unknown.length > 0) throw new Error(`シナリオファイルがありません: ${unknown.join("、")}`);
  const entries: ProseEntry[] = [];
  for (const { name, path, speakers } of all) {
    if (wanted.length > 0 && !wanted.includes(name)) continue;
    entries.push(...proseEntries(name, readScenarioFile(path).text, speakers, ruby));
  }
  const text = proseDocument(entries, ruby, o.language ?? "ja");
  if (!o.out) {
    process.stdout.write(text);
    return true;
  }
  const out = resolve(o.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(o.language === "en" ? `Extracted ${entries.length} lines of text: ${relative(process.cwd(), out)}` : `本文 ${entries.length} 行を書き出しました: ${relative(process.cwd(), out)}`);
  return true;
}

/**
 * lim prose apply [プロジェクト] <ファイル> [--check] — lim prose extract で抜き出して直した本文を、元のシナリオに書き戻す。
 * 抜き出したあとで元の行が変わったもの、本文以外（行の種類、話者、本文の中のコマンドと値、選択肢のジャンプ先）が変わったものは書き戻さずに知らせる。
 * --check は書き戻さずに知らせるだけ。書き戻さなかった行があれば false。パックの台本の行（packs/<フォルダ>/scenario/<台本>）はパックの台本へ書き戻す。
 */
export async function runProseApply(dir: string, input: string, o: { check?: boolean } = {}): Promise<boolean> {
  if (!input) throw new Error("直した本文のファイルを指定してください（lim prose apply prose.txt）");
  if (!existsSync(input)) throw new Error(`ファイルがありません: ${input}`);
  const ctx = await loadContext(dir);
  assertProjectScenariosUtf8(ctx.project.root, ctx.project.paths.scenario);
  const doc = readProseDocument(readFileSync(input, "utf8"));
  const files = new Map(proofreadFiles(ctx).map((f) => [f.name, f]));
  const byFile = new Map<string, ProseEntry[]>();
  for (const e of doc.entries) (byFile.get(e.file) ?? byFile.set(e.file, []).get(e.file)!).push(e);
  let applied = 0;
  let unchanged = 0;
  const problems: string[] = doc.problems.map((p) => `  ${input}:${p.line}: 行キー（[ファイル:行 hash]）がありません: ${p.text}`);
  const reasons = { stale: "抜き出したあとで元の行が変わっています", shape: "本文以外（行の種類、話者、本文の中のコマンドと値、ジャンプ先）が変わっているか、読めません", missing: "その行がありません" };
  for (const [file, entries] of byFile) {
    const found = files.get(file);
    if (!found) {
      problems.push(`  ${file}.lim がありません（${entries.length} 行）`);
      continue;
    }
    const { path, speakers } = found;
    const source = readScenarioFile(path).text;
    const r = applyProse(source, entries, speakers, doc.ruby);
    applied += r.applied;
    unchanged += r.unchanged;
    for (const x of r.rejected) problems.push(`  ${file}.lim:${x.line}: ${reasons[x.reason]}: ${x.text}`);
    if (!o.check && r.applied > 0) {
      // 一時ファイルに書いてから置き換える
      writeFileSync(`${path}.tmp`, r.text);
      renameSync(`${path}.tmp`, path);
    }
  }
  console.log(o.check ? `書き戻せる行 ${applied}、変わっていない行 ${unchanged}` : `書き戻した行 ${applied}、変わっていない行 ${unchanged}`);
  if (problems.length > 0) console.log(`書き戻さなかった行 ${problems.length}:\n${problems.join("\n")}`);
  return problems.length === 0;
}
