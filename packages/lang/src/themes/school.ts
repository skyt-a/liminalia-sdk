import type { UiThemePreset } from "./index.ts";

const INK = "#2d3a55";
const CORAL = "#ef6f6c";

/** ノートの紙。角の丸い紙に、内側の細い線（破線は切り分けて伸ばすと崩れる）。 */
const paper = (size: number, fill: string, dash: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect x="1" y="1" width="${size - 2}" height="${size - 2}" rx="14" fill="${fill}" stroke="#b9c6dc" stroke-width="2"/>
<rect x="6" y="6" width="${size - 12}" height="${size - 12}" rx="10" fill="none" stroke="${dash}" stroke-width="1.5"/>
</svg>
`;

/** 付箋。名前の欄に使う。 */
const sticky = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><rect x="1" y="1" width="34" height="34" rx="4" fill="#ffd166" stroke="#e0ad3a" stroke-width="2"/></svg>
`;

/** 学園。明るいノートの紙と付箋、丸い書体。日常の物語に向く。 */
export const schoolTheme: UiThemePreset = {
  id: "school",
  name: "学園",
  nameEn: "School",
  assets: {
    "paper.svg": paper(64, "rgba(255, 255, 255, 0.95)", "#9fb4d6"),
    "sticky.svg": sticky,
    "button.svg": paper(48, "#ffffff", "#9fb4d6"),
    "button-hover.svg": paper(48, "#ffe9e4", CORAL),
  },
  ui: {
    text: {
      font: '"Hiragino Maru Gothic ProN", "Yu Gothic UI", "Meiryo", sans-serif',
      color: INK,
      decoration: "none",
      readColor: "#66728c",
    },
    message: { image: "themes/school/paper.svg", imageSlice: 20, padding: "30px 46px" },
    name: { image: "themes/school/sticky.svg", imageSlice: 8, color: INK, size: 20, padding: "4px 22px" },
    glyph: { shape: "dot", motion: "bounce", color: CORAL, size: 0.4, gap: 1 },
    choice: {
      image: "themes/school/button.svg",
      hoverImage: "themes/school/button-hover.svg",
      imageSlice: 18,
      color: INK,
      hoverColor: "#b53a37",
      size: 22,
      padding: "16px 36px",
    },
    system: {
      theme: "light",
      font: '"Hiragino Maru Gothic ProN", "Yu Gothic UI", "Meiryo", sans-serif',
      fg: INK,
      accent: CORAL,
      screenBg: "rgba(247, 250, 255, 0.98)",
      controlBg: "rgba(45, 58, 85, 0.05)",
      border: "rgba(45, 58, 85, 0.28)",
      radius: 12,
      titleBg: "linear-gradient(180deg, #dff1ff 0%, #fdfdff 62%, #fff4d6 100%)",
      titleButtonBg: "rgba(255, 255, 255, 0.92)",
      titleShadow: "0 1px 8px rgba(255, 255, 255, 0.95)",
    },
    menuBar: { color: "rgba(255, 255, 255, 0.9)", shadow: "0 1px 3px rgba(20, 30, 50, 0.95)" },
  },
};
