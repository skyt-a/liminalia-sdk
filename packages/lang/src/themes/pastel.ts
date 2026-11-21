import type { UiThemePreset } from "./index.ts";

/** パステル。淡い桃色の地に、丸いボタンと丸ゴシック。 */
export const pastelTheme: UiThemePreset = {
  id: "pastel",
  name: "パステル",
  nameEn: "Pastel",
  ui: {
    text: { font: '"Hiragino Maru Gothic ProN", "Yu Gothic UI", "Meiryo", sans-serif', color: "#54475e", decoration: "none", readColor: "#8a7c94" },
    message: { background: "rgba(255, 250, 252, 0.93)", borderColor: "rgba(232, 164, 190, 0.8)", radius: 22 },
    name: { background: "#f4b6cb", color: "#ffffff", borderColor: "none", padding: "5px 24px", shadow: "0 1px 2px rgba(150, 80, 110, 0.5)" },
    glyph: { text: "♥", motion: "bounce", color: "#e88aab", size: 0.7 },
    choice: { background: "rgba(255, 250, 252, 0.96)", hoverBackground: "#fde3ec", color: "#54475e", hoverColor: "#c8527d", borderColor: "rgba(232, 164, 190, 0.8)", hoverBorderColor: "#e88aab", radius: 26, hoverShadow: "0 4px 14px rgba(232, 138, 171, 0.32)" },
    menuBar: { color: "rgba(255, 255, 255, 0.92)", shadow: "0 1px 3px rgba(70, 40, 60, 0.95)" },
    system: {
      theme: "light",
      font: '"Hiragino Maru Gothic ProN", "Zen Maru Gothic", "M PLUS Rounded 1c", sans-serif',
      fg: "#4a3f55",
      accent: "#d0659d",
      screenBg: "rgba(255, 244, 250, 0.96)",
      controlBg: "rgba(255, 182, 214, 0.2)",
      border: "rgba(214, 140, 190, 0.45)",
      radius: 16,
      titleBg: "linear-gradient(160deg, #ffe4f1 0%, #e8e9ff 55%, #e2fbf2 100%)",
      titleButtonBg: "rgba(255, 250, 252, 0.92)",
      titleShadow: "0 1px 8px rgba(255, 255, 255, 0.95)",
    },
  },
};
