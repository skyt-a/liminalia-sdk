import type { StandardScreen } from "@liminalia/lang";

/**
 * 標準の確認の画面の型（docs/design/screen-templates.md）。作品は ui/screens/confirm/confirm.html に写して直せる（liminalia.json の ui.templates.confirm）。
 * 部品を変えたら、その部品の data-version を一つ上げる（写した作品に、標準が変わったことを知らせる）。
 * クラス名は screen-catalog.ts の confirm の classes と parts のまま保つ（作品の CSS が写した画面にも効くように）。
 * 値（data-field）: message（尋ねる文）、yes と no（ボタンの文言）、kind（何の確かめか）。
 * 見えない見出し（confirm.heading）が画面の名前（aria-labelledby）、尋ねる文（data-field="message"）が説明（aria-describedby）になる。
 * 版 2: 見えない見出しを足した（版 1 は名前の無いダイアログとして読まれた）。
 * 押すと起きること（data-role）: ok（はい）、cancel と close（いいえ。Esc と右クリックも同じ）。
 */
export const CONFIRM_TEMPLATE = `<template data-part="screen" data-version="2">
<div class="lm-dialog-backdrop">
  <div class="lm-dialog" role="alertdialog">
    <h2 class="lm-sr-only" data-text="confirm.heading"></h2>
    <p class="lm-dialog-message" data-field="message"></p>
    <div class="lm-dialog-buttons">
      <button class="lm-button" data-role="cancel" data-field="no"></button>
      <button class="lm-button lm-primary" data-role="ok" data-field="yes" data-autofocus></button>
    </div>
  </div>
</div>
</template>
`;

/**
 * 確認の画面の決まり（lim check と制作画面のチェックが、作品の写したテンプレートを確かめるのに読む。rules.ts が並べる）。
 * 働く値を足したら、確認の画面を作るところ（system/confirm.ts）とここを一緒に直す。
 */
export const CONFIRM_SCREEN: StandardScreen = {
  template: CONFIRM_TEMPLATE,
  roles: ["ok", "cancel", "close"],
  fields: ["message", "yes", "no", "kind"],
  // はいを押せること、閉じられること
  required: [["ok"], ["close", "cancel", "ok"]],
  // プラグインの screens.confirm と、システム画面を丸ごと差し替える system（ui-probe.ts の replacedScreens と同じ見方）
  replacedBy: ["screens.confirm", "system"],
};
