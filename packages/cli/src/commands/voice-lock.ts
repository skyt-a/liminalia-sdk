import { renameSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { PACK_COMBINATION_LIMIT, parse, updateVoiceLock, voiceAutoSettings, type Script, type VoiceLine } from "@liminalia/lang";
import { assertScenariosUtf8, listPackSources, listScenarioFiles, loadScenarioSource, readScenarioFile, readVoiceLock } from "@liminalia/project";
import { parsePacks } from "@liminalia/plugin-host";
import { observeVoiceNumbers } from "@liminalia/runtime";
import { loadContext, runtimeOptionsOf, type Context } from "../context.ts";

/**
 * lim voice-lock [プロジェクト] [--runs 8] — 連番のボイス（@voice-auto）の番号を台詞ごとに固定する（paths.voiceLock）。
 * パック（packs/<フォルダ>/scenario）の台詞も、パックのどの組み合わせで遊ばれても数える（遊ぶ側はパックの台詞にも本体の固定を使う）。
 * パックの台詞の位置は packs/<フォルダ>/scenario/<台本>:<行> で出す。
 * 今の固定は変えず、新しい台詞に番号を足す（@liminalia/lang の updateVoiceLock）。
 * 固定がまだ無いときは、「はじめから」から選択肢の選び方を変えて何通りか流し、今の数え方で鳴る番号を写す
 * （収録した番号をそのまま固定するため。届かなかった台詞には新しい番号を振る）。
 */
export async function runVoiceLock(dir: string, runs: number, o: { clearRerecord?: boolean } = {}): Promise<boolean> {
  const ctx = await loadContext(dir);
  const { project } = ctx;
  // 化けた台詞の鍵で番号を固定しない
  assertScenariosUtf8(project.paths.scenario);
  const scripts = new Map<string, Script>();
  for (const { name, path: file } of listScenarioFiles(project.paths.scenario)) scripts.set(name, parse(readScenarioFile(file).text, name, { speakers: ctx.cast.speakers }));
  // パックの台本（遊ぶ側はパックの台詞にも本体の固定を使う。パックの台詞にも番号を振り、パックの台詞の番号を retired に移さない）
  const sources = listPackSources(project.root);
  const parsed = parsePacks(sources, ctx.cast.speakers);
  const packs = parsed.map((p) => p.scripts);
  const speakers = new Set([scripts, ...packs].flatMap((s) => [...voiceAutoSettings(s).keys()]));
  if (speakers.size === 0) {
    console.log("@voice-auto で pattern を指定した話者がいないため、固定するボイスがありません");
    return true;
  }
  const existing = readVoiceLock(project);
  // 録り直したら、要再収録の印を消す
  if (existing && o.clearRerecord) for (const e of Object.values(existing.lines)) delete e.rerecord;
  // 初めて作るときは、本体だけと、本体にパックのどの組み合わせを重ねても流す（パックの台詞は、パックを入れて遊んだときに鳴る番号を写す）
  const observed = existing ? undefined : await observe(ctx, scripts, runs, parsed.map((p, i) => ({ scripts: p.scripts, source: (file: string) => sources[i]!.scripts.get(file) })));
  const r = updateVoiceLock(existing, scripts, speakers, observed, { entry: project.config.entry, packs, packDirs: parsed.map((p) => p.dir) });
  const path = project.paths.voiceLock;
  writeFileSync(`${path}.tmp`, `${JSON.stringify(r.lock, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  const total = Object.keys(r.lock.lines).length;
  console.log(`${relative(project.root, path)}: ${total} 行（${[...speakers].join("、")}）`);
  console.log(`  変更なし ${r.kept}、実行して取得 ${r.captured}、編集前の台詞から引き継ぎ ${r.carried}、新しく割り当て ${r.added}`);
  if (r.skippedSets > 0) console.log(skippedSetsMessage(packs.filter((p) => p.size > 0).length, r.skippedSets));
  if (r.rerecord.length > 0) {
    console.log(`要再収録（書き換える前の台詞から番号を引き継いだため、収録したボイスと原文が違います。録り直したら --clear-rerecord で印を消します）: ${r.rerecord.length} 行`);
    for (const l of r.rerecord.slice(0, 40)) console.log(`  ${voiceLinePlace(l)} ${l.speaker} → ${r.lock.lines[l.key]!.n} ${l.source}`);
  }
  if (r.varied.length > 0) {
    console.log(`ルートによって番号が変わった台詞と、ほかの台詞と同じ番号が再生された台詞（収録したファイルと合っているか確認してください）:`);
    for (const l of r.varied.slice(0, 40)) console.log(`  ${voiceLinePlace(l)} ${l.speaker} → ${r.lock.lines[l.key]!.n}`);
  }
  return true;
}

/** 台詞の位置（本体は 台本:行、パックの台詞は packs/<フォルダ>/scenario/台本:行。収録用の台本の位置と同じ）。 */
export function voiceLinePlace(l: Pick<VoiceLine, "file" | "line" | "pack">): string {
  return `${l.pack ? `${l.pack}/scenario/` : ""}${l.file}:${l.line}`;
}

/** パックが多くて、すべての組み合わせを読まなかったことの知らせ（lim voice-lock）。 */
export function skippedSetsMessage(packs: number, skipped: number): string {
  return `台本のあるパックが ${packs} 個あり、組み合わせが多いため（上限 ${PACK_COMBINATION_LIMIT} 個）、本体だけ、本体にパックを一つずつ、本体にすべてのパックを重ねた組だけを読みました（読まなかった組み合わせ ${skipped} 通り）。その組み合わせでだけ連番が鳴る台詞には番号を振っていません`;
}

/** 「はじめから」を何通りか流し、台詞の鍵 → 鳴った連番を集める（packs があれば、本体にパックのどの組み合わせを重ねても流す）。 */
function observe(ctx: Context, scripts: ReadonlyMap<string, Script>, runs: number, packs: { scripts: ReadonlyMap<string, Script>; source(file: string): string | undefined }[] = []): Promise<Map<string, Set<number>>> {
  return observeVoiceNumbers({
    scripts,
    entry: ctx.project.config.entry,
    loadSource: async (file) => loadScenarioSource(ctx.project.paths.scenario, file),
    runtime: runtimeOptionsOf(ctx),
    runs,
    packs,
  });
}
