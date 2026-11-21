import { CHOICE_TEMPLATE } from "./choice.ts";
import { CONFIG_TEMPLATE } from "./config.ts";
import { CONFIRM_TEMPLATE } from "./confirm.ts";
import { ENDING_TEMPLATE } from "./ending.ts";
import { HELP_TEMPLATE } from "./help.ts";
import { BACKLOG_TEMPLATE } from "./backlog.ts";
import { MENU_TEMPLATE } from "./menu.ts";
import { SAVELOAD_TEMPLATE } from "./saveload.ts";
import { TITLE_TEMPLATE } from "./title.ts";

/**
 * 標準の画面の型（画面の名前 → 型の文字）。書き直した画面から足していく。
 * 遊ぶ側は、確認の画面のほかを初めて開くときに読む（system/standard-templates.ts。書き出しでは別の束になる）。
 */
export const STANDARD_TEMPLATES: Readonly<Record<string, string>> = { confirm: CONFIRM_TEMPLATE, menu: MENU_TEMPLATE, help: HELP_TEMPLATE, ending: ENDING_TEMPLATE, choice: CHOICE_TEMPLATE, saveload: SAVELOAD_TEMPLATE, backlog: BACKLOG_TEMPLATE, title: TITLE_TEMPLATE, config: CONFIG_TEMPLATE };
