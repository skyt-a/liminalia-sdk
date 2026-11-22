/**
 * 制作画面のプラグインの口の版。口を足したら上げる（プラグインは ctx.apiVersion がこれ以上かを見て、新しい口を使うかを決める）。
 * 画面（./studio）と開発サーバー（./studio-server）の両方の ctx.apiVersion がこの値になる。
 * - 1: はじめの口（ctx.apiVersion は無い）
 * - 2: 画面の dataDocument・assetField・askConfirm・askText、開発サーバーの cast・speakers・assets・scripts・parse
 * - 3: 画面の ctx.language（表示の言語）と、画面・欄・操作の titleEn（英語の表示のときの名前）
 * - 4: 画面の suggestAssets（台本の補完に、書いている場面に合う素材を足す）
 */
// 正本はプラグインとの約束（@liminalia/sdk/studio）
export { STUDIO_PLUGIN_API_VERSION } from "@liminalia/sdk/studio";
