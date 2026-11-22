import type { StudioContext } from "../plugin.ts";
import { PS } from "./strings.ts";

/**
 * 作品のデータ（data/*.json）を一つの文書として編集する部品（制作画面のプラグインの画面が使う）。
 * - 変えたら少し待って自動で保存する（flush ですぐ書く。画面の flush から呼ぶ）
 * - ほかで書き換えられていたら（ほかのエディタ・AI・git）、読んだときの中身を基に三方向で重ねて書き直す
 *   （同じ項目を両方で変えたら、こちらの値を残す）。保存待ちが無いあいだにほかで変わったら、読み直す
 * - ⌘Z・⇧⌘Z（Ctrl+Z・Ctrl+Y）で戻す・やり直す（bindKeys で受ける要素を決める）
 */
export interface DataDocumentOptions<T> {
  /** ファイルが無いとき・読めないときの値。 */
  fallback: T;
  /** 変えてから保存するまでの間（ミリ秒。既定 800）。 */
  delay?: number;
  /** 書くときの JSON の字下げ（既定 2）。 */
  indent?: number;
  /** 戻す履歴の数（既定 100）。 */
  history?: number;
}

/** 値が変わった理由。local は update・set、remote はほかで変わったのを読み直した・重ねた、undo・redo は履歴、load ははじめに読んだとき。 */
export type DataChangeSource = "local" | "remote" | "undo" | "redo" | "load";

export interface DataDocument<T> {
  /** 今の値（読むだけ。変えるのは update・set）。 */
  readonly value: T;
  /** はじめに読み終えたら解決する。 */
  readonly ready: Promise<void>;
  /** 保存待ちの変更があるか。 */
  readonly dirty: boolean;
  /** 最後に書けなかった理由（書けたら null）。 */
  readonly error: string | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** 値を変える（fn は写しを受け取り、書き換えるか新しい値を返す）。戻す履歴に積み、自動で保存する。 */
  update(fn: (draft: T) => T | void): void;
  set(value: T): void;
  undo(): boolean;
  redo(): boolean;
  /** 保存待ちをすぐ書く。書けなければ理由の文字列で拒否する（画面の flush からそのまま返せる）。 */
  flush(): Promise<void>;
  /** ファイルから読み直す（保存待ちは捨てる）。 */
  reload(): Promise<void>;
  /** 値が変わったら呼ぶ。返す関数で外す。 */
  onChange(listener: (value: T, source: DataChangeSource) => void): () => void;
  /** el の中にフォーカスがあるとき、⌘Z・⇧⌘Z・⌘Y で戻す・やり直す（入力欄の中の文字の取り消しはそのまま）。返す関数で外す。 */
  bindKeys(el: HTMLElement): () => void;
  /** 見張りと保存の待ちを止める（保存待ちは書かない。先に flush する）。 */
  dispose(): void;
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 三方向で重ねる。base は読んだときの値、mine はこちらの値、theirs はほかで書かれた値。
 * 片方だけが変えた項目はその値、両方が変えたオブジェクトは項目ごとに重ね、それ以外で両方が変えたらこちらの値。
 */
export function mergeJson(base: unknown, mine: unknown, theirs: unknown): unknown {
  if (same(mine, base)) return clone(theirs);
  if (same(theirs, base) || same(mine, theirs)) return clone(mine);
  if (isObject(base) && isObject(mine) && isObject(theirs)) {
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
      const inMine = key in mine;
      const inTheirs = key in theirs;
      const inBase = key in base;
      if (inMine && inTheirs) out[key] = mergeJson(base[key], mine[key], theirs[key]);
      else if (inMine) {
        // ほかで消したもの: こちらが変えていなければ消す
        if (!(inBase && same(mine[key], base[key]))) out[key] = clone(mine[key]);
      } else if (inTheirs) {
        // こちらで消したもの: ほかが変えていなければ消す
        if (!(inBase && same(theirs[key], base[key]))) out[key] = clone(theirs[key]);
      }
    }
    return out;
  }
  return clone(mine);
}

