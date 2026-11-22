/**
 * 開発サーバーだけで出す作り手向けの道具（変数の監視、重さの計測、立ち絵の位置調整への入口、右上の位置表示）の言語。
 * ゲームの言語ではなく、制作画面と同じ決め方にする: ?lang=、制作画面で選んだ言語（同じオリジンの localStorage）、
 * それも無ければブラウザの言語（日本語なら日本語、ほかは英語）。立ち絵の位置調整画面（caster/main.ts）と同じ。
 */
export const devEnglish: boolean = (() => {
  if (typeof location === "undefined") return false;
  const given = new URLSearchParams(location.search).get("lang");
  if (given === "ja" || given === "en") return given === "en";
  try {
    const v = localStorage.getItem("liminalia.studio.language");
    if (v === "ja" || v === "en") return v === "en";
  } catch {
    // 使えなければブラウザの言語
  }
  return typeof navigator !== "undefined" && !navigator.language.toLowerCase().startsWith("ja");
})();

/** 今の言語の方の文言。 */
export const devText = (ja: string, en: string): string => (devEnglish ? en : ja);
