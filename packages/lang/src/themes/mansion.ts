import type { UiThemePreset } from "./index.ts";

const GOLD = "#c9a45c";
const WINE = "#2a0d13";

/** 飾り枠。二重の金線の四隅に小さな菱形を置く。角を伸ばさないよう切り分けて使う。 */
const frame = (size: number, fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect x="1.5" y="1.5" width="${size - 3}" height="${size - 3}" fill="${fill}" stroke="${GOLD}" stroke-width="2"/>
<rect x="6.5" y="6.5" width="${size - 13}" height="${size - 13}" fill="none" stroke="${GOLD}" stroke-opacity="0.45"/>
${[
  [10, 10],
  [size - 10, 10],
  [10, size - 10],
  [size - 10, size - 10],
]
  .map(([x, y]) => `<path d="M${x} ${y! - 5} L${x! + 5} ${y} L${x} ${y! + 5} L${x! - 5} ${y} Z" fill="${GOLD}"/>`)
  .join("")}
</svg>
`;

/** 小さなボタンと名前の札の枠。文字にかからないよう、線と四隅の小さな印だけにする。 */
const small = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
<rect x="1" y="1" width="22" height="22" fill="${fill}" stroke="${GOLD}" stroke-width="1.5"/>
<path d="M1 5 V1 H5 M19 1 H23 V5 M23 19 V23 H19 M5 23 H1 V19" fill="none" stroke="#f0d9a0" stroke-width="2"/>
</svg>
`;

const thumb = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M12 2 L22 12 L12 22 L2 12 Z" fill="${WINE}" stroke="${GOLD}" stroke-width="2"/></svg>
`;

/** 洋館。深紅の地に金の飾り枠、明朝。古い館の調度の見た目。 */
export const mansionTheme: UiThemePreset = {
  id: "mansion",
  name: "洋館",
  nameEn: "Mansion",
  assets: {
    "frame.svg": frame(72, "rgba(36, 10, 16, 0.9)"),
    "plate.svg": small("rgba(58, 16, 24, 0.97)"),
    "choice.svg": frame(48, "rgba(58, 16, 24, 0.94)"),
    "choice-hover.svg": frame(48, "rgba(116, 34, 44, 0.96)"),
    "button.svg": small("rgba(58, 16, 24, 0.94)"),
    "button-hover.svg": small("rgba(116, 34, 44, 0.96)"),
    "panel.svg": frame(72, "rgba(30, 9, 14, 0.98)"),
    "thumb.svg": thumb,
  },
  ui: {
    text: {
      font: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif',
      color: "#f2e7d2",
      decoration: "shadow",
      decorationColor: "rgba(0, 0, 0, 0.8)",
      readColor: "#d9c9ad",
    },
    message: { image: "themes/mansion/frame.svg", imageSlice: 24, padding: "34px 52px 34px" },
    name: { image: "themes/mansion/plate.svg", imageSlice: 8, color: "#f0d9a0", size: 21, letterSpacing: "0.12em", padding: "6px 26px", font: '"Hiragino Mincho ProN", "Yu Mincho", serif' },
    glyph: { shape: "diamond", motion: "breathe", color: GOLD, size: 0.4, gap: 1.2 },
    choice: {
      image: "themes/mansion/choice.svg",
      hoverImage: "themes/mansion/choice-hover.svg",
      imageSlice: 18,
      color: "#f2e7d2",
      hoverColor: "#ffe9b0",
      font: '"Hiragino Mincho ProN", "Yu Mincho", serif',
      size: 22,
      letterSpacing: "0.08em",
      padding: "18px 40px",
    },
    system: {
      theme: "dark",
      font: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif',
      fg: "#f2e7d2",
      accent: GOLD,
      screenBg: "rgba(26, 8, 12, 0.97)",
      controlBg: "rgba(201, 164, 92, 0.1)",
      border: "rgba(201, 164, 92, 0.55)",
      radius: 0,
      titleBg: `radial-gradient(ellipse at center, #4d1620 0%, ${WINE} 55%, #0d0406 100%)`,
      titleButtonBg: "rgba(36, 10, 16, 0.9)",
      titleShadow: "0 2px 10px rgba(0, 0, 0, 0.9)",
      images: {
        button: "themes/mansion/button.svg",
        buttonHover: "themes/mansion/button-hover.svg",
        buttonSlice: 8,
        frame: "themes/mansion/panel.svg",
        frameSlice: 24,
        sliderThumb: "themes/mansion/thumb.svg",
      },
    },
    menuBar: { color: "rgba(240, 217, 160, 0.78)" },
  },
};
