import { checkCommandDefaults, projectMacros, type CommandDefaults } from "@liminalia/lang";
import type { PartWrite } from "../protocol.ts";
import { configPartHash, updateConfigPart } from "./manage.ts";
import { StudioError, type StudioWorkspace } from "./workspace.ts";

/** 作品のコマンドの既定値（liminalia.json の commandDefaults。無ければ空）。 */
export function readCommandDefaults(ws: StudioWorkspace): CommandDefaults {
  return ws.readConfig().commandDefaults ?? {};
}

/** 読んだときのコマンドの既定値の hash（書くときの baseHash）。 */
export function commandDefaultsHash(ws: StudioWorkspace): string {
  return configPartHash(readCommandDefaults(ws));
}

/**
 * 作品のコマンドの既定値を書く（ゲームの設定の「コマンドの既定値」）。空なら外す。無いコマンド・パラメータ・型の誤りがあれば書かない（400）。
 * 書くと作業場がコマンドの仕様に重ね直し、プレビューは次の「はじめから」・ロードから新しい既定値で流す。
 * baseHash（読んだときの commandDefaultsHash）を渡したときは、読んだあとにほかで変わっていれば書かずに今の中身を返す（ok: false）。
 */
export function setCommandDefaults(ws: StudioWorkspace, defaults: unknown, baseHash?: string): PartWrite<CommandDefaults> {
  const problems = checkCommandDefaults(defaults ?? {}, ws.baseCommands, new Set(Object.keys(ws.castFile.cast)), projectMacros(ws.files().map((f) => [f, ws.script(f).script] as const)));
  if (problems.length > 0) throw new StudioError(400, problems.map((p) => p.message).join("\n"));
  const value = Object.fromEntries(Object.entries((defaults ?? {}) as CommandDefaults).filter(([, params]) => Object.keys(params).length > 0));
  return updateConfigPart(ws, (raw) => (raw.commandDefaults ?? {}) as CommandDefaults, baseHash, (raw) => {
    if (JSON.stringify(raw.commandDefaults ?? {}) === JSON.stringify(value)) return;
    if (Object.keys(value).length === 0) {
      delete raw.commandDefaults;
      return;
    }
    if ("commandDefaults" in raw) {
      raw.commandDefaults = value;
      return;
    }
    // 無ければ variables・ui・extra のうち最後のものの後ろに入れる（ほかの項目の並びは保つ）
    const entries = Object.entries(raw);
    const after = Math.max(...["variables", "ui", "extra"].map((k) => entries.findIndex(([key]) => key === k)));
    entries.splice(after < 0 ? entries.length : after + 1, 0, ["commandDefaults", value]);
    for (const k of Object.keys(raw)) delete raw[k];
    Object.assign(raw, Object.fromEntries(entries));
  });
}
