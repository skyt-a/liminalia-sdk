export interface ScreenCase {
  /** 出す一行。 */
  line: string;
  /** 出ているときに見える要素。 */
  shown: string;
  /** 文字の欄で打つ画面（ショートカットのキーは字になるので試さない）。 */
  typing?: boolean;
  /** Esc と右クリック: menu はメニューを開く、back は画面の戻る（図鑑を閉じる、選ぶのをやめるなど）。 */
  escape: "menu" | "back";
  rightClick: "menu" | "back";
}

/** 遊ぶ人の操作を待つ画面を出す命令と、ブラウザで試す出し方。 */
export const SCREENS: Record<string, ScreenCase> = {
  investigate: { line: "@investigate room", shown: ".lm-investigate-spot", escape: "menu", rightClick: "menu" },
  "map-choice": { line: "@map-choice town result=temp.where", shown: ".lm-map-choice-spot", escape: "menu", rightClick: "menu" },
  codex: { line: "@codex", shown: ".lm-codex", escape: "back", rightClick: "back" },
  "open-screen": { line: "@open-screen codex", shown: ".lm-codex", escape: "back", rightClick: "back" },
  "item-select": { line: "@item-select temp.used", shown: "[data-lm-screen='items']", escape: "back", rightClick: "back" },
  "text-input": { line: '@text-input temp.name prompt="名前"', shown: ".lm-panel input", typing: true, escape: "menu", rightClick: "menu" },
  dialog: { line: '@dialog "続けますか" type=confirm', shown: ".lm-panel", escape: "back", rightClick: "menu" },
};
