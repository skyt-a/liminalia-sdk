import type { StandardScreen } from "@liminalia/lang";

/**
 * 標準の履歴（バックログ）の型（docs/design/screen-templates.md）。作品は ui/screens/backlog/backlog.html に写して直せる（liminalia.json の ui.templates.backlog）。
 * 部品を変えたら、その部品の data-version を一つ上げる。クラス名は screen-catalog.ts の backlog の classes と parts のまま保つ。
 * 一つのページは部品 entry（作品はこの一行だけを差し替えられる）。まだ何も読んでいなければ、一覧には empty を一つ置く。
 * 一覧（entries）の要素は、開いたら一番下（新しいページ）を見せ、一番下でさらにホイールを下へ回すと閉じる（data-autofocus なら開いたときにフォーカスを置く）。
 * 検索欄は data-input="search" の <input>。打つと、話者か本文に当たったページだけで一覧を作り直す（入力中の Esc は文字を消すだけ）。
 * 値（data-field、data-if、data-attr-*）:
 *   screen: search-label（検索欄の読み上げの名前と、空のときの文字）、count（当たったページの数。探していなければ空）
 *   entry: name（話者。地の文は空、選んだ選択肢は「選択肢」）、text（本文。data-field="text" の要素には、エンジンがルビ、色、改行、絵を付けた本文を入れる）、
 *          voice-label（ボイスを再生するボタンの読み上げの名前）、jump-title（ここに戻るボタンの説明）
 * 押すと起きること（data-role）: close（閉じる。Esc と右クリックも同じ）、entry の voice（そのページのボイスを鳴らし直す。ボイスが無ければ外す）、
 * jump（そのページから読み直す。確かめてから。戻れないページでは外す）。
 * 状態（data-lm-*）: entry に choice（選んだ選択肢）、narration（地の文）、hit（探して当たったページ）。
 * 話者の名前（data-field="name"）にはエンジンが話者の色を、本文には人物ごとの台詞の文字の見た目（cast.json の text）を付ける。
 */
export const BACKLOG_TEMPLATE = `<template data-part="screen" data-version="1">
<div class="lm-screen lm-backlog">
  <header class="lm-screen-header">
    <h2 class="lm-screen-title" data-text="backlog.heading"></h2>
    <span class="lm-log-find">
      <input class="lm-log-search" type="search" data-input="search" data-attr-placeholder="search-label" data-attr-aria-label="search-label">
      <span class="lm-log-count" data-field="count"></span>
    </span>
    <button class="lm-button lm-close" data-role="close" data-text="close"></button>
  </header>
  <div class="lm-log" tabindex="-1" data-list="entries" data-item="entry" data-autofocus></div>
</div>
</template>
<template data-part="entry" data-version="1">
<div class="lm-log-entry">
  <div class="lm-log-speaker">
    <button class="lm-log-voice" data-role="voice" data-attr-title="voice-label" data-attr-aria-label="voice-label">▶</button>
    <span class="lm-log-name" data-field="name"></span>
  </div>
  <div class="lm-log-text" data-field="text"></div>
  <button class="lm-log-jump" data-role="jump" data-attr-title="jump-title" data-text="backlog.jump"></button>
</div>
</template>
<template data-part="empty" data-version="1">
<p class="lm-log-empty" data-text="backlog.empty"></p>
</template>
`;

/** 履歴の決まり（lim check が作品の写したテンプレートを確かめるのに読む）。 */
export const BACKLOG_SCREEN: StandardScreen = {
  template: BACKLOG_TEMPLATE,
  roles: ["close", "voice", "jump"],
  fields: ["search-label", "count", "name", "text", "voice-label", "jump-title"],
  required: [["close"]],
  replacedBy: ["screens.backlog", "system"],
};
