import { existsSync } from "node:fs";
import { join } from "node:path";
import { voiceAutoSettings, voiceScriptRows, type VoiceLock, type VoiceScriptRow } from "@liminalia/lang";
import { readVoiceLock } from "@liminalia/project";
import type { AssetUse, VoiceList } from "../protocol.ts";
import type { StudioWorkspace } from "./workspace.ts";

/**
 * ボイスの割り当ての材料（Node 側）。台詞ごとのボイスのファイルは lim voice-script と同じ決まり（@liminalia/lang の voiceScriptRows）。
 * 書き込みは画面が書き込み口（PUT /file）を通して行う。
 */

/** 読めない番号の固定は無いものとして扱う（lim voice-script と同じ。形の誤りは lim check が知らせる）。 */
function lockOf(ws: StudioWorkspace): VoiceLock | null {
  try {
    return readVoiceLock(ws.project);
  } catch {
    return null;
  }
}

function rows(ws: StudioWorkspace): { rows: VoiceScriptRow[]; hashes: Record<string, string> } {
  const files = [...ws.files()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const scripts = new Map<string, { script: ReturnType<StudioWorkspace["script"]>["script"]; text: string }>();
  const hashes: Record<string, string> = {};
  for (const file of files) {
    const { script, text, hash } = ws.script(file);
    scripts.set(file, { script, text });
    hashes[file] = hash;
  }
  // 演技のメモの行は lim voice-script と同じ（liminalia.json の voiceScript.notes）
  return { rows: voiceScriptRows(scripts, lockOf(ws), { notes: ws.project.config.voiceScript?.notes, entry: ws.project.config.entry }), hashes };
}

/** GET /voices。 */
export function voiceList(ws: StudioWorkspace): VoiceList {
  const { rows: list, hashes } = rows(ws);
  const assets = ws.assets();
  const scripts = new Map(ws.files().map((file) => [file, ws.script(file).script]));
  const auto = new Set(voiceAutoSettings(scripts).keys());
  // 大きな作品で行ごとに一覧を探さないよう、フォルダごとに Set にして引く
  const sets = new Map<string, Set<string>>();
  const has = (folder: string, path: string) => {
    if (!assets[folder]) return existsSync(join(ws.project.paths.assets, folder, path));
    let set = sets.get(folder);
    if (!set) sets.set(folder, (set = new Set(assets[folder])));
    return set.has(path);
  };
  const linesOf = new Map<string, string[]>();
  const lineAt = (file: string, line: number) => {
    let lines = linesOf.get(file);
    if (!lines) linesOf.set(file, (lines = ws.script(file).text.split("\n")));
    return lines[line - 1] ?? "";
  };
  return {
    rows: list.map((r) => ({
      ...r,
      exists: r.voice !== "" && has(r.folder, r.voice),
      pendingAuto: r.how === "none" && auto.has(r.speaker),
      source: lineAt(r.file, r.line),
      voiceSource: r.voiceLine === null ? null : lineAt(r.file, r.voiceLine),
    })),
    hashes,
  };
}

/** {n}・{n:桁} を数に当てる正規表現（連番のボイスの型に当たるファイルを探す）。 */
function patternRegex(pattern: string): RegExp {
  const parts = pattern.split(/\{n(?::(\d+))?\}/);
  let source = "";
  parts.forEach((part, i) => {
    // split のキャプチャで、奇数番目は桁の指定（無ければ undefined）
    if (i % 2 === 1) source += part ? `\\d{${part},}` : "\\d+";
    else source += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${source}$`);
}

/**
 * @voice-auto で鳴らすボイスの使用箇所。@voice-auto の型のファイルは assetReferences に載らないので、足さないと「使われていない」に見える。
 * 番号が固定された台詞はその行。番号の固定がまだ無いときは鳴らす順で番号が決まるので、型に当たるファイルをすべて @voice-auto の行で使うものとする。
 */
export function autoVoiceUses(ws: StudioWorkspace): { folder: string; path: string; use: AssetUse }[] {
  const out: { folder: string; path: string; use: AssetUse }[] = [];
  for (const r of rows(ws).rows) if (r.how === "auto") out.push({ folder: r.folder, path: r.voice, use: { in: "script", file: r.file, line: r.line } });
  if (lockOf(ws)) return out;
  const assets = ws.assets();
  const scripts = new Map(ws.files().map((file) => [file, ws.script(file).script]));
  for (const list of voiceAutoSettings(scripts).values()) {
    for (const s of list) {
      const re = patternRegex(s.pattern);
      for (const path of assets[s.folder] ?? []) if (re.test(path)) out.push({ folder: s.folder, path, use: { in: "script", file: s.file, line: s.line } });
    }
  }
  return out;
}
