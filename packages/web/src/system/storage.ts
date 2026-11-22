import type { SaveData, Value } from "@liminalia/runtime";
import type { DesktopWriteResult } from "../plugin.ts";
import type { LogEntry } from "./backlog.ts";
import { ReadSet } from "./read-set.ts";
import { openBrowserIndexedStore, type IndexedStore } from "./idb-store.ts";
import { normalizeSettings, type Settings } from "./settings.ts";

/**
 * 既定のシステム画面が保存するもの。キーは "liminalia:<作品の id>:" で始め、作品ごとに分ける。
 * - slot:<番号> / slot:quick / slot:quick:<番号> / slot:auto:<番号> … セーブ（SlotRecord）。quick（1 番目の枠）と quick:1 からはクイックセーブ、
 *   auto はオートセーブ。どちらも新しいもので古いものを置き換えて回す
 * - system … 全セーブ共通の変数（Runtime.system）
 * - read … 既読のページ（ReadSet）
 * - config … 設定画面の値（Settings）
 * - last-slot … 最後にセーブしたスロット（セーブ画面を開くページを決める）
 * ブラウザ版は IndexedDB（idb-store.ts。起動したときに prepareSaveStore で開く。開けなければ localStorage）、
 * デスクトップ版はファイル、スマホのアプリはアプリのファイル（window.LiminaliaSaves。鍵ごとに一つのファイル）。テストでは KeyValueStore を差し替える。
 *
 * 作品が守る設定（liminalia.json の saves.protect）なら、値は読めない形で書き、合図（チェックサム）が合わないものは読まない
 * （書き換えたセーブ・設定は、無いものとして扱う）。鍵はゲームの中にあるので、手間をかければ破れる。中身を見て書き換えるのを防ぐためのもの。
 */
export interface SlotRecord {
  version: 1;
  save: SaveData;
  /** 保存した日時（ISO 8601）。 */
  date: string;
  /** 一覧に出す文（そのとき表示していたページの頭など）。 */
  title: string;
  /** 一覧に出す舞台の縮小画像（data URL）。撮れなければ無いか空。 */
  thumb?: string;
  /** 保存したときの履歴の末尾（ロードしたら履歴に戻す）。 */
  log?: LogEntry[];
  /** 作品のメタ情報（章・作中の日付など。WebPlugin.slotMeta と saveTo の meta）。 */
  meta?: Record<string, Value>;
  /** 「前の選択肢へ」で戻れる選択肢（古い順。log は log に戻した履歴の何件目で出したか）。 */
  choices?: ChoicePoint[];
  /** 遊ぶ人が付けたメモ。 */
  memo?: string;
  /** 章の名前（一覧に出す。前の版のセーブには無い）。 */
  chapter?: string;
  /** プレイ時間（ミリ秒。前の版のセーブには無い）。 */
  playTime?: number;
  /** 保護（上書き・削除・移動先にできない）。 */
  locked?: boolean;
}

/** 選択肢を出した時点（そのときのセーブ・履歴の件数・台本の位置）。 */
export interface ChoicePoint {
  save: SaveData;
  log: number;
  at: string;
  /** 選んだもの（巻き戻しで戻ってから同じ選択肢に来たとき、固定するか・選び直したかを見る）。 */
  chosen?: number;
}

/** オートセーブの枠（0 からの番号）。 */
export type AutoSlotId = `auto:${number}`;
/** クイックセーブの枠（1 番目は "quick"。前の版の一つだけの枠と同じ名前）。 */
export type QuickSlotId = "quick" | `quick:${number}`;
export type SlotId = QuickSlotId | number | AutoSlotId;

/** クイックセーブの枠か。 */
export function isQuickSlot(slot: SlotId): slot is QuickSlotId {
  return slot === "quick" || (typeof slot === "string" && slot.startsWith("quick:"));
}

/** クイックセーブの枠の並び（count 個。1 番目は "quick"）。 */
export function quickSlotIds(count: number): QuickSlotId[] {
  return ["quick", ...Array.from({ length: Math.max(0, count - 1) }, (_, i) => `quick:${i + 1}` as const)];
}

