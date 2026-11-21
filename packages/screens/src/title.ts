import type { StandardScreen } from "@liminalia/lang";

/**
 * 標準のタイトル画面の型（docs/design/screen-templates.md）。作品は ui/screens/title/title.html に写して直せる（liminalia.json の ui.templates.title）。
 * 部品を変えたら、その部品の data-version を一つ上げる。クラス名は screen-catalog.ts の title の classes と parts のまま保つ。
 * 項目は data-role に操作の名前を書いたボタン。並べ替えれば並びが、消せば出さない項目が変わる。書いた項目でも、今は使えないもの
 * （おまけの無い作品のおまけ、使っていないか何も読んでいないフローチャート、ui.help.title の無い操作説明、ブラウザ版の終了）はエンジンが外す。
 * セーブが無いときの「つづきから」は押せない（data-lm-disabled と disabled）。
 * 背景（ui.title.background）、曲（ui.title.bgm）、背景の置き方は、エンジンがいちばん外の要素と舞台に付ける（今のテーマの値のまま）。
 * 値（data-field、data-if、data-attr-*）: name（作品の題。遊んでいる言語の訳）、logo（ui.title.logo の絵の URL。無ければ空）、
 * heading（題を文字で出すか。ロゴがあるときと ui.title.showName が false のときは出さない）。
 * 押すと起きること（data-role）: start（はじめから）、load（つづきから。ui.title.resume ならいちばん新しいセーブから再開する）、extra（おまけ）、
 * flowchart、config、help（操作説明）、exit（終了）。押すと ui.systemVoice.actions のその操作のボイスを鳴らす（load と extra などは今と同じ名前）。
 */
export const TITLE_TEMPLATE = `<template data-part="screen" data-version="1">
<div class="lm-title">
  <h1 class="lm-title-name" data-if="heading" data-field="name"></h1>
  <img class="lm-title-logo" data-if="logo" data-attr-src="logo" data-attr-alt="name">
  <div class="lm-title-menu">
    <button class="lm-title-button" data-role="start" data-text="title.start"></button>
    <button class="lm-title-button" data-role="load" data-text="title.continue"></button>
    <button class="lm-title-button" data-role="extra" data-text="title.extra"></button>
    <button class="lm-title-button" data-role="flowchart" data-text="title.flowchart"></button>
    <button class="lm-title-button" data-role="config" data-text="title.config"></button>
    <button class="lm-title-button" data-role="help" data-text="menu.help"></button>
    <button class="lm-title-button" data-role="exit" data-text="title.exit"></button>
  </div>
</div>
</template>
`;

/** タイトル画面の決まり（lim check が作品の写したテンプレートを確かめるのに読む）。 */
export const TITLE_SCREEN: StandardScreen = {
  template: TITLE_TEMPLATE,
  roles: ["start", "load", "extra", "flowchart", "config", "help", "exit"],
  fields: ["name", "logo", "heading"],
  required: [["start"]],
  replacedBy: ["title", "system"],
};
