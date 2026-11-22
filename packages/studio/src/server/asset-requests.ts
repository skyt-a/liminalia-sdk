import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { assetReferences, castAssetReferences } from "@liminalia/lang";
import type { AssetRequest, AssetRequestsResult } from "../protocol.ts";
import { voiceList } from "./voices.ts";
import { writeAtomic, type StudioWorkspace } from "./workspace.ts";

/** 素材の依頼表を書く場所（作品のフォルダからの相対。書き出し先と同じ exports/ の下。Studio の .gitignore の既定で外れる）。 */
export const ASSET_REQUESTS_FILE = "exports/asset-requests.csv";

/** 立ち絵の差分が無いという診断（@liminalia/lang の check.ts の unknown-variant の文）。 */
const UNKNOWN_VARIANT = /^(.+) の (.+) に差分 (.+) はありません$/;

/**
 * 素材の依頼表（絵と音の担当に頼むもの）。シナリオとキャラクターが使っているのに無い素材、無い立ち絵の差分、収録していないボイスを、
 * 初めて使う行（ファイルの名前順、行の順。「はじめから」のファイルを先に）と、そこの本文、使う回数と一緒に並べる。
 */
export function assetRequests(ws: StudioWorkspace): AssetRequest[] {
  const files = ws.files();
  const entry = ws.project.config.entry.split("#")[0]!;
  const order = [...files.filter((f) => f === entry), ...files.filter((f) => f !== entry)];
  const rank = new Map(order.map((f, i) => [f, i] as const));
  const index = ws.assets();
  const sets = new Map<string, Set<string>>();
  const exists = (folder: string, path: string) => {
    if (!index[folder]) return existsSync(join(ws.project.paths.assets, folder, path));
    let set = sets.get(folder);
    if (!set) sets.set(folder, (set = new Set(index[folder])));
    return set.has(path);
  };
  const texts = new Map<string, string[]>();
  const lineText = (file: string, line: number) => {
    let lines = texts.get(file);
    if (!lines) texts.set(file, (lines = ws.script(file).text.split("\n")));
    return (lines[line - 1] ?? "").trim();
  };
  const byKey = new Map<string, AssetRequest>();
  const add = (key: string, row: Omit<AssetRequest, "count">) => {
    const had = byKey.get(key);
    if (had) had.count++;
    else byKey.set(key, { ...row, count: 1 });
  };
  for (const file of order) {
    for (const r of assetReferences(ws.script(file).script, ws.commands)) {
      if (!exists(r.folder, r.path)) add(`asset:${r.folder}/${r.path}`, { kind: "asset", folder: r.folder, name: r.path, file, line: r.line, text: lineText(file, r.line) });
    }
  }
  // キャラクターの定義（cast.json）が指す立ち絵
  for (const r of castAssetReferences(ws.castFile.cast as Record<string, unknown>)) {
    const folder = r.folder ?? "fgimage";
    if (!exists(folder, r.path)) add(`asset:${folder}/${r.path}`, { kind: "asset", folder, name: r.path, who: r.who, file: "cast.json", line: 1, text: "" });
  }
  // 無い立ち絵の差分（構文チェックの unknown-variant）
  for (const d of ws.check().diagnostics) {
    const m = d.code === "unknown-variant" ? UNKNOWN_VARIANT.exec(d.message) : null;
    if (!m || !rank.has(d.file)) continue;
    const [, who, appearance, variant] = m;
    add(`variant:${who}\u0000${appearance}\u0000${variant}`, { kind: "variant", folder: "fgimage", name: appearance === "default" ? variant! : `${appearance}/${variant}`, who: who!, file: d.file, line: d.line, text: lineText(d.file, d.line) });
  }
  // 収録していないボイス（決まった名前のファイルが無い台詞）
  for (const r of voiceList(ws).rows) {
    if (r.voice === "" || r.exists || byKey.has(`asset:${r.folder}/${r.voice}`)) continue;
    add(`voice:${r.folder}/${r.voice}`, { kind: "voice", folder: r.folder, name: r.voice, who: r.speaker, file: r.file, line: r.line, text: lineText(r.file, r.line) });
  }
  const at = (r: AssetRequest) => rank.get(r.file) ?? Number.MAX_SAFE_INTEGER;
  return [...byKey.values()].sort((a, b) => at(a) - at(b) || a.line - b.line);
}

/** 依頼表の CSV（Excel で文字化けしないよう BOM を付ける。改行は CRLF）。 */
export function assetRequestsCsv(rows: readonly AssetRequest[], english: boolean): string {
  const kinds = english ? { asset: "Asset", variant: "Sprite variant", voice: "Voice" } : { asset: "素材", variant: "立ち絵の差分", voice: "ボイス" };
  const head = english ? ["Kind", "Folder", "Name", "Character", "First used in", "Line", "Text", "Uses"] : ["種類", "フォルダ", "名前", "キャラクター", "初めて使うファイル", "行", "その行", "使う回数"];
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [head, ...rows.map((r) => [kinds[r.kind], r.folder, r.name, r.who ?? "", r.file === "cast.json" ? r.file : `${r.file}.lim`, r.line, r.text, r.count])];
  return `﻿${lines.map((l) => l.map(cell).join(",")).join("\r\n")}\r\n`;
}

/** 依頼表を exports/asset-requests.csv に書く。 */
export function writeAssetRequests(ws: StudioWorkspace, english: boolean): AssetRequestsResult {
  const rows = assetRequests(ws);
  const path = join(ws.project.root, ...ASSET_REQUESTS_FILE.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeAtomic(path, assetRequestsCsv(rows, english));
  return { path: ASSET_REQUESTS_FILE, count: rows.length };
}