/** オートセーブの枠か。 */
export function isAutoSlot(slot: SlotId): slot is AutoSlotId {
  return typeof slot === "string" && slot.startsWith("auto:");
}

/** オートセーブの枠の並び（count 個）。 */
export function autoSlotIds(count: number): AutoSlotId[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => `auto:${i}` as const);
}

/** localStorage と同じ形（length と key は、セーブを丸ごと書き出すときに使う）。 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

/** セーブを丸ごと書き出したファイルの形。 */
export interface SaveBackup {
  format: "liminalia-saves";
  version: 1;
  /** 作品の id（違う作品のものは読み込まない）。 */
  project: string;
  /** 書き出した日時（ISO 8601）。 */
  date: string;
  /** 保存しているもの（slot:…・system・read・config・last-slot → 中身の JSON の文字列）。 */
  entries: Record<string, string>;
}

export interface StorageOptions {
  /** 値を読めない形で書き、書き換えたものを読まない（liminalia.json の saves.protect）。 */
  protect?: boolean;
}

export class Storage {
  private readonly store: KeyValueStore | null;
  private readonly protect: boolean;

  constructor(
    private readonly projectId: string,
    store?: KeyValueStore | null,
    options: StorageOptions = {},
  ) {
    this.store = store === undefined ? defaultStore() : store;
    this.protect = options.protect ?? false;
  }

  private key(name: string): string {
    return `liminalia:${this.projectId}:${name}`;
  }

  /** 書く形（守るなら封をする）。 */
  private encode(json: string): string {
    return this.protect ? seal(json, this.projectId) : json;
  }

  /**
   * 読んだ値の JSON。封をしたものは開いて合図を確かめる（合わなければ null）。守る作品では、封をしていないもの
   * （書き換えて入れたもの）も null。守るのをやめた作品は、封をしたものもそのまま読める。
   */
  private decode(raw: string): string | null {
    if (raw.startsWith(SEALED)) return unseal(raw, this.projectId);
    return this.protect ? null : raw;
  }

  read<T>(name: string): T | null {
    try {
      const raw = this.store?.getItem(this.key(name)) ?? null;
      const json = raw === null ? null : this.decode(raw);
      return json === null ? null : (JSON.parse(json) as T);
    } catch (e) {
      // 壊れたものは無いものとして続ける（セーブの欄は空に見える）。何が読めなかったかは開発者ツールに残す
      console.warn(`保存したデータ ${name} を読めません（壊れています）`, e);
      return null;
    }
  }

  write(name: string, value: unknown): boolean {
    if (!this.store) return false;
    try {
      this.store.setItem(this.key(name), this.encode(JSON.stringify(value)));
      return true;
    } catch (e) {
      console.warn(`保存できません: ${name}`, e);
      return false;
    }
  }

  remove(name: string): void {
    try {
      this.store?.removeItem(this.key(name));
    } catch {
      // 消せなくても遊ぶのには困らない
    }
  }

  // ---- セーブ ----

  loadSlot(slot: SlotId): SlotRecord | null {
    const r = this.read<SlotRecord>(`slot:${slot}`);
    return r && r.version === 1 && r.save && typeof r.date === "string" ? r : null;
  }

  /** 書き込む。容量が足りなければ、巻き戻しの記録・選択肢の控え・履歴・縮小画像を諦めて入れ直す。 */
  saveSlot(slot: SlotId, record: SlotRecord): boolean {
    // 容量が足りなければ、巻き戻しの記録（履歴の rewind）・選択肢の控え・履歴・縮小画像の順に諦める
    const attempts: SlotRecord[] = [record];
    if (record.log?.some((e) => e.rewind)) attempts.push({ ...record, log: record.log.map(({ rewind: _, ...e }) => e) });
    const { choices: _, ...lean } = record;
    if (record.choices?.length) attempts.push({ ...lean, ...(attempts.at(-1)!.log ? { log: attempts.at(-1)!.log } : {}) });
    if (record.log?.length) attempts.push({ ...lean, log: [] });
    if (record.thumb) attempts.push({ ...lean, log: [], thumb: "" });
    for (const r of attempts) {
      if (this.write(`slot:${slot}`, r)) {
        if (typeof slot === "number") this.write("last-slot", slot);
        return true;
      }
    }
    return false;
  }

