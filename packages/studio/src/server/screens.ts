import type { ScreenTemplateRules } from "@liminalia/lang";
import type { ScreenInfo } from "../protocol.ts";

/**
 * 標準の画面の一覧（GET /screens。制作画面の「ゲームの画面」が並べる）。制作画面は描画側を読まないので、
 * 開発サーバーを立てる側（web の vite.config.ts、スマホ版の Service Worker）が @liminalia/web の screen-preview/samples.ts の
 * screenPreviewTable を渡す。渡さなければ空。
 */
let table: readonly ScreenInfo[] = [];

export function setScreenTable(next: readonly ScreenInfo[]): void {
  table = next;
}

export function screenTable(): readonly ScreenInfo[] {
  return table;
}

/**
 * 標準の画面の決まり（作品の画面のテンプレート ui.templates のチェックに使う。@liminalia/web/screen-rules の screenTemplateRules）。
 * 制作画面は描画側を読まないので、開発サーバーを立てる側（web の vite.config.ts、スマホ版の Service Worker、lim mcp）が渡す。
 * 渡さなければテンプレートを確かめない（lim check と同じ一覧にするには、必ず渡す）。
 */
let rules: ScreenTemplateRules | null = null;

export function setScreenTemplateRules(next: ScreenTemplateRules): void {
  rules = next;
}

export function screenTemplateRules(): ScreenTemplateRules | null {
  return rules;
}
