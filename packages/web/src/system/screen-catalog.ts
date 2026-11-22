/**
 * 標準の画面の一覧と、作品が見た目を変える四つの段（1 文言、2 テーマの値、3 CSS、4 自作の画面）のそれぞれの口。
 * docs/screens.md の表はここから作り（packages/web/scripts/screen-catalog.ts）、test/screen-catalog.test.ts がソースと突き合わせる
 * （新しい画面、文言の群、テーマの値、差し替えの口を足して、ここに書かなければテストが落ちる）。
 * 遊ぶ画面からは読まない（書き出すエンジンには入らない）。
 */

/** 段の名前。 */
export type ScreenTier = "texts" | "theme" | "css" | "replace";

/** 日本語と英語の文。 */
export interface Bilingual {
  ja: string;
  en: string;
}

export interface ScreenCatalogEntry {
  /** 画面の名前（system.status.screen や openScreen の名前があればそれ）。 */
  id: string;
  name: Bilingual;
  /** 作るパッケージ（web は @liminalia/web、std は標準の命令 @liminalia/std）。 */
  owner: "web" | "std";
  /**
   * 1 文言: 作品の文言の表の鍵（プラグインの texts、訳のファイルの ui。system/strings.ts の TEXT の入れ子）。
   * 末尾が ".*" なら、その群のすべての鍵。
   */
  texts: readonly string[];
  /** 2 テーマの値: liminalia.json と theme.json の ui のパス（群なら "ending"、項目なら "system.titleBg"）。 */
  theme: readonly string[];
  /** 3 CSS の部品（クラス名）。 */
  classes: readonly string[];
  /** 3 CSS の変数（その画面だけのもの。システム画面の共通の変数は systemVars）。 */
  vars: readonly string[];
  /** システム画面の共通の変数（SYSTEM_SCREEN_VARS）で色と形が決まる。 */
  systemVars?: boolean;
  /** 4 自作の画面: WebPlugin の口（"screens.ending"、"title"、"extensions.text.glyph" など）。 */
  replace: readonly string[];
  /** 画面を開く名前（default.ts の openStandard、std の openScreen の name）。テストが新しい画面を見つけるのに使う。 */
  opens?: readonly string[];
  /** 段を持たない理由（埋めていない段は、ここに書く）。 */
  without?: Partial<Record<Exclude<ScreenTier, "css">, Bilingual>>;
  /**
   * 画面の部品（制作画面の「ゲームの画面」で、見本の上で押して選ぶもの）。押した要素から近いものを先に、具体的なものを先に並べる。
   * 見本で入った状態（filled）を開くと、どの部品も画面に出る（studio の test/screen-preview-e2e.test.ts が確かめる）。
   */
  parts: readonly ScreenPart[];
}

/** 部品の見た目を決める一つのテーマの値。 */
export interface PartValue {
  /** liminalia.json と theme.json の ui の中の道筋（"ending.color"、"system.accent"）。 */
  path: string;
  /** その値を入れる CSS の変数（ui-style.ts が当てる）。値を要素の style や作り方で使うものは省く。 */
  var?: string;
}

/** 画面の部品の一つ。 */
export interface ScreenPart {
  name: Bilingual;
  /** 部品の CSS のセレクタ（".lm-slot-name"、".choices > button"）。押した要素から closest で探す。 */
  selector: string;
  /** その部品の見た目を決めるテーマの値。空ならテーマの値では変えられない（作品の CSS で selector を上書きする）。 */
  values: readonly PartValue[];
}

/** システム画面（メニュー、セーブ、コンフィグなど）が共通に読む CSS の変数。ui.system の値がここへ入る。 */
export const SYSTEM_SCREEN_VARS = [
  "--lm-fg",
  "--lm-fg-muted",
  "--lm-accent",
  "--lm-ui-font",
  "--lm-text-font",
  "--lm-screen-bg",
  "--lm-control-bg",
  "--lm-control-hover",
  "--lm-control-active",
  "--lm-border",
  "--lm-border-faint",
  "--lm-radius",
  "--lm-screen-image",
  "--lm-button-image",
  "--lm-frame-image",
] as const;

// ---- 部品の表に使う値と部品（システム画面の共通のもの） ----

const v = (path: string, cssVar?: string): PartValue => (cssVar ? { path, var: cssVar } : { path });
const part = (selector: string, ja: string, en: string, values: readonly PartValue[]): ScreenPart => ({ name: { ja, en }, selector, values });

const FG = v("system.fg", "--lm-fg");
/** 薄い文字の色（ui.system.fg から作る）。 */
const FG_MUTED = v("system.fg", "--lm-fg-muted");
const ACCENT = v("system.accent", "--lm-accent");
const UI_FONT = v("system.font", "--lm-ui-font");
const SCREEN_BG = v("system.screenBg", "--lm-screen-bg");
const SCREEN_IMAGE = v("system.images.screen", "--lm-screen-image");
const CONTROL_BG = v("system.controlBg", "--lm-control-bg");
const BORDER = v("system.border", "--lm-border");
/** 細い線の色（ui.system.border から作る）。 */
const BORDER_FAINT = v("system.border", "--lm-border-faint");
const RADIUS = v("system.radius", "--lm-radius");
const BUTTON_IMAGE = v("system.images.button", "--lm-button-image");
const FRAME_IMAGE = v("system.images.frame", "--lm-frame-image");

