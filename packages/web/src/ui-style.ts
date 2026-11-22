import { isPortrait, uiSpace, type CastEntry, type UiConfig, type UiImageSlice, type UiNvl } from "@liminalia/lang";

/**
 * liminalia.json の ui（ゲームの見た目の設定）を舞台に当てる。色・大きさは舞台の CSS 変数（style.css・system/default.css が読む）、
 * メッセージ枠と名前の欄の位置は要素の style に書く。書いていない項目は CSS の既定に戻す（設定を外したときも元に戻る）。
 */
export interface UiTargets {
  stage: HTMLElement;
  /** 作品の画面の大きさ（無ければ舞台の大きさから測る）。 */
  screen?: { width: number; height: number };
  message: HTMLElement;
  name: HTMLElement;
  /** 素材の URL。 */
  asset(kind: "image" | "bgimage" | "others", path: string): string;
}

/** NVL の見た目の CSS 変数（ui.nvl は舞台に、ui.nvlStyles の名前ごとのものは枠に置く）。 */
const NVL_VARS = ["--nvl-bg", "--nvl-image", "--nvl-padding", "--nvl-align", "--nvl-justify", "--nvl-font", "--nvl-fg", "--nvl-size", "--nvl-line", "--nvl-fade", "--nvl-names"] as const;

/** 当てる CSS 変数（設定を外したときに消すため、名前を一か所に持つ）。 */
const VARS = [
  "--lm-reveal-animation",
  "--lm-reveal-time",
  "--lm-reveal-easing",
  "--font",
  "--text-size",
  "--text-line",
  "--ruby-size",
  "--ruby-gap",
  "--paragraph-gap",
  "--line-chars",
  "--line-break",
  "--hanging",
  "--glyph-size",
  "--glyph-gap",
  "--text-shadow",
  "--message-fg",
  "--read-fg",
  "--message-bg",
  "--message-border",
  "--message-radius",
  "--message-image",
  "--message-padding",
  "--face-width",
  "--face-height",
  "--face-x",
  "--face-y",
  "--name-fg",
  "--name-size",
  "--name-bg",
  "--name-border",
  "--name-image",
  "--glyph-fg",
  "--choice-width",
  "--choice-size",
  "--choice-gap",
  "--choice-fg",
  "--choice-read-fg",
  "--choice-read-opacity",
  "--choice-bg",
  "--choice-hover-bg",
  "--choice-border",
  "--choice-image",
  "--choice-hover-image",
  "--choice-height",
  "--choice-y",
  "--choice-backdrop",
  "--lm-accent",
  "--lm-ui-font",
  "--lm-fg",
  "--lm-fg-muted",
  "--lm-screen-bg",
  "--lm-control-bg",
  "--lm-control-hover",
  "--lm-control-active",
  "--lm-border",
  "--lm-border-faint",
  "--lm-radius",
  "--lm-title-bg",
  "--lm-screen-image",
  "--lm-button-image",
  "--lm-button-hover-image",
  "--lm-button-border",
  "--lm-frame-image",
  "--lm-frame-bg",
  "--lm-frame-border",
  "--choice-cursor",
  "--text-align",
  "--text-emphasis",
  "--text-letter-spacing",
  "--text-weight",
  "--text-stroke",
  "--text-top-gap",
  "--message-border-width",
  "--message-backdrop",
  "--message-backdrop-height",
  "--message-border-image",
  "--message-frame-border",
  "--name-border-width",
  "--name-border-image",
  "--name-font",
  "--name-weight",
  "--name-letter-spacing",
  "--name-shadow",
  "--name-padding",
  "--name-line",
  "--name-rule",
  "--choice-font",
  "--choice-weight",
  "--choice-letter-spacing",
  "--choice-line",
  "--choice-align",
  "--choice-padding",
  "--choice-margin",
  "--choice-min-height",
  "--choice-fixed-width",
  "--choice-transition",
  "--choice-radius",
  "--choice-blur",
  "--choice-shadow",
  "--choice-hover-fg",
  "--choice-hover-border",
  "--choice-hover-shadow",
  "--choice-gradient",
  "--choice-hover-gradient",
  "--choice-border-width",
  "--choice-border-image",
  "--choice-hover-border-image",
  "--choice-ornament-color",
  "--lm-button-border-image",
  "--lm-button-hover-border-image",
  "--lm-frame-border-image",
  "--lm-slider-thumb",
  "--lm-bar-fg",
  "--lm-bar-shadow",
  "--lm-title-button-bg",
  "--lm-title-shadow",
  "--lm-title-align",
  "--lm-title-direction",
  "--lm-title-gap",
  "--lm-title-button-width",
  "--chat-size",
  "--chat-font",
  "--chat-fg",
  "--chat-bg",
  "--chat-image",
  "--chat-head-bg",
  "--chat-head-fg",
  "--chat-other-bg",
  "--chat-other-fg",
  "--chat-me-bg",
  "--chat-me-fg",
  "--chat-radius",
  "--chat-tail-radius",
  "--chat-name",
  "--chat-note",
  "--chat-face-size",
  "--chat-reply-bg",
  "--lm-text-font",
  "--lm-ending-bg",
  "--lm-ending-image",
  "--lm-ending-font",
  "--lm-ending-fg",
  "--lm-ending-size",
  "--lm-ending-letter-spacing",
  "--lm-ending-kind-fg",
  "--lm-ending-rule",
  "--lm-ending-mark-fg",
  "--lm-ending-mark-size",
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
  "--lm-dialog-border",
  "--lm-dialog-button-bg",
  "--lm-dialog-button-fg",
  "--lm-notice-bg",
  "--lm-notice-fg",
  "--lm-notice-theme-accent",
  "--lm-toast-bg",
  ...NVL_VARS,
] as const;

