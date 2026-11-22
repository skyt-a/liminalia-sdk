/**
 * 制作画面の言語（制作画面とプラグインの部品が使う）。
 */

export type StudioLanguage = "ja" | "en";
const LANGUAGE_KEY = "liminalia.studio.language";

/**
 * 制作画面の言語。デスクトップ版はアプリが ?lang= で渡す。ブラウザでは選んだもの（言語の切り替え）、それも無ければ
 * OS・ブラウザの言語が日本語なら日本語、ほかは英語。画面の外（テストなど Node で読んだとき）は日本語。
 */
export function studioLanguage(): StudioLanguage {
  if (typeof window === "undefined") return "ja";
  const given = new URLSearchParams(location.search).get("lang");
  if (given === "ja" || given === "en") return given;
  try {
    const v = localStorage.getItem(LANGUAGE_KEY);
    if (v === "ja" || v === "en") return v;
  } catch {
    // 使えなければ OS・ブラウザの言語
  }
  const nav = typeof navigator === "undefined" ? "ja" : navigator.language;
  return nav.toLowerCase().startsWith("ja") ? "ja" : "en";
}

/** 言語を選ぶ（開き直すと効く。各画面は読み込んだときに文言を取り込むため）。 */
export function setStudioLanguage(language: StudioLanguage): void {
  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    // 覚えられなければ今回だけ
  }
}
