// 読み込みの口（node:module の register）。見つからないときだけ、lim のある場所から探し直す。それ以外は何も変えない。
// - 作品のプラグインから @liminalia/… が見つからないとき（作品のフォルダに node_modules が無い・入れていない）
// - lim の依存（vite など）が見つからないとき。npm で入れた lim は、依存を cli の中の node_modules に持つことがあり、
//   隣のエンジン（@liminalia/web の vite.config.ts など）や、Vite が作品の .liminalia/vite に書く設定の写しからは見えない
import { readFileSync } from "node:fs";

let base = null;
let deps = new Set();

export function initialize(data) {
  base = data?.base ?? null;
  if (!base) return;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", base), "utf8"));
    deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]);
  } catch {
    // package.json を読めなければ @liminalia/… だけを探し直す
  }
}

/** "vite/dist/x" → "vite"、"@a/b/c" → "@a/b"。相対や絶対の指定、node: は null。 */
export function packageName(specifier) {
  if (/^(\.|\/|[a-z]+:)/i.test(specifier)) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    const name = packageName(specifier);
    if (base && name && (name.startsWith("@liminalia/") || deps.has(name)) && e?.code === "ERR_MODULE_NOT_FOUND" && context.parentURL !== base) {
      return next(specifier, { ...context, parentURL: base });
    }
    throw e;
  }
}
