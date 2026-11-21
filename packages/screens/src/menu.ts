import type { StandardScreen } from "@liminalia/lang";

/**
 * 標準のメニューの型（docs/design/screen-templates.md）。作品は ui/screens/menu/menu.html に写して直せる（liminalia.json の ui.templates.menu）。
 * 部品を変えたら、その部品の data-version を一つ上げる。クラス名は screen-catalog.ts の menu の classes と parts のまま保つ。
 * 項目は data-role にシステムの操作の名前を書いたボタン。並べ替えれば並びが、消せば出さない項目が変わる。中身が空の項目には、
 * エンジンがその操作の標準の文言（menu.save など。WebPlugin.texts で替えたもの）を入れる。文字を書けば、その文字のまま出す。書いた操作でも、今は使えないもの
 * （ブラウザ版の終了、ボイスの無いページのボイスの再生、回想の間のセーブとロードなど）はエンジンが外す。項目にはエンジンが data-action も書く。
 * 値（data-field、data-attr-*）: auto と skip（"true" か "false"。aria-pressed に書く）。作品の画面の一行（screen-button）は label。
 * 押すと起きること（data-role）: システムの操作の名前（SYSTEM_ACTIONS）、close（閉じる。Esc と右クリックも同じ）、screen-button の open（作品の画面を開く）。
 * いちばん外の要素そのもの（枠の外の暗がり）を押しても閉じる。
 */
export const MENU_TEMPLATE = `<template data-part="screen" data-version="1">
<div class="lm-screen lm-menu">
  <div class="lm-menu-panel">
    <h2 class="lm-screen-title" data-text="menu.heading"></h2>
    <div class="lm-menu-list">
      <button class="lm-button lm-menu-button" data-role="quick-save"></button>
      <button class="lm-button lm-menu-button" data-role="quick-load"></button>
      <button class="lm-button lm-menu-button" data-role="save"></button>
      <button class="lm-button lm-menu-button" data-role="load"></button>
      <button class="lm-button lm-menu-button" data-role="auto" data-attr-aria-pressed="auto"></button>
      <button class="lm-button lm-menu-button" data-role="skip" data-attr-aria-pressed="skip"></button>
      <button class="lm-button lm-menu-button" data-role="prev-choice"></button>
      <button class="lm-button lm-menu-button" data-role="next-choice"></button>
      <button class="lm-button lm-menu-button" data-role="next-unread"></button>
      <button class="lm-button lm-menu-button" data-role="backlog"></button>
      <button class="lm-button lm-menu-button" data-role="replay-voice"></button>
      <button class="lm-button lm-menu-button" data-role="items"></button>
      <button class="lm-button lm-menu-button" data-role="help"></button>
      <button class="lm-button lm-menu-button" data-role="config"></button>
      <button class="lm-button lm-menu-button" data-role="flowchart"></button>
      <button class="lm-button lm-menu-button" data-role="screenshot"></button>
      <button class="lm-button lm-menu-button" data-role="hide"></button>
      <template data-list="screens" data-item="screen-button"></template>
      <button class="lm-button lm-menu-button" data-role="title"></button>
      <button class="lm-button lm-menu-button" data-role="check-update"></button>
      <button class="lm-button lm-menu-button" data-role="exit"></button>
    </div>
    <button class="lm-button lm-primary lm-menu-resume" data-role="close" data-sound="select" data-text="menu.resume" data-autofocus></button>
  </div>
</div>
</template>
<template data-part="screen-button" data-version="1">
<button class="lm-button lm-menu-button" data-role="open" data-field="label"></button>
</template>
`;

/** メニューの決まり（lim check が作品の写したテンプレートを確かめるのに読む）。 */
export const MENU_SCREEN: StandardScreen = {
  template: MENU_TEMPLATE,
  roles: ["quick-save", "quick-load", "save", "load", "auto", "skip", "rollback", "rollforward", "prev-choice", "next-choice", "next-unread", "backlog", "replay-voice", "items", "config", "help", "flowchart", "screenshot", "hide", "title", "exit", "check-update", "fullscreen", "close", "open"],
  fields: ["auto", "skip", "label"],
  // 閉じられること（暗がりを押しても閉じるが、キーとパッドで選べるものを一つ）
  required: [["close"]],
  replacedBy: ["screens.menu", "system"],
};