const SCREEN_PART = part(".lm-screen", "画面の背景", "Screen background", [SCREEN_BG, SCREEN_IMAGE, FG, UI_FONT]);
const HEADING_PART = part(".lm-screen-title", "見出し", "Heading", [FG]);
const BUTTON_PART = part(".lm-button", "ボタン", "Buttons", [CONTROL_BG, BORDER, RADIUS, ACCENT, BUTTON_IMAGE, UI_FONT]);
const TAB_PART = part(".lm-tab", "タブ", "Tabs", [CONTROL_BG, BORDER, RADIUS, ACCENT, BUTTON_IMAGE]);

/** どの画面にも属さない文言の群（ほかの画面と共有するもの、読み上げ）。 */
export const SHARED_TEXT_GROUPS: Readonly<Record<string, Bilingual>> = {
  close: { ja: "閉じるボタン（どの画面も）", en: "Close buttons (every screen)" },
  a11y: { ja: "スクリーンリーダーとテキスト読み上げに渡す文", en: "Text handed to screen readers and text-to-speech" },
};

export const SCREEN_CATALOG: readonly ScreenCatalogEntry[] = [
  {
    id: "gate",
    name: { ja: "クリックで開始", en: "Click to start" },
    owner: "web",
    texts: ["gate", "gateTouch"],
    theme: [],
    classes: [".lm-gate"],
    vars: [],
    replace: [],
    parts: [part(".lm-gate", "クリックで開始の面", "Click-to-start layer", [])],
    without: {
      theme: { ja: "音を鳴らせるようにするための一回目の押しを受ける黒い面で、作品の値を読む前に出す", en: "A black layer that takes the first press so sound can play; it shows before the game's values are read" },
      replace: { ja: "同じ理由で差し替えない。起動の演出は splash で差し替える", en: "Not replaceable for the same reason; replace the opening sequence with splash" },
    },
  },
  {
    id: "splash",
    name: { ja: "起動の演出", en: "Opening sequence" },
    owner: "web",
    texts: [],
    theme: ["splash"],
    classes: [".lm-splash", ".lm-splash-screen", ".lm-splash-logo-image", ".lm-splash-block", ".lm-splash-label", ".lm-splash-text", ".lm-splash-rule"],
    vars: [],
    replace: ["splash", "endSplash"],
    parts: [
      part(".lm-splash-logo-image", "ロゴ", "Logo", [v("splash.logos")]),
      part(".lm-splash-screen", "起動の演出の画面", "Splash screen", [v("splash.notice.background"), v("splash.notice.color")]),
    ],
    without: { texts: { ja: "文はすべて ui.splash に作品が書く", en: "All text is written by the game in ui.splash" } },
  },
  {
    id: "warning",
    name: { ja: "注意書き", en: "Content warning" },
    owner: "web",
    texts: ["warning.*"],
    theme: ["contentWarning", "system"],
    classes: [".lm-warning", ".lm-warning-panel", ".lm-warning-text", ".lm-warning-buttons"],
    vars: [],
    systemVars: true,
    replace: [],
    parts: [
      part(".lm-warning-text", "注意書きの文", "Warning text", [v("contentWarning.text"), FG, UI_FONT]),
      BUTTON_PART,
      SCREEN_PART,
    ],
    without: { replace: { ja: "同意を受ける画面なので差し替えない。文は ui.contentWarning で替える", en: "Not replaceable because it collects consent; change the text with ui.contentWarning" } },
  },
  {
    id: "title",
    name: { ja: "タイトル", en: "Title" },
    owner: "web",
    texts: ["title.*"],
    theme: ["title.menu", "title.background", "title.logo", "title.showName", "system.titleBg", "system.titleButtonBg", "system.titleShadow"],
    classes: [".lm-title", ".lm-title-name", ".lm-title-logo", ".lm-title-menu", ".lm-title-button"],
    vars: ["--lm-title-bg", "--lm-title-button-bg", "--lm-title-shadow", "--lm-title-align", "--lm-title-direction", "--lm-title-gap", "--lm-title-button-width"],
    systemVars: true,
    replace: ["title", "system"],
    parts: [
      part(".lm-title-name", "作品の題名", "Game title", [v("system.titleShadow", "--lm-title-shadow"), FG]),
      part(".lm-title-logo", "ロゴ", "Logo", [v("title.logo")]),
      part(".lm-title-button", "タイトル画面のボタン", "Title buttons", [v("system.titleButtonBg", "--lm-title-button-bg"), BORDER, RADIUS, BUTTON_IMAGE, UI_FONT]),
      part(".lm-title-menu", "ボタンの並び", "Button layout", [v("title.menu")]),
      part(".lm-title", "タイトル画面の背景", "Title background", [v("title.background"), v("system.titleBg", "--lm-title-bg")]),
    ],
  },
  {
    id: "message",
    name: { ja: "メッセージウィンドウと本文", en: "Message window and text" },
    owner: "web",
    texts: [],
    theme: ["message", "text", "fonts", "face"],
    classes: [".message", ".text", ".ch", ".message-frame"],
    vars: ["--message-bg", "--message-fg", "--message-border", "--message-radius", "--message-image", "--message-padding", "--font", "--text-size", "--text-line", "--text-shadow", "--read-fg", "--lm-reveal-animation", "--lm-reveal-time", "--lm-reveal-easing"],
    replace: ["extensions.text", "extensions.dialogue"],
    parts: [
      part(".text", "本文", "Text", [v("text.font", "--font"), v("text.size", "--text-size"), v("text.color", "--message-fg"), v("text.lineHeight", "--text-line"), v("text.letterSpacing", "--text-letter-spacing"), v("text.shadow", "--text-shadow"), v("text.readColor", "--read-fg")]),
      part(".message", "メッセージウィンドウ", "Message window", [v("message.background", "--message-bg"), v("message.borderColor", "--message-border"), v("message.radius", "--message-radius"), v("message.padding", "--message-padding"), v("message.image", "--message-image")]),
    ],
    without: { texts: { ja: "本文は台本の文で、画面の決まった文言を持たない", en: "The text comes from the script; the window has no fixed wording" } },
  },
  {
    id: "name",
    name: { ja: "名前欄", en: "Name box" },
    owner: "web",
    texts: [],
    theme: ["name"],
    classes: [".name", ".lm-name-custom"],
    vars: ["--name-fg", "--name-bg", "--name-size", "--name-border", "--name-image", "--name-font", "--name-padding", "--name-rule"],
    replace: ["screens.name"],
    parts: [
      part(".name", "名前欄", "Name box", [v("name.color", "--name-fg"), v("name.size", "--name-size"), v("name.font", "--name-font"), v("name.background", "--name-bg"), v("name.borderColor", "--name-border"), v("name.letterSpacing", "--name-letter-spacing"), v("name.shadow", "--name-shadow"), v("name.image", "--name-image"), v("name.rule", "--name-rule")]),
    ],
    without: { texts: { ja: "名前は台本と cast.json の名前", en: "Names come from the script and cast.json" } },
  },
  {
    id: "glyph",
    name: { ja: "クリック待ちアイコン", en: "Click-wait icon" },
    owner: "web",
    texts: [],
    theme: ["glyph"],
    classes: [".glyph", ".glyph-shape"],
    vars: ["--glyph-fg", "--glyph-size", "--glyph-gap"],
    replace: ["extensions.text.glyph"],
    parts: [
      part(".glyph", "クリック待ちアイコン", "Click-wait icon", [v("glyph.color", "--glyph-fg"), v("glyph.size", "--glyph-size"), v("glyph.gap", "--glyph-gap"), v("glyph.shape"), v("glyph.text"), v("glyph.image"), v("glyph.motion")]),
    ],
    without: { texts: { ja: "文字で出すアイコンは ui.glyph.text で替える", en: "A text icon is set with ui.glyph.text" } },
  },
  {
    id: "choice",
    name: { ja: "選択肢", en: "Choices" },
    owner: "web",
    texts: ["choice.*"],
    theme: ["choice"],
    classes: [".choices", ".choice-image", ".choice-area", ".choice-timer", ".is-locked", ".is-read", ".lm-choices-custom"],
    vars: ["--choice-width", "--choice-size", "--choice-gap", "--choice-fg", "--choice-bg", "--choice-hover-bg", "--choice-border", "--choice-image", "--choice-radius", "--choice-font"],
    replace: ["screens.choice"],
    parts: [
      part(".choices > button", "選択肢のボタン", "Choice buttons", [v("choice.font", "--choice-font"), v("choice.size", "--choice-size"), v("choice.color", "--choice-fg"), v("choice.background", "--choice-bg"), v("choice.borderColor", "--choice-border"), v("choice.radius", "--choice-radius"), v("choice.letterSpacing", "--choice-letter-spacing"), v("choice.shadow", "--choice-shadow"), v("choice.image", "--choice-image")]),
      part(".choices", "選択肢の並び", "Choice list", [v("choice.width", "--choice-width"), v("choice.gap", "--choice-gap"), v("choice.y", "--choice-y")]),
    ],
  },
  {
    id: "menuBar",
    name: { ja: "クイックメニュー", en: "Quick menu" },
    owner: "web",
    texts: ["menu.*"],
    theme: ["menuBar"],
    classes: [".lm-menubar"],
    vars: ["--lm-bar-fg", "--lm-bar-shadow", "--lm-bar-image", "--lm-bar-active-image"],
    replace: ["screens.menuBar"],
    parts: [part(".lm-menubar", "クイックメニュー", "Quick menu", [v("menuBar.color", "--lm-bar-fg"), v("menuBar.shadow", "--lm-bar-shadow")])],
  },
  {
    id: "indicator",
    name: { ja: "オートとスキップの表示", en: "Auto and skip indicator" },
    owner: "web",
    texts: ["menu.auto", "menu.skip"],
    theme: ["indicator", "menuBar.color", "menuBar.shadow"],
    classes: [".lm-indicator", ".lm-indicator-mark", ".lm-indicator-at-top-left"],
    vars: [],
    systemVars: true,
    replace: ["screens.indicator"],
    parts: [part(".lm-indicator", "オートとスキップの表示", "Auto and skip indicator", [v("menuBar.color", "--lm-bar-fg"), v("menuBar.shadow", "--lm-bar-shadow")])],
  },
  {
    id: "menu",
    name: { ja: "メニュー", en: "Menu" },
    owner: "web",
    texts: ["menu.*"],
    theme: ["system"],
    classes: [".lm-menu", ".lm-menu-panel", ".lm-menu-list"],
    vars: [],
    systemVars: true,
    replace: ["screens.menu"],
    parts: [
      HEADING_PART,
      BUTTON_PART,
      part(".lm-menu-panel", "メニューの枠", "Menu panel", [SCREEN_BG, FRAME_IMAGE, BORDER, RADIUS, FG, UI_FONT]),
      part(".lm-menu", "背景の暗がり", "Backdrop", []),
    ],
    opens: ["menu"],
  },
  {
    id: "saveload",
    name: { ja: "セーブとロード", en: "Save and load" },
    owner: "web",
    texts: ["saveload.*", "saves.*"],
    theme: ["system", "saveSlots", "chapterNames"],
    classes: [".lm-saveload", ".lm-slots", ".lm-slot-thumb", ".lm-slot-name", ".lm-slot-text", ".lm-slot-date", ".lm-slot-tools"],
    vars: ["--lm-thumb-bg"],
    systemVars: true,
    replace: ["screens.saveload"],
    parts: [
      part(".lm-slot-name", "スロットの番号", "Slot number", [ACCENT]),
      part(".lm-slot-date", "日時", "Date", [FG_MUTED]),
      part(".lm-slot-chapter", "章の名前", "Chapter name", [v("chapterNames"), FG_MUTED]),
      part(".lm-slot-text", "本文の頭", "Text", [FG_MUTED]),
      part(".lm-slot-memo", "メモ", "Memo", [ACCENT]),
      part(".lm-slot-tool", "メモと保護のボタン", "Memo and lock buttons", [CONTROL_BG, BORDER_FAINT, RADIUS, FG_MUTED]),
      part(".lm-slot-thumb", "サムネイル", "Thumbnail", [BORDER_FAINT]),
      part(".lm-slot", "セーブスロット", "Save slot", [CONTROL_BG, BORDER_FAINT, RADIUS, ACCENT]),
      part(".lm-slots", "スロットの並び", "Slot grid", [v("saveSlots")]),
      HEADING_PART,
      TAB_PART,
      BUTTON_PART,
      SCREEN_PART,
    ],
    opens: ["save", "load"],
  },
  {
    id: "config",
    name: { ja: "コンフィグ", en: "Settings" },
    owner: "web",
    texts: ["config.*", "saves.*"],
    theme: ["system", "system.images.sliderThumb", "defaults", "settings", "message.background"],
    classes: [".lm-config", ".lm-config-row", ".lm-config-label", ".lm-config-control", ".lm-config-value", ".lm-preview"],
    vars: ["--lm-slider-thumb"],
    systemVars: true,
    replace: ["screens.config"],
    parts: [
      part(".lm-config-label", "項目の名前", "Item name", [FG]),
      part(".lm-config-value", "値", "Value", [FG_MUTED]),
      part(".lm-range", "スライダー", "Slider", [v("system.images.sliderThumb", "--lm-slider-thumb"), ACCENT]),
      part(".lm-preview", "テキストのプレビュー", "Text preview", [v("message.background", "--message-bg"), BORDER]),
      part(".lm-toggle", "切り替えのボタン", "Toggle buttons", [CONTROL_BG, BORDER, RADIUS, ACCENT, BUTTON_IMAGE]),
      HEADING_PART,
      TAB_PART,
      BUTTON_PART,
      SCREEN_PART,
    ],
    opens: ["config"],
  },
  {
    id: "backlog",
    name: { ja: "バックログ", en: "Backlog" },
    owner: "web",
    texts: ["backlog.*"],
    theme: ["system", "backlog", "backlogChoices"],
    classes: [".lm-backlog", ".lm-log", ".lm-log-name", ".lm-log-text", ".lm-log-search"],
    vars: ["--lm-speaker-fg", "--lm-speaker-font"],
    systemVars: true,
    replace: ["screens.backlog"],
    parts: [
      part(".lm-log-name", "話者の名前", "Speaker", [ACCENT]),
      part(".lm-log-text", "本文", "Text", [FG]),
      part(".lm-log-search", "検索欄", "Search box", [CONTROL_BG, BORDER, RADIUS, FG, UI_FONT]),
      HEADING_PART,
      BUTTON_PART,
      SCREEN_PART,
    ],
    opens: ["backlog"],
  },
  {
    id: "confirm",
    name: { ja: "確認", en: "Confirmation" },
    owner: "web",
    texts: ["confirm.*", "analytics.*", "crash.*", "update.*", "quitUnavailable"],
    theme: ["system", "system.images.frame"],
    classes: [".lm-dialog-backdrop", ".lm-dialog", ".lm-dialog-message", ".lm-dialog-buttons"],
    vars: ["--lm-frame-bg", "--lm-frame-border", "--lm-backdrop"],
    systemVars: true,
    replace: ["screens.confirm"],
    parts: [
      part(".lm-dialog-message", "確認の文", "Message", [FG]),
      BUTTON_PART,
      part(".lm-dialog", "確認の枠", "Dialog", [SCREEN_BG, FRAME_IMAGE, BORDER, RADIUS, UI_FONT]),
      part(".lm-dialog-backdrop", "背景の暗がり", "Backdrop", []),
    ],
    opens: ["confirm"],
  },
  {
    id: "ending",
    name: { ja: "結末の名前", en: "Ending name" },
    owner: "web",
    texts: ["ending.*"],
    theme: ["ending", "system.titleBg", "system.fg", "system.accent"],
    classes: [".lm-ending", ".lm-ending-go", ".lm-ending-kind", ".lm-ending-name", ".lm-ending-rule", ".lm-ending-mark", ".lm-ending-mark-above", ".lm-ending-mark-none"],
    vars: ["--lm-ending-bg", "--lm-ending-image", "--lm-ending-font", "--lm-ending-fg", "--lm-ending-size", "--lm-ending-letter-spacing", "--lm-ending-kind-fg", "--lm-ending-rule", "--lm-ending-mark-fg", "--lm-ending-mark-size"],
    replace: ["screens.ending"],
    parts: [
      part(".lm-ending-kind", "種類", "Kind", [v("ending.kindColor", "--lm-ending-kind-fg"), ACCENT]),
      part(".lm-ending-name", "エンディングの名前", "Ending name", [v("ending.font", "--lm-ending-font"), v("ending.color", "--lm-ending-fg"), v("ending.size", "--lm-ending-size"), v("ending.letterSpacing", "--lm-ending-letter-spacing")]),
      part(".lm-ending-rule", "区切り線", "Divider", [v("ending.rule", "--lm-ending-rule"), ACCENT]),
      part(".lm-ending-mark", "終わりの表記", "End mark", [v("ending.mark"), v("ending.markColor", "--lm-ending-mark-fg"), v("ending.markSize", "--lm-ending-mark-size")]),
      part(".lm-ending", "背景", "Background", [v("ending.background", "--lm-ending-bg"), v("ending.image", "--lm-ending-image"), v("system.titleBg", "--lm-title-bg")]),
    ],
    opens: ["ending"],
  },
  {
    id: "extra",
    name: { ja: "おまけ", en: "Extras" },
    owner: "web",
    texts: ["extra.*"],
    theme: ["system"],
    classes: [".lm-extra", ".lm-extra-grid", ".lm-extra-thumb", ".lm-extra-viewer", ".lm-extra-list", ".lm-music"],
    vars: [],
    systemVars: true,
    replace: ["screens.extra"],
    parts: [
      part(".lm-extra-thumb", "CG のサムネイル", "CG thumbnail", [CONTROL_BG, BORDER, RADIUS]),
      HEADING_PART,
      TAB_PART,
      BUTTON_PART,
      SCREEN_PART,
    ],
    opens: ["extra"],
  },
  {
    id: "flowchart",
    name: { ja: "フローチャート", en: "Flowchart" },
    owner: "web",
    texts: ["flowchart.*"],
    theme: ["system"],
    classes: [".lm-flow", ".lm-flow-canvas", ".lm-flow-summary", ".lm-flow-ending"],
    vars: [],
    systemVars: true,
    replace: ["screens.flowchart"],
    parts: [
      part(".lm-flow-summary", "到達の数", "Progress", [FG_MUTED, UI_FONT]),
      HEADING_PART,
      TAB_PART,
      BUTTON_PART,
      SCREEN_PART,
    ],
    opens: ["flowchart"],
  },
  {
    id: "help",
    name: { ja: "操作説明", en: "Controls help" },
    owner: "web",
    texts: ["help.*"],
    theme: ["system", "help"],
    classes: [".lm-help", ".lm-help-body", ".lm-help-table", ".lm-help-page"],
    vars: [],
    systemVars: true,
    replace: ["screens.help"],
    parts: [
      part(".lm-help-table", "操作の表", "Controls table", [BORDER_FAINT, FG_MUTED]),
      HEADING_PART,
      TAB_PART,
      BUTTON_PART,
      SCREEN_PART,
    ],
    opens: ["help"],
  },
  {
    id: "items",
    name: { ja: "持ち物", en: "Inventory" },
    owner: "web",
    texts: ["items.*"],
    theme: ["system"],
    classes: [".lm-items", ".lm-items-grid", ".lm-items-detail"],
    vars: [],
    systemVars: true,
    replace: ["screens.items"],
    parts: [
      part(".lm-items-tile", "持ち物", "Item", [CONTROL_BG, BORDER, RADIUS, ACCENT]),
      part(".lm-items-name", "名前", "Name", [FG]),
      part(".lm-items-desc", "説明", "Description", [FG]),
      part(".lm-items-picture", "絵", "Picture", []),
      HEADING_PART,
      BUTTON_PART,
      SCREEN_PART,
    ],
    opens: ["items"],
  },
  {
    id: "dialog",
    name: { ja: "確認と入力のダイアログ（@dialog、@text-input）", en: "Dialog and text input (@dialog, @text-input)" },
    owner: "web",
    texts: ["dialog.*"],
    theme: ["system.border", "system.controlBg", "system.fg", "message.background", "text.color", "text.font"],
    classes: [".lm-panel", ".lm-panel-box", ".lm-panel-buttons", ".lm-panel-custom", ".lm-keyboard"],
    vars: ["--lm-dialog-border", "--lm-dialog-button-bg", "--lm-dialog-button-fg"],
    replace: ["screens.dialog"],
    parts: [
      part(".lm-panel-buttons", "ボタン", "Buttons", [v("system.controlBg", "--lm-dialog-button-bg"), v("system.fg", "--lm-dialog-button-fg"), v("system.border", "--lm-dialog-border")]),
      part(".lm-panel-box", "ダイアログ", "Dialog", [v("message.background", "--message-bg"), v("system.border", "--lm-dialog-border"), v("text.font", "--font"), v("text.color", "--message-fg")]),
    ],
  },
  {
    id: "notice",
    name: { ja: "通知（@notify）", en: "Notifications (@notify)" },
    owner: "web",
    texts: [],
    theme: ["system.screenBg", "system.fg", "system.accent", "text.font"],
    classes: [".lm-notices", ".lm-notice", ".lm-notice-title"],
    vars: ["--lm-notice-bg", "--lm-notice-fg", "--lm-notice-accent", "--lm-notice-top", "--lm-notice-right", "--lm-notice-gap", "--lm-notice-width"],
    replace: ["screens.toast"],
    parts: [part(".lm-notice", "通知", "Notification", [v("system.screenBg", "--lm-notice-bg"), v("system.fg", "--lm-notice-fg"), v("system.accent", "--lm-notice-theme-accent"), v("text.font", "--font")])],
    without: { texts: { ja: "文は @notify と作品が出すもの", en: "The text comes from @notify and the game" } },
  },
  {
    id: "toast",
    name: { ja: "短い知らせ（セーブしました など）", en: "Short messages (Saved, etc.)" },
    owner: "web",
    texts: ["toast.*", "store.*"],
    theme: ["system.screenBg", "system.fg", "system.border", "system.radius"],
    classes: [".lm-toast"],
    vars: ["--lm-toast-bg"],
    replace: [],
    parts: [part(".lm-toast", "短い知らせ", "Short message", [v("system.screenBg", "--lm-toast-bg"), BORDER, RADIUS, FG])],
    without: { replace: { ja: "一行の知らせで、文言の表と CSS で足りる。作品の知らせは @notify と screens.toast", en: "A one-line message; the text table and CSS cover it. Use @notify and screens.toast for the game's own messages" } },
  },
  {
    id: "term",
    name: { ja: "用語の説明", en: "Glossary popup" },
    owner: "web",
    texts: ["extra.termAdded"],
    theme: ["system"],
    classes: [".lm-term-pop", ".lm-term-name", ".lm-term-desc", ".lm-term"],
    vars: [],
    systemVars: true,
    replace: [],
    parts: [
      part(".lm-term-name", "用語", "Term", [ACCENT]),
      part(".lm-term-pop", "用語の説明", "Glossary popup", [SCREEN_BG, FG, BORDER, RADIUS, UI_FONT]),
      part(".lm-term", "本文の用語", "Term in the text", []),
    ],
    without: { replace: { ja: "本文の語に付く小さい札で、CSS で足りる。用語集の画面はおまけ（screens.extra）", en: "A small popup on a word; CSS covers it. The glossary list is part of the extras (screens.extra)" } },
  },
  {
    id: "captions",
    name: { ja: "効果音の字幕", en: "Sound captions" },
    owner: "web",
    texts: ["captions.*"],
    theme: ["captions"],
    classes: [".lm-caption"],
    vars: [],
    replace: [],
    parts: [part(".lm-caption", "字幕", "Caption", [])],
    without: { replace: { ja: "読みやすさのための表示で、白い文字と暗い地のまま変えない（CSS では変えられる）", en: "An accessibility aid that stays white on dark (CSS can still change it)" } },
  },
  {
    id: "rotate",
    name: { ja: "端末の向きの案内", en: "Rotate-device hint" },
    owner: "web",
    texts: ["rotate", "rotateKeep"],
    theme: [],
    classes: [".lm-rotate"],
    vars: [],
    replace: [],
    parts: [part(".lm-rotate", "端末の向きの案内", "Rotate-device hint", [])],
    without: {
      theme: { ja: "端末の案内で、作品の見た目に合わせない", en: "A device hint that does not follow the game's look" },
      replace: { ja: "同じ理由で差し替えない", en: "Not replaceable for the same reason" },
    },
  },
  {
    id: "feedback",
    name: { ja: "テスト版の指摘", en: "Playtest feedback" },
    owner: "web",
    texts: ["feedback.*"],
    theme: [],
    classes: [".lm-feedback"],
    vars: [],
    replace: [],
    parts: [part(".lm-feedback", "指摘の欄", "Feedback form", [])],
    without: {
      theme: { ja: "lim build --feedback で書き出したテスト版だけに出る開発ツール", en: "A development tool shown only in playtest builds made with lim build --feedback" },
      replace: { ja: "同じ理由で差し替えない", en: "Not replaceable for the same reason" },
    },
  },
  {
    id: "codex",
    name: { ja: "図鑑（@codex）", en: "Codex (@codex)" },
    owner: "std",
    texts: ["codex.*"],
    theme: ["system"],
    classes: [".lm-codex", ".lm-codex-list", ".lm-codex-item", ".lm-codex-detail", ".lm-codex-fresh", ".lm-codex-related"],
    vars: [],
    systemVars: true,
    replace: ["screens.codex"],
    parts: [
      part(".lm-codex-fresh", "新着の印", "New badge", [ACCENT, RADIUS, SCREEN_BG]),
      part(".lm-codex-node", "関係図の人物", "Person on the chart", [RADIUS, ACCENT, BORDER, SCREEN_BG]),
      part(".lm-codex-list", "一覧", "List", [BORDER]),
      HEADING_PART,
      BUTTON_PART,
      part(".lm-codex", "画面の背景", "Screen background", [SCREEN_BG, SCREEN_IMAGE, FG]),
    ],
    opens: ["codex"],
  },
  {
    id: "investigate",
    name: { ja: "調べる画面（@investigate）", en: "Investigation (@investigate)" },
    owner: "std",
    texts: ["investigate.*"],
    theme: ["system"],
    classes: [".lm-investigate", ".lm-investigate-spot", ".lm-investigate-tip", ".lm-investigate-finish", ".lm-investigate-reveal", ".lm-investigate-progress", ".lm-investigate-opening"],
    vars: [],
    systemVars: true,
    replace: ["extensions.renderers.investigate"],
    parts: [
      part(".lm-investigate-tip", "場所の名前", "Spot name", [SCREEN_BG, BORDER, RADIUS]),
      part(".lm-investigate-spot", "調べる場所", "Spot", [RADIUS, FG_MUTED]),
      part(".lm-investigate", "調べる画面", "Investigation", [FG, UI_FONT]),
    ],
    opens: ["investigate"],
  },
  {
    id: "map-choice",
    name: { ja: "地図から選ぶ（@map-choice）", en: "Map choice (@map-choice)" },
    owner: "std",
    texts: ["mapChoice.*"],
    theme: ["system"],
    classes: [".lm-map-choice", ".lm-map-choice-spot", ".lm-map-choice-panel", ".lm-map-choice-locked", ".lm-map-choice-go"],
    vars: [],
    systemVars: true,
    replace: ["extensions.renderers.map-choice"],
    parts: [
      part(".lm-map-choice-panel", "説明の枠", "Detail panel", [SCREEN_BG, BORDER, RADIUS]),
      part(".lm-map-choice-spot", "場所", "Spot", [RADIUS, FG]),
      part(".lm-map-choice", "地図", "Map", [FG, UI_FONT]),
    ],
    opens: ["map-choice"],
  },
  {
    id: "chapter",
    name: { ja: "章の扉と章末（@chapter-card、@chapter-end）", en: "Chapter card and chapter end (@chapter-card, @chapter-end)" },
    owner: "std",
    texts: ["chapter.*"],
    theme: ["chapter", "system.titleBg", "system.fg", "system.accent"],
    classes: [".lim-chapter", ".lim-chapter-number", ".lim-chapter-title", ".lim-chapter-rule", ".lim-chapter-subtitle", ".lim-chapter-end", ".lm-chapter-no-rule"],
    vars: [
      "--lim-chapter-bg",
      "--lim-chapter-image",
      "--lim-chapter-font",
      "--lim-chapter-fg",
      "--lim-chapter-size",
      "--lim-chapter-letter-spacing",
      "--lim-chapter-accent",
      "--lim-chapter-number-size",
      "--lim-chapter-subtitle-fg",
      "--lim-chapter-subtitle-size",
      "--lim-chapter-rule",
      "--lim-chapter-end-fg",
      "--lim-chapter-end-size",
    ],
    replace: ["extensions.renderers.chapter-card", "extensions.renderers.chapter-end"],
    parts: [
      part(".lim-chapter-number", "章の番号", "Chapter number", [v("chapter.accent", "--lim-chapter-accent"), v("chapter.numberSize", "--lim-chapter-number-size")]),
      part(".lim-chapter-title", "章の題", "Chapter title", [v("chapter.size", "--lim-chapter-size"), v("chapter.letterSpacing", "--lim-chapter-letter-spacing"), v("chapter.color", "--lim-chapter-fg"), v("chapter.font", "--lim-chapter-font")]),
      part(".lim-chapter-rule", "区切り線", "Divider", [v("chapter.rule", "--lim-chapter-rule"), v("chapter.accent", "--lim-chapter-accent")]),
      part(".lim-chapter-subtitle", "副題", "Subtitle", [v("chapter.subtitleColor", "--lim-chapter-subtitle-fg"), v("chapter.subtitleSize", "--lim-chapter-subtitle-size")]),
      part(".lim-chapter", "背景", "Background", [v("chapter.background", "--lim-chapter-bg"), v("chapter.image", "--lim-chapter-image"), v("system.titleBg", "--lm-title-bg")]),
    ],
  },
  {
    id: "cutin",
    name: { ja: "カットイン（@cutin）", en: "Cut-in (@cutin)" },
    owner: "std",
    texts: [],
    theme: [],
    classes: [".lim-cutin-frame", ".lim-cutin-image"],
    vars: [],
    replace: ["extensions.renderers.cutin"],
    parts: [part(".lim-cutin-frame", "カットイン", "Cut-in", [])],
    without: {
      texts: { ja: "絵だけの演出で文言を持たない", en: "An image-only effect with no wording" },
      theme: { ja: "絵と命令の引数で決まる", en: "Its look comes from the image and the command's parameters" },
    },
  },
  {
    id: "hud",
    name: { ja: "常駐の表示（@hud）", en: "HUD (@hud)" },
    owner: "std",
    texts: [],
    theme: ["message.background", "message.borderColor", "text.color", "text.shadow", "text.size", "text.font"],
    classes: [".lim-hud", ".lim-hud-button", ".lim-hud-text"],
    vars: ["--message-bg", "--message-fg", "--message-border", "--text-shadow"],
    replace: ["extensions.renderers.hud"],
    parts: [
      part(".lim-hud-button", "ボタン", "Buttons", [v("message.background", "--message-bg"), v("message.borderColor", "--message-border"), v("text.color", "--message-fg"), v("text.size", "--text-size")]),
      part(".lim-hud-text", "文", "Text", [v("text.color", "--message-fg"), v("text.font", "--font"), v("text.size", "--text-size"), v("text.shadow", "--text-shadow")]),
    ],
    without: { texts: { ja: "文と絵は作品が @hud に書く", en: "The game writes the text and images in @hud" } },
  },
  {
    id: "chat",
    name: { ja: "チャットの画面（@chat-open、ui.chat.dialogue）", en: "Chat screen (@chat-open, ui.chat.dialogue)" },
    owner: "std",
    texts: [],
    theme: ["chat"],
    classes: [".lim-chat", ".lim-chat-head", ".lim-chat-list", ".lim-chat-row", ".lim-chat-bubble", ".lim-chat-name", ".lim-chat-note"],
    vars: ["--chat-bg", "--chat-fg", "--chat-other-bg", "--chat-me-bg", "--chat-radius", "--chat-font"],
    replace: ["extensions.dialogue"],
    parts: [
      part(".lim-chat-name", "名前", "Name", [v("chat.nameColor", "--chat-name")]),
      part(".lim-chat-note", "地の文", "Narration", [v("chat.noteColor", "--chat-note")]),
      part(".lim-chat-row.is-me .lim-chat-bubble", "自分の吹き出し", "Own bubble", [v("chat.meBackground", "--chat-me-bg"), v("chat.meColor", "--chat-me-fg"), v("chat.radius", "--chat-radius"), v("chat.tailRadius", "--chat-tail-radius")]),
      part(".lim-chat-bubble", "相手の吹き出し", "Other's bubble", [v("chat.otherBackground", "--chat-other-bg"), v("chat.otherColor", "--chat-other-fg"), v("chat.radius", "--chat-radius"), v("chat.tailRadius", "--chat-tail-radius")]),
      part(".lim-chat-head", "ヘッダー", "Header", [v("chat.headBackground", "--chat-head-bg"), v("chat.headColor", "--chat-head-fg")]),
      part(".lim-chat", "チャットの画面", "Chat screen", [v("chat.background", "--chat-bg"), v("chat.image", "--chat-image"), v("chat.font", "--chat-font"), v("chat.size", "--chat-size"), v("chat.color", "--chat-fg")]),
    ],
    without: { texts: { ja: "文は台本と ui.chat.title", en: "The text comes from the script and ui.chat.title" } },
  },
];

