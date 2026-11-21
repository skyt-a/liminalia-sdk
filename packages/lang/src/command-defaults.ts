import type { Diagnostic } from "./ast.ts";
import { parseLiteral } from "./args.ts";
import type { Script, Statement } from "./ast.ts";
import { defineSpec, hintFrom, typeProblem } from "./check.ts";
import { createRegistry, type CommandSpec, type ParamSpec, type Registry } from "./registry.ts";
import { renamedParam } from "./migrate.ts";
import { markShownCast } from "./macro-shown.ts";

/**
 * 作品ごとのコマンドの既定値（liminalia.json の commandDefaults）。コマンド名 → パラメータ名 → 値（.lim の書き方。"400ms"・"true"・"default"）。
 * シナリオで省いたパラメータに使う。組み込みのコマンドにも、プラグインのコマンドにも効く。
 *
 * ```json
 * "commandDefaults": { "chara": { "time": "400ms", "appearance": "default" }, "bg": { "time": "1s" } }
 * ```
 */
export type CommandDefaults = Record<string, Record<string, string | number | boolean>>;

const FILE = "liminalia.json";

/** 既定値の字面（数と真偽は文字にする）。 */
function valueText(v: unknown): string | null {
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;
}

/** 既定値として使える値か（式・必須のパラメータ・型の誤りは使えない）。使えなければその理由。 */
function problemOf(spec: CommandSpec, name: string, raw: unknown, cast?: ReadonlySet<string>): { message: string; hint?: string } | null {
  const p = spec.params[name]!;
  if (p.required) return { message: `@${spec.name} の ${name} は必須のパラメータなので、既定値を決められません` };
  const text = valueText(raw);
  if (text === null || text === "") return { message: `@${spec.name} の ${name} の既定値は、.lim の書き方の文字列で書きます`, hint: '"400ms"' };
  if (text.startsWith("(")) return { message: `@${spec.name} の ${name} の既定値に式は書けません` };
  const literal = parseLiteral(text);
  if (literal.kind === "expr") return { message: `@${spec.name} の ${name} の既定値に式は書けません` };
  const problem = typeProblem(p.type, literal, cast);
  return problem ? { message: `@${spec.name} の ${name}: ${problem.message}`, ...(problem.hint ? { hint: problem.hint } : {}) } : null;
}

/**
 * 作品の既定値の検査。形の崩れ・無いコマンド・無いパラメータ・必須のパラメータ・型の誤りをエラーにする（liminalia.json の 1 行目）。
 * cast があれば、キャラクター ID の既定値が登録された名前かも確かめる。macros（projectMacros）があれば、@define のマクロの既定値も書ける
 * （既定値のあるパラメータだけ。既定値の無いパラメータは必須なので決められない）。
 */
export function checkCommandDefaults(defaults: unknown, registry: Registry, cast?: ReadonlySet<string>, macros?: ReadonlyMap<string, CommandSpec>): Diagnostic[] {
  if (defaults === undefined) return [];
  const out: Diagnostic[] = [];
  const error = (message: string, hint?: string) => out.push({ severity: "error", code: "bad-command-defaults", message, file: FILE, line: 1, ...(hint ? { hint } : {}) });
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    error("commandDefaults はコマンド名 → { パラメータ名: 値 } の形で書きます", '"commandDefaults": { "chara": { "time": "400ms" } }');
    return out;
  }
  for (const [name, params] of Object.entries(defaults as Record<string, unknown>)) {
    const spec = registry.get(name) ?? macros?.get(name);
    if (!spec) {
      error(`commandDefaults のコマンド @${name} はありません`, hintFrom(name, [...registry.keys(), ...(macros?.keys() ?? [])], (n) => n).hint);
      continue;
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      error(`commandDefaults の ${name} はパラメータ名 → 値 の形で書きます`, `"${name}": { "${Object.keys(spec.params).find((k) => !spec.params[k]!.required) ?? "fade"}": "…" }`);
      continue;
    }
    for (const [given, value] of Object.entries(params as Record<string, unknown>)) {
      // 前の版の引数の名前（"fade" → "time"）。そのまま効くので警告し、今の名前で確かめる
      const renamed = renamedParam(spec, given);
      if (renamed !== null) {
        // 今の名前も書いていれば、前の名前の値は使われていない（applyCommandDefaults は今の名前を使う）
        if (renamed in (params as Record<string, unknown>)) {
          out.push({ severity: "warning", code: "renamed-param", message: `commandDefaults の @${name} の ${given} は使われていません（${renamed} も書いてあり、そちらを使います）`, file: FILE, line: 1, hint: `"${given}" を消します（lim migrate で外せます）` });
          continue;
        }
        out.push({ severity: "warning", code: "renamed-param", message: `commandDefaults の @${name} の ${given} は ${renamed} という名前になりました`, file: FILE, line: 1, hint: `"${renamed}" と書きます（lim migrate で直せます）` });
      }
      const param = renamed ?? given;
      if (!(param in spec.params)) {
        error(`commandDefaults の @${name} に ${param} というパラメータはありません`, hintFrom(param, Object.keys(spec.params), (n) => n).hint);
        continue;
      }
      const problem = problemOf(spec, param, value, cast);
      if (problem) error(`commandDefaults の ${problem.message}`, problem.hint);
    }
  }
  return out;
}

