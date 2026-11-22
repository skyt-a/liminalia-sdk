/**
 * 実装へつなぐ口。sdk は約束（型と軽い関数）だけを持ち、エンジンの実装が要るもの（描画の部品、制作画面の部品など）は、
 * lim と Liminalia Studio の中の部品が読み込まれたときに provide で登録した実装を、呼ばれたときに呼ぶ。
 * 作品に別の版の sdk が入っていても、動くときは必ず lim か Liminalia Studio の実装が使われる（同じ部品が二つ動かない）。
 * 登録は globalThis の Symbol.for("liminalia.sdk.host") に置くので、sdk の写しがいくつあっても同じ表を見る。
 */
const KEY = Symbol.for("liminalia.sdk.host");

type Part = Record<string, unknown>;

function table(): Record<string, Part> {
  const g = globalThis as unknown as Record<symbol, Record<string, Part> | undefined>;
  g[KEY] ??= {};
  return g[KEY];
}

/** エンジンの部品が、自分の実装を登録する（lim と Liminalia Studio の中の部品が呼ぶ。プラグインは呼ばない）。 */
export function provide(part: string, impl: Part): void {
  table()[part] = Object.assign(table()[part] ?? {}, impl);
}

/** 登録された実装（無ければ、どこで使えるかを添えて投げる）。 */
export function hosted<T>(part: string, name: string): T {
  const value = table()[part]?.[name];
  if (value === undefined) {
    throw new Error(
      `@liminalia/sdk の ${name}（${part}）は、lim か Liminalia Studio の中で動かしたときに使えます。テストでは先に @liminalia/cli/testing を読み込みます` +
        ` / ${name} (${part}) from @liminalia/sdk works when run inside lim or Liminalia Studio. In tests, import @liminalia/cli/testing first`,
    );
  }
  return value as T;
}

/** 実装の関数を呼ぶ口。 */
export function forwardFunction<F extends (...args: never[]) => unknown>(part: string, name: string): F {
  return ((...args: Parameters<F>) => hosted<(...a: Parameters<F>) => ReturnType<F>>(part, name)(...args)) as unknown as F;
}

/** 実装のクラスを使う口（new も、継承も、instanceof も実装のクラスに向く）。 */
export function forwardClass<C extends abstract new (...args: never[]) => unknown>(part: string, name: string): C {
  const real = () => hosted<new (...args: unknown[]) => unknown>(part, name);
  // 中身は使わない（Proxy の的。new と prototype は実装のクラスに向ける）
  const stand = function () {
    // 呼ばれない
  } as unknown as C;
  const proxy: C = new Proxy(stand, {
    // new StudioServerError(…) は実装のクラスで作る。継承したクラスからの new は、そのクラスの形のまま実装の土台で作る
    construct: (_target, args, newTarget) => Reflect.construct(real(), args, newTarget === proxy ? real() : newTarget) as object,
    get: (_target, key) => (key === "prototype" ? real().prototype : Reflect.get(real(), key)),
    getPrototypeOf: () => Reflect.getPrototypeOf(real()),
  });
  return proxy;
}

/** 実装の値（オブジェクトや並び）を見せる口。読むたびに実装の値を見る（作品の設定で中身が変わる値もそのまま見える）。 */
export function forwardValue<T extends object>(part: string, name: string, shape: "object" | "array" = "object"): T {
  const real = () => hosted<T>(part, name) as unknown as object;
  return new Proxy((shape === "array" ? [] : {}) as T, {
    get: (_target, key) => {
      const v = Reflect.get(real(), key);
      return typeof v === "function" ? v.bind(real()) : v;
    },
    has: (_target, key) => Reflect.has(real(), key),
    ownKeys: () => Reflect.ownKeys(real()),
    getOwnPropertyDescriptor: (_target, key) => {
      const d = Reflect.getOwnPropertyDescriptor(real(), key);
      return d ? { ...d, configurable: true } : undefined;
    },
  });
}
