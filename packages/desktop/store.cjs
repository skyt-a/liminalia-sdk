// @ts-check
/**
 * 店の口（書き出したデスクトップ版の main.cjs が使う）。実績、在席表示、画面のキーボード、買ったものの確かめと購入を、
 * 店ごとの実装に任せる。Steam（steamworks.js）は組み込みの実装で、ほかの店（GOG Galaxy、Epic Games Store など）は
 * 作品のプラグインが実装を差し込む（liminalia.json の build.store.desktop.module。docs/distribution.md）。
 *
 * 実装（create が返すもの）は次を持てる。無いものは使わない（何もしない）。
 *   name                      店の名前（build.store.products の商品の、店ごとの ID の鍵）
 *   achievement(id)           @achieve の実績を店に送る（id はゲームの実績の名前）
 *   achievementProgress(id, value, goal)  @achieve-progress の数を店に送る（goal は目標。目標の無い実績は 0）
 *   presence(text)            在席表示を出す（空なら消す）
 *   gamepadText(o)            画面のキーボードで文字を打ってもらう（打った文字か null）
 *   isDeck()                  Steam Deck などの、キーボードの無い端末で遊んでいるか
 *   owned(ids)                その店の商品 ID（DLC など）のうち、持っているもの
 *   buy(id)                   買う（"purchased" | "pending" | "cancelled" | "failed" | "opened"。opened は店のページを開いただけ）
 *   restore(ids)              購入を復元して、持っているもの
 *   checkLicense()            遊んでよいか（false なら知らせて終了する。DRM で包む店の起動の確かめなど）
 *   packs()                   店が配る追加の中身（ワークショップなど）のフォルダの一覧 [{ id, folder }]
 *   input                     ゲームパッドの操作（Steam Input）。start(send) で始め、send(操作の名前) でゲームに渡す
 *   shutdown()                終了するとき
 */
const path = require("node:path");

/**
 * game.json のうち店が読むもの（書き出しの build.ts が作る）。steam は build.steam、store は build.store.desktop。
 * @typedef {{ title: string, steam?: any, store?: { module: string, options?: unknown } }} StoreGame
 * @typedef {{ appDir?: string, log?: (m: string) => void, require?: (name: string) => any, version?: string }} StoreOptions
 * @typedef {{ start(send: (action: string, pressed: boolean) => void, every?: number): { stop(): void, poll(): void }, targets?: readonly string[] }} StoreInput
 * @typedef {{
 *   name: string, client?: any,
 *   achievement?(id: string): void, achievementProgress?(id: string, value: number, goal: number): void, presence?(text: string): void,
 *   gamepadText?(o: { description?: string, max?: number, text?: string } | null | undefined): Promise<string | null>, isDeck?(): boolean,
 *   owned?(ids: string[]): Promise<string[]>, buy?(id: string): Promise<string>, restore?(ids: string[]): Promise<string[]>,
 *   checkLicense?(): boolean | Promise<boolean>, licenseMessage?: string,
 *   packs?(): { id: string, folder: string }[], input?: StoreInput, shutdown?(): void,
 * }} Store
 */

/** @param {unknown} e */
const message = (e) => (e instanceof Error ? e.message : e && typeof e === "object" && "message" in e ? String(e.message) : String(e));

/**
 * game.json の設定から店の実装を作る（つながらなければ null）。
 * @param {StoreGame} game
 * @param {StoreOptions} [o]
 * @returns {Store | null}
 */
function createStore(game, o = {}) {
  const log = o.log || console.log;
  if (game.steam && game.steam.appId) return steamStore(game, { ...o, log });
  if (game.store && game.store.module) return pluginStore(game, { ...o, log });
  return null;
}

/**
 * 作品のプラグインの店（build.store.desktop.module を書き出しが store/ に入れる）。
 * @param {StoreGame} game
 * @param {StoreOptions & { log: (m: string) => void }} o
 * @returns {Store | null}
 */
function pluginStore(game, o) {
  const spec = game.store;
  if (!spec) return null;
  const file = path.join(o.appDir || __dirname, spec.module);
  try {
    const mod = require(file);
    const create = mod.create || (mod.default && mod.default.create);
    if (typeof create !== "function") throw new Error(`${spec.module} が create を書き出していません`);
    const impl = create({ game: { title: game.title, version: o.version || "" }, options: spec.options || {}, log: o.log, dir: path.dirname(file) });
    if (!impl) return null;
    const name = impl.name || mod.name || "plugin";
    o.log(`店（${name}）につなぎました`);
    return { ...impl, name };
  } catch (e) {
    o.log(`ストア連携モジュール（${spec.module}）を読み込めませんでした。ストア機能を使わずに続けます: ${message(e)}`);
    return null;
  }
}

