// @ts-check
/**
 * 書き出したデスクトップ版の、Mac のメニューと、ゲームの画面の外で出す知らせの文言（main.cjs が使い、テストもこのファイルを読む）。
 * 文言は日本語と英語。遊ぶ言語（ゲームの画面が知らせる。作品の languages から選んだもの）が日本語なら日本語、ほかは英語。
 * ゲームの画面が言語を知らせる前と、作品が言語を決めていないときは OS の言語で選ぶ。
 * Mac のメニューは OS の慣習どおり単語の頭を大文字にする（docs/design/wording.md の英語の文言）。
 */

const JA = {
  about: (/** @type {string} */ t) => `${t} について`,
  hide: (/** @type {string} */ t) => `${t} を隠す`,
  hideOthers: "ほかを隠す",
  unhide: "すべてを表示",
  quit: (/** @type {string} */ t) => `${t} を終了`,
  edit: "編集",
  undo: "元に戻す",
  redo: "やり直す",
  cut: "切り取り",
  copy: "コピー",
  paste: "貼り付け",
  selectAll: "すべて選択",
  view: "表示",
  fullscreen: "フルスクリーン",
  window: "ウインドウ",
  minimize: "しまう",
  zoom: "拡大/縮小",
  close: "閉じる",
  crashTitle: "ゲームの画面が止まりました",
  crashMessage: "ゲームの画面が続けて止まったため、読み込み直すのをやめました。次の起動からは GPU を使わずに表示します。",
  crashMessageNoGpu: "ゲームの画面が続けて止まったため、読み込み直すのをやめました。",
  restart: "再起動",
  quitButton: "終了",
  startFailed: "ゲームを起動できませんでした。",
};

/** @type {typeof JA} */
const EN = {
  about: (t) => `About ${t}`,
  hide: (t) => `Hide ${t}`,
  hideOthers: "Hide Others",
  unhide: "Show All",
  quit: (t) => `Quit ${t}`,
  edit: "Edit",
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectAll: "Select All",
  view: "View",
  fullscreen: "Toggle Full Screen",
  window: "Window",
  minimize: "Minimize",
  zoom: "Zoom",
  close: "Close",
  crashTitle: "The game screen stopped",
  crashMessage: "The game screen kept stopping, so it won't be reloaded again. From the next launch, the game will be drawn without the GPU.",
  crashMessageNoGpu: "The game screen kept stopping, so it won't be reloaded again.",
  restart: "Restart",
  quitButton: "Quit",
  startFailed: "Couldn't start the game.",
};

/**
 * 文言の言語。language はゲームの画面が知らせた遊ぶ言語（空なら作品が決めていない）、system は OS の言語の並び。
 * @param {string} language
 * @param {readonly string[]} system
 * @returns {"ja" | "en"}
 */
function textLanguage(language, system) {
  const lang = language || system[0] || "";
  return lang.toLowerCase().startsWith("ja") ? "ja" : "en";
}

/** @param {"ja" | "en"} lang */
function texts(lang) {
  return lang === "ja" ? JA : EN;
}

/**
 * Mac のメニュー（Menu.buildFromTemplate に渡すもの）。編集のメニューは入力欄の ⌘C ⌘V ⌘A などのため（役目の付いた項目が無いと効かない）。
 * 入力欄の外の ⌘C は、ゲームの画面が先に受けて本文をコピーする（ゲームの画面が受けたキーはメニューへ回らない）。
 * @param {string} title
 * @param {{ fullscreen: boolean }} o fullscreen は全画面にできるか
 * @param {"ja" | "en"} lang
 * @returns {import("electron").MenuItemConstructorOptions[]}
 */
function menuTemplate(title, o, lang) {
  const t = texts(lang);
  return [
    {
      label: title,
      submenu: [{ role: "about", label: t.about(title) }, { type: "separator" }, { role: "hide", label: t.hide(title) }, { role: "hideOthers", label: t.hideOthers }, { role: "unhide", label: t.unhide }, { type: "separator" }, { role: "quit", label: t.quit(title) }],
    },
    {
      label: t.edit,
      submenu: [{ role: "undo", label: t.undo }, { role: "redo", label: t.redo }, { type: "separator" }, { role: "cut", label: t.cut }, { role: "copy", label: t.copy }, { role: "paste", label: t.paste }, { role: "selectAll", label: t.selectAll }],
    },
    ...(o.fullscreen ? [{ label: t.view, submenu: [/** @type {import("electron").MenuItemConstructorOptions} */ ({ role: "togglefullscreen", label: t.fullscreen })] }] : []),
    { label: t.window, submenu: [{ role: "minimize", label: t.minimize }, { role: "zoom", label: t.zoom }, { role: "close", label: t.close }] },
  ];
}

module.exports = { textLanguage, texts, menuTemplate };
