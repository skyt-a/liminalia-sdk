import type { StandardScreen } from "@liminalia/lang";

/**
 * 標準のコンフィグの型（docs/design/screen-templates.md）。作品は ui/screens/config/config.html に写して直せる（liminalia.json の ui.templates.config）。
 * 部品を変えたら、その部品の data-version を一つ上げる。クラス名は screen-catalog.ts の config の classes と parts のまま保つ。
 *
 * 項目の一行は data-setting="設定の名前"（Settings の名前。作品独自の設定は custom.名前）。行を消せば項目が消え、並べ替えれば順が変わる。
 * 今は使えない項目（全画面に切り替えられない環境の画面モード、デスクトップ版だけの項目、作品が使わない項目）は、エンジンが行ごと外す。
 * 行の中の欄:
 *   <input>                 つまみ（エンジンが type="range" にし、幅と刻みを設定から決める。作品独自の設定は min、max、step を書く）
 *   data-value="値"         選択の一つ（押すとその値にする。押したものに aria-pressed="true"）
 *   data-toggle             切り替え（入と切。role="switch"、aria-checked、data-lm-on）
 * まとまり（タブ）: data-role="page" data-page="名前" のボタンを押すと、data-page にその名前を含む要素だけを出す（ほかは hidden）。
 * data-page には名前を空白で区切って並べられる（プレビューはテキストと画面のタブで出す）。タブのボタンが無ければ、すべて出す。
 * 値（data-field、data-if、data-attr-*）:
 *   screen: つまみの値の文字（textSpeed、autoWait、windowOpacity、textScale、master、bgm、se、voice）、filter-label（表現を控えめにする項目の名前）、
 *           preview（プレビューの文。エンジンが中身を入れる）、controls（キーとパッドの割り当てを出すか。data-if）
 *   option: label、lang（言語の選択だけ）。言語（languages）、ウィンドウの大きさ（sizes）、システムボイス（voices）の選択の一つ
 *   speaker: label（読み上げの名前も）、volume（値の文字）。話者ごとの声の音量の一行
 *   binding: label、keys（今のキーかボタン）、waiting（押すのを待っている間は "true"。aria-pressed に書く）。キー（keys）とパッド（buttons）の割り当ての一行
 * 押すと起きること（data-role）: close（閉じる。Esc と右クリックも同じ）、page（タブ）、reset（初期設定に戻す）、export と import（セーブデータの書き出しと読み込み）、
 * reset-controls（操作を初期値に戻す）、binding の change（次に押したキーかボタンを割り当てる。もう一度押すとやめる）。
 */
