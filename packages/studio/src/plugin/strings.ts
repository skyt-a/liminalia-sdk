import { studioLanguage } from "./language.ts";

/**
 * 制作画面のプラグインの部品（src/plugin）が出す文言。制作画面の文言の表（src/client/strings.ts。非公開）とは分けて、
 * 部品が使うものだけを持つ。言語は制作画面と同じ決め方（studioLanguage）。
 */
const JA = {
  ok: "はい",
  cancel: "キャンセル",
  splitterTitle: "ドラッグで幅を変更（ダブルクリックで元の幅）",
  dataConflict: (name: string) => `data/${name} がほかでも書き換え続けられているため、保存できませんでした`,
  assetNone: "（なし）",
  assetMissing: (path: string) => `${path} は素材にありません`,
  assetCount: (n: number) => `${n} 件`,
};

const EN: typeof JA = {
  ok: "Yes",
  cancel: "Cancel",
  splitterTitle: "Drag to resize (double-click to reset)",
  dataConflict: (name: string) => `Couldn't save data/${name} because it keeps being changed elsewhere`,
  assetNone: "(none)",
  assetMissing: (path: string) => `${path} isn't in the assets`,
  assetCount: (n: number) => `${n.toLocaleString("en")} ${n === 1 ? "item" : "items"}`,
};

/** プラグインの部品の文言（読み込んだときの言語）。 */
export const PS = studioLanguage() === "en" ? EN : JA;
