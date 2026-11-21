import type { StandardScreen } from "@liminalia/lang";

/**
 * 標準の結末の名前の型（@title-screen ending=。docs/design/screen-templates.md）。作品は ui/screens/ending/ending.html に写して直せる
 * （liminalia.json の ui.templates.ending）。部品を変えたら、その部品の data-version を一つ上げる。クラス名は screen-catalog.ts の ending の classes と
 * parts のまま保つ（終わりの表記の置き方の lm-ending-mark-above と lm-ending-mark-none は舞台に付く）。
 * 押すと（Enter、Space、パッドの A も）タイトルへ進む。名前のボタンが画面を覆うので、どこを押しても進む。
 * 値（data-field、data-attr-*）: name（title= か、無ければ種類の文言）、kind（種類の名前。bad など。data-kind に書く）、
 * kind-label（title= があるときだけ、種類の文言。BAD END など）、mark（終わりの表記）、proceed（進む操作の文言）、
 * spoken（読み上げに渡す名前。種類、名前、終わりの表記、進む操作をつないだもの）。
 * 押すと起きること（data-role）: proceed と close（タイトルへ進む。Esc、右クリック、パッドの B も同じ）。
 */
export const ENDING_TEMPLATE = `<template data-part="screen" data-version="1">
<div class="lm-screen lm-ending" data-attr-data-kind="kind">
  <button class="lm-ending-go" data-role="proceed" data-sound="none" data-attr-aria-label="spoken" data-autofocus>
    <span class="lm-ending-kind" data-if="kind-label" data-field="kind-label"></span>
    <span class="lm-ending-name" data-field="name"></span>
    <span class="lm-ending-rule"></span>
    <span class="lm-ending-mark" data-field="mark"></span>
  </button>
</div>
</template>
`;

/** 結末の名前の決まり（lim check が作品の写したテンプレートを確かめるのに読む）。 */
export const ENDING_SCREEN: StandardScreen = {
  template: ENDING_TEMPLATE,
  roles: ["proceed", "close"],
  fields: ["name", "kind", "kind-label", "mark", "proceed", "spoken"],
  required: [["proceed", "close"]],
  replacedBy: ["screens.ending", "system"],
};
