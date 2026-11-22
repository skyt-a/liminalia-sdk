import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packScenarioPlace, projectPackScripts, readVoiceLock, projectTextReport } from "@liminalia/project";
import type { TextReport } from "../protocol.ts";
import { writeConfigText } from "./manage.ts";
import { StudioError, type StudioWorkspace } from "./workspace.ts";

/**
 * 文字数と表記ゆれの候補（チェックの画面）。保存したシナリオで数える。lim stats と同じく、パック（packs/<フォルダ>/scenario）の台本も
 * packs/<フォルダ>/scenario/<台本> の名前で数える（制作画面はパックの台本を開かないので、画面はその行を開けない位置として出す）。
 */
export function textReport(ws: StudioWorkspace): TextReport {
  const scripts = new Map(ws.files().map((f) => [f, ws.script(f).script] as const));
  const packFiles: string[] = [];
  for (const pack of projectPackScripts(ws.project)) {
    for (const [name, s] of pack.scripts) {
      const place = packScenarioPlace(pack.dir, name);
      scripts.set(place, s.script);
      packFiles.push(place);
    }
  }
  let lock = null;
  try {
    lock = readVoiceLock(ws.project);
  } catch {
    lock = null;
  }
  const config = ws.readConfig();
  const ignored = config.stats?.variants?.ignore;
  return { ...projectTextReport({ root: ws.project.root, config, scripts, speakers: ws.castFile.speakers, lock }), ignored: Array.isArray(ignored) ? ignored.filter((x): x is string => typeof x === "string") : [], ...(packFiles.length > 0 ? { packFiles } : {}) };
}

/** 表記ゆれの組を出さないようにする（liminalia.json の stats.variants.ignore に足す）。 */
export function ignoreVariant(ws: StudioWorkspace, id: string): void {
  if (id.trim() === "") throw new StudioError(400, "id を送ってください");
  editIgnore(ws, (ignore) => (ignore.includes(id) ? null : [...ignore, id]));
}

/** 除外を取り消す（liminalia.json の stats.variants.ignore から外す。空になったら ignore ごと外す）。 */
export function unignoreVariant(ws: StudioWorkspace, id: string): void {
  if (id.trim() === "") throw new StudioError(400, "id を送ってください");
  editIgnore(ws, (ignore) => (ignore.includes(id) ? ignore.filter((x) => x !== id) : null));
}

/** stats.variants.ignore を書き換える（edit が null を返せば書かない。前の内容は変更履歴に残す）。 */
function editIgnore(ws: StudioWorkspace, edit: (ignore: unknown[]) => unknown[] | null): void {
  const path = join(ws.project.root, "liminalia.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const stats = (raw.stats && typeof raw.stats === "object" ? raw.stats : {}) as Record<string, unknown>;
  const variants = (stats.variants && typeof stats.variants === "object" ? stats.variants : {}) as Record<string, unknown>;
  const next = edit(Array.isArray(variants.ignore) ? (variants.ignore as unknown[]) : []);
  if (next === null) return;
  const { ignore: _old, ...rest } = variants;
  const nextVariants = next.length > 0 ? { ...rest, ignore: next } : rest;
  const { variants: _v, ...otherStats } = stats;
  const nextStats = Object.keys(nextVariants).length > 0 ? { ...otherStats, variants: nextVariants } : otherStats;
  if (Object.keys(nextStats).length > 0) raw.stats = nextStats;
  else delete raw.stats;
  writeConfigText(ws, `${JSON.stringify(raw, null, 2)}\n`);
}