/**
 * Steam（steamworks.js）。Steam が起動していないなどでつながらなければ null。
 * @param {StoreGame} game
 * @param {StoreOptions & { log: (m: string) => void }} o
 * @returns {Store | null}
 */
function steamStore(game, o) {
  /** @type {any} */
  let steamworks;
  /** @type {any} */
  let client;
  try {
    steamworks = (o.require || require)("steamworks.js");
    client = steamworks.init(Number(game.steam.appId));
    steamworks.electronEnableSteamOverlay();
    o.log(`Steam につなぎました（App ID ${game.steam.appId}）`);
  } catch (e) {
    o.log(`Steam につながりませんでした。実績は送らずに続けます: ${message(e)}`);
    return null;
  }
  const steam = game.steam;
  /**
   * 持っている DLC（商品の steam は DLC の App ID）。購入の復元も同じ（Steam は持っているものをいつも知っている）。
   * @param {string[]} ids
   */
  const owned = async (ids) =>
    ids.filter((id) => {
      try {
        return client.apps.isDlcInstalled(Number(id)) || client.apps.isSubscribedApp(Number(id));
      } catch {
        // Steam に聞けなければ持っていないものとする
        return false;
      }
    });
  return {
    name: "steam",
    client,
    achievement(id) {
      const name = (steam.achievements && steam.achievements[id]) || String(id);
      try {
        if (!client.achievement.isActivated(name)) {
          client.achievement.activate(name);
          client.stats.store();
        }
      } catch (e) {
        o.log(`Steam の実績 ${name} を解放できませんでした: ${message(e)}`);
      }
    },
    /**
     * 数を数える実績。build.steam.stats で結んだ統計（Steamworks の「統計」で作り、実績の「進行状況の統計」に選ぶ）の値にする。
     * 結んでいなければ送らない（目標に届いたときの解除は achievement で送る）。
     */
    achievementProgress(id, value) {
      const stat = steam.stats && steam.stats[id];
      if (!stat) return;
      try {
        if (client.stats.setInt(stat, Math.floor(Number(value) || 0))) client.stats.store();
      } catch (e) {
        o.log(`Steam の統計 ${stat} を書けませんでした: ${message(e)}`);
      }
    },
    /** 在席表示（Rich Presence）。Steamworks の在席表示の訳に "#Status" を "%status%" で用意する。 */
    presence(text) {
      try {
        if (text) {
          client.localplayer.setRichPresence("status", text);
          client.localplayer.setRichPresence("steam_display", "#Status");
        } else client.localplayer.clearRichPresence();
      } catch (e) {
        o.log(`Steam の在席表示を出せませんでした: ${message(e)}`);
      }
    },
    async gamepadText(q) {
      try {
        return await client.utils.showGamepadTextInput(0, 0, String((q && q.description) || ""), Number((q && q.max) || 64), String((q && q.text) || ""));
      } catch {
        // 入力の画面を出せなければ、入力をやめたものとする
        return null;
      }
    },
    isDeck() {
      try {
        return client.utils.isSteamRunningOnSteamDeck();
      } catch {
        // Steam に聞けなければ Steam Deck ではないとする
        return false;
      }
    },
    owned,
    /** DLC の店のページをオーバーレイで開く（買ったかは、あとで owned で確かめる）。 */
    async buy(id) {
      try {
        client.overlay.activateToStore(Number(id), 0);
        return "opened";
      } catch {
        // ストアを開けなかったことを遊ぶ側へ返す（遊ぶ側が知らせる）
        return "failed";
      }
    },
    restore: owned,
    ...(steam.workshop ? { packs: () => workshopPacks(client, o.log) } : {}),
    ...(steam.input && steam.input.actions ? { input: steamInput(client, steam.input, o.log) } : {}),
  };
}

/** パックの id に使える名前。 */
const PACK_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Steam ワークショップで購読しているアイテムのうち、入っているもの（pack.json のあるフォルダ。直下か、ただ一つのフォルダの中）。
 * id は pack.json の id（使えない名前なら workshop-<アイテムの ID>）。まだ入っていないものは取り寄せを頼む（次の起動から読み込む）。
 * @param {any} client steamworks.js の client
 * @param {(m: string) => void} log
 * @param {Pick<typeof import("node:fs"), "existsSync" | "readdirSync" | "statSync" | "readFileSync">} [fs] テストで差し替える
 */
