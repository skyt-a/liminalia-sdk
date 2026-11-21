import type { UiThemePreset } from "./index.ts";

/** 端末風。黒い地に緑の文字と等幅の書体。角は丸めない。 */
export const terminalTheme: UiThemePreset = {
  id: "terminal",
  name: "端末風",
  nameEn: "Terminal",
  ui: {
    text: { font: '"JetBrains Mono", "Menlo", "Consolas", "Osaka-Mono", monospace', color: "#b6f5b0", shadow: "0 0 5px rgba(93, 255, 138, 0.45)", readColor: "#7fbf7a", letterSpacing: "0.02em" },
    message: { background: "rgba(2, 10, 4, 0.9)", borderColor: "rgba(90, 255, 130, 0.5)", radius: 0 },
    name: { background: "#5dff8a", color: "#021004", borderColor: "none", size: 19, padding: "2px 14px", shadow: "none" },
    glyph: { shape: "bar", motion: "blink", color: "#5dff8a", size: 0.7, gap: 0.5 },
    choice: { background: "rgba(2, 10, 4, 0.92)", hoverBackground: "#5dff8a", color: "#b6f5b0", hoverColor: "#021004", borderColor: "rgba(90, 255, 130, 0.5)", hoverBorderColor: "#5dff8a", radius: 0, align: "left", font: '"JetBrains Mono", "Menlo", "Consolas", "Osaka-Mono", monospace', shadow: "none" },
    menuBar: { color: "rgba(182, 245, 176, 0.72)", shadow: "none" },
    system: {
      theme: "dark",
      font: '"JetBrains Mono", "Menlo", "Consolas", "Osaka-Mono", monospace',
      fg: "#b6f5b0",
      accent: "#5dff8a",
      screenBg: "rgba(2, 10, 4, 0.96)",
      controlBg: "rgba(80, 255, 120, 0.05)",
      border: "rgba(90, 255, 130, 0.38)",
      radius: 0,
      titleBg: "radial-gradient(ellipse at center, #06200c 0%, #010602 100%)",
      titleButtonBg: "rgba(2, 10, 4, 0.92)",
      titleShadow: "0 0 8px rgba(0, 0, 0, 0.95)",
    },
  },
};
