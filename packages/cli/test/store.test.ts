import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeLibraryManifests, storeBridgeJava } from "../src/mobile/android.ts";
import { createIosProject } from "../src/mobile/ios.ts";
import { mobileProductIds } from "../src/mobile/store.ts";

interface Store {
  name: string;
  achievement?(id: string): void;
  achievementProgress?(id: string, value: number, goal: number): void;
  presence?(text: string): void;
  owned?(ids: string[]): Promise<string[]>;
  buy?(id: string): Promise<string>;
  checkLicense?(): boolean;
}
const { createStore } = createRequire(import.meta.url)(resolve(import.meta.dirname, "../../desktop/store.cjs")) as {
  createStore(game: object, o?: { appDir?: string; log?: (m: string) => void; require?: (name: string) => unknown; version?: string }): Store | null;
};

describe("デスクトップ版の店の口（store.cjs）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-store-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const quiet = () => undefined;

  it("店の設定が無ければ null", () => {
    expect(createStore({ title: "T" }, { log: quiet })).toBeNull();
  });

  it("Steam: 実績の名前を対応づけ、DLC を持っているかを確かめ、買うときは店のページを開く", async () => {
    const calls: string[] = [];
    const client = {
      achievement: { isActivated: () => false, activate: (n: string) => calls.push(`activate:${n}`) },
      stats: { store: () => calls.push("store"), setInt: (n: string, v: number) => (calls.push(`stat:${n}=${v}`), true) },
      apps: { isDlcInstalled: (id: number) => id === 480, isSubscribedApp: () => false },
      overlay: { activateToStore: (id: number) => calls.push(`store-page:${id}`) },
      localplayer: { setRichPresence: (k: string, v: string) => calls.push(`presence:${k}=${v}`), clearRichPresence: () => calls.push("clear") },
    };
    const steamworks = { init: () => client, electronEnableSteamOverlay: () => undefined };
    const store = createStore({ title: "T", steam: { appId: 100, achievements: { first: "ACH_FIRST" }, stats: { reads: "STAT_READS" } } }, { log: quiet, require: () => steamworks })!;
    expect(store.name).toBe("steam");
    store.achievement!("first");
    // 数を数える実績は、結んだ統計だけに書く
    store.achievementProgress!("reads", 3, 10);
    store.achievementProgress!("other", 3, 10);
    store.presence!("第一章");
    expect(await store.owned!(["480", "481"])).toEqual(["480"]);
    expect(await store.buy!("481")).toBe("opened");
    expect(calls).toEqual(["activate:ACH_FIRST", "store", "stat:STAT_READS=3", "store", "presence:status=第一章", "presence:steam_display=#Status", "store-page:481"]);
  });

  it("Steam につながらなければ null（そのまま遊べる）", () => {
    const logs: string[] = [];
    expect(createStore({ title: "T", steam: { appId: 100 } }, { log: (m) => logs.push(m), require: () => ({ init: () => { throw new Error("Steam が起動していません"); } }) })).toBeNull();
    expect(logs[0]).toContain("Steam につながりませんでした");
  });

  it("作品のプラグインの店（GOG Galaxy など）を読み込み、設定を渡す。読めなければ null", async () => {
    mkdirSync(join(dir, "store"));
    writeFileSync(
      join(dir, "store", "gog.cjs"),
      `module.exports = { name: "gog", create(ctx) { return { owned: async (ids) => ids.filter((x) => x === ctx.options.owned), checkLicense: () => true, title: ctx.game.title }; } };`,
    );
    const store = createStore({ title: "星", store: { module: "store/gog.cjs", options: { owned: "dlc1" } } }, { appDir: dir, log: quiet })!;
    expect(store.name).toBe("gog");
    expect(await store.owned!(["dlc1", "dlc2"])).toEqual(["dlc1"]);
    expect(store.checkLicense!()).toBe(true);
    const logs: string[] = [];
    expect(createStore({ title: "星", store: { module: "store/none.cjs" } }, { appDir: dir, log: (m) => logs.push(m) })).toBeNull();
    expect(logs[0]).toContain("ストア連携モジュール");
  });
});

