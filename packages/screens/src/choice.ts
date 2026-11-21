import type { StandardScreen } from "@liminalia/lang";

/**
 * 標準の選択肢の型（docs/design/screen-templates.md）。作品は ui/screens/choice/choice.html に写して直せる（liminalia.json の ui.templates.choice）。
 * 部品を変えたら、その部品の data-version を一つ上げる。クラス名は screen-catalog.ts の choice の classes と parts のまま保つ。
 *
 * 並べる枠（screen）と一つの選択肢（option、option-image、option-area）を分けてあり、作品はどちらか一方だけを差し替えられる。
 * screen のいちばん外の要素は、舞台の選択肢の層（.choices。置き方と、チャットの画面の並べ方が動かす）そのものを表す: 選択肢を出している間、
 * その要素のクラスと属性を層に付け、中身を層に入れる（選び終えたら外す）。<template data-list="options"> は包む要素を作らずに並べるので、
 * 一つの選択肢は層の子になる（.choices > button）。
 * 一つの選択肢の部品: 文字の選択肢は option、絵の選択肢（image=）は option-image（hover= の絵は、中の img にエンジンが入れ替える）、
 * 見えない押せる範囲（width= と height= だけ）は option-area。x=、y=、width=、height=、cursor=、tip= はエンジンが要素に書く。
 * 値（data-field、data-if、data-attr-*）: timer（制限時間のある選択肢なら、ミリ秒。残り時間のバーは層に書く --choice-time で動く）、
 * 一つの選択肢は text（文）、image（絵の URL）、index（上から何番目か。1 から）。
 * 押すと起きること（data-role）: 一つの選択肢の choose（それを選ぶ。数字のキーは押せるものを上から数える）。
 * 状態（data-lm-*）: 選んだ先を読んだことのある選択肢に data-lm-read、押せない選択肢（locked= か、巻き戻しで前に選んだもの以外）に data-lm-disabled。
 * 前からの CSS のため、同じ状態に is-read と is-locked のクラスも付ける。
 */
export const CHOICE_TEMPLATE = `<template data-part="screen" data-version="1">
<div class="choices">
  <div class="choice-timer" role="progressbar" data-if="timer"></div>
  <template data-list="options" data-item="option"></template>
</div>
</template>
<template data-part="option" data-version="1">
<button data-role="choose" data-field="text"></button>
</template>
<template data-part="option-image" data-version="1">
<button class="choice-image" data-role="choose"><img data-attr-src="image" data-attr-alt="text" draggable="false"></button>
</template>
<template data-part="option-area" data-version="1">
<button class="choice-area" data-role="choose" data-attr-aria-label="text"></button>
</template>
`;

/** 選択肢の決まり（lim check が作品の写したテンプレートを確かめるのに読む）。 */
export const CHOICE_SCREEN: StandardScreen = {
  template: CHOICE_TEMPLATE,
  roles: ["choose"],
  fields: ["timer", "text", "image", "index"],
  required: [["choose"]],
  // システム画面を丸ごと差し替えても、選択肢は標準のまま（ui-probe.ts の SYSTEM_SCREENS）
  replacedBy: ["screens.choice"],
};
