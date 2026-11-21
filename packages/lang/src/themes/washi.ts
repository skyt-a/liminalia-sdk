import type { UiThemePreset } from "./index.ts";

/** 和紙。生成りの紙に墨の文字、選んでいるものは朱。明朝で、角はほとんど丸めない。 */
export const washiTheme: UiThemePreset = {
  id: "washi",
  name: "和紙",
  nameEn: "Washi",
  ui: {
    text: { font: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif', color: "#2b2620", decoration: "none", readColor: "#6d6355" },
    message: { background: "rgba(243, 236, 221, 0.94)", borderColor: "rgba(92, 70, 40, 0.45)", radius: 2 },
    name: { background: "#a8402c", color: "#f8f2e4", borderColor: "none", letterSpacing: "0.1em", font: '"Hiragino Mincho ProN", "Yu Mincho", serif' },
    glyph: { shape: "diamond", motion: "breathe", color: "#a8402c", size: 0.36, gap: 1.2 },
    choice: { background: "rgba(246, 240, 226, 0.96)", hoverBackground: "#efe2c8", color: "#2b2620", hoverColor: "#a8402c", borderColor: "rgba(92, 70, 40, 0.45)", hoverBorderColor: "#a8402c", radius: 2, font: '"Hiragino Mincho ProN", "Yu Mincho", serif', ornament: "underline", ornamentColor: "rgba(168, 64, 44, 0.5)" },
    menuBar: { color: "rgba(248, 242, 228, 0.9)", shadow: "0 1px 3px rgba(30, 20, 10, 0.95)" },
    system: {
      theme: "light",
      font: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif',
      fg: "#2b2620",
      accent: "#a8402c",
      screenBg: "rgba(243, 236, 221, 0.97)",
      controlBg: "rgba(120, 92, 52, 0.06)",
      border: "rgba(92, 70, 40, 0.3)",
      radius: 2,
      titleBg: "radial-gradient(ellipse at center, #f8f2e4 0%, #e0d3b8 100%)",
      titleButtonBg: "rgba(246, 240, 226, 0.94)",
      titleShadow: "0 1px 8px rgba(248, 242, 228, 0.95)",
    },
  },
};