/**
 * 作品の既定値を重ねたコマンドの仕様。重ねたパラメータは default を替え、projectDefault と元の既定値 standardDefault を付ける。
 * wait の既定値を替えたら、待つか（waits）も合わせる。使えない値（checkCommandDefaults のエラー）は重ねない。
 */
export function applyCommandDefaults(spec: CommandSpec, defaults: CommandDefaults | undefined): CommandSpec {
  const own = defaults?.[spec.name];
  if (!own || typeof own !== "object") return spec;
  const params: Record<string, ParamSpec> = { ...spec.params };
  let waits = spec.waits;
  let changed = false;
  for (const [given, raw] of Object.entries(own)) {
    // 前の版の引数の名前（"fade"）は今の名前（"time"）に重ねる。今の名前も書いてあればそちら
    const renamed = renamedParam(spec, given);
    if (renamed !== null && renamed in own) continue;
    const name = renamed ?? given;
    const p = spec.params[name];
    if (!p || problemOf(spec, name, raw)) continue;
    const value = valueText(raw)!;
    const { default: standard, ...rest } = p;
    params[name] = { ...rest, default: value, projectDefault: true, ...(standard !== undefined ? { standardDefault: standard } : {}) };
    if (name === "wait" && p.type.kind === "bool") waits = value === "true";
    changed = true;
  }
  if (!changed) return spec;
  const { waits: _w, ...base } = spec;
  return { ...base, params, ...(waits ? { waits } : {}) };
}

/** 作品の既定値を重ねたレジストリ（既定値が無ければそのまま）。 */
export function withCommandDefaults(registry: Registry, defaults: CommandDefaults | undefined): Registry {
  if (!defaults || typeof defaults !== "object" || Object.keys(defaults).length === 0) return registry;
  return createRegistry([...registry.values()].map((spec) => applyCommandDefaults(spec, defaults)));
}

/**
 * プロジェクトの @define のマクロの仕様（名前 → 仕様。同じ名前が二つあれば先のファイルのもの）。commandDefaults の検査と、
 * 書き戻し（lim backport）で省いたパラメータに既定値を書くのに使う。
 * specOf（組み込みとプラグインの命令）を渡すと、人物の引数が表示中の人物に効くか（型の shown）も本文から決める（制作画面の補完が使う。markShownCast）。
 */
export function projectMacros(scripts: Iterable<readonly [string, Script]>, specOf?: (name: string) => CommandSpec | undefined): Map<string, CommandSpec> {
  const out = new Map<string, CommandSpec>();
  const defines = new Map<string, Extract<Statement, { kind: "define" }>>();
  for (const [, script] of scripts) {
    for (const s of script.body) {
      if (s.kind !== "define" || s.name === "" || out.has(s.name)) continue;
      out.set(s.name, defineSpec(s)!);
      defines.set(s.name, s);
    }
  }
  if (specOf) markShownCast(defines, out, specOf);
  return out;
}
