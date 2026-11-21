import type { UiThemePreset } from "./index.ts";

/** 既定。何も決めない（system/default.css の暗い配色のまま）。ほかのテーマから戻すときに選ぶ。 */
export const defaultTheme: UiThemePreset = {
  id: "default",
  name: "既定",
  nameEn: "Default",
  ui: { system: {} },
};