export const CONFIG_TEMPLATE = `<template data-part="screen" data-version="1">
<div class="lm-screen lm-config">
  <header class="lm-screen-header">
    <h2 class="lm-screen-title" data-text="config.heading"></h2>
    <nav class="lm-tabs">
      <button class="lm-tab" data-role="page" data-page="text" data-text="config.tabs.text"></button>
      <button class="lm-tab" data-role="page" data-page="screen" data-text="config.tabs.screen"></button>
      <button class="lm-tab" data-role="page" data-page="sound" data-text="config.tabs.sound"></button>
      <button class="lm-tab" data-role="page" data-page="controls" data-if="controls" data-text="config.tabs.controls"></button>
    </nav>
    <button class="lm-button lm-close" data-role="close" data-text="close"></button>
  </header>
  <div class="lm-config-rows" data-page="text">
    <div class="lm-config-row" data-setting="textSpeed">
      <span class="lm-config-label" data-text="config.textSpeed"></span>
      <div class="lm-config-control"><span class="lm-config-end" data-text="config.slow"></span><input class="lm-range"><span class="lm-config-end" data-text="config.fast"></span></div>
      <output class="lm-config-value" data-field="textSpeed"></output>
    </div>
    <div class="lm-config-row" data-setting="autoWait">
      <span class="lm-config-label" data-text="config.autoWait"></span>
      <div class="lm-config-control"><span class="lm-config-end" data-text="config.short"></span><input class="lm-range"><span class="lm-config-end" data-text="config.long"></span></div>
      <output class="lm-config-value" data-field="autoWait"></output>
    </div>
    <div class="lm-config-row" data-setting="skipUnread">
      <span class="lm-config-label" data-text="config.skip"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.skipRead"></button>
        <button class="lm-toggle" data-value="true" data-text="config.skipAll"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="skipSpeed">
      <span class="lm-config-label" data-text="config.skipSpeed"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="fast" data-text="config.skipSpeeds.fast"></button>
        <button class="lm-toggle" data-value="fastest" data-text="config.skipSpeeds.fastest"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="autoAfterChoice">
      <span class="lm-config-label" data-text="config.autoAfterChoice"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.afterChoiceStop"></button>
        <button class="lm-toggle" data-value="true" data-text="config.afterChoiceKeep"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="skipAfterChoice">
      <span class="lm-config-label" data-text="config.skipAfterChoice"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.afterChoiceStop"></button>
        <button class="lm-toggle" data-value="true" data-text="config.afterChoiceKeep"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="choiceTimer">
      <span class="lm-config-label" data-text="config.choiceTimer"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.off"></button>
        <button class="lm-toggle" data-value="true" data-text="config.on"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="language">
      <span class="lm-config-label" data-text="config.language"></span>
      <div class="lm-config-control lm-segmented" data-list="languages" data-item="option"></div>
      <span class="lm-config-value"></span>
    </div>
  </div>
  <div class="lm-config-rows" data-page="screen">
    <div class="lm-config-row" data-setting="windowOpacity">
      <span class="lm-config-label" data-text="config.windowOpacity"></span>
      <div class="lm-config-control"><span class="lm-config-end" data-text="config.thin"></span><input class="lm-range"><span class="lm-config-end" data-text="config.thick"></span></div>
      <output class="lm-config-value" data-field="windowOpacity"></output>
    </div>
    <div class="lm-config-row" data-setting="textScale">
      <span class="lm-config-label" data-text="config.textScale"></span>
      <div class="lm-config-control"><span class="lm-config-end" data-text="config.small"></span><input class="lm-range"><span class="lm-config-end" data-text="config.large"></span></div>
      <output class="lm-config-value" data-field="textScale"></output>
    </div>
    <div class="lm-config-row" data-setting="font">
      <span class="lm-config-label" data-text="config.font"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="" data-text="config.fonts.work"></button>
        <button class="lm-toggle" data-value="mincho" data-text="config.fonts.mincho"></button>
        <button class="lm-toggle" data-value="gothic" data-text="config.fonts.gothic"></button>
        <button class="lm-toggle" data-value="maru" data-text="config.fonts.maru"></button>
        <button class="lm-toggle" data-value="ud" data-text="config.fonts.ud"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="reduceShake">
      <span class="lm-config-label" data-text="config.shake"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.motionFull"></button>
        <button class="lm-toggle" data-value="true" data-text="config.motionReduced"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="reduceFlash">
      <span class="lm-config-label" data-text="config.flash"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.motionFull"></button>
        <button class="lm-toggle" data-value="true" data-text="config.motionReduced"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="readColor">
      <span class="lm-config-label" data-text="config.readColor"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="off" data-text="config.off"></button>
        <button class="lm-toggle" data-value="on" data-text="config.on"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="lineSpacing">
      <span class="lm-config-label" data-text="config.lineSpacing"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="100" data-text="config.lineSpacings.100"></button>
        <button class="lm-toggle" data-value="125" data-text="config.lineSpacings.125"></button>
        <button class="lm-toggle" data-value="150" data-text="config.lineSpacings.150"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="textEdge">
      <span class="lm-config-label" data-text="config.textEdge"></span>
      <div class="lm-config-control lm-segmented lm-wrap">
        <button class="lm-toggle" data-value="" data-text="config.textEdges."></button>
        <button class="lm-toggle" data-value="none" data-text="config.textEdges.none"></button>
        <button class="lm-toggle" data-value="shadow" data-text="config.textEdges.shadow"></button>
        <button class="lm-toggle" data-value="edge" data-text="config.textEdges.edge"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="selfVoicing">
      <span class="lm-config-label" data-text="config.selfVoicing"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.off"></button>
        <button class="lm-toggle" data-value="true" data-text="config.on"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="highContrast">
      <span class="lm-config-label" data-text="config.highContrast"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.off"></button>
        <button class="lm-toggle" data-value="true" data-text="config.on"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="contentFilter">
      <span class="lm-config-label" data-field="filter-label"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.off"></button>
        <button class="lm-toggle" data-value="true" data-text="config.on"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="fullscreen">
      <span class="lm-config-label" data-text="config.screen"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.windowed"></button>
        <button class="lm-toggle" data-value="true" data-text="config.fullscreen"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="colorVision">
      <span class="lm-config-label" data-text="config.colorVision"></span>
      <div class="lm-config-control lm-segmented lm-wrap">
        <button class="lm-toggle" data-value="" data-text="config.colorVisions."></button>
        <button class="lm-toggle" data-value="protan" data-text="config.colorVisions.protan"></button>
        <button class="lm-toggle" data-value="deutan" data-text="config.colorVisions.deutan"></button>
        <button class="lm-toggle" data-value="tritan" data-text="config.colorVisions.tritan"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="captions">
      <span class="lm-config-label" data-text="config.captions"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.off"></button>
        <button class="lm-toggle" data-value="true" data-text="config.on"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="confirm">
      <span class="lm-config-label" data-text="config.confirm"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.off"></button>
        <button class="lm-toggle" data-value="true" data-text="config.on"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="hideCursor">
      <span class="lm-config-label" data-text="config.hideCursor"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.off"></button>
        <button class="lm-toggle" data-value="true" data-text="config.on"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="analytics">
      <span class="lm-config-label" data-text="analytics.setting"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.off"></button>
        <button class="lm-toggle" data-value="true" data-text="config.on"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="windowScale">
      <span class="lm-config-label" data-text="config.windowSize"></span>
      <div class="lm-config-control lm-segmented lm-wrap" data-list="sizes" data-item="option"></div>
      <span class="lm-config-value"></span>
    </div>
  </div>
  <div class="lm-config-rows" data-page="sound">
    <div class="lm-config-row" data-setting="master">
      <span class="lm-config-label" data-text="config.master"></span>
      <div class="lm-config-control"><span class="lm-config-end">0</span><input class="lm-range"><span class="lm-config-end">100</span></div>
      <output class="lm-config-value" data-field="master"></output>
    </div>
    <div class="lm-config-row" data-setting="mute">
      <span class="lm-config-label" data-text="config.mute"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="false" data-text="config.off"></button>
        <button class="lm-toggle" data-value="true" data-text="config.on"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="bgm">
      <span class="lm-config-label" data-text="config.bgm"></span>
      <div class="lm-config-control"><span class="lm-config-end">0</span><input class="lm-range"><span class="lm-config-end">100</span></div>
      <output class="lm-config-value" data-field="bgm"></output>
    </div>
    <div class="lm-config-row" data-setting="se">
      <span class="lm-config-label" data-text="config.se"></span>
      <div class="lm-config-control"><span class="lm-config-end">0</span><input class="lm-range"><span class="lm-config-end">100</span></div>
      <output class="lm-config-value" data-field="se"></output>
    </div>
    <div class="lm-config-row" data-setting="voice">
      <span class="lm-config-label" data-text="config.voice"></span>
      <div class="lm-config-control"><span class="lm-config-end">0</span><input class="lm-range"><span class="lm-config-end">100</span></div>
      <output class="lm-config-value" data-field="voice"></output>
    </div>
    <template data-list="speakers" data-item="speaker"></template>
    <div class="lm-config-row" data-setting="voiceStopOnPage">
      <span class="lm-config-label" data-text="config.voiceStop"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="true" data-text="config.voiceStopOn"></button>
        <button class="lm-toggle" data-value="false" data-text="config.voiceStopOff"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="duckBgm">
      <span class="lm-config-label" data-text="config.duck"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="true" data-text="config.duckOn"></button>
        <button class="lm-toggle" data-value="false" data-text="config.duckOff"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="systemVoice">
      <span class="lm-config-label" data-text="config.systemVoice"></span>
      <div class="lm-config-control lm-segmented" data-list="voices" data-item="option"></div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="whenHidden">
      <span class="lm-config-label" data-text="config.whenHidden"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="pause" data-text="config.inactiveActions.pause"></button>
        <button class="lm-toggle" data-value="mute" data-text="config.inactiveActions.mute"></button>
        <button class="lm-toggle" data-value="play" data-text="config.inactiveActions.play"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <div class="lm-config-row" data-setting="whenUnfocused">
      <span class="lm-config-label" data-text="config.whenUnfocused"></span>
      <div class="lm-config-control lm-segmented">
        <button class="lm-toggle" data-value="pause" data-text="config.inactiveActions.pause"></button>
        <button class="lm-toggle" data-value="mute" data-text="config.inactiveActions.mute"></button>
        <button class="lm-toggle" data-value="play" data-text="config.inactiveActions.play"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
  </div>
  <div class="lm-config-rows lm-controls" data-page="controls" data-if="controls">
    <h3 class="lm-config-group" data-text="config.keyboard"></h3>
    <template data-list="keys" data-item="binding"></template>
    <h3 class="lm-config-group" data-text="config.gamepad"></h3>
    <div class="lm-config-row" data-setting="padStyle">
      <span class="lm-config-label" data-text="config.padStyle"></span>
      <div class="lm-config-control lm-segmented lm-wrap">
        <button class="lm-toggle" data-value="" data-text="config.padStyles."></button>
        <button class="lm-toggle" data-value="xbox" data-text="config.padStyles.xbox"></button>
        <button class="lm-toggle" data-value="playstation" data-text="config.padStyles.playstation"></button>
        <button class="lm-toggle" data-value="nintendo" data-text="config.padStyles.nintendo"></button>
      </div>
      <span class="lm-config-value"></span>
    </div>
    <template data-list="buttons" data-item="binding"></template>
    <div class="lm-config-row"><button class="lm-button" data-role="reset-controls" data-text="config.resetControls"></button></div>
  </div>
  <div class="lm-preview" data-page="text screen"><span class="lm-preview-label" data-text="config.preview"></span><div class="lm-preview-text" data-field="preview"></div></div>
  <div class="lm-config-footer">
    <button class="lm-button" data-role="export" data-text="saves.export"></button>
    <button class="lm-button" data-role="import" data-text="saves.import"></button>
    <button class="lm-button" data-role="reset" data-text="config.reset"></button>
  </div>
</div>
</template>
<template data-part="option" data-version="1">
<button class="lm-toggle" data-field="label" data-attr-lang="lang"></button>
</template>
<template data-part="speaker" data-version="1">
<div class="lm-config-row">
  <span class="lm-config-label" data-field="label"></span>
  <div class="lm-config-control"><span class="lm-config-end">0</span><input class="lm-range"><span class="lm-config-end">100</span></div>
  <output class="lm-config-value" data-field="volume"></output>
</div>
</template>
<template data-part="binding" data-version="1">
<div class="lm-config-row">
  <span class="lm-config-label" data-field="label"></span>
  <div class="lm-config-control"><span class="lm-config-keys" data-field="keys"></span></div>
  <button class="lm-toggle" data-role="change" data-text="config.change" data-attr-aria-pressed="waiting"></button>
</div>
</template>
`;