/**
 * NVL の見た目（ui.nvl と ui.nvlStyles の名前ごとのもの）の CSS 変数の値（style.css の .message.nvl が読む）。書いていない項目は入れない。
 */
export function nvlVars(look: UiNvl | undefined, asset: (path: string) => string): Partial<Record<(typeof NVL_VARS)[number], string>> {
  const out: Partial<Record<(typeof NVL_VARS)[number], string>> = {};
  if (!look) return out;
  if (look.background) out["--nvl-bg"] = look.background;
  if (look.image) out["--nvl-image"] = cssUrl(asset(look.image));
  if (look.padding !== undefined) {
    const [top, right, bottom, left] = typeof look.padding === "number" ? [look.padding, look.padding, look.padding, look.padding] : look.padding;
    out["--nvl-padding"] = `${top}px ${right}px ${bottom}px ${left}px`;
  }
  if (look.align) out["--nvl-align"] = look.align;
  if (look.valign) out["--nvl-justify"] = look.valign === "top" ? "flex-start" : look.valign === "center" ? "center" : "flex-end";
  if (look.font) out["--nvl-font"] = look.font;
  if (look.color) out["--nvl-fg"] = look.color;
  if (typeof look.size === "number") out["--nvl-size"] = `${look.size}px`;
  if (typeof look.lineHeight === "number") out["--nvl-line"] = String(look.lineHeight);
  if (typeof look.fade === "number") out["--nvl-fade"] = `${Math.max(0, look.fade)}ms`;
  if (look.names !== undefined) out["--nvl-names"] = look.names ? "inline" : "none";
  return out;
}

/** 名前を付けた NVL の見た目（ui.nvlStyles）を枠に置く（look が無ければ外して ui.nvl の見た目に戻す）。 */
export function applyNvlStyle(message: HTMLElement, look: UiNvl | undefined, asset: (path: string) => string): void {
  for (const v of NVL_VARS) message.style.removeProperty(v);
  for (const [k, v] of Object.entries(nvlVars(look, asset))) message.style.setProperty(k, v);
}

const FONT_STYLE_ID = "lm-ui-font";
const FONT_FAMILY = "liminalia-ui-text";

/** ui.fonts で読み込んだ書体（family と file の組）。同じものを読み直さない。 */
const loadedFonts = new Set<string>();

