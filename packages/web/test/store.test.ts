import { describe, expect, it } from "vitest";
import type { Value } from "@liminalia/runtime";
import { nativeStore, storeIds, storeRequest, syncPurchases, type BuyResult, type StoreBridge } from "../src/store.ts";
import { TEXT } from "../src/system/strings.ts";

const products = { full: { ios: "com.example.full", android: "full_unlock", steam: 480 }, art: { ios: "com.example.art" } };

/** システム画面の代わり（全セーブ共通の変数と、残したもの）。 */
function fakeSystem() {
  const systemVariables: Record<string, Value> = {};
  let saved = 0;
  return {
    systemVariables,
    importData: (d: { system?: Record<string, Value> }) => {
      Object.assign(systemVariables, d.system);
      saved++;
      return 0;
    },
    saved: () => saved,
  };
}

function fakeBridge(name: string, owned: string[], buy: BuyResult = "purchased"): StoreBridge & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    calls,
    owned: async (ids) => (calls.push(`owned:${ids.join(",")}`), owned.filter((x) => ids.includes(x))),
    buy: async (id) => (calls.push(`buy:${id}`), buy),
    restore: async (ids) => (calls.push(`restore:${ids.join(",")}`), owned.filter((x) => ids.includes(x))),
  };
}

describe("店とアプリ内課金", () => {
  it("店ごとの商品 ID を引く（その店の ID が無い商品は除く）", () => {
    expect([...storeIds(products, "ios")]).toEqual([["full", "com.example.full"], ["art", "com.example.art"]]);
    expect([...storeIds(products, "steam")]).toEqual([["full", "480"]]);
  });

  it("持っているものを system.purchases に書いて残す。店に聞けなければ前のままにする", async () => {
    const system = fakeSystem();
    expect(await syncPurchases(products, fakeBridge("ios", ["com.example.art"]), system)).toEqual(["art"]);
    expect(system.systemVariables.purchases).toEqual({ full: false, art: true });
    const broken: StoreBridge = { name: "ios", owned: async () => Promise.reject(new Error("offline")), buy: async () => "failed", restore: async () => [] };
    expect(await syncPurchases(products, broken, system)).toBeNull();
    expect(system.systemVariables.purchases).toEqual({ full: false, art: true });
  });

  it("@purchase で買い、買えたらすぐ system.purchases に書く。結果を知らせる", async () => {
    const system = fakeSystem();
    const said: string[] = [];
    const bridge = fakeBridge("android", []);
    expect(await storeRequest({ name: "purchase", args: { product: "full" } }, { products, system, layer: null, bridge, say: (m) => said.push(m) })).toBe(true);
    expect(bridge.calls).toEqual(["buy:full_unlock"]);
    expect(system.systemVariables.purchases).toMatchObject({ full: true });
    expect(said).toEqual([TEXT.store.purchased]);
    // キャンセルは書かない
    const other = fakeSystem();
    await storeRequest({ name: "purchase", args: { product: "full" } }, { products, system: other, layer: null, bridge: fakeBridge("android", [], "cancelled"), say: (m) => said.push(m) });
    expect(other.systemVariables.purchases).toBeUndefined();
    expect(said.at(-1)).toBe(TEXT.store.cancelled);
    // その店に ID が無い商品と、店の無い環境
    await storeRequest({ name: "purchase", args: { product: "art" } }, { products, system, layer: null, bridge, say: (m) => said.push(m) });
    expect(said.at(-1)).toBe(TEXT.store.unavailable);
    await storeRequest({ name: "purchase", args: { product: "full" } }, { products, system, layer: null, bridge: null, say: (m) => said.push(m) });
    expect(said.at(-1)).toBe(TEXT.store.unavailable);
    // ほかの要求は受けない
    expect(await storeRequest({ name: "auto", args: {} }, { products, system, layer: null, bridge })).toBe(false);
  });

  it("@restore-purchases で復元し、持っているものを書く", async () => {
    const system = fakeSystem();
    const said: string[] = [];
    const bridge = fakeBridge("ios", ["com.example.full"]);
    await storeRequest({ name: "restore-purchases", args: {} }, { products, system, layer: null, bridge, say: (m) => said.push(m) });
    expect(bridge.calls[0]).toMatch(/^restore:/);
    expect(system.systemVariables.purchases).toEqual({ full: true, art: false });
    expect(said).toEqual([TEXT.store.restored]);
  });

  it("スマホ版のアプリの口に JSON を送り、答えを受ける（Android の LiminaliaStore と iOS の messageHandlers）", async () => {
    const sent: { id: number; method: string; product: string }[] = [];
    const w: Parameters<typeof nativeStore>[0] = {
      LiminaliaStore: {
        call: (m) => {
          const msg = JSON.parse(m) as { id: number; method: string; product: string };
          sent.push(msg);
          // アプリは少し後で window.__liminaliaStoreReply を呼ぶ
          queueMicrotask(() => w.__liminaliaStoreReply!(msg.id, msg.method === "buy" ? "pending" : ["full_unlock", "other"]));
        },
      },
    };
    const bridge = nativeStore(w)!;
    expect(bridge.name).toBe("android");
    expect(await bridge.owned(["full_unlock"])).toEqual(["full_unlock"]);
    expect(await bridge.buy("full_unlock")).toBe("pending");
    expect(sent.map((s) => `${s.method}:${s.product}`)).toEqual(["owned:", "buy:full_unlock"]);
    const ios: Parameters<typeof nativeStore>[0] = { webkit: { messageHandlers: { liminaliaStore: { postMessage: (m) => queueMicrotask(() => ios.__liminaliaStoreReply!((JSON.parse(m) as { id: number }).id, null)) } } } };
    // 店につながらない（null の答え）は、持っていないことにせず失敗にする
    await expect(nativeStore(ios)!.owned(["a"])).rejects.toThrow();
    expect(nativeStore({})).toBeNull();
  });
});
