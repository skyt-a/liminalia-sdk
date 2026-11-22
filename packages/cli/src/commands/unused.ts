import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { dynamicAssetUses, mediaKindOf, parse, referencedAssetKeys, type Diagnostic, type Script } from "@liminalia/lang";
import { assetAlwaysUsed, assetNameKey, assetTextUses, listScenarioFiles, readAssetTextFiles, readScenarioFile, type AssetTextUse } from "@liminalia/project";
import { loadContext, type Context } from "../context.ts";
import { projectCheck } from "./check.ts";
import { formatBytes } from "./clean.ts";

/**
 * lim unused [プロジェクト] [--all] [--json] — どこからも参照されていない素材の候補を出す。
 *
 * 参照は lim check・lim build と同じ集め方（台本の命令と本文の中の命令、キャストの定義、liminalia.json のおまけ・持ち物・ゲームの設定。
 * @liminalia/lang の referencedAssetKeys）。そのほかに、素材の名前（拡張子つきか拡張子なし）が、台本、データ、設定、作品の CSS と画面のテンプレート、
 * パック、訳、作品のプラグイン（作品の外や node_modules のものも）、立ち絵のモデル（Live2D の .model3.json、Spine の .atlas）のどこかに
 * 文字として出てくれば「使っていそう」として外す（@liminalia/project の assetTextUses。制作画面の素材の「未使用だけ」と同じ数え方）。
 * 連番の型（@flipbook の slash_{nn}.png）に当たるものと、式でつなぐ名前の一部（"radio_" + n）が出てくるものも外す。
 * 名前は大文字と小文字、濁点などの合成の違いを問わずに比べる。選んだテーマが写した素材（image/themes/<id>/）はそのテーマが読むので外す。
 * 自動の連番で鳴らす声（voice/）は名前が台本に出ないので、--all を付けたときだけ見る。消すかどうかは人が決める（何も消さない）。
 */

export interface UnusedAsset {
  path: string;
  bytes: number;
}

