import type { UiThemePreset } from "./index.ts";

/** 夜。紺の地に青白い文字。角を少し丸める。 */
export const nightTheme: UiThemePreset = {
  id: "night",
  name: "夜",
  nameEn: "Night",
  ui: {
    text: { font: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif', color: "#e6e8f2", decoration: "shadow", decorationColor: "rgba(0, 0, 10, 0.8)", readColor: "#aeb4cc", letterSpacing: "0.06em" },
    message: { background: "rgba(10, 14, 34, 0.82)", borderColor: "rgba(216, 202, 150, 0.35)", radius: 6 },
    name: { background: "rgba(16, 22, 52, 0.96)", color: "#e8d9a4", borderColor: "rgba(216, 202, 150, 0.45)", letterSpacing: "0.1em" },
    glyph: { shape: "dot", motion: "breathe", color: "#e8d9a4", size: 0.32, gap: 1.2 },
    choice: { background: "rgba(12, 17, 42, 0.86)", hoverBackground: "rgba(36, 44, 92, 0.92)", color: "#e6e8f2", hoverColor: "#fff3c8", borderColor: "rgba(216, 202, 150, 0.35)", hoverBorderColor: "#e8d9a4", radius: 6, blur: 6, hoverShadow: "0 0 18px rgba(232, 217, 164, 0.18)", ornament: "brackets" },
    menuBar: { color: "rgba(232, 217, 164, 0.7)" },
    system: {
      theme: "dark",
      fg: "#dfe6f5",
      accent: "#8fb0ff",
      screenBg: "rgba(8, 12, 30, 0.94)",
      controlBg: "rgba(120, 150, 255, 0.07)",
      border: "rgba(140, 170, 255, 0.24)",
      radius: 8,
      titleBg: "radial-gradient(ellipse at 50% 30%, #1d2853 0%, #05070f 100%)",
      titleButtonBg: "rgba(10, 14, 34, 0.86)",
      titleShadow: "0 2px 10px rgba(0, 0, 10, 0.9)",
    },
  },
};