  deleteSlot(slot: SlotId): void {
    this.remove(`slot:${slot}`);
  }

  /** メモと保護を変える（無いスロットなら false）。 */
  updateSlot(slot: SlotId, patch: { memo?: string; locked?: boolean }): boolean {
    const r = this.loadSlot(slot);
    if (!r) return false;
    const next: SlotRecord = { ...r };
    if (patch.memo !== undefined) {
      if (patch.memo === "") delete next.memo;
      else next.memo = patch.memo;
    }
    if (patch.locked !== undefined) {
      if (patch.locked) next.locked = true;
      else delete next.locked;
    }
    return this.write(`slot:${slot}`, next);
  }

  /**
   * スロットを写す（move なら元を消す）。写し先が保護されていれば写さない。
   * 結果は "ok"・"locked"（写し先が保護）・"empty"（元が無い）・"failed"（書けない）。
   */
  copySlot(from: SlotId, to: SlotId, move = false): "ok" | "locked" | "empty" | "failed" {
    const r = this.loadSlot(from);
    if (!r) return "empty";
    if (from === to) return "ok";
    if (this.loadSlot(to)?.locked) return "locked";
    // 写しは保護を外す（移すときは保護ごと移す）
    const copy: SlotRecord = { ...r };
    if (!move) delete copy.locked;
    if (!this.saveSlot(to, copy)) return "failed";
    if (move) this.deleteSlot(from);
    return "ok";
  }

  /** 最後にセーブした番号つきのスロット。 */
  lastSlot(): number | null {
    const n = this.read<number>("last-slot");
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
  }

  /** 0〜count-1 とクイックセーブ（quickCount 個）と autoCount 個のオートセーブのうち、いちばん新しいセーブ。無ければ null。 */
  latestSlot(count: number, autoCount = 0, quickCount = 1): SlotId | null {
    let best: SlotId | null = null;
    let bestTime = -Infinity;
    for (const slot of [...Array.from({ length: count }, (_, i) => i), ...quickSlotIds(quickCount), ...autoSlotIds(autoCount)]) {
      const r = this.loadSlot(slot);
      if (!r) continue;
      const t = Date.parse(r.date) || 0;
      if (best === null || t > bestTime) {
        best = slot;
        bestTime = t;
      }
    }
    return best;
  }

  /**
   * オートセーブを書く（count 個の枠を回す）。いちばん新しいオートセーブと同じ位置なら、その枠に書き直す
   * （裏へ回るのを繰り返すなど、同じ場面で枠を使い潰さないため）。そうでなければ空いている枠か、いちばん古い枠に書く。
   * 書いた枠を返す（枠が無い・書けなければ null）。
   */
  saveAuto(count: number, record: SlotRecord): AutoSlotId | null {
    const ids = autoSlotIds(count);
    if (ids.length === 0) return null;
    const found = ids.map((id) => ({ id, r: this.loadSlot(id) }));
    const time = (r: SlotRecord | null) => (r ? Date.parse(r.date) || 0 : -Infinity);
    const newest = found.reduce((a, b) => (time(b.r) > time(a.r) ? b : a));
    let target: AutoSlotId;
    if (newest.r && samePosition(newest.r.save, record.save)) target = newest.id;
    else target = (found.find((f) => !f.r) ?? found.reduce((a, b) => (time(b.r) < time(a.r) ? b : a))).id;
    return this.saveSlot(target, record) ? target : null;
  }

  /** いちばん新しいオートセーブ（無ければ null）。 */
  latestAuto(count: number): AutoSlotId | null {
    return this.newest(autoSlotIds(count));
  }

  /**
   * クイックセーブを書く（count 個の枠を回す）。空いている枠か、いちばん古い枠に書く（保護した枠は使わない）。
   * 書いた枠を返す（書けなければ null）。
   */
  saveQuick(count: number, record: SlotRecord): QuickSlotId | null {
    const found = quickSlotIds(count).map((id) => ({ id, r: this.loadSlot(id) }));
    const time = (r: SlotRecord | null) => (r ? Date.parse(r.date) || 0 : -Infinity);
    const open = found.filter((f) => !f.r?.locked);
    if (open.length === 0) return null;
    const target = (open.find((f) => !f.r) ?? open.reduce((a, b) => (time(b.r) < time(a.r) ? b : a))).id;
    return this.saveSlot(target, record) ? target : null;
  }