function loadFonts(t: UiTargets, ui: UiConfig | undefined): void {
  if (typeof FontFace === "undefined") return;
  for (const f of ui?.fonts ?? []) {
    const key = `${f.family}\n${f.file}\n${f.weight ?? ""}`;
    if (loadedFonts.has(key)) continue;
    loadedFonts.add(key);
    const face = new FontFace(f.family, `url("${t.asset("others", f.file)}")`, { display: "swap", ...(f.weight !== undefined ? { weight: String(f.weight) } : {}) });
    document.fonts.add(face);
    face.load().catch(() => console.warn(`書体を読み込めません: ${f.file}`));
  }
}

/** border-image の値（角を伸ばさない画像）。 */
function sliced(image: string, slice: UiImageSlice): string {
  const [top, right, bottom, left] = typeof slice === "number" ? [slice, slice, slice, slice] : slice;
  return `${image} ${top} ${right} ${bottom} ${left} fill / ${top}px ${right}px ${bottom}px ${left}px stretch`;
}

const isGradient = (v: string | undefined) => !!v && /gradient\(/.test(v);

/**
 * CSS の url()。CSS 変数に入れて外部のスタイルシートで使うと、相対パスはそのスタイルシートが基準になるので、
 * ページを基準にした絶対の URL にしておく。
 */
const absolute = (u: string) => (typeof document === "undefined" || !document.baseURI ? u : new URL(u, document.baseURI).href);
export const cssUrl = (u: string) => `url("${absolute(u).replace(/"/g, '\\"')}")`;

/** 枠の位置と大きさの CSS 変数（ゲームの設定の ui.message の x・y・width・height・scroll）。 */
const MESSAGE_BOX_VARS = ["--message-left", "--message-top", "--message-right", "--message-bottom", "--message-width", "--message-height", "--message-min-height"];

/** 縦書きのメッセージ枠の既定の幅（style.css の .message.vertical と同じ）。 */
const VERTICAL_WIDTH = 420;
/** 縦長の作品のメッセージ枠の既定の高さと、下の余白（system/portrait.css の --message-min-height・--message-bottom と同じ）。 */
const PORTRAIT_MESSAGE_HEIGHT = 250;
const PORTRAIT_MESSAGE_BOTTOM = 64;

export function applyUiStyle(t: UiTargets, ui: UiConfig | undefined): void {
  const s = t.stage.style;
  for (const v of VARS) s.removeProperty(v);
  const set = (name: (typeof VARS)[number], value: string | number | undefined, unit = "") => {
    if (value !== undefined && value !== "") s.setProperty(name, typeof value === "number" ? `${value}${unit}` : value);
  };

  loadFonts(t, ui);

  // 文字
  const text = ui?.text;
  let font = document.getElementById(FONT_STYLE_ID);
  if (text?.fontFile) {
    if (!font) {
      font = document.createElement("style");
      font.id = FONT_STYLE_ID;
      document.head.append(font);
    }
    font.textContent = `@font-face { font-family: "${FONT_FAMILY}"; src: ${cssUrl(t.asset("others", text.fontFile))}; font-display: swap; }`;
  } else font?.remove();
  const family = [text?.fontFile ? `"${FONT_FAMILY}"` : "", text?.font ?? ""].filter(Boolean).join(", ");
  if (family) set("--font", `${family}, var(--font-fallback)`);
  set("--text-size", text?.size, "px");
  set("--text-line", text?.lineHeight);
  set("--message-fg", text?.color);
  set("--read-fg", text?.readColor);
  set("--text-align", text?.align);
  set("--text-emphasis", text?.emphasis);
  set("--ruby-size", text?.rubySize);
  set("--paragraph-gap", text?.paragraphGap, "em");
  set("--ruby-gap", text?.rubyGap);
  set("--line-chars", text?.lineChars);
  set("--line-break", text?.lineBreak);
  if (text?.hangingPunctuation) set("--hanging", "allow-end");
  // 文字の出し方（style.css の .ch）。none は一文字ずつ、フェードせずに出す
  if (text?.reveal === "none") {
    set("--lm-reveal-time", "1ms");
    set("--lm-reveal-easing", "linear");
  } else {
    if (text?.reveal === "rise") set("--lm-reveal-animation", "lim-reveal-rise");
    if (typeof text?.revealTime === "number" && text.revealTime >= 0) set("--lm-reveal-time", Math.max(1, text.revealTime), "ms");
  }
  set("--glyph-size", ui?.glyph?.size, "em");
  set("--glyph-gap", ui?.glyph?.gap, "em");
  if (text?.decoration === "shadow") set("--text-shadow", `0 2px 4px ${text.decorationColor ?? "rgba(0, 0, 0, 0.85)"}`);
  if (text?.decoration === "edge") {
    const c = text.decorationColor ?? "#000";
    set("--text-shadow", `1px 1px 0 ${c}, -1px 1px 0 ${c}, 1px -1px 0 ${c}, -1px -1px 0 ${c}, 0 1px 0 ${c}, 0 -1px 0 ${c}, 1px 0 0 ${c}, -1px 0 0 ${c}`);
  }
  if (text?.decoration === "none") set("--text-shadow", "none");
  set("--text-shadow", text?.shadow);
  set("--text-stroke", text?.stroke);
  set("--text-letter-spacing", text?.letterSpacing);
  set("--text-weight", text?.weight);
  set("--text-top-gap", text?.topGap, "px");

  set("--face-width", ui?.face?.width, "px");
  set("--face-height", ui?.face?.height, "px");
  set("--face-x", ui?.face?.x, "px");
  set("--face-y", ui?.face?.y, "px");

  // メッセージ枠
  const m = ui?.message;
  set("--message-bg", m?.image ? "transparent" : m?.background);
  if (m?.borderColor === "none") set("--message-border-width", "0px");
  else set("--message-border", m?.image ? "transparent" : m?.borderColor);
  set("--message-radius", m?.radius, "px");
  set("--message-padding", m?.padding, "px");
  if (m?.image && m.imageSlice !== undefined) {
    set("--message-border-image", sliced(cssUrl(t.asset("image", m.image)), m.imageSlice));
    set("--message-frame-border", "1px");
  }
  else if (m?.image) set("--message-image", cssUrl(t.asset("image", m.image)));
  set("--message-backdrop", m?.backdrop);
  set("--message-backdrop-height", m?.backdropHeight, "px");
  t.message.classList.toggle("has-backdrop", !!m?.backdrop);
  // 位置と大きさは枠の CSS 変数で渡す（style.css の .message が読む。NVL・縦書きの既定の置き方は CSS が上書きする）。
  // 吹き出しが直に書いた位置（インラインの left など）は、ここで外す
  const box = t.message.style;
  for (const p of ["left", "top", "right", "bottom", "width", "height", "min-height"]) box.removeProperty(p);
  for (const v of MESSAGE_BOX_VARS) box.removeProperty(v);
  if (m && (m.x !== undefined || m.y !== undefined || m.width !== undefined || m.height !== undefined)) {
    // 位置を一つでも書いたら、左上と大きさで置く（書いていないものは既定の置き方の値）
    // ui の px は文字と枠の座標（基準の大きさ）。screen が基準と違う作品では舞台の大きさと同じではない
    const space = t.screen ? uiSpace(t.screen) : { width: t.stage.offsetWidth || 1280, height: t.stage.offsetHeight || 720 };
    const stageW = space.width;
    const stageH = space.height;
    // 縦長の既定の置き方（system/portrait.css の --message-* と同じ）
    const tall = t.screen && isPortrait(t.screen);
    const side = tall ? 24 : 60;
    const below = tall ? PORTRAIT_MESSAGE_BOTTOM : 28;
    // 既定の置き方: 横書きは画面の下に横長、縦書きは画面の右に縦長（style.css の .message・.message.vertical と同じ）
    const width = m.width ?? (m.vertical ? VERTICAL_WIDTH : stageW - side * 2);
    const height = m.height ?? (m.vertical ? stageH - below - 28 : tall ? PORTRAIT_MESSAGE_HEIGHT : 150);
    box.setProperty("--message-left", `${m.x ?? (m.vertical ? stageW - side - width : Math.round((stageW - width) / 2))}px`);
    box.setProperty("--message-top", `${m.y ?? (m.vertical ? 28 : stageH - below - height)}px`);
    box.setProperty("--message-right", "auto");
    box.setProperty("--message-bottom", "auto");
    box.setProperty("--message-width", `${width}px`);
    box.setProperty("--message-height", `${height}px`);
    box.setProperty("--message-min-height", "0px");
  }
  // 収まらない本文を枠の中でスクロールさせる（高さを決めたままにする）
  t.message.classList.toggle("scroll", m?.scroll === true);
  if (m?.scroll && !box.getPropertyValue("--message-height")) {
    box.setProperty("--message-height", `${m.height ?? 150}px`);
    box.setProperty("--message-min-height", "0px");
  }

  // 名前の欄
  const n = ui?.name;
  set("--name-fg", n?.color);
  set("--name-size", n?.size, "px");
  set("--name-bg", n?.image ? "transparent" : n?.background);
  if (n?.borderColor === "none") set("--name-border-width", "0px");
  else set("--name-border", n?.image ? "transparent" : n?.borderColor);
  set("--name-font", n?.font);
  set("--name-weight", n?.weight);
  set("--name-letter-spacing", n?.letterSpacing);
  set("--name-shadow", n?.shadow);
  set("--name-padding", n?.padding);
  set("--name-line", n?.lineHeight);
  set("--name-rule", n?.rule);
  t.name.classList.toggle("has-rule", !!n?.rule);
  if (n?.image && n.imageSlice !== undefined) set("--name-border-image", sliced(cssUrl(t.asset("image", n.image)), n.imageSlice));
  else if (n?.image) set("--name-image", cssUrl(t.asset("image", n.image)));
  const name = t.name.style;
  name.removeProperty("left");
  name.removeProperty("top");
  if (n?.x !== undefined) name.left = `${n.x}px`;
  if (n?.y !== undefined) name.top = `${n.y}px`;

  // クリック待ちの印・選択肢・システム画面
  set("--glyph-fg", ui?.glyph?.color);
  const c = ui?.choice;
  set("--choice-width", c?.width, "px");
  set("--choice-size", c?.size, "px");
  set("--choice-gap", c?.gap, "px");
  set("--choice-fg", c?.color);
  set("--choice-read-fg", c?.readColor);
  // 既読の色を決めたら、薄くはしない
  set("--choice-read-opacity", c?.readColor ? "1" : undefined);
  // 地がグラデーションなら background-image で描く（background-color には書けない）
  if (isGradient(c?.background)) {
    set("--choice-bg", "transparent");
    set("--choice-gradient", c?.background);
  } else set("--choice-bg", c?.image ? "transparent" : c?.background);
  if (isGradient(c?.hoverBackground)) {
    set("--choice-hover-bg", "transparent");
    set("--choice-hover-gradient", c?.hoverBackground);
  } else set("--choice-hover-bg", c?.hoverImage || c?.image ? "transparent" : c?.hoverBackground);
  if (c?.borderColor === "none") set("--choice-border-width", "0px");
  else set("--choice-border", c?.image ? "transparent" : c?.borderColor);
  if (c?.image && c.imageSlice !== undefined) {
    set("--choice-border-image", sliced(cssUrl(t.asset("image", c.image)), c.imageSlice));
    set("--choice-hover-border-image", sliced(cssUrl(t.asset("image", c.hoverImage ?? c.image)), c.imageSlice));
  } else {
    if (c?.image) set("--choice-image", cssUrl(t.asset("image", c.image)));
    if (c?.hoverImage ?? c?.image) set("--choice-hover-image", cssUrl(t.asset("image", (c?.hoverImage ?? c?.image)!)));
  }
  set("--choice-font", c?.font);
  set("--choice-weight", c?.weight);
  set("--choice-letter-spacing", c?.letterSpacing);
  set("--choice-line", c?.lineHeight);
  set("--choice-align", c?.align);
  set("--choice-padding", c?.padding);
  set("--choice-margin", c?.margin);
  set("--choice-min-height", c?.minHeight, "px");
  if (c?.fixedWidth) set("--choice-fixed-width", `${c.width ?? 560}px`);
  // 重ねたときの変化を決めたテーマは、変化をなめらかにする
  if (c?.ornament || c?.hoverShadow || c?.hoverBorderColor || c?.hoverColor) set("--choice-transition", "background 0.18s ease, border-color 0.18s ease, box-shadow 0.22s ease, color 0.18s ease");
  set("--choice-radius", c?.radius, "px");
  if (c?.blur !== undefined) set("--choice-blur", typeof c.blur === "number" ? `blur(${c.blur}px)` : c.blur);
  set("--choice-shadow", c?.shadow);
  set("--choice-hover-fg", c?.hoverColor);
  set("--choice-hover-border", c?.hoverBorderColor);
  set("--choice-hover-shadow", c?.hoverShadow);
  set("--choice-ornament-color", c?.ornamentColor ?? c?.borderColor);
  for (const o of ["brackets", "underline"]) t.stage.classList.toggle(`lm-choice-${o}`, c?.ornament === o);
  t.stage.classList.toggle("lm-choice-hide-message", c?.hideMessage === true);
  set("--choice-height", c?.height, "px");
  set("--choice-y", c?.y, "px");
  if (c?.backdrop) set("--choice-backdrop", cssUrl(t.asset("image", c.backdrop)));
  t.stage.classList.toggle("lm-choice-top", c?.y !== undefined);
  t.stage.classList.toggle("lm-choice-backdrop", !!c?.backdrop);
  const sys = ui?.system;
  set("--lm-accent", sys?.accent);
  set("--lm-ui-font", sys?.font);
  t.stage.classList.toggle("lm-theme-light", sys?.theme === "light");
  // テーマの色と形。薄い文字・細い線・触れたときの地は、決めた色から作る（一つ直せば揃って変わるように）
  set("--lm-fg", sys?.fg);
  if (sys?.fg) set("--lm-fg-muted", `color-mix(in srgb, ${sys.fg} 60%, transparent)`);
  set("--lm-screen-bg", sys?.screenBg);
  set("--lm-border", sys?.border);
  if (sys?.border) set("--lm-border-faint", `color-mix(in srgb, ${sys.border} 45%, transparent)`);
  set("--lm-radius", sys?.radius, "px");
  set("--lm-title-bg", sys?.titleBg);
  set("--lm-title-button-bg", sys?.titleButtonBg);
  set("--lm-title-shadow", sys?.titleShadow);
  const images = sys?.images;
  if (images?.button) {
    // ボタンの画像があれば、地の色と線は消して画像だけを見せる（選んでいるものの線は残す）
    set("--lm-control-bg", "transparent");
    set("--lm-control-hover", "transparent");
    set("--lm-button-border", "transparent");
    const button = cssUrl(t.asset("image", images.button));
    const hover = cssUrl(t.asset("image", images.buttonHover ?? images.button));
    if (images.buttonSlice !== undefined) {
      set("--lm-button-border-image", sliced(button, images.buttonSlice));
      set("--lm-button-hover-border-image", sliced(hover, images.buttonSlice));
    } else {
      set("--lm-button-image", button);
      set("--lm-button-hover-image", hover);
    }
  } else if (sys?.controlBg) {
    set("--lm-control-bg", sys.controlBg);
    set("--lm-control-hover", `color-mix(in srgb, ${sys.controlBg}, var(--lm-accent) 22%)`);
    set("--lm-control-active", `color-mix(in srgb, ${sys.controlBg}, var(--lm-accent) 36%)`);
  }
  if (images?.screen) set("--lm-screen-image", cssUrl(t.asset("bgimage", images.screen)));
  if (images?.frame) {
    if (images.frameSlice !== undefined) set("--lm-frame-border-image", sliced(cssUrl(t.asset("image", images.frame)), images.frameSlice));
    else set("--lm-frame-image", cssUrl(t.asset("image", images.frame)));
    set("--lm-frame-bg", "transparent");
    set("--lm-frame-border", "transparent");
  }

  if (images?.sliderThumb) set("--lm-slider-thumb", cssUrl(t.asset("image", images.sliderThumb)));
  t.stage.classList.toggle("lm-slider-image", !!images?.sliderThumb);

  // 本文の上に出す枠と知らせ（@dialog・@text-input の枠、@notify の通知、システムの短い知らせ）は、システム画面の色に合わせる。
  // 書いていなければ前の版と同じ暗い色のまま（style.css・system/default.css の既定）
  set("--lm-dialog-border", sys?.border);
  set("--lm-dialog-button-bg", sys?.controlBg);
  set("--lm-dialog-button-fg", sys?.fg);
  set("--lm-notice-bg", sys?.screenBg);
  set("--lm-notice-fg", sys?.fg);
  set("--lm-notice-theme-accent", sys?.accent);
  set("--lm-toast-bg", sys?.screenBg);

  // 結末の名前の画面（system/default.css の .lm-ending）。書いていない項目はシステム画面の色と本文の書体
  const ending = ui?.ending;
  set("--lm-ending-bg", ending?.background);
  if (ending?.image) set("--lm-ending-image", cssUrl(t.asset("bgimage", ending.image)));
  // 書体を書いていなければ本文の書体（ui.text.font）。--lm-text-font は :root で決まり舞台の --font を読まないので、ここで渡す。
  // 吹き出しの作品は --lm-text-font（チャットの書体）のまま
  set("--lm-ending-font", ending?.font ?? (family && !ui?.chat?.dialogue ? `${family}, var(--font-fallback)` : undefined));
  set("--lm-ending-fg", ending?.color);
  set("--lm-ending-size", ending?.size, "px");
  set("--lm-ending-letter-spacing", ending?.letterSpacing);
  set("--lm-ending-kind-fg", ending?.kindColor);
  set("--lm-ending-rule", ending?.rule === "none" ? undefined : ending?.rule);
  set("--lm-ending-mark-fg", ending?.markColor);
  set("--lm-ending-mark-size", ending?.markSize, "px");
  t.stage.classList.toggle("lm-ending-mark-above", ending?.mark === "above");
  t.stage.classList.toggle("lm-ending-mark-none", ending?.mark === "none");
  t.stage.classList.toggle("lm-ending-no-rule", ending?.rule === "none");

  // NVL（style.css の .message.nvl）。名前を付けた見た目は @nvl on style= のときに枠に重ねる（dom-host.ts の setNvl）
  for (const [k, v] of Object.entries(nvlVars(ui?.nvl, (path) => t.asset("image", path)))) s.setProperty(k, v);

  // 章の扉と章末（std の chapter.css の .lim-chapter）。書いていない項目はシステム画面の色と本文の書体
  const chapter = ui?.chapter;
  set("--lim-chapter-bg", chapter?.background);
  if (chapter?.image) set("--lim-chapter-image", cssUrl(t.asset("bgimage", chapter.image)));
  set("--lim-chapter-font", chapter?.font);
  set("--lim-chapter-fg", chapter?.color);
  set("--lim-chapter-size", chapter?.size, "px");
  set("--lim-chapter-letter-spacing", chapter?.letterSpacing);
  set("--lim-chapter-accent", chapter?.accent);
  set("--lim-chapter-number-size", chapter?.numberSize, "px");
  set("--lim-chapter-subtitle-fg", chapter?.subtitleColor);
  set("--lim-chapter-subtitle-size", chapter?.subtitleSize, "px");
  set("--lim-chapter-rule", chapter?.rule === "none" ? undefined : chapter?.rule);
  set("--lim-chapter-end-fg", chapter?.endColor);
  set("--lim-chapter-end-size", chapter?.endSize, "px");
  t.stage.classList.toggle("lm-chapter-no-rule", chapter?.rule === "none");

  // チャットの画面（packages/std の chat.css が読む）。書かなければ @chat の見た目は既定のまま
  const chat = ui?.chat;
  set("--chat-size", chat?.size, "px");
  set("--chat-font", chat?.font);
  set("--chat-fg", chat?.color);
  set("--chat-bg", chat?.background);
  if (chat?.image) set("--chat-image", cssUrl(t.asset("image", chat.image)));
  set("--chat-head-bg", chat?.headBackground);
  set("--chat-head-fg", chat?.headColor);
  set("--chat-other-bg", chat?.otherBackground);
  set("--chat-other-fg", chat?.otherColor);
  set("--chat-me-bg", chat?.meBackground);
  set("--chat-me-fg", chat?.meColor);
  set("--chat-radius", chat?.radius, "px");
  set("--chat-tail-radius", chat?.tailRadius, "px");
  set("--chat-name", chat?.nameColor);
  set("--chat-note", chat?.noteColor);
  set("--chat-face-size", chat?.faceSize, "px");
  set("--chat-reply-bg", chat?.choiceBackground);
  // 吹き出しの作品は、システム画面の見出しと履歴の本文も同じ書体で揃える（default.css の --lm-text-font は :root で決まり、舞台の --font を読まない）
  if (chat?.dialogue) set("--lm-text-font", chat.font ?? "var(--font)");

  // 操作の帯とタイトルのボタンの並べ方
  set("--lm-bar-fg", ui?.menuBar?.color);
  set("--lm-bar-shadow", ui?.menuBar?.shadow);
  const tm = ui?.title?.menu;
  if (tm?.align) set("--lm-title-align", tm.align === "left" ? "flex-start" : tm.align === "right" ? "flex-end" : "center");
  set("--lm-title-direction", tm?.direction);
  set("--lm-title-gap", tm?.gap, "px");
  set("--lm-title-button-width", tm?.width, "px");

  // カーソル（動く画像は ui-pointer.ts が舞台の上に描く）
  const cursor = ui?.cursor;
  const image = cursor?.image && !cursor.animated ? cursor.image : undefined;
  t.stage.style.cursor = image ? `${cssUrl(t.asset("image", image))} ${cursor!.x ?? 0} ${cursor!.y ?? 0}, auto` : "";
  if (image) set("--choice-cursor", `${cssUrl(t.asset("image", image))} ${cursor!.x ?? 0} ${cursor!.y ?? 0}, pointer`);
}

/** クリック待ちの印（ui.glyph）。設定が無ければ null（既定の ▼）。 */
export function uiGlyph(ui: UiConfig | undefined, asset: (kind: "image", path: string) => string): HTMLElement | null {
  const g = ui?.glyph;
  if (!g || (!g.image && !g.text && !g.motion && !g.shape)) return null;
  const el = document.createElement("span");
  el.className = `glyph${g.motion && g.motion !== "bounce" ? ` glyph-${g.motion}` : ""}${g.shape ? ` glyph-shape glyph-shape-${g.shape}` : ""}`;
  if (g.shape) return el;
  if (g.image) {
    const img = document.createElement("img");
    img.src = asset("image", g.image);
    img.alt = "";
    el.append(img);
  } else el.textContent = g.text ?? "▼";
  return el;
}

/**
 * 人物ごとの台詞の文字の見た目（cast.json の text）を、本文の入れ物に CSS 変数で載せる（メッセージ枠、NVL の段落、吹き出し、履歴の本文）。
 * 当てる CSS は style.css の [data-speaker-look]（遊ぶ人が選んだ書体が先）。text が無ければ外す。
 */
export function applySpeakerText(target: HTMLElement, text: CastEntry["text"]): void {
  const vars: [string, string | undefined][] = [
    ["--lm-speaker-fg", text?.color],
    ["--lm-speaker-font", text?.font],
    ["--lm-speaker-style", text?.italic === true ? "italic" : text?.italic === false ? "normal" : undefined],
  ];
  for (const [name, value] of vars) {
    if (value) target.style.setProperty(name, value);
    else target.style.removeProperty(name);
  }
  target.toggleAttribute("data-speaker-look", vars.some(([, v]) => v !== undefined));
}