const ASSET_FOLDERS = ["bgimage", "fgimage", "image", "bgm", "sound", "voice", "video", "others"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 素材の型の引数を式で書いた命令（どの素材を使うか台本から分からない。lim build の「使っている素材だけ」はこのフォルダを外さない）。 */
export interface DynamicAssetUse {
  file: string;
  folder: string;
  line: number;
  source: string;
}

/** 名前そのものではなく、連番の型か式でつなぐ名前の一部が出てくるので候補から外した素材（how は AssetTextUse の how）。 */
export interface GuessedAssetUse {
  path: string;
  where: string;
  line: number;
  how: "pattern" | "fragment";
}

export async function findUnusedAssets(dir: string, o: { all?: boolean } = {}): Promise<{ unused: UnusedAsset[]; checked: number; skippedVoice: number; dynamic: DynamicAssetUse[]; guessed: GuessedAssetUse[] }> {
  const ctx = await loadContext(dir);
  const { project } = ctx;
  const scripts = new Map<string, Script>();
  const texts: { where: string; text: string }[] = [];
  for (const { name, path } of listScenarioFiles(project.paths.scenario)) {
    const { text } = readScenarioFile(path);
    scripts.set(name, parse(text, name, { speakers: ctx.cast.speakers }));
    texts.push({ where: `${relative(project.root, path).split(sep).join("/")}`, text });
  }
  // 大文字と小文字、合成の違いだけの参照も「使っている」に数える（lim check が asset-case-mismatch で知らせる）
  const referenced = new Set([...referencedAssetKeys({ scripts, registry: ctx.registry, cast: ctx.cast.cast, castFile: "cast.json", extra: project.config.extra, items: project.config.items, ui: project.config.ui })].map(assetNameKey));
  const candidates: { folder: string; path: string; file: string }[] = [];
  let checked = 0;
  let skippedVoice = 0;
  for (const folder of ASSET_FOLDERS) {
    for (const file of walk(join(project.paths.assets, folder))) {
      // 書き出しに入らない種類（.psd など）は素材として数えない
      if (!mediaKindOf(file)) continue;
      const rel = relative(join(project.paths.assets, folder), file).split(sep).join("/");
      if (folder === "voice" && !o.all) {
        skippedVoice++;
        continue;
      }
      checked++;
      if (referenced.has(assetNameKey(`${folder}/${rel}`)) || assetAlwaysUsed(folder, rel, project.config.ui)) continue;
      candidates.push({ folder, path: rel, file });
    }
  }
  const uses = assetTextUses([...texts, ...readAssetTextFiles(project)], candidates);
  const unused: UnusedAsset[] = [];
  const guessed: GuessedAssetUse[] = [];
  for (const c of candidates) {
    const found: AssetTextUse[] | undefined = uses.get(`${c.folder}/${c.path}`);
    if (!found) unused.push({ path: `${c.folder}/${c.path}`, bytes: statSync(c.file).size });
    else if (found.every((u) => u.how !== "name")) {
      const u = found[0]!;
      guessed.push({ path: `${c.folder}/${c.path}`, where: u.where, line: u.line, how: u.how as "pattern" | "fragment" });
    }
  }
  unused.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return { unused, checked, skippedVoice, dynamic: dynamicAssetUses({ scripts, registry: ctx.registry }), guessed };
}

/**
 * 書き出しの「使っている素材だけ」（lim build --only-used・build.onlyUsed）で外す素材。lim unused の候補から、
 * 式で名前を組み立てて使うフォルダの素材を除いたもの（声 voice/ とテーマの素材はもともと候補に入らない）。
 * drop は素材のフォルダからのパス（"bgimage/a.png"）、kept は式で使うので外さなかったフォルダとその命令。
 */
export async function assetsToDropForBuild(dir: string): Promise<{ drop: UnusedAsset[]; kept: { folder: string; uses: DynamicAssetUse[]; files: number }[]; guessed: GuessedAssetUse[] }> {
  const r = await findUnusedAssets(dir);
  const dynamicFolders = new Map<string, DynamicAssetUse[]>();
  for (const d of r.dynamic) dynamicFolders.set(d.folder, [...(dynamicFolders.get(d.folder) ?? []), d]);
  const drop: UnusedAsset[] = [];
  const keptCount = new Map<string, number>();
  for (const a of r.unused) {
    const folder = a.path.split("/")[0]!;
    if (dynamicFolders.has(folder)) keptCount.set(folder, (keptCount.get(folder) ?? 0) + 1);
    else drop.push(a);
  }
  const kept = [...keptCount].map(([folder, files]) => ({ folder, uses: dynamicFolders.get(folder)!, files }));
  return { drop, kept, guessed: r.guessed };
}

/**
 * 外す素材（素材のフォルダからのパス）を無いものとして、lim check と同じ検査（素材の実在、プラグインの検査。@flipbook のコマ、Live2D の Core など）を
 * 流し直し、外すと新しく出る診断が名指す素材を返す。外す判定（findUnusedAssets）と別の入力で、外しすぎを止める。
 * 名指さない診断が残れば、外す素材をすべて返す（安全な側に倒す）。problems は外すと新しく出る診断。
 */
export function assetsNeededByCheck(ctx: Context, drop: readonly string[]): { needed: string[]; problems: Diagnostic[] } {
  if (drop.length === 0) return { needed: [], problems: [] };
  const key = (d: Diagnostic) => `${d.code}\0${d.file}\0${d.line}\0${d.message}`;
  const before = new Set(projectCheck(ctx).diagnostics.map(key));
  const fresh = (hidden: readonly string[]) => {
    const set = new Set(hidden.map(assetNameKey));
    return projectCheck(ctx, { hide: (folder, path) => set.has(assetNameKey(`${folder}/${path}`)) }).diagnostics.filter((d) => !before.has(key(d)));
  };
  const problems = fresh(drop);
  if (problems.length === 0) return { needed: [], problems };
  // 診断の文が名指す素材（"フォルダ/パス" か、フォルダの中のパス）
  const names = (d: Diagnostic) => {
    const text = assetNameKey(`${d.message}\n${d.hint ?? ""}`);
    return drop.filter((rel) => text.includes(assetNameKey(rel)) || text.includes(assetNameKey(rel.slice(rel.indexOf("/") + 1))));
  };
  const needed = new Set(problems.flatMap(names));
  // 名指さない診断があるか、名指した素材を戻してもまだ出るなら、すべて戻す
  if (problems.some((d) => names(d).length === 0) || fresh(drop.filter((rel) => !needed.has(rel))).length > 0) return { needed: [...drop], problems };
  return { needed: [...needed], problems };
}

export async function runUnused(dir: string, o: { all?: boolean; json?: boolean }): Promise<boolean> {
  const r = await findUnusedAssets(dir, o);
  const total = r.unused.reduce((n, a) => n + a.bytes, 0);
  if (o.json) {
    console.log(JSON.stringify({ checked: r.checked, unused: r.unused, bytes: total, skippedVoice: r.skippedVoice, dynamic: r.dynamic, guessed: r.guessed }, null, 2));
    return true;
  }
  if (r.unused.length === 0) console.log(`参照の見つからない素材はありません（${r.checked} 件を確かめました）`);
  else {
    console.log("参照の見つからない素材（大きい順）:");
    for (const a of r.unused) console.log(`  ${a.path}（${formatBytes(a.bytes)}）`);
    console.log(`\n${r.checked} 件のうち ${r.unused.length} 件、合わせて ${formatBytes(total)}。`);
    console.log("名前が台本、データ、設定、作品の CSS とテンプレート、パック、訳、プラグイン、立ち絵のモデルのどこにも出てこないものです。式で名前を組み立てて使う素材は、使っていても出ることがあります（消す前に確かめてください）");
  }
  if (r.skippedVoice > 0) console.log(`声（voice/）の ${r.skippedVoice} 件は自動の連番で鳴らすことがあるので見ていません（--all で見る）`);
  if (r.guessed.length > 0) {
    const g = r.guessed[0]!;
    console.log(`連番の型か、式でつなぐ名前の一部が文字に出てくるので、候補に出さなかった素材が ${r.guessed.length} 件あります（最初は ${g.path}。${g.where}:${g.line}）`);
  }
  const folders = [...new Set(r.dynamic.map((d) => d.folder))];
  if (folders.length > 0 && r.unused.some((a) => folders.includes(a.path.split("/")[0]!))) {
    const first = r.dynamic[0]!;
    console.log(`素材の名前を式で組み立てる命令が ${r.dynamic.length} か所（最初は ${first.file}.lim:${first.line} ${first.source}）あります。${folders.join("、")} の候補は使っていることがあります`);
  }
  return true;
}