  /** いちばん新しいクイックセーブ（無ければ null）。 */
  latestQuick(count: number): QuickSlotId | null {
    return this.newest(quickSlotIds(count));
  }

  /** 並びのうち、いちばん新しいセーブのある枠。 */
  private newest<T extends SlotId>(ids: readonly T[]): T | null {
    let best: T | null = null;
    let bestTime = -Infinity;
    for (const id of ids) {
      const r = this.loadSlot(id);
      const t = r ? Date.parse(r.date) || 0 : -Infinity;
      if (r && (best === null || t > bestTime)) {
        best = id;
        bestTime = t;
      }
    }
    return best;
  }

  // ---- 丸ごと書き出す・読み込む（バックアップと、別のコンピューターへの移し替え） ----

  /** この作品が保存しているものすべて。 */
  exportAll(): SaveBackup {
    const entries: Record<string, string> = {};
    const prefix = this.key("");
    const store = this.store;
    if (store?.key && typeof store.length === "number") {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        const v = k?.startsWith(prefix) ? store.getItem(k) : null;
        if (k && v !== null) entries[k.slice(prefix.length)] = v;
      }
    }
    return { format: "liminalia-saves", version: 1, project: this.projectId, date: new Date().toISOString(), entries };
  }

  /** 同じ保存先（ブラウザ）にある別の作品（体験版など）の保存を、書き出したものの形で（無ければ null）。 */
  foreign(projectId: string): SaveBackup | null {
    const entries: Record<string, string> = {};
    const prefix = `liminalia:${projectId}:`;
    const store = this.store;
    if (store?.key && typeof store.length === "number") {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        const v = k?.startsWith(prefix) ? store.getItem(k) : null;
        if (k && v !== null) entries[k.slice(prefix.length)] = v;
      }
    }
    return Object.keys(entries).some((k) => k.startsWith("slot:")) ? { format: "liminalia-saves", version: 1, project: projectId, date: new Date().toISOString(), entries } : null;
  }

  /**
   * 書き出したものを読み込む（今のセーブ・既読・設定は置き換わる）。形が違う・別の作品のものなら理由を返して何もしない。
   * carryFrom（引き継げる作品の id。体験版など）の作品のものは、その作品の封を開いてこの作品の形で書く。読み込めたら null。
   */
  importAll(data: unknown, carryFrom: readonly string[] = []): string | null {
    const b = data as Partial<SaveBackup> | null;
    if (!b || b.format !== "liminalia-saves" || b.version !== 1 || !b.entries || typeof b.entries !== "object") return "invalid";
    const from = b.project ?? "";
    if (from !== this.projectId && !carryFrom.includes(from)) return "other-project";
    const entries: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.entries)) {
      if (typeof v !== "string") return "invalid";
      try {
        // 別の作品のものは、その作品の id で封を開き、この作品の形に書き直す
        const json = from === this.projectId ? this.decode(v) : v.startsWith(SEALED) ? unseal(v, from) : v;
        if (json === null) return "invalid";
        JSON.parse(json);
        entries[k] = from === this.projectId ? v : this.encode(json);
      } catch {
        // 読めないものが一つでもあれば、取り込みを断る（呼ぶ側が知らせる）
        return "invalid";
      }
    }
    b.entries = entries;
    const before = this.exportAll();
    for (const k of Object.keys(before.entries)) this.remove(k);
    for (const [k, v] of Object.entries(b.entries)) {
      try {
        this.store?.setItem(this.key(k), v);
      } catch {
        // 入りきらなければ元に戻す
        for (const k2 of Object.keys(b.entries)) this.remove(k2);
        for (const [k2, v2] of Object.entries(before.entries)) this.store?.setItem(this.key(k2), v2);
        return "full";
      }
    }
    return null;
  }

  // ---- 全セーブ共通 ----

  loadSystemVariables(): Record<string, Value> {
    const v = this.read<Record<string, Value>>("system");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  }

  saveSystemVariables(system: Record<string, Value>): void {
    this.write("system", system);
  }

  loadReadSet(): ReadSet {
    return ReadSet.from(this.read("read"));
  }

  saveReadSet(set: ReadSet): void {
    if (this.write("read", set)) set.dirty = false;
  }

  /** 設定画面の値。保存されていなければ base（作品の初期の設定）。 */
  loadSettings(base?: Settings): Settings {
    return normalizeSettings(this.read("config"), base);
  }

  saveSettings(settings: Settings): void {
    this.write("config", settings);
  }
}

