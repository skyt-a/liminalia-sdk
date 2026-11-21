import type { StandardScreen } from "@liminalia/lang";

/**
 * 標準の操作説明の型（docs/design/screen-templates.md）。作品は ui/screens/help/help.html に写して直せる（liminalia.json の ui.templates.help）。
 * 部品を変えたら、その部品の data-version を一つ上げる。クラス名は screen-catalog.ts の help の classes と parts のまま保つ。
 * タブ（tabs の一行は tab）は作品のページ（ui.help.pages）があるときだけ出す（data-if="tabs"）。タブを押すと body の一覧を作り直す:
 * 一つ目のタブは操作の表（controls。行は row）、ほかは作品のページ（page）。
 * 値（data-field、data-attr-*）: tab は label と current（今のタブなら "true"、ほかは "false"。aria-pressed に書く）、
 * row は label、keyboard、touch、pad（無い操作は「—」）、page は title、image（絵の URL）、text。
 * 押すと起きること（data-role）: close（閉じる。Esc と右クリックも同じ）、tab の page（そのタブを出す）。
 * 状態（data-lm-*）: 今のタブの一行に data-lm-current。
 */
export const HELP_TEMPLATE = `<template data-part="screen" data-version="1">
<div class="lm-screen lm-help">
  <header class="lm-screen-header">
    <h2 class="lm-screen-title" data-text="help.heading"></h2>
    <nav class="lm-tabs" data-if="tabs" data-list="tabs" data-item="tab"></nav>
    <button class="lm-button lm-close" data-role="close" data-text="close"></button>
  </header>
  <div class="lm-help-body" data-list="body" data-item="controls"></div>
</div>
</template>
<template data-part="tab" data-version="1">
<button class="lm-tab" data-role="page" data-field="label" data-attr-aria-pressed="current"></button>
</template>
<template data-part="controls" data-version="1">
<table class="lm-help-table">
  <thead>
    <tr><th></th><th data-text="help.keyboard"></th><th data-text="help.touch"></th><th data-text="help.pad"></th></tr>
  </thead>
  <tbody data-list="rows" data-item="row"></tbody>
</table>
</template>
<template data-part="row" data-version="1">
<tr><th data-field="label"></th><td data-field="keyboard"></td><td data-field="touch"></td><td data-field="pad"></td></tr>
</template>
<template data-part="page" data-version="1">
<div class="lm-help-page">
  <img data-if="image" data-attr-src="image" alt="" draggable="false">
  <p class="lm-help-text" data-if="text" data-field="text"></p>
</div>
</template>
`;

/** 操作説明の決まり（lim check が作品の写したテンプレートを確かめるのに読む）。 */
export const HELP_SCREEN: StandardScreen = {
  template: HELP_TEMPLATE,
  roles: ["close", "page"],
  fields: ["tabs", "label", "current", "keyboard", "touch", "pad", "title", "image", "text"],
  required: [["close"]],
  replacedBy: ["screens.help", "system"],
};
