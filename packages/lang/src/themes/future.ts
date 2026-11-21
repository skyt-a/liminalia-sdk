import type { UiThemePreset } from "./index.ts";

const CYAN = "#58d6ff";

/** 角を切った枠。切り分けの大きさより角を小さくして、伸ばしても形が変わらないようにする。 */
const frame = (size: number, cut: number, fill: string, stroke: string) => {
  const a = 1.5;
  const b = size - 1.5;
  const c = cut;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<path d="M${a + c} ${a} H${b} V${b - c} L${b - c} ${b} H${a} V${a + c} Z" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
<path d="M${b - 14} ${a + 3} H${b - 3} V${a + 14}" fill="none" stroke="${stroke}" stroke-width="2"/>
<path d="M${a + 3} ${b - 14} V${b - 3} H${a + 14}" fill="none" stroke="${stroke}" stroke-width="2"/>
</svg>
`;
};

/** 近未来。濃紺に青く光る線、角を切った枠。 */
export const futureTheme: UiThemePreset = {
  id: "future",
  name: "近未来",
  nameEn: "Near Future",
  assets: {
    "frame.svg": frame(64, 16, "rgba(5, 18, 34, 0.86)", CYAN),
    "plate.svg": frame(36, 9, "rgba(8, 44, 72, 0.94)", CYAN),
    "button.svg": frame(44, 11, "rgba(6, 24, 44, 0.9)", "rgba(88, 214, 255, 0.75)"),
    "button-hover.svg": frame(44, 11, "rgba(18, 80, 120, 0.94)", "#b8efff"),
    "panel.svg": frame(64, 16, "rgba(4, 14, 28, 0.97)", CYAN),
  },
  ui: {
    text: {
      font: '"Hiragino Sans", "Yu Gothic UI", "Noto Sans JP", sans-serif',
      color: "#e4f6ff",
      shadow: "0 0 6px rgba(88, 214, 255, 0.35), 0 1px 3px rgba(0, 0, 0, 0.9)",
      readColor: "#a8c9da",
      letterSpacing: "0.05em",
    },
    message: { image: "themes/future/frame.svg", imageSlice: 20, padding: "30px 48px" },
    name: { image: "themes/future/plate.svg", imageSlice: 12, color: "#b8efff", size: 19, letterSpacing: "0.14em", padding: "5px 24px" },
    glyph: { shape: "triangle", motion: "blink", color: CYAN, size: 0.6 },
    choice: {
      image: "themes/future/button.svg",
      hoverImage: "themes/future/button-hover.svg",
      imageSlice: 14,
      color: "#e4f6ff",
      hoverColor: "#ffffff",
      size: 21,
      letterSpacing: "0.06em",
      padding: "16px 40px",
    },
    system: {
      theme: "dark",
      font: '"Hiragino Sans", "Yu Gothic UI", "Noto Sans JP", sans-serif',
      fg: "#e4f6ff",
      accent: CYAN,
      screenBg: "rgba(3, 12, 24, 0.97)",
      controlBg: "rgba(88, 214, 255, 0.08)",
      border: "rgba(88, 214, 255, 0.5)",
      radius: 0,
      titleBg: "linear-gradient(160deg, #0c2a48 0%, #04101f 60%, #010510 100%)",
      titleButtonBg: "rgba(5, 18, 34, 0.9)",
      titleShadow: "0 0 10px rgba(0, 0, 0, 0.95)",
      images: {
        button: "themes/future/button.svg",
        buttonHover: "themes/future/button-hover.svg",
        buttonSlice: 14,
        frame: "themes/future/panel.svg",
        frameSlice: 20,
      },
    },
    menuBar: { color: "rgba(184, 239, 255, 0.78)", shadow: "0 0 4px rgba(0, 0, 0, 0.9)" },
    title: { menu: { align: "left", gap: 12, width: 320 } },
  },
};