export function dataDocument<T>(ctx: Pick<StudioContext, "readData" | "writeData" | "onDataChanged">, name: string, options: DataDocumentOptions<T>): DataDocument<T> {
  const delay = options.delay ?? 800;
  const indent = options.indent ?? 2;
  const limit = options.history ?? 100;
  let value = clone(options.fallback);
  /** 最後に読んだ・書いた中身と、その hash。 */
  let base: T = clone(options.fallback);
  let hash: string | null = null;
  let dirty = false;
  let error: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> | null = null;
  let disposed = false;
  const past: T[] = [];
  const future: T[] = [];
  const listeners = new Set<(value: T, source: DataChangeSource) => void>();
  const emit = (source: DataChangeSource) => {
    for (const l of [...listeners]) {
      try {
        l(value, source);
      } catch (e) {
        console.warn(e);
      }
    }
  };
  const parse = (text: string): T => {
    try {
      return JSON.parse(text) as T;
    } catch {
      return clone(options.fallback);
    }
  };

  const load = async (source: DataChangeSource) => {
    const read = await ctx.readData(name);
    if (disposed) return;
    hash = read?.hash ?? null;
    base = read ? parse(read.text) : clone(options.fallback);
    value = clone(base);
    dirty = false;
    error = null;
    emit(source);
  };
  const ready = load("load");

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save().catch(() => undefined), delay);
  };

  /** 書く。ほかで書き換えられていたら、重ねてもう一度書く。 */
  const save = async (): Promise<void> => {
    clearTimeout(timer);
    if (saving) await saving.catch(() => undefined);
    if (!dirty || disposed) return;
    const job = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const mine = clone(value);
        const r = await ctx.writeData(name, `${JSON.stringify(mine, null, indent)}\n`, hash);
        if (r.ok) {
          hash = r.hash;
          base = mine;
          // 書いているあいだに変えていなければ、保存済み
          dirty = !same(value, mine);
          error = null;
          if (dirty) schedule();
          return;
        }
        // ほかで書き換えられていた: 読んだときの中身を基に重ねる
        const theirs = parse(r.current.text);
        const merged = mergeJson(base, value, theirs) as T;
        base = theirs;
        hash = r.current.hash;
        if (!same(merged, value)) {
          value = merged;
          emit("remote");
        }
      }
      error = PS.dataConflict(name);
      throw new Error(error);
    })();
    saving = job;
    try {
      await job;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      throw error;
    } finally {
      if (saving === job) saving = null;
    }
  };

  const change = (next: T, source: DataChangeSource) => {
    if (same(next, value)) return;
    value = next;
    dirty = true;
    emit(source);
    schedule();
  };

  const off = ctx.onDataChanged((changed) => {
    if (disposed || (changed !== name && changed !== `${name}.json` && `${changed}.json` !== name)) return;
    void (async () => {
      await ready;
      if (saving) await saving.catch(() => undefined);
      const read = await ctx.readData(name);
      if (!read || read.hash === hash || disposed) return;
      const theirs = parse(read.text);
      if (!dirty) {
        hash = read.hash;
        base = theirs;
        value = clone(theirs);
        emit("remote");
        return;
      }
      const merged = mergeJson(base, value, theirs) as T;
      base = theirs;
      hash = read.hash;
      value = merged;
      emit("remote");
      schedule();
    })();
  });

  return {
    get value() {
      return value;
    },
    ready,
    get dirty() {
      return dirty;
    },
    get error() {
      return error;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    update(fn) {
      const draft = clone(value);
      const next = fn(draft);
      const result = next === undefined ? draft : next;
      if (same(result, value)) return;
      past.push(clone(value));
      while (past.length > limit) past.shift();
      future.length = 0;
      change(result, "local");
    },
    set(next) {
      this.update(() => clone(next));
    },
    undo() {
      const prev = past.pop();
      if (prev === undefined) return false;
      future.push(clone(value));
      change(prev, "undo");
      return true;
    },
    redo() {
      const next = future.pop();
      if (next === undefined) return false;
      past.push(clone(value));
      change(next, "redo");
      return true;
    },
    flush: () => save(),
    async reload() {
      clearTimeout(timer);
      past.length = 0;
      future.length = 0;
      await load("remote");
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    bindKeys(el) {
      const onKey = (e: KeyboardEvent) => {
        if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
        const target = e.target as HTMLElement | null;
        // 入力欄の中の文字の取り消しは、ブラウザに任せる
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
        const key = e.key.toLowerCase();
        const done = key === "z" ? (e.shiftKey ? this.redo() : this.undo()) : key === "y" ? this.redo() : null;
        if (done === null) return;
        e.preventDefault();
        e.stopPropagation();
      };
      el.addEventListener("keydown", onKey);
      return () => el.removeEventListener("keydown", onKey);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      off();
      listeners.clear();
    },
  };
}