/** コンフィグの決まり（lim check が作品の写したテンプレートを確かめるのに読む）。 */
export const CONFIG_SCREEN: StandardScreen = {
  template: CONFIG_TEMPLATE,
  roles: ["close", "page", "reset", "export", "import", "reset-controls", "change"],
  fields: ["textSpeed", "autoWait", "windowOpacity", "textScale", "master", "bgm", "se", "voice", "filter-label", "preview", "controls", "label", "lang", "volume", "keys", "waiting"],
  required: [["close"]],
  replacedBy: ["screens.config", "system"],
  settings: [
    "textSpeed",
    "autoWait",
    "skipUnread",
    "skipSpeed",
    "autoAfterChoice",
    "skipAfterChoice",
    "choiceTimer",
    "language",
    "windowOpacity",
    "textScale",
    "font",
    "reduceShake",
    "reduceFlash",
    "readColor",
    "lineSpacing",
    "textEdge",
    "selfVoicing",
    "highContrast",
    "contentFilter",
    "fullscreen",
    "colorVision",
    "captions",
    "confirm",
    "hideCursor",
    "analytics",
    "windowScale",
    "master",
    "mute",
    "bgm",
    "se",
    "voice",
    "voiceStopOnPage",
    "duckBgm",
    "systemVoice",
    "whenHidden",
    "whenUnfocused",
    "padStyle",
  ],
};
