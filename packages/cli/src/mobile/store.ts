/**
 * スマホ版のアプリ内課金。ゲームの画面（packages/web の store.ts）は、iOS では window.webkit.messageHandlers.liminaliaStore、
 * Android では window.LiminaliaStore.call に {"id", "method", "product"} の JSON を送り、アプリ（Swift、Java）は
 * window.__liminaliaStoreReply(id, 結果) で答える。method は owned（持っている商品 ID の一覧）、
 * buy（purchased、pending、cancelled、failed）、restore（復元して持っている商品 ID の一覧）。
 */

/** 書き出しの設定から、その店の商品 ID の一覧。 */
export function mobileProductIds(products: Record<string, Record<string, string | number | undefined>> | undefined, store: "ios" | "android"): string[] {
  return [...new Set(Object.values(products ?? {}).map((p) => p[store]).filter((x): x is string => typeof x === "string" && x !== ""))];
}
