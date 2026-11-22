// @ts-check
// ゲーム側にデスクトップ版であることと、実績を送る口などだけを渡す（Node の機能は渡さない）。
const { contextBridge, ipcRenderer } = require("electron");
// アップデートの確認（liminalia.json の build.update があるときだけ）
const updateConfig = ipcRenderer.sendSync("liminalia:update-enabled");
// 店（Steam か、作品のプラグインの店）。買ったものを確かめられる店だけ store を渡す
const storeInfo = ipcRenderer.sendSync("liminalia:store-info");
// ウィンドウの今の様子（覚えた位置と大きさを当てたか、全画面か）
const windowInfo = ipcRenderer.sendSync("liminalia:window-info") || { restored: false, fullscreen: false };
// ウィンドウを閉じる前（ゲームのオートセーブと保存）。済んだら答える（セーブの書き込みは先に送ったものから順に届く）
/** @type {(() => unknown) | null} */
let beforeClose = null;
ipcRenderer.on("liminalia:before-close", async () => {
  try {
    if (beforeClose) await beforeClose();
  } catch {
    // 書けなくても閉じる
  }
  ipcRenderer.send("liminalia:close-ready");
});
contextBridge.exposeInMainWorld("liminaliaDesktop", {
  ...(storeInfo && storeInfo.purchases
    ? {
        store: {
          name: String(storeInfo.name),
          // ids はその店の商品 ID（liminalia.json の build.store.products の、店の名前の鍵の値）
          owned: (/** @type {unknown[]} */ ids) => ipcRenderer.invoke("liminalia:store-owned", (ids || []).map(String)),
          buy: (/** @type {unknown} */ id) => ipcRenderer.invoke("liminalia:store-buy", String(id)),
          restore: (/** @type {unknown[]} */ ids) => ipcRenderer.invoke("liminalia:store-restore", (ids || []).map(String)),
        },
      }
    : {}),
  ...(updateConfig
    ? {
        update: {
          startup: !!updateConfig.startup,
          // fresh なら取り寄せ直す（メニューから確かめたとき）。起動したときの確認は一度だけ取り寄せる
          check: (/** @type {unknown} */ fresh) => ipcRenderer.invoke("liminalia:update-check", !!fresh),
          apply: (/** @type {unknown} */ what) => ipcRenderer.invoke("liminalia:update-apply", String(what)),
          onProgress: (/** @type {(p: unknown) => void} */ listener) => {
            ipcRenderer.on("liminalia:update-progress", (_event, p) => listener(p));
          },
          // 閉じる前の知らせ（オートセーブと保存）を通してから終了し、起動し直す
          relaunch: () => ipcRenderer.send("liminalia:relaunch"),
        },
      }
    : {}),
  platform: process.platform,
  // 店のコントローラーの操作（Steam Input のアクションを結んだもの。ゲームパッドのボタンか、システム画面の操作）。押したときと離したとき
  onInputAction: (/** @type {(action: string, pressed: boolean) => void} */ listener) => {
    ipcRenderer.on("liminalia:input-action", (_event, action, pressed) => listener(String(action), !!pressed));
  },
  achievement: (/** @type {unknown} */ id) => ipcRenderer.send("liminalia:achievement", String(id)),
  // 数を数える実績の進み具合（今の数と目標）
  achievementProgress: (/** @type {unknown} */ id, /** @type {unknown} */ value, /** @type {unknown} */ goal) => ipcRenderer.send("liminalia:achievement-progress", String(id), Number(value), Number(goal)),
  // 入っている追加の中身・修正（パック）の id
  packs: () => ipcRenderer.invoke("liminalia:packs"),
  // セーブのファイル（保存先の saves/。Steam の Auto-Cloud で同期できる）。書くのと消すのは、済んだら結果（{ ok, code, message }）を返す
  storage: {
    load: () => ipcRenderer.sendSync("liminalia:storage-load"),
    set: (/** @type {unknown} */ key, /** @type {unknown} */ value) => ipcRenderer.invoke("liminalia:storage-set", String(key), String(value)),
    remove: (/** @type {unknown} */ key) => ipcRenderer.invoke("liminalia:storage-remove", String(key)),
  },
  // Steam の画面のキーボード。Steam Deck か、ゲームパッドで遊んでいるとき（最後の操作がパッド）だけ使う
  gamepadText: async (/** @type {unknown} */ o) => {
    const pad = typeof navigator !== "undefined" && [...(navigator.getGamepads?.() ?? [])].some((g) => g && g.connected);
    if (!pad && !(await ipcRenderer.invoke("liminalia:steam-deck"))) return null;
    return ipcRenderer.invoke("liminalia:gamepad-text", o);
  },
  // 画面写真（写真のフォルダの <題名>/ に置く）
  screenshot: () => ipcRenderer.invoke("liminalia:screenshot"),
  // 止まったときの記録を logs/ に書く
  crash: (/** @type {unknown} */ text) => ipcRenderer.send("liminalia:crash", String(text)),
  // Steam の在席表示
  presence: (/** @type {unknown} */ text) => ipcRenderer.send("liminalia:presence", String(text)),
  // 体験版などのセーブ（liminalia.json の saves.carryFrom）を読む
  carry: (/** @type {unknown} */ from) => ipcRenderer.invoke("liminalia:carry", from),
  // 全画面（ウィンドウ全体）。切り替えは Alt+Enter・F11 でもでき、変わったら onFullscreen に知らせる
  setFullscreen: (/** @type {unknown} */ on) => ipcRenderer.send("liminalia:set-fullscreen", !!on),
  // 起動したときに全画面か（覚えた全画面を、ウィンドウを出す前に当てたとき）
  fullscreenAtStart: !!windowInfo.fullscreen,
  // ウィンドウの大きさ（ゲームの大きさの何倍か。0 ははじめの大きさ）
  setWindowScale: (/** @type {unknown} */ scale) => ipcRenderer.send("liminalia:set-window-scale", Number(scale) || 0),
  // 覚えた位置と大きさを当てて起動したか（そのときは、設定のウィンドウの大きさを起動したときに当て直さない）
  windowRestored: !!windowInfo.restored,
  onFullscreen: (/** @type {(on: boolean) => void} */ listener) => {
    ipcRenderer.on("liminalia:fullscreen", (_event, on) => listener(!!on));
  },
  // 最小化した・戻した（描画を絞らないときは、ページの visibilitychange が来ないため）
  onWindowVisible: (/** @type {(visible: boolean) => void} */ listener) => {
    ipcRenderer.on("liminalia:window-visible", (_event, visible) => listener(!!visible));
  },
  // 最小化したときに描画と時計を絞るか（遊ぶ人の設定で、最小化しても鳴らし続けるときは絞らない）
  setBackgroundThrottling: (/** @type {unknown} */ on) => ipcRenderer.send("liminalia:background-throttling", !!on),
  // 画面のスリープを止める・戻す（オート中と動画の再生中）
  keepAwake: (/** @type {unknown} */ on) => ipcRenderer.send("liminalia:keep-awake", !!on),
  // 遊ぶ言語（Mac のメニューと、ゲームの画面の外の知らせの文言を合わせる）
  setLanguage: (/** @type {unknown} */ language) => ipcRenderer.send("liminalia:language", String(language || "")),
  // ウィンドウを閉じる前に呼ぶもの（済むまで閉じない。2 秒で諦める）
  onBeforeClose: (/** @type {() => unknown} */ listener) => {
    beforeClose = listener;
  },
});
