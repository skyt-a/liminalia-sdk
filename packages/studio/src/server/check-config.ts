import { SEVERITY_LEVELS, type SeverityLevel } from "@liminalia/lang";
import { StudioError } from "./workspace.ts";
import { updateConfig } from "./manage.ts";
import type { StudioWorkspace } from "./workspace.ts";

/**
 * 検査の設定とシーンの情報を、制作画面の操作から liminalia.json に書く。
 * - check.severity: 問題の吹き出しとチェックの一覧の「この種類を出さない」（off）と、戻すとき（null で外す）
 * - scenes: シーン一覧とフローチャートの「シーンの情報」（視点の人物 pov、作中の日付 date、場所 place。ほかの項目は残す）
 */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 診断の code の重さを書く（null なら外す。空になった severity と check も外す）。 */
export function setCheckSeverity(ws: StudioWorkspace, code: unknown, level: unknown): void {
  if (typeof code !== "string" || !/^[a-z][a-z0-9-]*$/.test(code)) throw new StudioError(400, "code は診断の code（英小文字、数字、-）で送ってください");
  if (level !== null && !(SEVERITY_LEVELS as readonly unknown[]).includes(level)) throw new StudioError(400, `level は ${SEVERITY_LEVELS.join("、")} か null で送ってください`);
  updateConfig(ws, (raw) => {
    const check = isObj(raw.check) ? { ...raw.check } : {};
    const severity = isObj(check.severity) ? { ...check.severity } : {};
    if (level === null) {
      if (!(code in severity)) return false;
      delete severity[code];
    } else {
      if (severity[code] === level) return false;
      severity[code] = level as SeverityLevel;
    }
    if (Object.keys(severity).length > 0) check.severity = severity;
    else delete check.severity;
    if (Object.keys(check).length > 0) raw.check = check;
    else delete raw.check;
  });
}

/** シーンの情報の鍵（`ファイル` か `ファイル#ラベル`）と、そのシーンがあるか。 */
function sceneKey(ws: StudioWorkspace, key: unknown): string {
  if (typeof key !== "string") throw new StudioError(400, "key は `ファイル` か `ファイル#ラベル` で送ってください");
  const [file = "", label] = key.split("#");
  if (!ws.files().includes(file)) throw new StudioError(404, `ファイル ${file} がありません`);
  if (label !== undefined && !ws.script(file).script.body.some((s) => s.kind === "label" && s.name === label)) throw new StudioError(404, `ラベル #${label} が ${file} にありません`);
  return key;
}

/** 今のシーンの情報（liminalia.json の scenes。無ければ空）。 */
export function readScenes(ws: StudioWorkspace): Record<string, Record<string, unknown>> {
  const scenes = (ws.readConfig() as { scenes?: unknown }).scenes;
  return isObj(scenes) ? (scenes as Record<string, Record<string, unknown>>) : {};
}

/** シーンの pov、date、place を書く（空の文字は外す。ほかの項目は残し、空になったシーンと scenes は外す）。 */
export function setSceneInfo(ws: StudioWorkspace, key: unknown, info: unknown): void {
  const at = sceneKey(ws, key);
  if (!isObj(info)) throw new StudioError(400, "info は { pov, date, place } で送ってください");
  for (const k of ["pov", "date", "place"]) if (info[k] !== undefined && typeof info[k] !== "string") throw new StudioError(400, `${k} は文字で送ってください`);
  updateConfig(ws, (raw) => {
    const scenes = isObj(raw.scenes) ? { ...raw.scenes } : {};
    const before = isObj(scenes[at]) ? (scenes[at] as Record<string, unknown>) : {};
    const next: Record<string, unknown> = { ...before };
    for (const k of ["pov", "date", "place"]) {
      const v = typeof info[k] === "string" ? (info[k] as string).trim() : "";
      if (v === "") delete next[k];
      else next[k] = v;
    }
    if (JSON.stringify(next) === JSON.stringify(before)) return false;
    if (Object.keys(next).length > 0) scenes[at] = next;
    else delete scenes[at];
    if (Object.keys(scenes).length > 0) raw.scenes = scenes;
    else delete raw.scenes;
  });
}
