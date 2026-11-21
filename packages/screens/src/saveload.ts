import type { StandardScreen } from "@liminalia/lang";

/**
 * 標準のセーブとロードの型（docs/design/screen-templates.md）。作品は ui/screens/saveload/saveload.html に写して直せる（liminalia.json の ui.templates.saveload）。
 * セーブもロードも同じ型で、いちばん外の要素にエンジンが lm-save か lm-load のクラスを足す。
 * 部品を変えたら、その部品の data-version を一つ上げる。クラス名は screen-catalog.ts の saveload の classes と parts のまま保つ。
 * スロットの一行は部品 slot（作品はこの一行だけを差し替えられる）。ページのタブは page、コピーと移動の写し先を選んでいる間の知らせは banner、
 * メモを書く入力欄は memo（ボタンの並びの場所に出す。入力欄の <input> に、エンジンが Enter と Esc と、離れたら決めることを付ける）。
 * 値（data-field、data-if、data-attr-*）:
 *   screen: heading（見出し。セーブかロード）
 *   page: label（1、2、…、A、Q）、current（今のページなら "true"、ほかは "false"。aria-pressed に書く）、spoken（読み上げの名前。オートセーブのページだけ）
 *   banner: message（写し先を選んでくださいの文）
 *   slot: name（No.01 など）、date、chapter、time（プレイ時間）、sub（章の名前かプレイ時間があるか）、text（本文の頭。空きなら「空き」）、memo、
 *         thumb（縮小画像の URL）、locked（保護しているか）、tools（メモや削除のボタンを出すか）、protect（保護のボタンの文言。保護か保護を外す）
 *   memo: memo（今のメモ）、placeholder、label（読み上げの名前）
 * 押すと起きること（data-role）: close（閉じる。Esc と右クリックも同じ）、page（そのページを出す）、banner の cancel（写し先を選ぶのをやめる）、
 * slot の pick（セーブ、ロード、写し先に選ぶ）、memo、protect（保護と、保護を外す）、copy、move、delete。
 * 番号の無いスロット（オートセーブとクイックセーブ）では memo、protect、copy、move を外す。
 * 状態（data-lm-*）: page に current、slot に empty（空き）、protected（保護している）、source（写し元）。
 */
export const SAVELOAD_TEMPLATE = `<template data-part="screen" data-version="1">
<div class="lm-screen lm-saveload">
  <header class="lm-screen-header">
    <h2 class="lm-screen-title" data-field="heading"></h2>
    <nav class="lm-tabs" data-list="pages" data-item="page"></nav>
    <button class="lm-button lm-close" data-role="close" data-text="close"></button>
  </header>
  <template data-list="banner" data-item="banner"></template>
  <div class="lm-slots" data-list="slots" data-item="slot"></div>
</div>
</template>
<template data-part="page" data-version="1">
<button class="lm-tab" data-role="page" data-field="label" data-attr-aria-pressed="current" data-attr-aria-label="spoken"></button>
</template>
<template data-part="banner" data-version="1">
<div class="lm-slot-banner">
  <span data-field="message"></span>
  <button class="lm-button" data-role="cancel" data-sound="select" data-text="saveload.cancel"></button>
</div>
</template>
<template data-part="slot" data-version="1">
<div class="lm-slot-wrap">
  <button class="lm-slot" data-role="pick">
    <div class="lm-slot-thumb"><img data-if="thumb" data-attr-src="thumb" alt="" draggable="false"></div>
    <div class="lm-slot-meta">
      <div class="lm-slot-head">
        <span class="lm-slot-name"><span data-field="name"></span><span class="lm-slot-lock" data-if="locked" data-text="saveload.locked"></span></span>
        <span class="lm-slot-date" data-field="date"></span>
      </div>
      <div class="lm-slot-sub" data-if="sub"><span class="lm-slot-chapter" data-field="chapter"></span><span class="lm-slot-time" data-field="time"></span></div>
      <div class="lm-slot-text" data-field="text"></div>
      <div class="lm-slot-memo" data-if="memo" data-field="memo"></div>
    </div>
  </button>
  <div class="lm-slot-tools" data-if="tools">
    <button class="lm-slot-tool" data-role="memo" data-text="saveload.memo"></button>
    <button class="lm-slot-tool" data-role="protect" data-field="protect"></button>
    <button class="lm-slot-tool" data-role="copy" data-text="saveload.copy"></button>
    <button class="lm-slot-tool" data-role="move" data-text="saveload.move"></button>
    <button class="lm-slot-tool" data-role="delete" data-text="saveload.delete"></button>
  </div>
</div>
</template>
<template data-part="memo" data-version="1">
<input class="lm-slot-memo-input" type="text" maxlength="100" data-attr-value="memo" data-attr-placeholder="placeholder" data-attr-aria-label="label">
</template>
`;

/** セーブとロードの決まり（lim check が作品の写したテンプレートを確かめるのに読む）。 */
export const SAVELOAD_SCREEN: StandardScreen = {
  template: SAVELOAD_TEMPLATE,
  roles: ["close", "page", "cancel", "pick", "memo", "protect", "copy", "move", "delete"],
  fields: ["heading", "label", "current", "spoken", "message", "name", "date", "chapter", "time", "sub", "text", "memo", "thumb", "locked", "tools", "protect", "placeholder"],
  required: [["close"], ["pick"]],
  replacedBy: ["screens.saveload", "system"],
};