/** 段の見出し。 */
const HEAD: Record<"ja" | "en", string[]> = {
  ja: ["画面", "1 文言のキー", "2 テーマの値（ui）", "3 CSS の部品と変数", "4 差し替えフック"],
  en: ["Screen", "1 Text keys", "2 Theme values (ui)", "3 CSS classes and variables", "4 Replacement hook"],
};

const code = (s: string) => `\`${s}\``;
const list = (items: readonly string[]) => items.map(code).join("、");
const listEn = (items: readonly string[]) => items.map(code).join(", ");

/** docs/screens.md（lang が ja）と英訳（en）に入れる表と、埋めていない段の一覧。 */
export function screenCatalogMarkdown(lang: "ja" | "en"): string {
  const join = lang === "ja" ? list : listEn;
  const none = "—";
  const rows = SCREEN_CATALOG.map((e) => {
    const css = [join(e.classes), e.vars.length > 0 ? join(e.vars) : "", e.systemVars ? (lang === "ja" ? "共通の変数" : "shared variables") : ""].filter(Boolean).join(lang === "ja" ? "、" : ", ");
    const cells = [e.name[lang], e.texts.length > 0 ? join(e.texts) : none, e.theme.length > 0 ? join(e.theme) : none, css || none, e.replace.length > 0 ? join(e.replace) : none];
    return `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  });
  const head = `| ${HEAD[lang].join(" | ")} |\n|${HEAD[lang].map(() => "---").join("|")}|`;
  const tierName: Record<Exclude<ScreenTier, "css">, Bilingual> = {
    texts: { ja: "文言", en: "Text" },
    theme: { ja: "テーマの値", en: "Theme values" },
    replace: { ja: "差し替え", en: "Replacement" },
  };
  const gaps = SCREEN_CATALOG.flatMap((e) =>
    (Object.entries(e.without ?? {}) as [Exclude<ScreenTier, "css">, Bilingual][]).map(([tier, why]) => (lang === "ja" ? `- ${e.name.ja}の${tierName[tier].ja}: ${why.ja}` : `- ${e.name.en}, ${tierName[tier].en.toLowerCase()}: ${why.en}`)),
  );
  const shared = Object.entries(SHARED_TEXT_GROUPS).map(([k, v]) => `- ${code(k)}: ${v[lang]}`);
  const sharedHead = lang === "ja" ? "どの画面にも属さない文言のキー:" : "Text keys shared by every screen:";
  const varsHead = lang === "ja" ? "共通の変数（ui.system の値が入る。システム画面のすべてが読む）:" : "Shared variables (filled from ui.system and read by every system screen):";
  const gapsHead = lang === "ja" ? "持たない段とその理由:" : "Tiers a screen does not have, and why:";
  // 部品の表（制作画面の「ゲームの画面」で、見本の部品を押すと出す欄）
  const partsHead = lang === "ja" ? "画面の部品と、その見た目を決めるテーマの値（括弧の中は値を入れる CSS の変数。「—」はテーマの値が無く、作品の CSS でセレクタを上書きする部品）:" : "Screen parts and the theme values that set their look (the CSS variable each value goes into is in parentheses; a dash marks a part with no theme value, styled by overriding its selector in the game's CSS):";
  const partsCols = lang === "ja" ? ["画面", "部品", "セレクタ", "テーマの値（ui）"] : ["Screen", "Part", "Selector", "Theme values (ui)"];
  const value = (p: PartValue) => (p.var ? `${code(p.path)}${lang === "ja" ? `（${code(p.var)}）` : ` (${code(p.var)})`}` : code(p.path));
  const partRows = SCREEN_CATALOG.flatMap((e) =>
    e.parts.map((p, i) => {
      const cells = [i === 0 ? e.name[lang] : "", p.name[lang], code(p.selector), p.values.length > 0 ? p.values.map(value).join(lang === "ja" ? "、" : ", ") : none];
      return `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
    }),
  );
  const partsTable = [`| ${partsCols.join(" | ")} |`, `|${partsCols.map(() => "---").join("|")}|`, ...partRows];
  return [head, ...rows, "", varsHead, "", join(SYSTEM_SCREEN_VARS), "", sharedHead, "", ...shared, "", gapsHead, "", ...gaps, "", partsHead, "", ...partsTable].join("\n");
}

/** docs の中で表を入れる場所の印。 */
export const CATALOG_MARKERS = { start: "<!-- screen-catalog:start -->", end: "<!-- screen-catalog:end -->" } as const;

/** docs の文の印のあいだを、今の表に替える。印が無ければ null。 */
export function withScreenCatalog(doc: string, lang: "ja" | "en"): string | null {
  const a = doc.indexOf(CATALOG_MARKERS.start);
  const b = doc.indexOf(CATALOG_MARKERS.end);
  if (a < 0 || b < a) return null;
  return `${doc.slice(0, a + CATALOG_MARKERS.start.length)}\n${screenCatalogMarkdown(lang)}\n${doc.slice(b)}`;
}
