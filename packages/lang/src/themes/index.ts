import { isPortrait, type ScreenSize } from "../screen.ts";
import type { UiConfig, UiSystem, UiSystemImages, UiText, UiTitle } from "../ui.ts";
import { chatTheme } from "./chat.ts";
import { defaultTheme } from "./default.ts";
import { futureTheme } from "./future.ts";
import { mansionTheme } from "./mansion.ts";
import { nightTheme } from "./night.ts";
import { pastelTheme } from "./pastel.ts";
import { schoolTheme } from "./school.ts";
import { terminalTheme } from "./terminal.ts";
import { washiTheme } from "./washi.ts";

/**
 * ゲーム全体の見た目のテーマ（本文・メッセージ枠・名前・クリック待ち・選択肢・システム画面・結末の画面・章の扉・操作の帯）。中身は liminalia.json の
 * ui の一部で、制作画面の「ゲームの設定」で選ぶと、その値を ui に書き込む（ゲームはテーマの名前を読まず、書き込んだ値だけで描く）。
 * 書き込んだあとは、ほかの設定と同じように色や画像を一つずつ直せる。
 */
export interface UiThemePreset {
  /** ui.system.preset に書く名前。 */
  id: string;
  name: string;
  nameEn: string;
  /** 書き込む値（preset は選ぶときに足す）。 */
  ui: UiThemeValues;
  /** 作品の assets/image/themes/<id>/ へ写す素材（ファイル名 → 中身）。 */
  assets?: Readonly<Record<string, string>>;
  /** 作品の中のテーマ（themes/<id>/theme.json）か。 */
  local?: boolean;
  /** その向きの作品だけで使うテーマ（"portrait" は縦長の作品だけ。書かなければどの作品でも選べる）。 */
  orientation?: "portrait";
}

/** このテーマをこの大きさの作品に当てられるか（縦長専用のテーマは横長の作品には当てない）。 */
export function themeFitsScreen(theme: Pick<UiThemePreset, "orientation">, screen: ScreenSize): boolean {
  return theme.orientation !== "portrait" || isPortrait(screen);
}

/** 作品の向きで使えるテーマを、制作画面に並べる順にする（縦長の作品では、縦長専用を先頭にまとめる。横長の作品には出さない）。 */
export function themesForScreen<T extends Pick<UiThemePreset, "orientation">>(themes: readonly T[], screen: ScreenSize): { portrait: T[]; other: T[] } {
  const usable = themes.filter((t) => themeFitsScreen(t, screen));
  return { portrait: usable.filter((t) => t.orientation === "portrait"), other: usable.filter((t) => t.orientation !== "portrait") };
}

/** テーマが決める ui の項目。 */
export type UiThemeValues = Pick<UiConfig, "fonts" | "text" | "message" | "name" | "glyph" | "choice" | "chat" | "ending" | "chapter" | "menuBar"> & {
  system?: Omit<UiSystem, "preset">;
  title?: Pick<UiTitle, "menu">;
};

export const UI_THEMES: readonly UiThemePreset[] = [defaultTheme, washiTheme, nightTheme, pastelTheme, terminalTheme, mansionTheme, futureTheme, schoolTheme, chatTheme];

/** テーマを替えても残す本文の項目（組み方と、台詞の括弧の出し方。見た目ではなく読みやすさの設定）。 */
const KEEP_TEXT = ["rubySize", "paragraphGap", "rubyGap", "lineChars", "lineBreak", "hangingPunctuation", "emphasis", "quotes"] as const;
/** テーマを替えても残すメッセージ枠の項目（動き）。 */
const KEEP_MESSAGE = ["scroll", "vertical"] as const;
/** テーマを替えても残す操作の帯の項目（何をどこに置くか）。 */
const KEEP_MENU_BAR = ["items", "position", "x", "y", "touchButton"] as const;
/** テーマを替えても残すチャットの項目（作品の話者と題。見た目ではない）。 */
const KEEP_CHAT = ["me", "title"] as const;

function picked<T extends object>(from: T | undefined, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (from?.[k] !== undefined) out[k] = from[k];
  return out;
}

function omitted<T extends object>(from: T | undefined, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = { ...from };
  for (const k of keys) delete out[k];
  return out;
}

/** 値を持つものだけを組に入れる（空の群を ui に残さない）。 */
function group<K extends string, V extends object>(key: K, value: V): { [P in K]?: V } {
  return (Object.keys(value).length > 0 ? { [key]: value } : {}) as { [P in K]?: V };
}

