import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkUi, isPortrait, PLUGIN_API_VERSION, UI_THEMES, uiThemeValues } from "@liminalia/lang";
import { listUiThemes } from "@liminalia/project";
import type { AssetTrashResult, ThemeSaveResult } from "../protocol.ts";
import { moveToTrash, THEME_TRASH } from "./manage.ts";
import { StudioError, writeAtomic, type StudioWorkspace } from "./workspace.ts";

/**
 * 作品の中のテーマ（themes/<id>/theme.json）を書く・外す。読むのは @liminalia/project の listUiThemes。
 * テーマはゲームの設定（liminalia.json の ui）へ値を写す元なので、書き出すゲームには入らない。
 */

/** 名前の長さの上限（札に出すので長すぎるものは受けない）。 */
const NAME_MAX = 40;

/**
 * 名前からフォルダの名前を作る（英数字・_・- だけ。日本語の名前は theme になる）。用意したテーマと同じ ID を使うとそのテーマを隠してしまうので避け、
 * ほかと重なれば -2・-3… を付ける。
 */
export function themeIdFor(name: string, taken: ReadonlySet<string>): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = slug === "" ? "theme" : slug;
  const used = (id: string) => taken.has(id) || UI_THEMES.some((t) => t.id === id);
  if (!used(base)) return base;
  for (let i = 2; ; i++) if (!used(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * 今の見た目（liminalia.json の ui のうちテーマが扱う項目）を、名前を付けて作品のテーマにする。
 * 縦長の作品で保存したものは縦長専用にする（枠の位置や幅は作品の向きの座標で決めてあるので。チャットの設定を含まないテーマも同じ）。
 */
export function saveTheme(ws: StudioWorkspace, rawName: string, overwrite: boolean): ThemeSaveResult {
  const name = rawName.trim();
  if (name === "") throw new StudioError(400, "テーマの名前を入れてください");
  if (name.length > NAME_MAX) throw new StudioError(400, `テーマの名前は ${NAME_MAX} 字までです`);
  if (UI_THEMES.some((t) => t.name === name || t.nameEn === name)) throw new StudioError(400, `「${name}」は用意されたテーマの名前なので使えません`);
  const local = listUiThemes(ws.project.root).filter((t) => t.local);
  const same = local.find((t) => t.name === name);
  if (same && !overwrite) return { ok: false, exists: same.id };
  const ui = uiThemeValues(ws.readUi() ?? {});
  const problems = checkUi(ui);
  if (problems.length > 0) throw new StudioError(400, problems.map((p) => p.message).join("\n"));
  const id = same?.id ?? themeIdFor(name, new Set(local.map((t) => t.id)));
  const nameEn = same && same.nameEn !== same.name ? { nameEn: same.nameEn } : {};
  const orientation = isPortrait(ws.project.screen) ? { orientation: "portrait" } : {};
  // engines.liminalia: 合うエンジンの口の版（今の版の項目で作ったので、それより前のエンジンでは lim check が知らせる）
  const engines = { liminalia: `>=${PLUGIN_API_VERSION}` };
  writeAtomic(join(themeDir(ws, id), "theme.json"), `${JSON.stringify({ name, ...nameEn, ...orientation, engines, ui }, null, 2)}\n`);
  return { ok: true, id };
}

/** 作品のテーマをごみ箱に入れる（素材の themes/<id>/assets/ ごと）。用意されたテーマは消せない。 */
export function trashTheme(ws: StudioWorkspace, id: string): AssetTrashResult {
  const dir = themeDir(ws, id);
  const file = join(dir, "theme.json");
  if (!existsSync(file)) {
    if (UI_THEMES.some((t) => t.id === id)) throw new StudioError(400, "用意されたテーマは削除できません");
    throw new StudioError(404, `テーマがありません: ${id}`);
  }
  return { id: moveToTrash(ws, dir, THEME_TRASH, id), moved: [`themes/${id}`] };
}

function themeDir(ws: StudioWorkspace, id: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(id)) throw new StudioError(400, `テーマの ID として使えません: ${id}`);
  return join(ws.project.root, "themes", id);
}
