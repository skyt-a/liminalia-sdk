import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { updateVoiceLock, voiceAutoSettings, type Script } from "@liminalia/lang";
import { listPackSources, readVoiceLock } from "@liminalia/project";
import { parsePacks } from "@liminalia/plugin-host";
import { observeVoiceNumbers } from "@liminalia/runtime";
import type { VoiceLockResult } from "../protocol.ts";
import { keepVersion } from "./versions.ts";
import { HISTORY_DIR, StudioError, writeAtomic, type StudioWorkspace } from "./workspace.ts";

/**
 * ボイスの画面の「番号を固定」（POST /voice-lock。lim voice-lock と同じ）。連番のボイス（@voice-auto）の番号を台詞ごとに固定する。
 * 今の固定は変えず、新しい台詞に番号を足す。固定がまだ無ければ、「はじめから」を何通りか流して今の数え方で鳴る番号を写す。
 * 前の内容は変更履歴（.liminalia/history/@voice-lock/）に残す。
 */
export async function lockVoices(ws: StudioWorkspace, runs = 8): Promise<VoiceLockResult> {
  const scripts = new Map<string, Script>(ws.files().map((f) => [f, ws.script(f).script] as const));
  // パックの台本も数える（lim voice-lock と同じ。遊ぶ側はパックの台詞にも本体の固定を使う）
  const sources = listPackSources(ws.project.root);
  const parsed = parsePacks(sources, ws.castFile.speakers);
  const packs = parsed.map((p) => p.scripts);
  const speakers = new Set([scripts, ...packs].flatMap((s) => [...voiceAutoSettings(s).keys()]));
  const path = ws.project.paths.voiceLock;
  const rel = relative(ws.project.root, path).split(sep).join("/");
  if (speakers.size === 0) return { path: rel, speakers: [], total: 0, kept: 0, captured: 0, carried: 0, added: 0, varied: [], skippedSets: 0 };
  let existing;
  try {
    existing = readVoiceLock(ws.project);
  } catch (e) {
    throw new StudioError(400, `${rel} を JSON として読み込めません: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 初めて作るときは、本体だけと、本体にパックのどの組み合わせを重ねても流す（lim voice-lock と同じ）
  const observed = existing
    ? undefined
    : await observeVoiceNumbers({ scripts, entry: ws.project.config.entry, loadSource: async (file) => ws.script(file).text, runtime: ws.runtimeOptions(), runs, packs: parsed.map((p, i) => ({ scripts: p.scripts, source: (file: string) => sources[i]!.scripts.get(file) })) });
  const r = updateVoiceLock(existing, scripts, speakers, observed, { packs, packDirs: parsed.map((p) => p.dir) });
  const text = `${JSON.stringify(r.lock, null, 2)}\n`;
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (text !== before) {
    if (before !== null) keepVersion(join(ws.project.root, HISTORY_DIR, "@voice-lock"), ".json", before);
    writeAtomic(path, text);
  }
  return {
    path: rel,
    speakers: [...speakers],
    total: Object.keys(r.lock.lines).length,
    kept: r.kept,
    captured: r.captured,
    carried: r.carried,
    added: r.added,
    // パックの台詞は pack にフォルダ（制作画面はパックの台本を開かないので、画面は位置だけを出す）
    varied: r.varied.map((l) => ({ file: l.file, line: l.line, speaker: l.speaker, n: r.lock.lines[l.key]!.n, ...(l.pack ? { pack: l.pack } : {}) })),
    skippedSets: r.skippedSets,
  };
}
