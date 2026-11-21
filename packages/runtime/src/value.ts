import { arityText, FORBIDDEN_PROPERTIES, FUNCTION_ARITY, functionArity, type BinaryOp, type Expr } from "@liminalia/lang";

/** 実行時の値。セーブデータにそのまま入る（JSON にできるものだけ）。 */
export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
export type Scope = Record<string, Value>;

export class EvalError extends Error {}

export interface EvalEnv {
  /** game / system / temp と局所変数。 */
  lookup(name: string): Value;
  random(): number;
  /**
   * 実行器が答える関数（@liminalia/lang の STORY_FUNCTIONS: visits・read・chosen・lang・platform・app・replaying・chapter・endings）。
   * 引数の数と型は確かめてから渡す。無ければ、まだ何も無いときの値（0・false・""・"pc"）。
   */
  story?(name: string, args: Value[]): Value;
  /**
   * @function で作った式の関数を探す（無ければ undefined）。file を渡せばそのファイルから（関数の中から呼ぶ関数は、書いたファイルから探す）。
   * 組み込みの関数と同じ名前は呼ばない（検査がエラーにする）。
   */
  fn?(name: string, file?: string): { file: string; params: readonly string[]; body: Expr } | undefined;
  /** @function の呼び出しの深さ（実行器は書かない。中で数える）。 */
  depth?: number;
}

/** @function の呼び出しの深さの上限（自分を呼ぶ関数が終わらないとき）。 */
export const MAX_FUNCTION_DEPTH = 200;

/**
 * 式を評価する。暗黙の型変換はしない。例外は + の文字列連結（片方が文字列なら文字列にする）だけ。
 * 未設定の変数や存在しないメンバーは null になる。__proto__、constructor、prototype のメンバーと添字も null
 * （オブジェクトのプロトタイプを読ませない。代入は実行器がエラーにする）。
 */
export function evaluate(expr: Expr, env: EvalEnv): Value {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "array":
      return expr.items.map((e) => evaluate(e, env));
    case "object": {
      const o: { [key: string]: Value } = {};
      // __proto__ などのキーは検査がエラーにする。ここでも入れない（プロトタイプを書き換えさせない）
      for (const e of expr.entries) if (!FORBIDDEN_PROPERTIES.has(e.key)) o[e.key] = evaluate(e.value, env);
      return o;
    }
    case "name":
      return env.lookup(expr.name);
    case "member": {
      const o = evaluate(expr.object, env);
      if (FORBIDDEN_PROPERTIES.has(expr.property)) return null;
      if (o !== null && typeof o === "object" && !Array.isArray(o)) return own(o, expr.property);
      if (Array.isArray(o) && expr.property === "length") return o.length;
      return null;
    }
    case "index": {
      const o = evaluate(expr.object, env);
      const k = evaluate(expr.index, env);
      if (Array.isArray(o) && typeof k === "number") return o[k] ?? null;
      if (o !== null && typeof o === "object" && !Array.isArray(o) && typeof k === "string") return FORBIDDEN_PROPERTIES.has(k) ? null : own(o, k);
      return null;
    }
    case "call":
      return call(expr.callee, expr.args.map((a) => evaluate(a, env)), env);
    case "unary": {
      const v = evaluate(expr.operand, env);
      if (expr.op === "!") return !truthy(v);
      if (typeof v !== "number") throw new EvalError(`- は数値にだけ使えます（${describe(v)}）`);
      return -v;
    }
    case "binary":
      return binary(expr.op, expr.left, expr.right, env);
    case "conditional":
      return truthy(evaluate(expr.test, env)) ? evaluate(expr.then, env) : evaluate(expr.otherwise, env);
  }
}

/** オブジェクトが自分で持つ値（継承したもの（toString など）は読まない）。無ければ null。 */
function own(o: { [key: string]: Value }, key: string): Value {
  return Object.hasOwn(o, key) ? (o[key] ?? null) : null;
}

/** 偽になるのは false・null・0・"" だけ。 */
export function truthy(v: Value): boolean {
  return !(v === false || v === null || v === 0 || v === "");
}

export function equals(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equals(a[i] ?? null, b[i] ?? null)) return false;
    }
    return true;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && equals(a[k]!, b[k]!));
  }
  return false;
}

export function display(v: Value): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export function checkedDivision(a: number, b: number, op: "/" | "%"): number {
  if (b === 0) throw new EvalError(`0 で${op === "/" ? "割る" : "割った余りを求める"}ことはできません（${describe(a)} ${op} 0）`);
  return op === "/" ? a / b : a % b;
}