function workshopPacks(client, log, fs = require("node:fs")) {
  /** @type {{ id: string, folder: string, workshop: string }[]} */
  const out = [];
  /** @type {unknown[]} */
  let items = [];
  try {
    items = client.workshop.getSubscribedItems();
  } catch (e) {
    log(`ワークショップの購読を確かめられませんでした: ${message(e)}`);
    return out;
  }
  for (const item of items) {
    let info = null;
    try {
      info = client.workshop.installInfo(item);
    } catch {
      // 入っていない・聞けないワークショップの品は飛ばす
      info = null;
    }
    if (!info || !info.folder || !fs.existsSync(info.folder)) {
      try {
        client.workshop.download(item, false);
      } catch {
        // 取り寄せを頼めなくても続ける
      }
      continue;
    }
    /** @type {string} */
    let folder = info.folder;
    if (!fs.existsSync(path.join(folder, "pack.json"))) {
      const base = folder;
      const dirs = fs.readdirSync(base).filter((d) => !d.startsWith(".") && fs.statSync(path.join(base, d)).isDirectory());
      const only = dirs.length === 1 ? dirs[0] : undefined;
      if (only !== undefined && fs.existsSync(path.join(base, only, "pack.json"))) folder = path.join(base, only);
      else continue;
    }
    let id = `workshop-${String(item)}`;
    try {
      const pack = JSON.parse(fs.readFileSync(path.join(folder, "pack.json"), "utf8"));
      if (typeof pack.id === "string" && PACK_ID.test(pack.id)) id = pack.id;
    } catch {
      // pack.json の無い・読めない品はパックとして読まない
      continue;
    }
    out.push({ id, folder, workshop: String(item) });
  }
  return out;
}

/**
 * Steam Input のアクションに結べるゲームの操作。ゲームパッドのボタン（a: 決定と送り、b: 戻る、x、y、lb、rb、lt、rt、select、start、
 * 十字。動きは標準のゲームパッドと同じ。advance は a、back は b の別名）と、システム画面の操作（auto、quick-save など）。
 */
const INPUT_TARGETS = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "select", "start", "up", "down", "left", "right", "advance", "back", "quick-save", "quick-load", "save", "load", "auto", "skip", "rollback", "rollforward", "prev-choice", "next-choice", "next-unread", "backlog", "config", "flowchart", "screenshot", "hide", "menu", "title"];

/**
 * Steam Input。build.steam.input の actionSet（既定 "InGameControls"）を有効にし、actions（Steam のデジタルのアクションの名前 →
 * ゲームの操作）を、押したときと離したときに send(操作, 押しているか) でゲームへ渡す。Steam のコールバック（RunCallbacks）が入力を
 * 更新するので、それを見るだけ。
 * @param {any} client steamworks.js の client
 * @param {{ actionSet?: string, actions: Record<string, string> }} config
 * @param {(m: string) => void} log
 * @returns {StoreInput}
 */
function steamInput(client, config, log) {
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  return {
    targets: INPUT_TARGETS,
    start(send, every = 16) {
      try {
        client.input.init();
      } catch (e) {
        log(`Steam Input を使えません: ${message(e)}`);
        return { stop: () => undefined, poll: () => undefined };
      }
      const set = client.input.getActionSet(config.actionSet || "InGameControls");
      const actions = Object.entries(config.actions)
        .filter(([, target]) => INPUT_TARGETS.includes(target))
        .map(([name, target]) => ({ name, target, handle: client.input.getDigitalAction(name) }));
      /** コントローラーとアクションごとの、前に見たときの押され具合（押した瞬間だけ送る）。 */
      const pressed = new Map();
      const poll = () => {
        let controllers = [];
        try {
          controllers = client.input.getControllers();
        } catch {
          // コントローラーを聞けない回は飛ばし、次の回にまた聞く
          return;
        }
        for (const c of controllers) {
          const key = String(c.getHandle());
          c.activateActionSet(set);
          for (const a of actions) {
            const now = !!c.isDigitalActionPressed(a.handle);
            const id = `${key}:${a.name}`;
            if (now !== !!pressed.get(id)) send(a.target, now);
            pressed.set(id, now);
          }
        }
      };
      if (every > 0) timer = setInterval(poll, every);
      log(`Steam Input のアクションを結びました（${actions.map((a) => `${a.name} → ${a.target}`).join("、")}）`);
      return {
        stop: () => {
          if (timer) clearInterval(timer);
          timer = null;
        },
        poll,
      };
    },
  };
}

module.exports = { createStore, steamStore, pluginStore, workshopPacks, steamInput, INPUT_TARGETS };