/**
 * 作品が自分で決めた画像だけを残す（前のテーマのものは持ち越さない）。assets/image/themes/ の下はテーマが写した素材なので、
 * いま選んでいるテーマの名前によらず作品のものとして扱わない。切り分けの値は、その画像を残すときだけ残す。
 */
function ownImages(images: UiSystemImages | undefined, previous: UiSystemImages | undefined): UiSystemImages | undefined {
  if (!images) return undefined;
  const own: UiSystemImages = {};
  for (const k of ["screen", "button", "buttonHover", "frame", "sliderThumb"] as const) {
    const file = images[k];
    if (file !== undefined && !file.startsWith("themes/") && file !== previous?.[k]) own[k] = file;
  }
  if ((own.button || own.buttonHover) && images.buttonSlice !== undefined) own.buttonSlice = images.buttonSlice;
  if (own.frame && images.frameSlice !== undefined) own.frameSlice = images.frameSlice;
  return Object.keys(own).length > 0 ? own : undefined;
}

/**
 * ui を、テーマが決める見た目の項目（look）と、テーマを替えても残す項目（keep）に分ける。テーマが扱う範囲の定義はここだけで、
 * 当てるとき（applyUiTheme）も、今の見た目をテーマにするとき（uiThemeValues）もこれを使う。
 */
function splitUi(ui: UiConfig) {
  const { fonts, text, message, name, glyph, choice, chat, ending, chapter, menuBar, title, system, ...rest } = ui;
  const { menu, ...titleRest } = title ?? {};
  const { preset: _preset, ...systemLook } = system ?? {};
  const look: UiThemeValues = {
    ...(fonts ? { fonts } : {}),
    ...group("text", omitted(text, KEEP_TEXT)),
    ...group("message", omitted(message, KEEP_MESSAGE)),
    ...group("name", name ?? {}),
    ...group("glyph", glyph ?? {}),
    ...group("choice", choice ?? {}),
    ...group("chat", omitted(chat, KEEP_CHAT)),
    ...group("ending", ending ?? {}),
    ...group("chapter", chapter ?? {}),
    ...group("system", systemLook),
    ...(menu !== undefined ? { title: { menu } } : {}),
    ...group("menuBar", omitted(menuBar, KEEP_MENU_BAR)),
  };
  const keep = { rest, text: picked(text, KEEP_TEXT), message: picked(message, KEEP_MESSAGE), menuBar: picked(menuBar, KEEP_MENU_BAR), chat: picked(chat, KEEP_CHAT), title: titleRest };
  return { look, keep };
}

/** 今の ui のうち、テーマに書く見た目の項目（操作の項目・作品固有の値・テーマの名前は入れない）。 */
export function uiThemeValues(ui: UiConfig): UiThemeValues {
  return structuredClone(splitUi(ui).look);
}

/**
 * テーマを選んだあとの ui。テーマが決める見た目の項目を置き換え、ui.system.preset に名前を書く。
 * 操作の設定（keys・defaults など）、タイトルの絵と音、本文の組み方は残す。書体と画像は、テーマが決めていなければ作品の値を残す
 * （テーマを替えるたびに、選んだ書体や作った画像が外れないように）。前のテーマが決めた書体と画像は作品の値ではないので残さない。
 * 前のテーマは themes から探す（作品の中のテーマを扱うときは、それも含む一覧を渡す）。
 */
export function applyUiTheme(ui: UiConfig, theme: UiThemePreset, themes: readonly UiThemePreset[] = UI_THEMES): UiConfig {
  const v = structuredClone(theme.ui);
  const before = ui.system ?? {};
  const previous = themes.find((t) => t.id === before.preset)?.ui;
  const system: UiSystem = { preset: theme.id, ...v.system };
  if (system.font === undefined && before.font !== undefined && before.font !== previous?.system?.font) system.font = before.font;
  if (system.images === undefined) {
    const images = ownImages(before.images, previous?.system?.images);
    if (images) system.images = structuredClone(images);
  }

  const { keep } = splitUi(ui);
  const text: UiText = { ...keep.text, ...v.text };
  if (v.text?.font === undefined) {
    if (ui.text?.font !== undefined && ui.text.font !== previous?.text?.font) text.font = ui.text.font;
    if (ui.text?.fontFile !== undefined && ui.text.fontFile !== previous?.text?.fontFile) text.fontFile = ui.text.fontFile;
  }

  const title = { ...keep.title, ...v.title };
  return {
    ...keep.rest,
    ...(v.fonts ? { fonts: v.fonts } : ui.fonts ? { fonts: ui.fonts } : {}),
    ...group("text", text),
    ...group("message", { ...keep.message, ...v.message }),
    ...group("name", v.name ?? {}),
    ...group("glyph", v.glyph ?? {}),
    ...group("choice", v.choice ?? {}),
    ...group("chat", { ...keep.chat, ...v.chat }),
    ...group("ending", v.ending ?? {}),
    ...group("chapter", v.chapter ?? {}),
    system,
    ...group("title", title),
    ...group("menuBar", { ...keep.menuBar, ...v.menuBar }),
  };
}