describe("Steam ワークショップと Steam Input", () => {
  const mod = createRequire(import.meta.url)(resolve(import.meta.dirname, "../../desktop/store.cjs")) as {
    workshopPacks(client: object, log: (m: string) => void): { id: string; folder: string; workshop: string }[];
    steamInput(client: object, config: { actionSet?: string; actions: Record<string, string> }, log: (m: string) => void): { start(send: (a: string, pressed: boolean) => void, every?: number): { stop(): void; poll(): void } };
  };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-workshop-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("購読して入っているアイテムの pack.json を読み、id を決める。入っていないものは取り寄せを頼む", () => {
    mkdirSync(join(dir, "111"), { recursive: true });
    writeFileSync(join(dir, "111", "pack.json"), JSON.stringify({ id: "fan_story" }));
    mkdirSync(join(dir, "222", "inner"), { recursive: true });
    writeFileSync(join(dir, "222", "inner", "pack.json"), JSON.stringify({ id: "../bad" }));
    mkdirSync(join(dir, "333"), { recursive: true });
    const downloads: bigint[] = [];
    const client = {
      workshop: {
        getSubscribedItems: () => [111n, 222n, 333n, 444n],
        installInfo: (id: bigint) => (id === 444n ? null : { folder: join(dir, String(id)), sizeOnDisk: 0n, timestamp: 0 }),
        download: (id: bigint) => downloads.push(id),
      },
    };
    expect(mod.workshopPacks(client, () => undefined)).toEqual([
      { id: "fan_story", folder: join(dir, "111"), workshop: "111" },
      { id: "workshop-222", folder: join(dir, "222", "inner"), workshop: "222" },
    ]);
    expect(downloads).toEqual([444n]);
  });

  it("アクションを押したときと離したときだけ、結んだ操作を送る（コントローラーごと）", () => {
    let pressed = new Set<string>();
    const sets: bigint[] = [];
    const controller = (handle: bigint) => ({ getHandle: () => handle, activateActionSet: (s: bigint) => sets.push(s), isDigitalActionPressed: (h: bigint) => pressed.has(`${handle}:${h}`) });
    const client = {
      input: {
        init: () => undefined,
        getActionSet: (name: string) => (name === "InGameControls" ? 7n : 0n),
        getDigitalAction: (name: string) => ({ confirm: 1n, skip_hold: 2n, unknown: 3n })[name] ?? 0n,
        getControllers: () => [controller(10n), controller(20n)],
      },
    };
    const sent: string[] = [];
    const run = mod.steamInput(client, { actions: { confirm: "a", skip_hold: "rb", unknown: "fly" } }, () => undefined).start((a, p) => sent.push(`${a}:${p}`), 0);
    run.poll();
    pressed = new Set(["10:1", "20:2"]);
    run.poll();
    run.poll();
    pressed = new Set(["20:2"]);
    run.poll();
    run.stop();
    expect(sent).toEqual(["a:true", "rb:true", "a:false"]);
    expect(sets.every((s) => s === 7n)).toBe(true);
  });
});

describe("スマホ版のアプリ内課金", () => {
  it("店ごとの商品 ID を集める", () => {
    expect(mobileProductIds({ full: { ios: "a", android: "b" }, art: { ios: "c", steam: 1 } }, "ios")).toEqual(["a", "c"]);
    expect(mobileProductIds(undefined, "android")).toEqual([]);
  });

  it("Android: ライブラリのマニフェストの権限と activity を足す（${applicationId} を置き換え、同じものは一度）", () => {
    const lib = `<manifest package="com.android.billingclient"><uses-sdk android:minSdkVersion="21"/><!-- c --><uses-permission android:name="com.android.vending.BILLING"/>
      <queries><intent><action android:name="com.android.vending.billing.InAppBillingService.BIND"/></intent></queries>
      <application><activity android:name="com.android.billingclient.api.ProxyBillingActivity" android:exported="false"/><provider android:authorities="\${applicationId}.billing"/></application></manifest>`;
    const r = mergeLibraryManifests([lib, lib], "com.example.game");
    expect(r.outside.filter((e) => e.includes("BILLING")).length).toBeGreaterThanOrEqual(1);
    expect(r.outside.some((e) => e.startsWith("<queries>"))).toBe(true);
    expect(r.outside.some((e) => e.includes("uses-sdk"))).toBe(false);
    expect(r.inside).toHaveLength(2);
    expect(r.inside[1]).toContain("com.example.game.billing");
  });

  it("Android: 課金の口は Play Billing Library 7 と 8 のどちらの答えの形も受け、ラムダを使わない（android.jar で組み立てるため）", () => {
    const java = storeBridgeJava("com.example.game");
    expect(java).toContain("getProductDetailsList");
    expect(java).toContain("Proxy.newProxyInstance");
    expect(java).toContain("acknowledgePurchase");
    expect(java).not.toMatch(/\)\s*->/);
  });

  it("iOS: 商品があるときだけ StoreKit 2 の口を入れる", () => {
    const dir = mkdtempSync(join(tmpdir(), "liminalia-ios-store-"));
    try {
      mkdirSync(join(dir, "web"));
      const base = { web: join(dir, "web"), appId: "com.example.game", title: "G", version: "1.0.0", build: 1, landscape: true, icon: null };
      createIosProject({ ...base, dir: join(dir, "a"), products: ["com.example.full"] });
      const swift = readFileSync(join(dir, "a", "App", "App.swift"), "utf8");
      expect(swift).toContain("import StoreKit");
      expect(swift).toContain('config.userContentController.add(store, name: "liminaliaStore")');
      expect(swift).toContain("Transaction.currentEntitlements");
      expect(swift).toContain("window.__liminaliaStoreReply(\\(id)");
      createIosProject({ ...base, dir: join(dir, "b") });
      expect(readFileSync(join(dir, "b", "App", "App.swift"), "utf8")).not.toContain("StoreKit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
