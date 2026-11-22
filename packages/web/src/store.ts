import type { Value } from "@liminalia/runtime";
import type { SystemController, SystemRequest } from "./plugin.ts";
import { TEXT } from "./system/strings.ts";
import { toast } from "./system/ui.ts";

/**
 * 店とアプリ内課金（liminalia.json の build.store.products）。
 *
 * 商品はゲームの中の名前（"full" など）→ 店ごとの商品 ID（ios: App Store の Product ID、android: Google Play の商品 ID、
 * steam: DLC の App ID、ほかは作品のプラグインの店の名前）。買ったものは全セーブ共通の変数 system.purchases.<名前> が true になる。
 * - シナリオからは `@purchase full` で買い（店の画面が閉じるまで待つ）、`@restore-purchases` で復元し、`@if (system.purchases.full)` で確かめる
 * - 店の口は、スマホ版はアプリが置く window.liminaliaStore（iOS の StoreKit 2、Android の Google Play Billing）、
 *   デスクトップ版は window.liminaliaDesktop.store（Steam の DLC か、作品のプラグインの店）
 * - 起動したときと、ゲームに戻ったとき（デスクトップ版で店のページから戻ったときなど）に、持っているものを確かめ直す
 */

/** 買った結果。opened は店のページを開いただけ（Steam の DLC など。買ったかは、あとで確かめ直す）。 */
export type BuyResult = "purchased" | "pending" | "cancelled" | "failed" | "opened";

/** 店の口（ID はその店の商品 ID）。 */
export interface StoreBridge {
  /** 店の名前（ios、android、steam、プラグインの店の名前）。商品の店ごとの ID の鍵。 */
  name: string;
  /** ids のうち、持っているもの。 */
  owned(ids: string[]): Promise<string[]>;
  buy(id: string): Promise<BuyResult>;
  /** 購入を復元して、ids のうち持っているもの。 */
  restore(ids: string[]): Promise<string[]>;
}

/** 商品（店の名前 → その店の商品 ID）。 */
export type StoreProducts = Record<string, Record<string, string | number | undefined>>;

/** この環境の店の口（無ければ null。ブラウザ版など）。 */
export function storeBridge(): StoreBridge | null {
  if (typeof window === "undefined") return null;
  return window.liminaliaStore ?? nativeStore(window as unknown as NativeWindow) ?? window.liminaliaDesktop?.store ?? null;
}

/** スマホ版のアプリが置く口（iOS は WKScriptMessageHandler、Android は addJavascriptInterface）。 */
interface NativeWindow {
  webkit?: { messageHandlers?: { liminaliaStore?: { postMessage(message: string): void } } };
  LiminaliaStore?: { call(message: string): void };
  __liminaliaStoreReply?: (id: number, result: unknown) => void;
}

/** 作った口（ウィンドウごとに一つ）。 */
const nativeBridges = new WeakMap<NativeWindow, StoreBridge | null>();

/**
 * スマホ版のアプリ内課金の口（lim build ios・android が build.store.products の商品があるときに入れる。packages/cli の mobile/store.ts）。
 * {"id", "method", "product"} の JSON を送り、アプリは window.__liminaliaStoreReply(id, 結果) で答える。
 */
export function nativeStore(w: NativeWindow): StoreBridge | null {
  if (nativeBridges.has(w)) return nativeBridges.get(w)!;
  const ios = w.webkit?.messageHandlers?.liminaliaStore;
  const android = w.LiminaliaStore;
  if (!ios && !android) {
    nativeBridges.set(w, null);
    return null;
  }
  let next = 0;
  const waiting = new Map<number, (result: unknown) => void>();
  w.__liminaliaStoreReply = (id, result) => {
    const done = waiting.get(id);
    waiting.delete(id);
    done?.(result);
  };
  const call = (method: "owned" | "buy" | "restore", product = "") =>
    new Promise<unknown>((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      const message = JSON.stringify({ id, method, product });
      if (ios) ios.postMessage(message);
      else android!.call(message);
    });
  // 一覧でない答え（店につながらないときの null）は、持っていないことにせず失敗にする（前に確かめたものを使う）
  const pick = (list: unknown, ids: string[]) => {
    if (!Array.isArray(list)) throw new Error("店につながりません");
    return list.map(String).filter((x) => ids.includes(x));
  };
  const results: readonly BuyResult[] = ["purchased", "pending", "cancelled", "failed", "opened"];
  const bridge: StoreBridge = {
    name: ios ? "ios" : "android",
    owned: async (ids) => pick(await call("owned"), ids),
    buy: async (id) => {
      const r = await call("buy", id);
      return results.includes(r as BuyResult) ? (r as BuyResult) : "failed";
    },
    restore: async (ids) => pick(await call("restore"), ids),
  };
  nativeBridges.set(w, bridge);
  return bridge;
}

