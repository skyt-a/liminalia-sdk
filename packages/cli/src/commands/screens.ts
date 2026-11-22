import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copyScreen, diffScreen, resetScreen, writeScreenScript, type ScreenDiff } from "@liminalia/project/screen-copy";
import { pluginScreens } from "@liminalia/project/screen-templates";
import { screenTemplateRules } from "@liminalia/web/screen-rules";
import { engineVersion } from "../version.ts";

/**
 * lim screens — 標準の画面のテンプレートを作品に写す（copy）、標準との違いを見る（diff）、標準に戻す（reset）、画面の JS の雛形を置く（js）。
 * 中身は @liminalia/project/screen-copy。写せる画面は標準の画面の一覧（@liminalia/web/screen-rules の STANDARD_SCREENS）から決まる。
 * docs/design/screen-templates.md の「写し出し」と「画面の JS」。
 */

export type ScreensAction = "copy" | "diff" | "reset" | "js";
export const SCREENS_ACTIONS: readonly ScreensAction[] = ["copy", "diff", "reset", "js"];

export interface ScreensOptions {
  parts?: string[];
  force?: boolean;
  js?: boolean;
  json?: boolean;
}

/** その画面を先に差し替えるプラグイン（あれば「プラグイン 名前 の 口」。後のプラグインが勝つ）。 */
export function screenOverriddenBy(dir: string, screen: string): string | null {
  const std = screenTemplateRules().screens[screen];
  if (!std) return null;
  let raw: { plugins?: unknown; ui?: { system?: { preset?: unknown } } } = {};
  try {
    raw = JSON.parse(readFileSync(join(dir, "liminalia.json"), "utf8")) as typeof raw;
  } catch {
    // 読めなければ知らせない（lim check が知らせる）
    return null;
  }
  const preset = typeof raw.ui?.system?.preset === "string" ? raw.ui.system.preset : undefined;
  let by: string | null = null;
  for (const p of pluginScreens(dir, Array.isArray(raw.plugins) ? (raw.plugins as string[]) : [])) {
    const themed = preset !== undefined ? std.replacedBy.find((k) => p.themes?.[preset]?.includes(k)) : undefined;
    const hit = std.replacedBy.find((k) => p.replaces.includes(k));
    if (themed) by = `プラグイン ${p.plugin} のテーマ ${preset} の ${themed}`;
    else if (hit) by = `プラグイン ${p.plugin} の ${hit}`;
  }
  return by;
}

/** 標準との違いを人が読む形にする。 */
export function screenDiffText(d: ScreenDiff): string {
  const lines: string[] = [`画面 ${d.screen}（${d.file}）`, "", "作品のテンプレートと今の標準の違い"];
  for (const p of d.parts) {
    if (p.standardVersion === undefined) lines.push(`部品 ${p.part}: 標準に無い部品です（使われません）`);
    else if (p.authorDiff === "") lines.push(`部品 ${p.part}: 標準と同じです`);
    else lines.push(`部品 ${p.part}:`, p.authorDiff.trimEnd());
  }
  lines.push("", "コピー元のバージョンから現在の標準テンプレートで変わった箇所");
  for (const p of d.parts) {
    const c = p.standardChange;
    if (p.standardVersion === undefined) continue;
    if (!c) lines.push(`部品 ${p.part}: 変わっていません（バージョン ${p.standardVersion}）`);
    else if ("missingOriginal" in c) lines.push(`部品 ${p.part}: バージョン ${c.from ?? "なし"} からバージョン ${c.now} に変わりました（コピー元のファイルが .liminalia/screens に無いので、バージョン番号だけを表示します）`);
    else lines.push(`部品 ${p.part}: バージョン ${c.from} からバージョン ${c.now} に変わりました`, c.diff.trimEnd());
  }
  if (d.parts.some((p) => p.standardChange)) lines.push("", "標準の変更点をプロジェクトのテンプレートに反映したら、その部品の data-version を現在のバージョンにします");
  return lines.join("\n");
}

export function runScreens(dir: string, action: string | undefined, screen: string | undefined, o: ScreensOptions = {}): boolean {
  if (!action || !(SCREENS_ACTIONS as readonly string[]).includes(action)) throw new Error(`lim screens の次に ${SCREENS_ACTIONS.join("、")} のどれかを書きます`);
  const screens = screenTemplateRules().screens;
  if (!screen) throw new Error(`画面の名前を書きます（テンプレートで作れる画面: ${Object.keys(screens).join("、")}）`);
  switch (action as ScreensAction) {
    case "copy": {
      const r = copyScreen(dir, screens, screen, { ...(o.parts ? { parts: o.parts } : {}), force: o.force === true, js: o.js === true, engine: engineVersion() });
      if (o.json) {
        console.log(JSON.stringify(r, null, 2));
        return true;
      }
      console.log(`${r.file} に画面 ${screen} のテンプレートをコピーしました（部品: ${r.parts.join("、")}）`);
      if (r.registered) console.log(`liminalia.json の ui.templates.${screen} に登録しました`);
      console.log(`コピー元のファイルを ${r.originals.join("、")} に残しました（標準との違いは lim screens diff ${screen}）`);
      if (r.script) console.log(`画面の JS の雛形を ${r.script} に置きました`);
      const by = screenOverriddenBy(dir, screen);
      if (by) console.warn(`ui.templates.${screen} は使われません。${by} が先です（テンプレートを使うなら、プラグインからその画面を外します）`);
      console.log(`テンプレートを直したら、lim check で確かめ、lim shot --screen ${screen} で撮って見ます`);
      return true;
    }
    case "js": {
      const file = writeScreenScript(dir, screens, screen, { force: o.force === true });
      console.log(`画面の JS の雛形を ${file} に置きました（作品のプラグインと同じく、--restricted のときは読みません）`);
      return true;
    }
    case "diff": {
      const d = diffScreen(dir, screens, screen);
      console.log(o.json ? JSON.stringify(d, null, 2) : screenDiffText(d));
      return true;
    }
    case "reset": {
      const r = resetScreen(dir, screen);
      if (r.unregistered) console.log(`liminalia.json の ui.templates.${screen} を外し、標準の画面に戻しました`);
      for (const m of r.moved) console.log(`${m.from} は ${m.to} に名前を変えて残しました`);
      return true;
    }
  }
}
