import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { applyLayers, castProblems, type Cast } from "@liminalia/lang";
import { loadProject } from "@liminalia/project";
import { importPsd } from "@liminalia/project/psd";

/**
 * lim psd [プロジェクト] <ファイル.psd|.psb> <キャラクター> [--appearance default] [--folder フォルダ]
 * PSD / PSB のレイヤーを、パーツ合成の立ち絵（キャストの layers）として取り込む。絵は fgimage の folder（既定はキャラクター名、
 * 立ち絵セットが default 以外なら キャラクター名/立ち絵セット）に PNG で書き、cast.json の立ち絵セットの層を置き換える。
 * 差分（parts）は残る層と絵のものだけを残す。差分が無ければ、表示していたレイヤーで出す normal を作る。
 */
export async function runPsd(dir: string, file: string, who: string, o: { appearance?: string; folder?: string }): Promise<boolean> {
  const project = loadProject(dir);
  const appearance = o.appearance ?? "default";
  const folder = o.folder ?? (appearance === "default" ? who : `${who}/${appearance}`);
  const r = await importPsd(readFileSync(file), folder);
  const root = join(project.paths.assets, "fgimage");
  for (const img of r.images) {
    const path = join(root, ...img.path.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, img.png);
  }
  const json = (existsSync(project.paths.cast) ? JSON.parse(readFileSync(project.paths.cast, "utf8")) : {}) as { speakers?: string[]; cast?: Cast };
  const cast = (json.cast ??= {});
  const isNew = !cast[who];
  applyLayers(cast, who, appearance, r.layers);
  if (isNew && !(json.speakers ??= []).includes(who)) json.speakers.push(who);
  writeFileSync(`${project.paths.cast}.tmp`, `${JSON.stringify(json, null, 2)}\n`);
  renameSync(`${project.paths.cast}.tmp`, project.paths.cast);
  console.log(`${who} / ${appearance}: ${r.layers.length} 層、絵 ${r.images.length} 枚（${r.width}×${r.height}）→ ${relative(project.root, join(root, ...folder.split("/")))}`);
  for (const l of r.layers) console.log(l.default ? `  ${l.name}: ${Object.keys(l.options).join(" / ")}（既定 ${l.default}）` : `  ${l.name}: ${Object.keys(l.options).join(" / ")}`);
  for (const w of r.warnings) console.log(`注意: ${w}`);
  const problems = castProblems({ [who]: cast[who] });
  for (const p of problems) console.log(`エラー: ${p.message}`);
  return problems.length === 0;
}