/** ゲームの中の名前 ↔ この店の商品 ID。 */
export function storeIds(products: StoreProducts, store: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, ids] of Object.entries(products)) {
    const id = ids[store];
    if (id !== undefined && id !== "") out.set(name, String(id));
  }
  return out;
}

/**
 * 持っているものを確かめて system.purchases に書き、残す（店に聞けなければ、前に確かめたものを使う）。
 * 持っている商品の名前を返す（聞けなければ null）。
 */
export async function syncPurchases(products: StoreProducts, bridge: StoreBridge, system: Pick<SystemController, "systemVariables" | "importData">, restore = false): Promise<string[] | null> {
  const ids = storeIds(products, bridge.name);
  if (ids.size === 0) return [];
  let owned: string[];
  try {
    owned = restore ? await bridge.restore([...ids.values()]) : await bridge.owned([...ids.values()]);
  } catch (e) {
    console.warn("店に購入を確かめられませんでした", e);
    return null;
  }
  const names = [...ids].filter(([, id]) => owned.includes(id)).map(([name]) => name);
  const purchases: Record<string, Value> = Object.fromEntries(Object.keys(products).map((name) => [name, names.includes(name)]));
  if (system.importData) system.importData({ system: { purchases } });
  else if (system.systemVariables) system.systemVariables.purchases = purchases;
  return names;
}

/**
 * シナリオからの @purchase と @restore-purchases を受ける（ほかは false）。結果は短く知らせ、system.purchases に書く。
 */
export async function storeRequest(
  req: SystemRequest,
  o: { products: StoreProducts; system: Pick<SystemController, "systemVariables" | "importData">; layer: HTMLElement | null; bridge?: StoreBridge | null; say?: (message: string) => void },
): Promise<boolean> {
  if (req.name !== "purchase" && req.name !== "restore-purchases") return false;
  const bridge = o.bridge === undefined ? storeBridge() : o.bridge;
  const say = o.say ?? ((m: string) => o.layer && toast(o.layer, m, 3000));
  if (!bridge) {
    say(TEXT.store.unavailable);
    return true;
  }
  if (req.name === "restore-purchases") {
    const names = await syncPurchases(o.products, bridge, o.system, true);
    say(names === null ? TEXT.store.failed : names.length > 0 ? TEXT.store.restored : TEXT.store.nothingToRestore);
    return true;
  }
  const name = String(req.args.product ?? "");
  const id = storeIds(o.products, bridge.name).get(name);
  if (!id) {
    console.warn(`商品 ${name} の ${bridge.name} の ID が liminalia.json の build.store.products にありません`);
    say(TEXT.store.unavailable);
    return true;
  }
  let result: BuyResult;
  try {
    result = await bridge.buy(id);
  } catch {
    // ストアに頼めなければ、買えなかったものとして知らせる
    result = "failed";
  }
  if (result === "purchased") {
    // 店が確かめた購入（iOS は署名を確かめた取引、Android は購入済みの状態）。店の一覧に出るまで間があることがあるので、すぐ書く
    const purchases = { ...((o.system.systemVariables?.purchases as Record<string, Value> | undefined) ?? {}), [name]: true };
    if (o.system.importData) o.system.importData({ system: { purchases } });
    else if (o.system.systemVariables) o.system.systemVariables.purchases = purchases;
  }
  say(TEXT.store[result]);
  return true;
}

/** 起動したときに確かめ、ゲームに戻ったとき（店のページから戻ったときなど）にも確かめ直す。 */
export function watchPurchases(products: StoreProducts, system: SystemController): void {
  const bridge = storeBridge();
  if (!bridge || storeIds(products, bridge.name).size === 0) return;
  void syncPurchases(products, bridge, system);
  let last = Date.now();
  const again = () => {
    // 続けて何度も聞かない
    if (Date.now() - last < 5000) return;
    last = Date.now();
    void syncPurchases(products, bridge, system);
  };
  window.addEventListener("focus", again);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") again();
  });
}