/** 見本の札に描く色（決めていない項目は system/default.css の既定の色）。 */
export interface UiThemeLook {
  titleBg: string;
  screenBg: string;
  fg: string;
  accent: string;
  controlBg: string;
  border: string;
  radius: number;
  font: string;
  /** メッセージ枠と選択肢の見本の色。 */
  messageBg: string;
  messageFg: string;
  messageBorder: string;
  messageRadius: number;
  choiceBg: string;
  choiceBorder: string;
  name: string;
  nameFg: string;
  /** チャットの吹き出しで本文を出すテーマの見本の色（ui.chat.dialogue のとき）。 */
  chat?: { bg: string; head: string; other: string; otherFg: string; me: string; meFg: string; radius: number };
}

/** system/default.css の :root（暗い配色）と .lm-theme-light（明るい配色）の値。 */
const DARK = {
  titleBg: "radial-gradient(ellipse at center, #1d1f27 0%, #08090c 100%)",
  screenBg: "rgba(12, 14, 18, 0.95)",
  fg: "#ecebe6",
  accent: "#a9bfd2",
  controlBg: "rgba(255, 255, 255, 0.05)",
  border: "rgba(255, 255, 255, 0.16)",
  radius: 4,
  font: "sans-serif",
};
const LIGHT = {
  ...DARK,
  titleBg: "radial-gradient(ellipse at center, #fbfaf7 0%, #e5e2da 100%)",
  screenBg: "rgba(246, 245, 241, 0.96)",
  fg: "#23242a",
  accent: "#3f6a8f",
  controlBg: "rgba(0, 0, 0, 0.04)",
  border: "rgba(0, 0, 0, 0.16)",
};

/** ui.system とテーマの値が描く色（制作画面の札と、テーマを選んでいるかの見分けに使う）。 */
export function uiThemeLook(system: UiSystem | undefined, values?: UiThemeValues): UiThemeLook {
  const base = system?.theme === "light" ? LIGHT : DARK;
  const screenBg = system?.screenBg ?? base.screenBg;
  const border = system?.border ?? base.border;
  const fg = system?.fg ?? base.fg;
  const visible = (c: string | undefined) => (c === undefined || c === "none" ? undefined : c);
  return {
    titleBg: system?.titleBg ?? base.titleBg,
    screenBg,
    fg,
    accent: system?.accent ?? base.accent,
    controlBg: system?.controlBg ?? base.controlBg,
    border,
    radius: system?.radius ?? base.radius,
    font: system?.font ?? base.font,
    messageBg: values?.message?.background ?? screenBg,
    messageFg: values?.text?.color ?? fg,
    messageBorder: visible(values?.message?.borderColor) ?? border,
    messageRadius: values?.message?.radius ?? system?.radius ?? base.radius,
    choiceBg: values?.choice?.background ?? system?.controlBg ?? base.controlBg,
    choiceBorder: visible(values?.choice?.borderColor) ?? border,
    name: values?.name?.background ?? system?.accent ?? base.accent,
    nameFg: values?.name?.color ?? fg,
    ...(values?.chat?.dialogue
      ? {
          chat: {
            bg: values.chat.background ?? "#e9edf2",
            head: values.chat.headBackground ?? "#f7f8fa",
            other: values.chat.otherBackground ?? "#fff",
            otherFg: values.chat.otherColor ?? values.chat.color ?? "#1c1c1e",
            me: values.chat.meBackground ?? "#2f7cf6",
            meFg: values.chat.meColor ?? "#fff",
            radius: values.chat.radius ?? 16,
          },
        }
      : {}),
  };
}
