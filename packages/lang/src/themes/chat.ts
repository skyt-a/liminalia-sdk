import type { UiThemePreset } from "./index.ts";

const INK = "#2c2825";
/** 柿の色。自分の吹き出しと、選んでいるもの。 */
const PERSIMMON = "#c2492f";
const PAPER = "#f4eee5";
const CREAM = "#fffaf3";
const FONT = '"Hiragino Sans", "Yu Gothic UI", "Noto Sans JP", sans-serif';

/** 地に敷く、ごく薄い吹き出しの柄（繰り返す）。 */
const pattern = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160" fill="none" stroke="${INK}" stroke-opacity="0.035" stroke-width="2.5" stroke-linejoin="round">
<path d="M22 28 h34 a10 10 0 0 1 10 10 v12 a10 10 0 0 1 -10 10 h-24 l-10 10 v-10 a10 10 0 0 1 -10 -10 v-12 a10 10 0 0 1 10 -10 Z"/>
<path d="M104 96 h28 a10 10 0 0 1 10 10 v8 a10 10 0 0 1 -10 10 v9 l-9 -9 h-19 a10 10 0 0 1 -10 -10 v-8 a10 10 0 0 1 10 -10 Z"/>
</svg>
`;

/**
 * チャット。台詞を吹き出しに、地の文を中央の小さな一行にして、舞台いっぱいのチャットの画面に積む縦長専用のテーマ。
 * 紙の色の地に柿の色。システム画面も同じ地と、丸いボタンで揃える。
 */
export const chatTheme: UiThemePreset = {
  id: "chat",
  name: "チャット",
  nameEn: "Chat",
  orientation: "portrait",
  assets: { "pattern.svg": pattern },
  ui: {
    // @nvl on・@vertical on・@balloon on の間に出すメッセージ枠も、同じ紙の色で揃える
    text: { font: FONT, color: INK, decoration: "none", readColor: "#6d645b", letterSpacing: "0.02em" },
    message: { background: "rgba(255, 250, 243, 0.97)", borderColor: "rgba(44, 40, 37, 0.14)", radius: 24, padding: "30px 34px" },
    name: { background: PERSIMMON, color: "#ffffff", borderColor: "none", size: 20, padding: "3px 18px" },
    glyph: { shape: "dot", motion: "breathe", color: PERSIMMON, size: 0.4, gap: 0.8 },
    choice: {
      font: FONT,
      size: 25,
      width: 600,
      gap: 12,
      color: PERSIMMON,
      background: CREAM,
      borderColor: "rgba(194, 73, 47, 0.55)",
      hoverColor: "#ffffff",
      hoverBackground: PERSIMMON,
      hoverBorderColor: PERSIMMON,
      readColor: "#8a6a5e",
      radius: 30,
      padding: "14px 28px",
      lineHeight: 1.45,
    },
    chat: {
      dialogue: true,
      font: FONT,
      size: 26,
      color: INK,
      background: PAPER,
      image: "themes/chat/pattern.svg",
      headBackground: CREAM,
      headColor: INK,
      otherBackground: "#ffffff",
      otherColor: INK,
      meBackground: PERSIMMON,
      meColor: "#ffffff",
      radius: 24,
      tailRadius: 6,
      nameColor: "#6d645b",
      noteColor: "#6d645b",
      showName: "first",
      showFace: true,
      faceSize: 60,
      choiceBackground: "rgba(255, 250, 243, 0.96)",
      typing: 420,
    },
    system: {
      theme: "light",
      font: FONT,
      fg: INK,
      accent: PERSIMMON,
      screenBg: "rgba(246, 240, 231, 0.985)",
      controlBg: "rgba(255, 255, 255, 0.82)",
      border: "rgba(44, 40, 37, 0.2)",
      radius: 22,
      titleBg: "linear-gradient(170deg, #fbf4ea 0%, #f6e4d3 58%, #efc9b4 100%)",
      titleButtonBg: "rgba(255, 250, 243, 0.94)",
      titleShadow: "0 1px 6px rgba(255, 250, 243, 0.9)",
    },
    menuBar: { color: "rgba(44, 40, 37, 0.66)", shadow: "0 0 3px rgba(255, 250, 243, 0.95)" },
    title: { menu: { gap: 16, width: 440 } },
  },
};
