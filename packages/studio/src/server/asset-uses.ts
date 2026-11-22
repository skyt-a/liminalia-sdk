import { isAbsolute, join, relative, sep } from "node:path";
import { assetTextUses, readAssetTextFiles } from "@liminalia/project";
import type { AssetUse } from "../protocol.ts";
import { autoVoiceUses } from "./voices.ts";
import type { StudioWorkspace } from "./workspace.ts";

/**
 * シナリオの命令・本文の中の命令・キャラクター・設定の参照（manage.ts の assetUsage）のほかに、素材を使っている場所。
 * 「使われていない」と見えた素材をまとめてごみ箱に入れられるので、分かるものは拾っておく。
 * - @voice-auto の連番のボイス
 * - 書き出しのアイコン（build.icon）が素材のフォルダの中にあるとき
 * それでも見つからない素材は textAssetUses が文字として探す。
 */
export function moreAssetUses(ws: StudioWorkspace): { folder: string; path: string; use: AssetUse }[] {
  const out = autoVoiceUses(ws);
  const icon = ws.readConfig().build?.icon;
  if (icon) {
    const rel = relative(ws.project.paths.assets, isAbsolute(icon) ? icon : join(ws.project.root, icon));
    const [folder, ...rest] = rel.split(sep);
    if (folder && folder !== ".." && rest.length > 0) out.push({ folder, path: rest.join("/"), use: { in: "config", where: "build.icon" } });
  }
  return out;
}

// ---- 文字としての一致 ----

type TextSource = { where: string; text: string };
type AssetPath = { folder: string; path: string };
type LocatedUse = AssetPath & { use: AssetUse };

const textUsage = new WeakMap<StudioWorkspace, {
  sources: TextSource[];
  assets: readonly AssetPath[];
  uses: LocatedUse[];
}>();

/**
 * 構文を追っても見つからなかった素材のうち、名前が文字として現れるもの。探す所と探し方は lim unused と同じ（@liminalia/project の
 * assetTextFiles と assetTextUses。全シナリオ、データ、設定、cast.json、テーマ、作品の CSS とテンプレート、パック、訳、プラグイン、立ち絵のモデル）。
 * マクロの引数・変数へ入れる文字列・条件式の文字列・テーマ・書き出しの設定・連番の型・式でつなぐ名前の一部などは、ここで「使っている可能性あり」になる。
 */
export function textAssetUses(ws: StudioWorkspace, assets: readonly AssetPath[]): LocatedUse[] {
  if (assets.length === 0) return [];
  const scenarios = ws.files().map((file) => ({ where: file, text: ws.script(file).text }));
  // 台本は作業場の中身を使う（ファイルからは読まない）
  const others = readAssetTextFiles({ ...ws.project, config: ws.readConfig() }).filter((t) => t.source !== "scenario");
  const sources = [...scenarios, ...others];
  const previous = textUsage.get(ws);
  if (previous?.sources.length === sources.length && previous.assets.length === assets.length &&
    sources.every((source, i) => source.where === previous.sources[i]!.where && source.text === previous.sources[i]!.text) &&
    assets.every((asset, i) => asset.folder === previous.assets[i]!.folder && asset.path === previous.assets[i]!.path)) return previous.uses;

  const names = new Set(scenarios.map((t) => t.where));
  const uses = assetTextUses(sources, assets);
  const located = assets.flatMap((a) => (uses.get(`${a.folder}/${a.path}`) ?? []).map((u) => ({ folder: a.folder, path: a.path, use: { in: "text" as const, where: u.where, line: u.line, scenario: names.has(u.where) } })));
  textUsage.set(ws, { sources, assets, uses: located });
  return located;
}