/** 二つのセーブが同じ位置（同じ命令）から再開するか。 */
function samePosition(a: SaveData, b: SaveData): boolean {
  return a.position.unit === b.position.unit && a.position.index === b.position.index && a.callStack.length === b.callStack.length;
}

/** 封をした値の頭。続けて合図・":"・中身（base64）。 */
const SEALED = "lm1:";

/** 値に封をする（中身を作品の id から作る鍵で混ぜて base64 にし、元の JSON の合図を付ける）。 */
export function seal(json: string, projectId: string): string {
  const bytes = mix(new TextEncoder().encode(json), projectId);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `${SEALED}${checksum(json, projectId)}:${btoa(bin)}`;
}

/** 封を開く。形が違うか合図が合わなければ null。 */
export function unseal(raw: string, projectId: string): string | null {
  const rest = raw.slice(SEALED.length);
  const at = rest.indexOf(":");
  if (at < 0) return null;
  try {
    const bin = atob(rest.slice(at + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const json = new TextDecoder().decode(mix(bytes, projectId));
    return checksum(json, projectId) === rest.slice(0, at) ? json : null;
  } catch {
    // 開けない封は null（守る作品では書き換えたものとして読まない）
    return null;
  }
}

/** 作品の id から作る鍵の列で混ぜる（同じことをもう一度すると戻る）。 */
function mix(bytes: Uint8Array, projectId: string): Uint8Array {
  const out = new Uint8Array(bytes.length);
  // xorshift32。種は作品の id の合図
  let x = Number.parseInt(checksum(projectId, "liminalia").slice(0, 8), 36) >>> 0 || 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = bytes[i]! ^ (x & 0xff);
  }
  return out;
}

/** 文字列の合図（cyrb53。暗号ではない）。 */
function checksum(text: string, salt: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (const s of [salt, "\u0000", text]) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * スマホのアプリが置くセーブの置き場所（アプリのファイル。packages/cli の mobile/android.ts・ios.ts）。load は全部を JSON で返す。
 * set は書けなければ false（Android。iOS は後で書くので返さない）。previous は前の版のアプリが使っていた置き場所（iOS は "indexeddb"）。
 */
interface NativeSaves {
  load(): string;
  set(key: string, value: string): boolean | void;
  remove(key: string): void;
  previous?: string;
}

/** 前の版の置き場所から移し終えた印（アプリの置き場所の鍵。作品の鍵 "liminalia:…" とは別）。 */
const CARRIED = "liminalia-store:carried";

function nativeSaves(): NativeSaves | null {
  return typeof window === "undefined" ? null : ((window as unknown as { LiminaliaSaves?: NativeSaves }).LiminaliaSaves ?? null);
}

/** 起動したときに開いた IndexedDB の保存先（prepareSaveStore）。 */
let indexed: IndexedStore | null = null;

/**
 * 制作画面の「ゲームの画面」の見本（開発サーバーだけ。screen-preview/run.ts）が置く、作り物の記憶の場所。
 * 置いたら、遊ぶ人のセーブ、既読、設定の置き場所（IndexedDB、localStorage、アプリのファイル）を開かず、読まず、書かない。
 */
let memory: KeyValueStore | null = null;

/** 作り物の記憶の場所に替える（prepareSaveStore と、システム画面を作るより前に呼ぶ）。 */
export function useMemorySaveStore(store: KeyValueStore): void {
  memory = store;
}

/** デスクトップ版・Android 版のアプリの保存先があるか（あれば IndexedDB は開かない）。 */
function hasNativeStore(): boolean {
  if (typeof window === "undefined") return false;
  return !!window.liminaliaDesktop?.storage || !!(window as unknown as { LiminaliaSaves?: NativeSaves }).LiminaliaSaves;
}

/**
 * ブラウザ版・iOS 版のアプリのセーブの置き場所（IndexedDB）を開き、作品（と引き継げる作品）の分を読んでおく。
 * Storage を作る前に一度呼ぶ（プレイヤーの起動の main.ts）。デスクトップ版・Android 版のアプリと、IndexedDB が使えない環境では何もしない
 * （localStorage を使う）。
 */
export async function prepareSaveStore(projectIds: readonly string[]): Promise<void> {
  if (indexed || memory) return;
  if (hasNativeStore()) return carryIndexedToNative(projectIds);
  try {
    indexed = await openBrowserIndexedStore(projectIds.map((id) => `liminalia:${id}:`));
  } catch (e) {
    console.warn("IndexedDB を開けません。localStorage に保存します", e);
    indexed = null;
  }
}

/**
 * iOS のアプリが置き場所をアプリのファイルに替えた最初の起動で、前の版が WKWebView の IndexedDB に書いたもの（作品と引き継げる作品の分）を移す。
 * 移し終えたら印を置き、二度は移さない（IndexedDB の中身は消さない）。開けなければ、次の起動でもう一度試す。
 */
async function carryIndexedToNative(projectIds: readonly string[]): Promise<void> {
  const native = nativeSaves();
  if (native?.previous !== "indexeddb") return;
  let current: Record<string, string>;
  try {
    current = JSON.parse(native.load()) as Record<string, string>;
  } catch {
    // 読めなければ次の起動でもう一度移す
    return;
  }
  if (current[CARRIED] !== undefined) return;
  try {
    const old = await openBrowserIndexedStore(projectIds.map((id) => `liminalia:${id}:`));
    for (let i = 0; old && i < old.length; i++) {
      const k = old.key(i);
      const v = k === null ? null : old.getItem(k);
      if (k && v !== null && current[k] === undefined) native.set(k, v);
    }
  } catch (e) {
    console.warn("以前のバージョンのセーブ（IndexedDB）を読めません。次の起動でもう一度移行します", e);
    return;
  }
  native.set(CARRIED, new Date().toISOString());
}

/** 書いたセーブが置き場所に入るまで待つ（IndexedDB とデスクトップ版のファイルのときだけ待つ。裏へ回る前・閉じる前）。 */
export function flushSaveStore(): Promise<void> {
  if (!indexed && fileWrites.size === 0) return Promise.resolve();
  return Promise.all([indexed?.flush(), ...fileWrites]).then(() => undefined);
}

/**
 * 書けなかったとき（IndexedDB の容量が足りない、デスクトップ版でファイルを書けないなど。localStorage は書いたときに分かる）に
 * 呼ぶものを決める。
 */
export function onSaveStoreError(listener: ((error: unknown) => void) | null): void {
  if (indexed) indexed.onError = listener;
  fileError = listener;
}

/** デスクトップ版のファイルの書き込みのうち、済んでいないもの。 */
const fileWrites = new Set<Promise<void>>();
/** デスクトップ版のファイルを書けなかったときに呼ぶもの（onSaveStoreError）。 */
let fileError: ((error: unknown) => void) | null = null;
/** 最後に書けなかったと知らせた時刻（続けて書けないとき、知らせを重ねない）。 */
let fileErrorAt = -Infinity;

/** デスクトップ版の殻が返した書き込みの結果を待ち、書けなければ知らせる（前の版の殻は何も返さない）。 */
function trackFileWrite(result: unknown): void {
  if (!result || typeof (result as PromiseLike<unknown>).then !== "function") return;
  const fail = (error: unknown) => {
    const now = Date.now();
    if (now - fileErrorAt < 2000) return;
    fileErrorAt = now;
    console.warn("セーブのファイルを書けません", error);
    fileError?.(error);
  };
  const p: Promise<void> = Promise.resolve(result as PromiseLike<DesktopWriteResult | void>)
    .then(
      (r) => {
        if (r && r.ok === false) fail(r);
      },
      fail,
    )
    .finally(() => fileWrites.delete(p));
  fileWrites.add(p);
}

/**
 * 今のセーブの置き場所を、撮影・自動確認と開発の道具から覗く口（window.__liminalia.saves）。鍵は "liminalia:<作品の id>:…" のまま。
 * 置き場所が無ければ null。
 */
export function saveStoreTools(): { entries(prefix?: string): Record<string, string>; set(key: string, value: string): void; remove(key: string): void; clear(prefix?: string): void } | null {
  const store = defaultStore();
  if (!store) return null;
  const keys = (prefix: string) => {
    const out: string[] = [];
    for (let i = 0; store.key && i < (store.length ?? 0); i++) {
      const k = store.key(i);
      if (k?.startsWith(prefix)) out.push(k);
    }
    return out;
  };
  return {
    entries: (prefix = "liminalia:") => Object.fromEntries(keys(prefix).flatMap((k) => (store.getItem(k) === null ? [] : [[k, store.getItem(k)!]]))),
    set: (k, v) => store.setItem(k, v),
    remove: (k) => store.removeItem(k),
    clear: (prefix = "liminalia:") => {
      for (const k of keys(prefix)) store.removeItem(k);
    },
  };
}

function defaultStore(): KeyValueStore | null {
  if (memory) return memory;
  if (indexed && !hasNativeStore()) return indexed;
  const native = nativeSaves();
  const files =
    typeof window === "undefined"
      ? undefined
      : (window.liminaliaDesktop?.storage ??
        (native
          ? {
              load: () => {
                try {
                  return JSON.parse(native.load()) as Record<string, string>;
                } catch (e) {
                  // アプリのファイルのセーブが読めなければ、空から始める（ファイルは書き換えるまで残る）。開発者ツールに残す
                  console.warn("アプリのファイルのセーブを読めません（壊れています）", e);
                  return {};
                }
              },
              set: (k: string, v: string) => native.set(k, v),
              remove: (k: string) => native.remove(k),
            }
          : undefined));
  if (files) return fileStore(files);
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // 使えない環境（サイトのデータを禁止したブラウザなど）では保存しない
    return null;
  }
}

/** 一つの保存先として使う、ファイルのセーブ（デスクトップ版）。起動したときに全部読み、書くたびにファイルへ書く。 */
let shared: KeyValueStore | null = null;

/**
 * デスクトップ版のセーブ（保存先の saves/ のファイル。Steam の Auto-Cloud でそのまま同期できる）と、スマホのアプリのセーブ（アプリのファイル）。
 * はじめて使うとき、前の版が localStorage に書いたものを移す。置き場所が書けなかったと答えたら（false）、投げる（Storage.write が「セーブできませんでした」にする）。
 */
function fileStore(files: { load(): Record<string, string>; set(key: string, value: string): boolean | void | PromiseLike<unknown>; remove(key: string): void | PromiseLike<unknown> }): KeyValueStore {
  if (shared) return shared;
  const map = new Map(Object.entries(files.load()).filter(([k]) => k !== CARRIED));
  if (map.size === 0) {
    try {
      const ls = globalThis.localStorage;
      for (let i = 0; ls && i < ls.length; i++) {
        const k = ls.key(i);
        const v = k?.startsWith("liminalia:") ? ls.getItem(k) : null;
        if (k && v !== null) {
          map.set(k, v);
          trackFileWrite(files.set(k, v));
        }
      }
    } catch {
      // 前の版の保存が読めなくても、新しく始める
    }
  }
  const keys = () => [...map.keys()];
  shared = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      // スマホのアプリは書けなければ false を返す。デスクトップ版は書き終わりを待つ Promise を返す（失敗は trackFileWrite が知らせる）
      const written = files.set(k, v);
      if (written === false) throw new Error(`保存先に書けません: ${k}`);
      map.set(k, v);
      trackFileWrite(written);
    },
    removeItem: (k) => {
      map.delete(k);
      trackFileWrite(files.remove(k));
    },
    get length() {
      return map.size;
    },
    key: (i) => keys()[i] ?? null,
  };
  return shared;
}
