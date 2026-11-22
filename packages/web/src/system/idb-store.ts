import type { KeyValueStore } from "./storage.ts";

/**
 * ブラウザ版とスマホ版（iOS のアプリ）のセーブの置き場所（IndexedDB）。
 * localStorage は 5MB ほどしか入らず、縮小画像つきのセーブが数十枠で埋まる。IndexedDB はずっと大きい。
 *
 * 置き方は Android 版のアプリ（SharedPreferences）とデスクトップ版（ファイル）と同じで、起動したときに作品の分を全部読んでおき、
 * そのあとの読み書きはメモリの写しで同期的に答え（KeyValueStore。システム画面は今までどおり同期で読む）、書いたものは裏で IndexedDB へ書く。
 * - 前の版が localStorage に書いたもの（"liminalia:<作品の id>:" で始まる鍵）は、起動するたびに見つけたものを移して localStorage から消す
 *   （移した後に localStorage へ書くのは前の版のエンジンだけなので、見つかったものの方が新しい）
 * - 書き終わる前にページが閉じられたときのために、裏へ回っている間に書いたものと、閉じるときに書き終わっていないものは
 *   localStorage の JOURNAL にも置き、次に起動したときに IndexedDB へ入れる
 * - 同じ作品をほかのタブでも開いていれば、書いたものを BroadcastChannel で知らせ、写しを合わせる
 * - はじめてセーブしたとき、ブラウザにデータを消さないよう頼む（navigator.storage.persist()）
 */

const DB_NAME = "liminalia";
const DB_STORE = "saves";
/** 書き終わっていないもの（鍵 → 値。消したものは null）。 */
export const JOURNAL = "liminalia-journal";
const CHANNEL = "liminalia-saves";

/** 開いた保存先。KeyValueStore に、書き終わるのを待つ口と書けなかったときの知らせを足したもの。 */
export interface IndexedStore extends KeyValueStore {
  readonly length: number;
  key(index: number): string | null;
  /** 今までに書いたものが IndexedDB に入るまで待つ（書けなかったものは JOURNAL に残る）。 */
  flush(): Promise<void>;
  /** 書けなかったとき（容量が足りないなど）に呼ぶ。 */
  onError: ((error: unknown) => void) | null;
}

/** テストで差し替える、ブラウザの道具。 */
export interface IndexedStoreEnv {
  indexedDB: IDBFactory;
  localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length"> | null;
  /** 裏へ回っているか（裏で書いたものは JOURNAL にも置く）。 */
  hidden?: () => boolean;
  /** 閉じるときに呼ぶものを登録する（pagehide）。 */
  onLeave?: (listener: () => void) => void;
  /** ほかのタブと書いたものを知らせ合う口（BroadcastChannel）。 */
  channel?: { post(message: unknown): void; listen(listener: (message: unknown) => void): void } | null;
  persist?: (() => Promise<unknown>) | null;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB の書き込みが取り消されました"));
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  const r = factory.open(DB_NAME, 1);
  r.onupgradeneeded = () => {
    if (!r.result.objectStoreNames.contains(DB_STORE)) r.result.createObjectStore(DB_STORE);
  };
  return request(r);
}

/**
 * IndexedDB を開き、鍵が prefixes のどれかで始まるもの（作品と、引き継げる作品の分）を読む。前の版の localStorage と、
 * 書き終わらなかったもの（JOURNAL）を入れてから返す。開けなければ null（呼んだ側は localStorage を使う）。
 */
