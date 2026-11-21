import type { Value } from "@liminalia/runtime";

/**
 * 型の付いたプラグインの状態（セーブに入る stage.extra の一つの鍵）。命令の apply・run と、描画側の renderers・restorers の両方から同じ形で読み書きする。
 * ```ts
 * interface Stamps { list: { image: string; x: number }[] }
 * export const stamps = defineState<Stamps>("stamp.list", () => ({ list: [] }));
 * // 命令: apply(args, extra) { stamps.update(extra, (s) => { s.list.push({ image: String(args.image), x: Number(args.x) }); }); }
 * // 描画: restorers: [(ctx, stage) => draw(stamps.read(stage.extra))]
 * ```
 * 値は JSON にできる素の値だけにする（関数・Map・Date・undefined は入れない）。鍵はプラグインの名前を頭に付けて、ほかと重ならないようにする。
 * `as unknown as Value` と書かずに済むように、読み書きの型をここで合わせる（中身の形までは確かめない。古いセーブの形を直すなら read の後で直す）。
 */
export interface PluginState<T> {
  /** stage.extra の鍵。 */
  readonly key: string;
  /** 今の値（無ければ undefined）。 */
  get(extra: Readonly<Record<string, Value>>): T | undefined;
  /** 今の値（無ければ初めの値。初めの値を渡していなければ undefined）。返したものを書き換えても状態は変わらない（update で書く）。 */
  read(extra: Readonly<Record<string, Value>>): T;
  /** 値を入れる（写しを入れる）。 */
  set(extra: Record<string, Value>, value: T): void;
  /** 今の値（無ければ初めの値）の写しを change で書き換えて入れ、入れた値を返す。change が値を返せばそれを入れる。 */
  update(extra: Record<string, Value>, change: (value: T) => T | void): T;
  /** 鍵ごと消す（空になったら消すとセーブが小さくなる）。 */
  clear(extra: Record<string, Value>): void;
}

/** 型の付いたプラグインの状態を作る。initial は値が無いときの初めの値（呼ぶたびに新しく作る）。 */
export function defineState<T>(key: string, initial?: () => T): PluginState<T> {
  const copy = (v: T): T => (v === undefined || v === null || typeof v !== "object" ? v : (structuredClone(v) as T));
  const fresh = (): T => (initial ? initial() : (undefined as T));
  return {
    key,
    get: (extra) => (Object.hasOwn(extra, key) ? (extra[key] as unknown as T) : undefined),
    read: (extra) => (Object.hasOwn(extra, key) ? copy(extra[key] as unknown as T) : fresh()),
    set: (extra, value) => {
      if (value === undefined) delete extra[key];
      else extra[key] = copy(value) as unknown as Value;
    },
    update: (extra, change) => {
      const current = Object.hasOwn(extra, key) ? copy(extra[key] as unknown as T) : fresh();
      const result = change(current);
      const next = (result === undefined ? current : result) as T;
      if (next === undefined) delete extra[key];
      else extra[key] = next as unknown as Value;
      return next;
    },
    clear: (extra) => {
      delete extra[key];
    },
  };
}
