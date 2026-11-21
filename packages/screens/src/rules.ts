import type { ScreenTemplateRules, StandardScreen } from "@liminalia/lang";
import { TEXT } from "./strings.ts";
import { CHOICE_SCREEN } from "./choice.ts";
import { CONFIG_SCREEN } from "./config.ts";
import { CONFIRM_SCREEN } from "./confirm.ts";
import { ENDING_SCREEN } from "./ending.ts";
import { HELP_SCREEN } from "./help.ts";
import { BACKLOG_SCREEN } from "./backlog.ts";
import { MENU_SCREEN } from "./menu.ts";
import { SAVELOAD_SCREEN } from "./saveload.ts";
import { TITLE_SCREEN } from "./title.ts";

/**
 * 標準の画面の決まり（@liminalia/screens/rules。前の @liminalia/web/screen-rules も同じもの）。lim check、制作画面のチェック、VS Code、MCP が、作品のテンプレート（ui.templates）を
 * 確かめるのに読む（@liminalia/lang の checkScreenTemplates。docs/design/screen-templates.md）。遊ぶ画面からは読まない。
 * 画面をテンプレートに書き直したら、その画面のファイル（screens/<画面>.ts）に決まりを書き、ここに並べる。検査の側は書き足さない。
 * DOM を使わない（Node と Service Worker でも読む）。
 */
export const STANDARD_SCREENS: Readonly<Record<string, StandardScreen>> = { confirm: CONFIRM_SCREEN, menu: MENU_SCREEN, help: HELP_SCREEN, ending: ENDING_SCREEN, choice: CHOICE_SCREEN, saveload: SAVELOAD_SCREEN, backlog: BACKLOG_SCREEN, title: TITLE_SCREEN, config: CONFIG_SCREEN };

/** 標準の文言の文字の鍵（data-text に書けるもの。"confirm.yes" など。関数の文言は入れない）。 */
export function textKeys(): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") out.push(path);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(TEXT, "");
  return out;
}

/** テンプレートの検査に渡すエンジンの決まり。 */
export function screenTemplateRules(): ScreenTemplateRules {
  return { screens: STANDARD_SCREENS, textKeys: textKeys() };
}