export async function openIndexedStore(prefixes: readonly string[], env: IndexedStoreEnv): Promise<IndexedStore | null> {
  let db: IDBDatabase;
  try {
    db = await openDb(env.indexedDB);
  } catch {
    // IndexedDB を開けなければ null（呼ぶ側が localStorage で続ける）
    return null;
  }
  const map = new Map<string, string>();
  const ours = (k: string) => prefixes.some((p) => k.startsWith(p));
  try {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    for (const prefix of prefixes) {
      const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
      const [keys, values] = await Promise.all([request(store.getAllKeys(range)), request(store.getAll(range))]);
      keys.forEach((k, i) => {
        if (typeof k === "string" && typeof values[i] === "string") map.set(k, values[i]);
      });
    }
  } catch {
    // 読めなければ null（呼ぶ側が localStorage で続ける）
    db.close();
    return null;
  }

  const ls = env.localStorage ?? null;
  // 前の版が localStorage に書いたもの と、書き終わらなかったもの（JOURNAL）を入れる
  const incoming = new Map<string, string | null>();
  const legacy: string[] = [];
  try {
    for (let i = 0; ls && i < ls.length; i++) {
      const k = ls.key(i);
      if (k && ours(k)) legacy.push(k);
    }
    for (const k of legacy) {
      const v = ls!.getItem(k);
      if (v !== null) incoming.set(k, v);
    }
    const journal = JSON.parse(ls?.getItem(JOURNAL) ?? "null") as Record<string, string | null> | null;
    if (journal && typeof journal === "object") for (const [k, v] of Object.entries(journal)) if (ours(k) && (typeof v === "string" || v === null)) incoming.set(k, v);
  } catch {
    // 読めなければ移さない
  }
  if (incoming.size > 0) {
    try {
      const tx = db.transaction(DB_STORE, "readwrite");
      const store = tx.objectStore(DB_STORE);
      for (const [k, v] of incoming) {
        if (v === null) store.delete(k);
        else store.put(v, k);
      }
      await done(tx);
      for (const [k, v] of incoming) {
        if (v === null) map.delete(k);
        else map.set(k, v);
      }
      for (const k of legacy) ls?.removeItem(k);
      dropJournal(ls, ours);
    } catch (e) {
      // 移せなければ localStorage に残しておく（次の起動でもう一度移す）。今回は読んだものを使う
      console.warn("前のセーブを IndexedDB へ移せません", e);
      for (const [k, v] of incoming) {
        if (v === null) map.delete(k);
        else map.set(k, v);
      }
    }
  }

  /** まだ IndexedDB に入っていないもの（鍵 → 値。消したものは null）。 */
  const pending = new Map<string, string | null>();
  /** 書いている途中のもの。 */
  const writing = new Map<string, string | null>();
  let scheduled: Promise<void> | null = null;
  let journaled = false;
  let asked = false;

  const unsaved = () => new Map([...writing, ...pending]);
  /** 書き終わっていないものを JOURNAL に置く（無ければ消す）。 */
  const writeJournal = () => {
    if (!ls) return;
    const rest = unsaved();
    try {
      // ほかの作品の分は残す
      const others = Object.fromEntries(Object.entries((JSON.parse(ls.getItem(JOURNAL) ?? "null") as Record<string, string | null> | null) ?? {}).filter(([k]) => !ours(k)));
      const all = { ...others, ...Object.fromEntries(rest) };
      if (Object.keys(all).length === 0) ls.removeItem(JOURNAL);
      else ls.setItem(JOURNAL, JSON.stringify(all));
      journaled = rest.size > 0;
    } catch {
      // 入りきらなければ諦める（IndexedDB には書いている途中）
    }
  };

  const store: IndexedStore = {
    onError: null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
      queue(k, v);
      if (!asked && k.includes(":slot:")) {
        asked = true;
        // 消されにくくする頼みは任意（断られても保存はできる）
        void env.persist?.()?.catch?.(() => undefined);
      }
    },
    removeItem: (k) => {
      if (!map.has(k)) return;
      map.delete(k);
      queue(k, null);
    },
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    flush: async () => {
      while (scheduled) await scheduled;
    },
  };

  const queue = (k: string, v: string | null) => {
    pending.set(k, v);
    env.channel?.post({ key: k, value: v });
    if (env.hidden?.()) writeJournal();
    scheduled ??= Promise.resolve().then(write);
  };

  /** たまったものを一つの書き込みで入れる。書いている間に足されたものは、終わってからもう一度。 */
  const write = async (): Promise<void> => {
    const batch = new Map(pending);
    pending.clear();
    for (const [k, v] of batch) writing.set(k, v);
    try {
      const tx = db.transaction(DB_STORE, "readwrite");
      const os = tx.objectStore(DB_STORE);
      for (const [k, v] of batch) {
        if (v === null) os.delete(k);
        else os.put(v, k);
      }
      await done(tx);
      for (const [k, v] of batch) if (writing.get(k) === v) writing.delete(k);
    } catch (e) {
      // 書けなかったものは JOURNAL に残し（入れば）、知らせる
      console.warn("セーブを書き込めません", e);
      writeJournal();
      for (const k of batch.keys()) writing.delete(k);
      store.onError?.(e);
    }
    if (journaled) writeJournal();
    if (pending.size > 0) return write();
    scheduled = null;
  };

  env.onLeave?.(() => {
    if (pending.size > 0 || writing.size > 0) writeJournal();
  });
  if (env.channel) {
    // ほかのタブが書いたもの（そちらが IndexedDB に書く）
    env.channel.listen((message) => {
      const m = message as { key?: unknown; value?: unknown } | null;
      if (!m || typeof m.key !== "string" || !ours(m.key)) return;
      if (typeof m.value === "string") map.set(m.key, m.value);
      else if (m.value === null) map.delete(m.key);
    });
  }
  return store;
}

function dropJournal(ls: IndexedStoreEnv["localStorage"], ours: (k: string) => boolean): void {
  if (!ls) return;
  try {
    const journal = JSON.parse(ls.getItem(JOURNAL) ?? "null") as Record<string, string | null> | null;
    if (!journal) return;
    const rest = Object.fromEntries(Object.entries(journal).filter(([k]) => !ours(k)));
    if (Object.keys(rest).length === 0) ls.removeItem(JOURNAL);
    else ls.setItem(JOURNAL, JSON.stringify(rest));
  } catch {
    // 書きかけの控えが読めなければ、控えごと捨てる（IndexedDB の分は残る）
    ls.removeItem(JOURNAL);
  }
}

/** ブラウザの道具で開く（IndexedDB が使えなければ null）。 */
export async function openBrowserIndexedStore(prefixes: readonly string[]): Promise<IndexedStore | null> {
  if (typeof indexedDB === "undefined") return null;
  let ls: Storage | null = null;
  try {
    ls = globalThis.localStorage ?? null;
  } catch {
    // localStorage を使えないブラウザ（設定で止めたとき）は控えなしで続ける
    ls = null;
  }
  let bc: BroadcastChannel | null = null;
  try {
    bc = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  } catch {
    // BroadcastChannel を使えないブラウザでは、ほかのタブへ知らせない
    bc = null;
  }
  const channel = bc ? { post: (m: unknown) => bc.postMessage(m), listen: (fn: (m: unknown) => void) => bc.addEventListener("message", (e) => fn(e.data)) } : null;
  return openIndexedStore(prefixes, {
    indexedDB,
    localStorage: ls,
    hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
    onLeave: (listener) => window.addEventListener("pagehide", listener),
    channel,
    persist: async () => {
      const storage = navigator.storage;
      if (!storage?.persist) return;
      if (await storage.persisted?.()) return;
      await storage.persist();
    },
  });
}
