import { normalizeBooleanArgs } from "./args.ts";
import type { Argument, Diagnostic, DiagnosticFix, Expr, Inline, Script, Statement } from "./ast.ts";
import type { Registry } from "./registry.ts";
import { typoDistance } from "./check.ts";

/** 変数の置き場所。game はセーブに入る変数、system は全セーブ共通、temp はそのプレイの間だけ。 */
export const VARIABLE_SCOPES = ["game", "system", "temp"] as const;
export type VariableScope = (typeof VARIABLE_SCOPES)[number];

/**
 * 台本の中で変数を使っている場所。path は "game.x" の形（入れ子は一段目まで）。write は値を入れるところ。
 * compound は `@set 変数 += 式` など前の値から計算する代入（値を入れるところと、前の値を読むところの両方に付く）。
 */
export interface VariableUse {
  path: string;
  line: number;
  write: boolean;
  compound?: true;
  /** compound の値が文字だけのとき（`+= "…"`。文字をつなぐ変数）。 */
  text?: true;
}

/** 変数の名前として書けるか（"game.x" の形。x は英字・数字・_ で、数字で始まらない）。 */
export function isVariablePath(path: string): boolean {
  return /^(game|system|temp)\.[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(path);
}

/** 式の中の変数（game.x・system.x・temp.x）。 */
export function variablePaths(expr: Expr, out: string[] = []): string[] {
  switch (expr.kind) {
    case "member": {
      // game.x.y は game.x として数える
      let base: Expr = expr;
      const props: string[] = [];
      while (base.kind === "member") {
        props.unshift(base.property);
        base = base.object;
      }
      if (base.kind === "name" && (VARIABLE_SCOPES as readonly string[]).includes(base.name)) out.push(`${base.name}.${props[0]}`);
      else variablePaths(base, out);
      break;
    }
    case "index":
      variablePaths(expr.object, out);
      variablePaths(expr.index, out);
      break;
    case "call":
      for (const a of expr.args) variablePaths(a, out);
      break;
    case "array":
      for (const a of expr.items) variablePaths(a, out);
      break;
    case "object":
      for (const e of expr.entries) variablePaths(e.value, out);
      break;
    case "unary":
      variablePaths(expr.operand, out);
      break;
    case "binary":
      variablePaths(expr.left, out);
      variablePaths(expr.right, out);
      break;
    case "conditional":
      variablePaths(expr.test, out);
      variablePaths(expr.then, out);
      variablePaths(expr.otherwise, out);
      break;
    case "name":
    case "literal":
      break;
  }
  return out;
}

/**
 * 台本の中で変数を読む・書く場所を集める。@set の左辺と、命令の結果を受け取る変数型の引数が書くところ、
 * 式（@set の右辺・@let・@if・本文の {…}・命令と選択肢の (…) の引数）が読むところ。@script の中は見ない。
 */
export function variableUses(script: Script, registry: Registry): VariableUse[] {
  const out: VariableUse[] = [];
  const reads = (expr: Expr, line: number) => {
    for (const path of variablePaths(expr)) out.push({ path, line, write: false });
  };
  const args = (list: readonly Argument[], line: number, name: string | null) => {
    const spec = name ? registry.get(name) : undefined;
    let pos = 0;
    for (const a of spec ? normalizeBooleanArgs(spec, list) : list) {
      const key = a.key ?? spec?.positional[pos++];
      if (a.value.kind === "expr") reads(a.value.expr, line);
      else if (key && spec?.params[key]?.type.kind === "variable" && a.value.kind === "string") {
        const [scope, first] = a.value.value.split(".");
        if (scope && first) out.push({ path: `${scope}.${first}`, line, write: true });
      }
    }
  };
  const inline = (content: readonly Inline[], line: number) => {
    for (const c of content) {
      if (c.kind === "value") reads(c.expr, line);
      else if (c.kind === "command") args(c.args, line, c.name);
      else if ("children" in c) inline(c.children, line);
    }
  };
  const visit = (body: readonly Statement[]) => {
    for (const s of body) {
      switch (s.kind) {
        case "say":
          if (s.name) inline(s.name, s.line);
          inline(s.content, s.line);
          break;
        case "prose":
          inline(s.content, s.line);
          break;
        case "set": {
          const [path, ...rest] = variablePaths(s.target);
          const compound = s.op !== "=" ? ({ compound: true, ...(s.value.kind === "literal" && typeof s.value.value === "string" ? { text: true } : {}) } as const) : {};
          if (path) out.push({ path, line: s.line, write: true, ...compound });
          // += などは前の値も読む
          if (path && s.op !== "=") out.push({ path, line: s.line, write: false, ...compound });
          // 添字の式の中の変数も読む（@set game.a[game.i] = … の game.i）
          for (const p of rest) out.push({ path: p, line: s.line, write: false });
          reads(s.value, s.line);
          break;
        }
        case "let":
          reads(s.value, s.line);
          break;
        case "command":
          args(s.args, s.line, s.name);
          break;
        case "if":
          if (s.with) args(s.with.args, s.line, s.with.name);
          if (s.each) reads(s.each.list, s.line);
          for (const b of s.branches) {
            if (b.condition) reads(b.condition, b.line);
            visit(b.body);
          }
          break;
        case "jump":
        case "call":
          if (s.target.expr) reads(s.target.expr, s.line);
          break;
        case "return":
          if (s.value) reads(s.value, s.line);
          break;
        case "function":
          reads(s.body, s.line);
          break;
        case "choice":
          // @choice の行のパラメータ（timeout=(…) など）の中の変数も読む
          args(s.args ?? [], s.line, null);
          for (const o of s.options) {
            inline(o.content, o.line);
            args(o.args, o.line, null);
            if (o.target.expr) reads(o.target.expr, o.line);
          }
          break;
        case "define":
          visit(s.body);
          break;
        default:
          break;
      }
    }
  };
  visit(script.body);
  return out;
}

/** 行の中の変数 from（"game.x"）を to にする（game.xy や a.game.x は替えない）。 */
export function renameVariableInLine(line: string, from: string, to: string): string {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return line.replace(new RegExp(`(?<![\\p{ID_Continue}_.])${esc}(?![\\p{ID_Continue}_])`, "gu"), to);
}

/**
 * エンジンが値を入れる変数（全セーブ共通の解放の記録・書き出しの版など）。作品が値を入れなくても読める。
 */
export const ENGINE_VARIABLES: ReadonlySet<string> = new Set([
  "system.cg_unlocked",
  "system.replay_unlocked",
  "system.bgm_heard",
  "system.achievements",
  "system.achievement_progress",
  "system.movies_seen",
  "system.sprites_seen",
  "system.chapters_unlocked",
  "system.glossary_unlocked",
  "system.codex_unlocked",
  "system.purchases",
  "system.content_filter",
  "system.variant",
]);

export interface VariableCheckOptions {
  registry: Registry;
  /** liminalia.json の variables（初期値。書いた変数は値が入る）。 */
  variables?: Readonly<Record<string, unknown>> | undefined;
  /** ほかに値を入れる変数（プラグインの宣言 variables、作品のデータが立てるフラグ）。末尾が .* なら、その下の名前すべて。 */
  written?: Iterable<string> | undefined;
  /** "declared" なら、liminalia.json の variables に書いた変数だけを認める（書いていない game. と system. の変数を警告）。 */
  mode?: "declared" | undefined;
}

/**
 * game. と system. の変数の綴り違い。読むのに、どこでも値を入れない変数（@set、命令の結果、liminalia.json の variables、
 * プラグインの宣言、データのフラグ、エンジンが入れるもの）で、値を入れる変数に綴りの近いものがあれば警告し、置き換える直し方を付ける（unset-variable）。
 * 近いものが無ければ知らせない（プラグインが黙って値を入れる変数などで誤って知らせないため）。
 * mode が "declared" なら、variables に書いていない変数を読む・書く所をすべて警告する（undeclared-variable）。
 * 初期値の無いまま読まれる変数（uninitialized-variable。uninitializedVariables）も、ここで一緒に見る。
 * 一段目の名前（game.x.y は game.x）で比べる。
 */
export function checkVariableNames(scripts: ReadonlyMap<string, Script>, o: VariableCheckOptions): Diagnostic[] {
  const uses = new Map<string, VariableUse[]>();
  for (const [file, script] of scripts) uses.set(file, variableUses(script, o.registry).filter((u) => u.path.startsWith("game.") || u.path.startsWith("system.")));
  const declared = new Set(Object.keys(o.variables ?? {}).map(firstLevel));
  const written = new Set<string>([...declared, ...ENGINE_VARIABLES]);
  const prefixes: string[] = [];
  for (const w of o.written ?? []) {
    if (w.endsWith(".*")) prefixes.push(w.slice(0, -1));
    else written.add(firstLevel(w));
  }
  for (const list of uses.values()) for (const u of list) if (u.write) written.add(u.path);
  const known = (path: string) => written.has(path) || prefixes.some((p) => `${path}.`.startsWith(p));
  const out: Diagnostic[] = [];
  const near = (path: string, among: Iterable<string>) => {
    const [scope, name] = [path.slice(0, path.indexOf(".")), path.slice(path.indexOf(".") + 1)];
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const w of among) {
      if (!w.startsWith(`${scope}.`)) continue;
      const d = typoDistance(name, w.slice(scope.length + 1));
      if (d < bestDistance) {
        best = w;
        bestDistance = d;
      }
    }
    return best !== null && bestDistance <= Math.max(1, Math.floor(name.length / 4)) ? best : null;
  };
  out.push(...uninitializedVariables(scripts, o, prefixes));
  for (const [file, list] of uses) {
    const seen = new Set<string>();
    for (const u of list) {
      const key = `${u.path}:${u.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (o.mode === "declared") {
        if (declared.has(u.path) || ENGINE_VARIABLES.has(u.path) || prefixes.some((p) => `${u.path}.`.startsWith(p))) continue;
        const to = near(u.path, declared);
        const fix: DiagnosticFix | undefined = to ? { kind: "replace", find: u.path, with: to } : undefined;
        out.push({
          severity: "warning",
          code: "undeclared-variable",
          message: `変数 ${u.path} は liminalia.json の variables に書いていません`,
          file,
          line: u.line,
          hint: to ? `${to} のことですか？` : `liminalia.json の variables に "${u.path}" と初期値を書きます`,
          ...(fix ? { fix, fixes: [fix] } : {}),
        });
        continue;
      }
      if (u.write || known(u.path)) continue;
      const to = near(u.path, written);
      if (!to) continue;
      const fix: DiagnosticFix = { kind: "replace", find: u.path, with: to };
      out.push({ severity: "warning", code: "unset-variable", message: `変数 ${u.path} には、どこでも値を入れていません`, file, line: u.line, hint: `${to} のことですか？`, fix, fixes: [fix] });
    }
  }
  return out;
}

/**
 * 初期値の無いまま読まれる変数（uninitialized-variable）。liminalia.json の variables に無く、どこでも = で値を入れず
 * （命令の結果を受け取るパラメータ、プラグインの宣言、作品のデータのフラグ、エンジンが入れるものでもなく）、+= などで前の値から計算するだけの変数を、
 * ほかの所で読んでいれば知らせる。+= などはまだ値の無い変数を 0（文字を足すなら空の文字）として計算するが、比べる式（>= など）と計算の式は
 * 0 とみなさないので、足す前にその行へ来ると誤りになる（条件なら偽として進む）。読む行ごとに一つ出す。
 * temp. も見る（liminalia.json には書けないので、直し方は先に = で値を入れること）。check.variables が "declared" なら、
 * variables に無い game. と system. は undeclared-variable が知らせるので、ここでは temp. だけを見る。
 */
function uninitializedVariables(scripts: ReadonlyMap<string, Script>, o: VariableCheckOptions, prefixes: readonly string[]): Diagnostic[] {
  const uses = new Map<string, VariableUse[]>();
  for (const [file, script] of scripts) uses.set(file, variableUses(script, o.registry));
  const initialized = new Set<string>([...Object.keys(o.variables ?? {}).map(firstLevel), ...ENGINE_VARIABLES]);
  for (const w of o.written ?? []) if (!w.endsWith(".*")) initialized.add(firstLevel(w));
  /** 前の値から計算するだけの変数 → 文字をつなぐか。 */
  const compound = new Map<string, boolean>();
  for (const list of uses.values()) {
    for (const u of list) {
      if (!u.write) continue;
      if (!u.compound) initialized.add(u.path);
      else compound.set(u.path, (compound.get(u.path) ?? false) || u.text === true);
    }
  }
  const out: Diagnostic[] = [];
  for (const [file, list] of uses) {
    const seen = new Set<string>();
    for (const u of list) {
      if (u.write || u.compound || !compound.has(u.path) || initialized.has(u.path)) continue;
      if (prefixes.some((p) => `${u.path}.`.startsWith(p))) continue;
      if (o.mode === "declared" && !u.path.startsWith("temp.")) continue;
      const key = `${u.path}:${u.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const init = compound.get(u.path) ? '""' : "0";
      out.push({
        severity: "warning",
        code: "uninitialized-variable",
        message: `変数 ${u.path} には初期値が無く、+= などで前の値から計算するだけです（その前にここへ来ると、値の無いまま読みます）`,
        file,
        line: u.line,
        hint: u.path.startsWith("temp.") ? `先に @set ${u.path} = ${init} で値を入れます` : `liminalia.json の variables に "${u.path}": ${init} と初期値を書きます`,
      });
    }
  }
  return out;
}

/** 変数の一段目（game.x.y → game.x）。 */
function firstLevel(path: string): string {
  const parts = path.split(".");
  return parts.length > 2 ? `${parts[0]}.${parts[1]}` : path;
}
