import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { assetReferences, castAssetReferences, extraAssetReferences, itemAssetReferences, projectMacros, uiAssetReferences } from "@liminalia/lang";
import { assetAlwaysUsed } from "@liminalia/project";
import type { AssetFolderListing, AssetUsage, AssetUse } from "../protocol.ts";
import { moreAssetUses, textAssetUses } from "./asset-uses.ts";
import { imageHeadSize } from "./image-head.ts";
import type { StudioWorkspace } from "./workspace.ts";

/** 素材のフォルダ（台本の命令が探すものと、素材のフォルダに今あるもの）。 */
export function assetKinds(ws: StudioWorkspace): string[] {
  const root = ws.project.paths.assets;
  const kinds = new Set(ws.assetFolders());
  if (existsSync(root)) for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith(".")) kinds.add(e.name);
  return [...kinds];
}

export function listAssets(ws: StudioWorkspace): AssetFolderListing[] {
  return assetKinds(ws).map((kind) => {
    const root = join(ws.project.paths.assets, kind);
    const files: AssetFolderListing["files"] = [];
    const dirs: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        const rel = relative(root, p).split(sep).join("/");
        if (e.isDirectory()) {
          dirs.push(rel);
          walk(p);
        } else if (e.isFile()) {
          const st = statSync(p);
          const size = imageHeadSize(p, st.mtimeMs, st.size);
          files.push({ path: rel, bytes: st.size, ...(size ?? {}) });
        }
      }
    };
    walk(root);
    const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return { kind, files: files.sort((a, b) => byName(a.path, b.path)), dirs: dirs.sort(byName) };
  });
}

/** 素材を使っている場所（"種類/パス" → 場所）。 */
export function assetUsage(ws: StudioWorkspace): AssetUsage {
  const out: AssetUsage = {};
  const add = (folder: string, path: string, use: AssetUse) => (out[`${folder}/${path}`] ??= []).push(use);
  // マクロ（@define）の素材の型の引数と、本文の中の命令（{@se …}）も数える（lim unused と同じ集め方）
  const scripts = ws.files().map((file) => [file, ws.script(file).script] as const);
  const macros = projectMacros(scripts);
  for (const [file, script] of scripts) for (const r of assetReferences(script, ws.commands, macros)) add(r.folder, r.path, { in: "script", file, line: r.line });
  const seen = new Set<string>();
  for (const r of castAssetReferences(ws.castFile.cast)) {
    const folder = r.folder ?? "fgimage";
    if (seen.has(`${r.who}\0${folder}/${r.path}`)) continue;
    seen.add(`${r.who}\0${folder}/${r.path}`);
    add(folder, r.path, { in: "cast", who: r.who });
  }
  const config = ws.readConfig();
  for (const r of extraAssetReferences(config.extra)) add(r.folder, r.path, { in: "config", where: r.where });
  for (const r of itemAssetReferences(config.items)) add(r.folder, r.path, { in: "config", where: r.where });
  for (const r of uiAssetReferences(ws.readUi())) add(r.folder, r.path, { in: "config", where: r.where });
  for (const r of moreAssetUses(ws)) add(r.folder, r.path, r.use);
  // 構文で見つからなかった素材は、名前が文字として現れるかを見る（マクロの引数・変数の文字列・テーマなど）。見つかったものには足さない（一覧が名前の偶然の一致で埋まらないように）
  // 選んだテーマが写した素材（image/themes/<id>/）はそのテーマが読む（lim unused と同じ）
  const ui = ws.readUi();
  for (const path of assetFilesIn(ws, "image")) if (assetAlwaysUsed("image", path, ui)) add("image", path, { in: "config", where: "ui.system.preset" });
  const unused = assetKinds(ws).flatMap((folder) => assetFilesIn(ws, folder).flatMap((path) => (out[`${folder}/${path}`] ? [] : [{ folder, path }])));
  for (const r of textAssetUses(ws, unused)) add(r.folder, r.path, r.use);
  return out;
}

/** 素材の種類の中のファイル（一覧と同じく . で始まるものは除く）。 */
function assetFilesIn(ws: StudioWorkspace, kind: string): string[] {
  const root = join(ws.project.paths.assets, kind);
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
      else if (e.isFile()) files.push(`${prefix}${e.name}`);
    }
  };
  walk(root, "");
  return files;
}