function binary(op: BinaryOp, l: Expr, r: Expr, env: EvalEnv): Value {
  if (op === "&&") {
    const a = evaluate(l, env);
    return truthy(a) ? evaluate(r, env) : a;
  }
  if (op === "||") {
    const a = evaluate(l, env);
    return truthy(a) ? a : evaluate(r, env);
  }
  const a = evaluate(l, env);
  const b = evaluate(r, env);
  switch (op) {
    case "==":
      return equals(a, b);
    case "!=":
      return !equals(a, b);
    case "+":
      if (typeof a === "number" && typeof b === "number") return a + b;
      if (typeof a === "string" || typeof b === "string") return display(a) + display(b);
      throw new EvalError(`+ は数値どうしか文字列にだけ使えます（${describe(a)} + ${describe(b)}）`);
    case "-":
    case "*":
    case "/":
    case "%": {
      if (typeof a !== "number" || typeof b !== "number") throw new EvalError(`${op} は数値にだけ使えます（${describe(a)} ${op} ${describe(b)}）`);
      if (op === "-") return a - b;
      if (op === "*") return a * b;
      return checkedDivision(a, b, op);
    }
    case "<":
    case "<=":
    case ">":
    case ">=": {
      if (!((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string"))) {
        throw new EvalError(`${op} は同じ型の数値か文字列にだけ使えます（${describe(a)} ${op} ${describe(b)}）`);
      }
      if (op === "<") return a < b;
      if (op === "<=") return a <= b;
      if (op === ">") return a > b;
      return a >= b;
    }
  }
}

type PluginFunctionImpl = (args: Value[], env: { random(): number }) => Value;

/** プラグインが足した式の関数の処理（プラグインの名前 → 関数の名前 → 処理）。@liminalia/sdk の combinePlugins が入れる。 */
const pluginFunctions = new Map<string, Map<string, PluginFunctionImpl>>();

/**
 * そのプラグインが足す式の関数の処理を入れ替える（そのプラグインが前に入れたものは外す。ほかのプラグインのものは残す。
 * 引数の数は @liminalia/lang の setPluginFunctions）。
 */
export function setPluginFunctionImpls(plugin: string, impls: Readonly<Record<string, PluginFunctionImpl>>): void {
  pluginFunctions.delete(plugin);
  if (Object.keys(impls).length > 0) pluginFunctions.set(plugin, new Map(Object.entries(impls)));
}

/** プラグインの関数の処理（同じ名前は後に入れたプラグインのもの）。 */
function pluginFunction(name: string): PluginFunctionImpl | undefined {
  let found: PluginFunctionImpl | undefined;
  for (const own of pluginFunctions.values()) found = own.get(name) ?? found;
  return found;
}

/** プラグインの関数を呼ぶ。返した値が値の形（JSON にできるもの）でなければ誤りにする。 */
function callPlugin(name: string, run: (args: Value[], env: { random(): number }) => Value, args: Value[], env: EvalEnv): Value {
  let v: unknown;
  try {
    v = run(structuredClone(args), { random: () => env.random() });
  } catch (e) {
    throw new EvalError(`${name}() が失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (v === undefined) return null;
  if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
  if (typeof v === "object") {
    try {
      return JSON.parse(JSON.stringify(v)) as Value;
    } catch {
      // 下で誤りにする
    }
  }
  throw new EvalError(`${name}() が値（数、文字、真偽、配列、オブジェクト）でないものを返しました`);
}

function call(name: string, args: Value[], env: EvalEnv): Value {
  if (name === "@each") {
    // @for が回すもの（program.ts の EACH_FUNCTION）。配列はそのまま、辞書はキーの並び
    const v = args[0] ?? null;
    if (Array.isArray(v)) return v;
    if (v !== null && typeof v === "object") return Object.keys(v);
    throw new EvalError(`@for で回せるのは配列か辞書です（${describe(v)}）`);
  }
  if (!Object.hasOwn(FUNCTION_ARITY, name)) {
    const f = env.fn?.(name);
    if (f) return callUser(name, f, args, env);
  }
  const arity = functionArity(name);
  if (arity && (args.length < arity[0] || args.length > arity[1])) throw new EvalError(`${name}() の引数は ${arityText(arity)}です（${args.length} つ）`);
  const num = (i: number) => {
    const v = args[i];
    if (typeof v !== "number") throw new EvalError(`${name}() の ${i + 1} 番目には数値が必要です（${describe(v ?? null)}）`);
    return v;
  };
  const str = (i: number) => {
    const v = args[i];
    if (typeof v !== "string") throw new EvalError(`${name}() の ${i + 1} 番目には文字列が必要です（${describe(v ?? null)}）`);
    return v;
  };
  const list = (i: number) => {
    const v = args[i];
    if (!Array.isArray(v)) throw new EvalError(`${name}() の ${i + 1} 番目には配列が必要です（${describe(v ?? null)}）`);
    return v;
  };
  const object = (i: number) => {
    const v = args[i];
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new EvalError(`${name}() の ${i + 1} 番目にはオブジェクトが必要です（${describe(v ?? null)}）`);
    return v;
  };
  const date = new Date();
  switch (name) {
    case "random":
      // random() は 0 以上 1 未満、random(n) は 0 以上 n 未満の整数。
      return args.length === 0 ? env.random() : Math.floor(env.random() * num(0));
    case "randint": {
      const [a, b] = [Math.ceil(num(0)), Math.floor(num(1))];
      return a + Math.floor(env.random() * (b - a + 1));
    }
    case "pick": {
      const xs = list(0);
      return xs.length === 0 ? null : xs[Math.floor(env.random() * xs.length)]!;
    }
    case "shuffle": {
      const xs = [...list(0)];
      for (let i = xs.length - 1; i > 0; i--) {
        const j = Math.floor(env.random() * (i + 1));
        [xs[i], xs[j]] = [xs[j]!, xs[i]!];
      }
      return xs;
    }
    case "floor":
      return Math.floor(num(0));
    case "ceil":
      return Math.ceil(num(0));
    case "round": {
      if (args.length === 1) return Math.round(num(0));
      const k = 10 ** Math.max(0, Math.floor(num(1)));
      return Math.round(num(0) * k) / k;
    }
    case "abs":
      return Math.abs(num(0));
    case "min":
      return Math.min(...args.map((_, i) => num(i)));
    case "max":
      return Math.max(...args.map((_, i) => num(i)));
    case "clamp":
      return Math.min(num(2), Math.max(num(1), num(0)));
    case "sum":
      return list(0).reduce<number>((t, v) => {
        if (typeof v !== "number") throw new EvalError(`sum() の配列には数値だけを入れます（${describe(v)}）`);
        return t + v;
      }, 0);
    case "len": {
      const v = args[0];
      if (typeof v === "string" || Array.isArray(v)) return v.length;
      throw new EvalError(`len() には文字列か配列が必要です（${describe(v ?? null)}）`);
    }
    case "includes": {
      const [c, x] = args;
      if (typeof c === "string" && typeof x === "string") return c.includes(x);
      if (Array.isArray(c)) return c.some((e) => equals(e, x ?? null));
      throw new EvalError(`includes() の 1 番目には文字列か配列が必要です（${describe(c ?? null)}）`);
    }
    case "index": {
      const [c, x] = args;
      if (typeof c === "string" && typeof x === "string") return c.indexOf(x);
      if (Array.isArray(c)) return c.findIndex((e) => equals(e, x ?? null));
      throw new EvalError(`index() の 1 番目には文字列か配列が必要です（${describe(c ?? null)}）`);
    }
    case "slice": {
      const c = args[0];
      const end = args.length > 2 ? num(2) : undefined;
      if (typeof c === "string") return [...c].slice(num(1), end).join("");
      if (Array.isArray(c)) return c.slice(num(1), end);
      throw new EvalError(`slice() の 1 番目には文字列か配列が必要です（${describe(c ?? null)}）`);
    }
    case "replace":
      return str(0).split(str(1)).join(str(2));
    case "upper":
      return str(0).toUpperCase();
    case "lower":
      return str(0).toLowerCase();
    case "trim":
      return str(0).trim();
    case "split":
      return str(0).split(str(1));
    case "join":
      return list(0).map((v) => display(v)).join(args.length > 1 ? str(1) : "");
    case "pad":
      return display(args[0] ?? null).padStart(Math.max(0, Math.floor(num(1))), args.length > 2 ? str(2) : "0");
    case "str":
      return display(args[0] ?? null);
    case "num": {
      const v = args[0];
      if (typeof v === "number") return v;
      if (typeof v !== "string" || v.trim() === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case "push":
      return [...list(0), args[1] ?? null];
    case "remove":
      return list(0).filter((e) => !equals(e, args[1] ?? null));
    case "sort":
      return [...list(0)].sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : display(a) < display(b) ? -1 : display(a) > display(b) ? 1 : 0));
    case "reverse":
      return [...list(0)].reverse();
    case "unique":
      return list(0).filter((e, i, xs) => xs.findIndex((x) => equals(x, e)) === i);
    case "keys":
      return Object.keys(object(0));
    case "has":
      return Object.hasOwn(object(0), str(1));
    case "version_before":
      return compareVersions(versionText(args[0]), versionText(args[1])) < 0;
    case "year":
      return date.getFullYear();
    case "month":
      return date.getMonth() + 1;
    case "day":
      return date.getDate();
    case "hour":
      return date.getHours();
    case "minute":
      return date.getMinutes();
    case "weekday":
      return date.getDay();
    case "now":
      return date.getTime();
    case "visits":
    case "read":
    case "chosen":
      str(0);
      return env.story ? env.story(name, args) : name === "visits" ? 0 : false;
    case "lang":
    case "platform":
    case "app":
    case "replaying":
    case "chapter":
      return env.story ? env.story(name, args) : name === "lang" || name === "chapter" ? "" : name === "platform" ? "pc" : false;
    case "endings":
      // 見たエンディングの数（全セーブ共通。実行器が答える）
      return env.story ? env.story(name, args) : 0;
    case "item": {
      // 持ち物の数（ゲームの変数の、式からは書けない名前のところ。@liminalia/lang の ITEMS_KEY）
      const items = (env.lookup("game") as Scope | null)?.["@items"];
      const key = args[0];
      if (typeof key !== "string") throw new EvalError(`item() には持ち物の名前（文字列）が必要です（${describe(key ?? null)}）`);
      const count = items && typeof items === "object" && !Array.isArray(items) && Object.hasOwn(items, key) ? (items as Scope)[key] : 0;
      return typeof count === "number" ? count : 0;
    }
    default: {
      const run = pluginFunction(name);
      if (run) return callPlugin(name, run, args, env);
      throw new EvalError(`関数 ${name}() はありません`);
    }
  }
}

/** @function の関数を呼ぶ。中で読めるのは引数と game・system・temp・save だけ（呼んだ側の @let は見えない）。 */
function callUser(name: string, f: { file: string; params: readonly string[]; body: Expr }, args: Value[], env: EvalEnv): Value {
  if (args.length !== f.params.length) throw new EvalError(`${name}() の引数は ${f.params.length} つです（${args.length} つ）`);
  const depth = (env.depth ?? 0) + 1;
  if (depth > MAX_FUNCTION_DEPTH) throw new EvalError(`${name}() の呼び出しが ${MAX_FUNCTION_DEPTH} 段を超えました（自分を呼び続けていないか確かめます）`);
  const local = new Map(f.params.map((p, i) => [p, args[i] ?? null] as const));
  const inner: EvalEnv = {
    ...env,
    depth,
    lookup: (n) => (local.has(n) ? local.get(n)! : n === "game" || n === "system" || n === "temp" || n === "save" ? env.lookup(n) : null),
    ...(env.fn ? { fn: (n: string, file?: string) => env.fn!(n, file ?? f.file) } : {}),
  };
  return evaluate(f.body, inner);
}

function describe(v: Value): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "配列";
  if (typeof v === "object") return "オブジェクト";
  return `${typeof v === "string" ? "文字列" : typeof v === "number" ? "数値" : "真偽値"} ${JSON.stringify(v)}`;
}

/** シード付きの乱数（mulberry32）。状態は数値一つなのでセーブできる。 */
export function nextRandom(seed: number): { value: number; seed: number } {
  let t = (seed + 0x6d2b79f5) | 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, seed: next };
}

/** version_before の版（文字列か数。null と空は「版の無い」もの）。 */
function versionText(v: Value | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v).trim();
  throw new EvalError(`version_before() には版の文字列（"1.2.0" など）が必要です（${describe(v)}）`);
}

/**
 * 版を比べる（1.2.10 は 1.2.9 より後。- の後ろの付いた 1.0.0-beta は 1.0.0 より前。頭の v は読まない。空の版はどの版よりも前）。
 * a が前なら負、同じなら 0、後なら正。デスクトップ版の更新（packages/desktop/update.cjs の compareVersions）と同じ決まり。
 */
export function compareVersions(a: string, b: string): number {
  if (a === "" || b === "") return a === b ? 0 : a === "" ? -1 : 1;
  const split = (v: string) => {
    const [main = "", pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: main.split(".").map((x) => Number.parseInt(x, 10) || 0), pre: pre ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre.localeCompare(y.pre, "en", { numeric: true }) > 0 ? 1 : -1;
}
