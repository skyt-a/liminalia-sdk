import { CORE_COMMANDS, createRegistry, parse, type Argument, type CommandSpec, type Inline, type ParamType, type Statement } from "@liminalia/lang";
import { compile } from "./compile.ts";
import { convert, typedValue, type ConvertOptions, type ConvertStats } from "./convert.ts";
import { convertJsExpression } from "./js-expr.ts";
import type { Diagnostic, Params, ScenarioIR } from "./types.ts";

/**
 * TyranoScript のマクロ（[macro]〜[endmacro]）を .lim の @define にする。
 *
 * - マクロの引数は、中身で使われている `%名前`・`mp.名前` と、`*` で中のタグへそのまま渡すときは呼び出し側で渡している名前
 * - 引数の型は、その引数を渡している命令の引数の型から決める（時間・真偽・数値・色。決まらなければ文字列）
 * - .ks のマクロの引数はどれも省略できるので、@define の引数にもすべて既定値を付ける
 *   （`%名前|既定値` の既定値、なければ渡している命令の引数の既定値、それもなければ型ごとの空の値）
 * - 引数名の _ は - にする（中の式では - を _ に戻した名前で参照する。format.md 8 章のマクロ）
 */

// ---- &式・%引数 の目印 ----

const OPEN = "";
const CLOSE = "";
const MARK = /([^]*)/g;

/** 値が &式・%引数 の目印そのものなら、.lim の式を返す。 */
export function entity(value: string): string | null {
  if (!value.startsWith(OPEN) || !value.endsWith(CLOSE) || value.indexOf(OPEN, 1) >= 0) return null;
  return value.slice(1, -1);
}

/** 目印を (式) の形にする（診断の文や、書き出しそこねた行に）。 */
export function unmark(text: string): string {
  return text.replace(MARK, (_, e: string) => `(${e})`);
}

/** マクロの中身を変換するときの、引数の対応。 */
export interface MacroBody {
  /** .ks の引数名 → .lim の式で参照する名前。 */
  names: Map<string, string>;
  params: Map<string, MacroParam>;
  /** `*` を使っているか（呼び出し側の引数をすべて受け取る）。 */
  spread: boolean;
  /**
   * マクロを書いたファイル（.lim の名前）。中身の飛び先の、ファイルを省いたラベルはこのファイルのもの。
   * null は @define と同じファイル、"" は本文として変換しないファイル（飛び先を書けない）。
   */
  file: string | null;
}

type Report = (severity: Diagnostic["severity"], code: string, message: string) => void;

/**
 * タグの引数の &式 と %引数 を目印にする。目印は ms / bool / str などの値の書き方が (式) にする。
 * マクロの外の %引数 は、TyranoScript でもマクロの引数がないので既定値（なければ空）になる。
 * `*` はマクロの引数をすべてこのタグに渡す。
 */
export function markEntities(pm: Params, macro: MacroBody | undefined, report: Report): Params {
  const out: Params = {};
  if (pm["*"] !== undefined && macro) {
    for (const p of macro.params.values()) if (pm[p.ks] === undefined) out[p.ks] = `${OPEN}${p.local}${CLOSE}`;
  }
  for (const [key, value] of Object.entries(pm)) {
    if (key === "cond" || key === "*") {
      out[key] = value;
      continue;
    }
    if (value.startsWith("&")) {
      const expr = convertJsExpression(value.slice(1), macro?.names);
      if (expr === null) {
        report("error", "manual-entity", `${key}=${value} の式を変換できません`);
        out[key] = value;
      } else {
        out[key] = `${OPEN}${expr}${CLOSE}`;
      }
      continue;
    }
    if (value.startsWith("%")) {
      const [name = "", def = ""] = value.slice(1).split("|").map((s) => s.trim());
      const local = macro?.names.get(name);
      out[key] = local === undefined ? def : `${OPEN}${local}${CLOSE}`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ---- マクロの収集 ----

export interface MacroParam {
  /** .ks の引数名。 */
  ks: string;
  /** @define の引数名。 */
  name: string;
  /** 中の式で参照する名前。 */
  local: string;
  type: "string" | "number" | "bool" | "duration" | "color";
  /** .lim の書き方の既定値（型が決まってから決める）。 */
  default: string;
  /** `%名前|既定値` の既定値（.ks の値）。 */
  ksDefault: string | null;
  /** 渡している先の命令の引数の既定値（.lim の書き方）。 */
  slotDefault?: string;
}

/** マクロの呼び出し方（@define の名前と引数）。 */
export interface MacroSignature {
  /** .ks のマクロ名。 */
  ks: string;
  /** @define の名前。 */
  name: string;
  /** .ks の引数名 → 引数。 */
  params: Map<string, MacroParam>;
  /** @define を置いたファイル（拡張子なし）。undefined は呼び出し側と同じファイル。 */
  library?: string;
}

export interface MacroSource {
  name: string;
  /** マクロを書いた .ks（data/scenario からのパス）。 */
  file: string;
  line: number;
  ir: ScenarioIR;
  /** [macro] と [endmacro] の位置。 */
  start: number;
  end: number;
}

/** .ks の中の [macro]〜[endmacro] を集める。 */
export function findMacros(ir: ScenarioIR, file: string): MacroSource[] {
  const out: MacroSource[] = [];
  ir.commands.forEach((c, i) => {
    if (c.name === "macro" && c.next !== undefined) out.push({ name: c.pm.name ?? "", file, line: c.line, ir, start: i, end: c.next });
  });
  return out;
}

/**
 * 本文から実際に呼ばれるマクロだけを残す（呼ばれるマクロの中で呼ぶマクロも含める）。
 * system/ 下やプラグインには、その作品が使わないマクロ（別の機能の部品など）も多く、変換すると要らない手作業が増えるため。
 * roots は本文のファイル（マクロの定義の中は除く）。
 */
export function reachableMacros(sources: readonly MacroSource[], roots: readonly ScenarioIR[]): { used: MacroSource[]; unused: MacroSource[] } {
  const byName = new Map<string, MacroSource[]>();
  for (const m of sources) byName.set(m.name, [...(byName.get(m.name) ?? []), m]);
  const used = new Set<string>();
  const queue: string[] = [];
  const visit = (commands: ScenarioIR["commands"], from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const c = commands[i]!;
      if (c.name === "macro" && c.next !== undefined) {
        i = c.next; // 定義の中は、そのマクロが呼ばれたときに見る
        continue;
      }
      if (byName.has(c.name) && !used.has(c.name)) {
        used.add(c.name);
        queue.push(c.name);
      }
    }
  };
  for (const ir of roots) visit(ir.commands, 0, ir.commands.length);
  while (queue.length > 0) {
    for (const m of byName.get(queue.shift()!) ?? []) visit(m.ir.commands, m.start + 1, m.end);
  }
  return { used: sources.filter((m) => used.has(m.name)), unused: sources.filter((m) => !used.has(m.name)) };
}

/** マクロを呼んでいるタグが渡している引数の名前（`*` を使うマクロの引数を決めるため）。 */
export function collectCallKeys(ir: ScenarioIR, names: ReadonlySet<string>, into: Map<string, Set<string>>): void {
  for (const c of ir.commands) {
    if (!names.has(c.name)) continue;
    const keys = into.get(c.name) ?? new Set<string>();
    for (const k of Object.keys(c.pm)) if (k !== "cond" && k !== "*" && !k.startsWith("_")) keys.add(k);
    into.set(c.name, keys);
  }
}

export interface MacroBuild {
  signatures: Map<string, MacroSignature>;
  /** 書き出す @define（行）。マクロを書いた場所ごと。 */
  defines: { source: MacroSource; lines: string[] }[];
  diagnostics: Diagnostic[];
  stats: ConvertStats;
  speakers: Set<string>;
  cast: Set<string>;
  /** storage で直接指定された画像に付けた表情名（convert の variants と同じ）。 */
  variants: Map<string, Map<string, string>>;
}

/**
 * マクロを @define にする。library を渡すとそのファイルに置く前提の呼び出し方（呼ぶ側が @use する）を返す。
 * 変換が直接扱うタグと同じ名前のマクロ（TyranoBuilder のマクロなど）と、TyranoScript のタグと同じ名前のマクロ
 * （TyranoScript でも呼ばれない）は @define にしない。
 */
export function buildMacros(
  sources: readonly MacroSource[],
  options: ConvertOptions,
  callKeys: ReadonlyMap<string, ReadonlySet<string>>,
  /** @define を置くファイル。省くとマクロを書いたファイルに置く。 */
  library?: { file: string; /** マクロを書いた .ks が .lim になる名前（本文として変換しないファイルなら null）。 */ target(file: string): string | null },
): MacroBuild {
  const diagnostics: Diagnostic[] = [];
  const report = (s: MacroSource, severity: Diagnostic["severity"], code: string, message: string) =>
    diagnostics.push({ severity, code, message, file: s.file, line: s.line });
  const registry = options.registry ?? createRegistry(CORE_COMMANDS);

  // 同じ名前のマクロは先に見つけたものを使う。
  const chosen = new Map<string, MacroSource>();
  for (const s of sources) {
    const first = chosen.get(s.name);
    if (!first) {
      chosen.set(s.name, s);
      continue;
    }
    if (bodyKey(first) !== bodyKey(s)) {
      report(s, "error", "macro-redefined", `マクロ ${s.name} は ${first.file}:${first.line} にも違う中身で定義されています（${first.file} のものを使います）`);
    }
  }

  const signatures = new Map<string, MacroSignature>();
  const bodies = new Map<string, MacroBody>();
  const usedNames = new Set<string>();
  for (const [name, s] of chosen) {
    if (TYRANO_TAGS.has(name)) {
      report(s, "info", "macro-shadowed", `マクロ ${name} は TyranoScript のタグと同じ名前なので、TyranoScript でも呼ばれません（取り込みません）`);
      continue;
    }
    if (directlyConverted(name, options)) {
      report(s, "info", "macro-direct", `マクロ ${name} は変換が直接扱うので @define にしません`);
      continue;
    }
    let limName = name.toLowerCase().replace(/_/g, "-").replace(/^-+|-+$/g, "");
    if (!/^[a-z][a-z0-9-]*$/.test(limName)) {
      report(s, "error", "macro-name", `マクロ名 ${name} は .lim の命令名（英小文字・数字・-）にできません`);
      continue;
    }
    if (registry.has(limName) || usedNames.has(limName)) {
      const renamed = `${limName}-macro`;
      report(s, "info", "macro-renamed", `マクロ ${name} は命令 @${limName} と重なるので @${renamed} にしました`);
      limName = renamed;
    }
    usedNames.add(limName);
    const body = collectParams(s, callKeys.get(name), (severity, code, message) => report(s, severity, code, message));
    bodies.set(name, { ...body, file: library === undefined ? null : (library.target(s.file) ?? "") });
    signatures.set(name, { ks: name, name: limName, params: body.params, ...(library !== undefined ? { library: library.file } : {}) });
  }

  // 引数の型を、渡している先の命令の引数の型から決める。マクロからマクロへ渡すものがあるので、変わらなくなるまで繰り返す。
  const run = (name: string) => {
    const s = chosen.get(name)!;
    return convert("", s.file, { ...options, macros: signatures }, { ir: s.ir, from: s.start + 1, to: s.end, macro: bodies.get(name)! });
  };
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const name of signatures.keys()) {
      const sig = signatures.get(name)!;
      const slots = slotTypes(run(name).text, sig, signatures, registry);
      for (const p of sig.params.values()) {
        const slot = slots.get(p.local);
        if (!slot || slot.type === p.type) continue;
        p.type = slot.type;
        if (slot.default !== undefined) p.slotDefault = slot.default;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 書き出す。
  const out: MacroBuild = { signatures, defines: [], diagnostics, stats: { byTag: {} }, speakers: new Set(), cast: new Set(), variants: new Map() };
  for (const sig of signatures.values()) for (const p of sig.params.values()) p.default = finalDefault(p);
  for (const [name, sig] of signatures) {
    const s = chosen.get(name)!;
    const result = run(name);
    diagnostics.push(...result.diagnostics);
    for (const [tag, outcomes] of Object.entries(result.stats.byTag)) {
      const t = (out.stats.byTag[tag] ??= {});
      for (const [k, n] of Object.entries(outcomes) as [keyof typeof outcomes, number][]) t[k] = (t[k] ?? 0) + n;
    }
    for (const sp of result.speakers) out.speakers.add(sp);
    for (const c of result.cast) out.cast.add(c);
    for (const [who, map] of result.variants) {
      const merged = out.variants.get(who) ?? new Map<string, string>();
      out.variants.set(who, merged);
      for (const [variant, image] of map) if (!merged.has(variant)) merged.set(variant, image);
    }
    const params = [...sig.params.values()].map((p) => `${p.name}: ${p.type} = ${p.default}`).join(", ");
    const body = result.text.trimEnd().split("\n").filter((l, i, a) => !(l === "" && (i === 0 || i === a.length - 1)));
    out.defines.push({ source: s, lines: [`// [macro name=${name}]（${s.file}:${s.line}）`, `@define ${sig.name}(${params})`, ...body.map((l) => (l === "" ? "" : `  ${l}`)), "@end"] });
  }
  return out;
}

/** マクロの中身から引数を集める。 */
function collectParams(s: MacroSource, callKeys: ReadonlySet<string> | undefined, report: Report): Omit<MacroBody, "file"> {
  const params = new Map<string, MacroParam>();
  const names = new Map<string, string>();
  let spread = false;
  const add = (ks: string, def: string | null) => {
    const existing = params.get(ks);
    if (existing) {
      if (def === null) return;
      if (existing.ksDefault === null) existing.ksDefault = def;
      else if (existing.ksDefault !== def) report("warning", "macro-default", `マクロ ${s.name} の引数 ${ks} の既定値が場所によって違います（${existing.ksDefault} を使います）`);
      return;
    }
    const lower = ks.toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(lower) || ["game", "system", "temp"].includes(lower)) {
      report("error", "macro-param-name", `マクロ ${s.name} の引数名 ${ks} は @define の引数名にできません`);
      return;
    }
    if ([...params.values()].some((p) => p.local === lower)) {
      report("error", "macro-param-name", `マクロ ${s.name} の引数名 ${ks} は、大文字と小文字だけが違う引数と重なります`);
      return;
    }
    params.set(ks, { ks, name: lower.replace(/_/g, "-"), local: lower, type: "string", default: '""', ksDefault: def });
    names.set(ks, lower);
  };
  for (let i = s.start + 1; i < s.end; i++) {
    const c = s.ir.commands[i]!;
    if (c.name === "text" || c.name === "label" || c.name === "iscript") continue;
    if (c.pm["*"] !== undefined) spread = true;
    for (const [key, value] of Object.entries(c.pm)) {
      if (value.startsWith("%")) {
        const [name = "", def] = value.slice(1).split("|").map((v) => v.trim());
        if (name !== "") add(name, def ?? null);
      }
      if (key === "exp" || key === "cond" || value.startsWith("&")) for (const m of value.matchAll(/\bmp\.([A-Za-z_$][\w$]*)/g)) add(m[1]!, null);
    }
  }
  if (spread) for (const k of callKeys ?? []) add(k, null);
  return { names, params, spread };
}

/** 書き出した @define の中身で、引数がどの命令のどの型の引数に渡されているか。 */
function slotTypes(text: string, sig: MacroSignature, signatures: ReadonlyMap<string, MacroSignature>, registry: ReadonlyMap<string, CommandSpec>) {
  const locals = new Set([...sig.params.values()].map((p) => p.local));
  const slots = new Map<string, { type: MacroParam["type"]; default?: string }>();
  const specs = new Map<string, CommandSpec>(registry);
  for (const other of signatures.values()) specs.set(other.name, signatureSpec(other));
  const visitArgs = (name: string, args: Argument[]) => {
    const spec = specs.get(name);
    if (!spec) return;
    let position = 0;
    for (const a of args) {
      const key = a.key ?? spec.positional[position++];
      if (key === undefined || a.value.kind !== "expr" || a.value.expr.kind !== "name" || !locals.has(a.value.expr.name)) continue;
      const p = spec.params[key];
      if (!p || slots.has(a.value.expr.name)) continue;
      const type = defineType(p.type);
      if (type !== "string") slots.set(a.value.expr.name, p.default !== undefined ? { type, default: p.default } : { type });
    }
  };
  const visitInline = (content: Inline[]) => {
    for (const n of content) {
      if (n.kind === "command") visitArgs(n.name, n.args);
      else if ("children" in n) visitInline(n.children);
    }
  };
  const visit = (body: Statement[]) => {
    for (const st of body) {
      if (st.kind === "command") visitArgs(st.name, st.args);
      if (st.kind === "say" || st.kind === "prose") visitInline(st.content);
      if (st.kind === "if") for (const b of st.branches) visit(b.body);
    }
  };
  visit(parse(text, "macro").body);
  return slots;
}

function defineType(t: ParamType): MacroParam["type"] {
  switch (t.kind) {
    case "duration":
    case "bool":
    case "color":
      return t.kind;
    case "number":
    case "int":
      return "number";
    default:
      return "string";
  }
}

/**
 * 型の決まった引数の既定値（.lim の書き方）。`%名前|既定値` の既定値、なければ渡している先の命令の引数の既定値、
 * それもなければ型ごとの空の値（.ks では省いた引数は空の文字列になる）。
 */
function finalDefault(p: MacroParam): string {
  if (p.ksDefault !== null) return typedValue(p.type, p.ksDefault);
  if (p.slotDefault !== undefined) return p.slotDefault;
  return { string: '""', number: "0", bool: "false", duration: "0ms", color: "#000000" }[p.type];
}

/** マクロの呼び出しの仕様（型の決まり具合を見るため）。 */
export function signatureSpec(sig: MacroSignature): CommandSpec {
  const params: Record<string, CommandSpec["params"][string]> = {};
  for (const p of sig.params.values()) params[p.name] = { type: { kind: p.type === "number" ? "number" : p.type } as ParamType, default: p.default, doc: "" };
  return { name: sig.name, summary: "", positional: [], params, example: "" };
}

/** 変換がこのタグを直接扱うか（汎用の形にならないか）。 */
function directlyConverted(name: string, options: ConvertOptions): boolean {
  const probe = convert(`[${name}]`, "probe.ks", { ...options, macros: new Map() });
  return probe.stats.byTag[name] !== undefined && probe.stats.byTag[name]!.generic === undefined;
}

function bodyKey(s: MacroSource): string {
  return JSON.stringify(s.ir.commands.slice(s.start + 1, s.end).map((c) => [c.name, c.pm, c.val]));
}

/**
 * このファイルの中の [macro] を、このファイルの @define にする（convert を単独で使うとき）。
 * 返す defines のキーは [macro] の位置。
 */
export function localMacros(ir: ScenarioIR, file: string, options: ConvertOptions) {
  const sources = findMacros(ir, file);
  if (sources.length === 0) return { macros: new Map<string, MacroSignature>(), defines: new Map<number, string[]>(), diagnostics: [], stats: { byTag: {} } as ConvertStats };
  const keys = new Map<string, Set<string>>();
  collectCallKeys(ir, new Set(sources.map((s) => s.name)), keys);
  const build = buildMacros(sources, options, keys);
  return {
    macros: build.signatures,
    defines: new Map(build.defines.map((d) => [d.source.start, d.lines])),
    diagnostics: build.diagnostics,
    stats: build.stats,
  };
}

/** .ks を一行ずつ変換し直さずに、マクロの中身だけを持つ中間表現（テスト用）。 */
export function compileMacros(source: string, file: string): MacroSource[] {
  return findMacros(compile(source, file), file);
}

/**
 * このエンジンでは扱わないタグ。manual は手で直さないと意味が欠けるもの（手作業の対象として数える）。
 * そうでないものは書き出さずに、理由を警告として残す。
 */
export const UNSUPPORTED: Record<string, { reason: string; manual: boolean }> = {
  deffont: { reason: "既定の文字の見た目は、プラグインの本文の見た目（TextTheme）か CSS で決めます", manual: false },
  position: { reason: "メッセージ枠の位置・大きさ・見た目は、liminalia.json の ui.message（縦書きは @vertical）で決めます", manual: false },
  message_config: { reason: "メッセージ枠の文字の組み方は、CSS かプラグインの本文の見た目（TextTheme）で決めます", manual: false },
  glyph: { reason: "クリック待ちの記号は、プラグインの本文の見た目（TextTheme.glyph）で作ります", manual: false },
  glyph_auto: { reason: "オート中の記号は、システム画面で作ります", manual: false },
  glyph_skip: { reason: "スキップ中の記号は、システム画面で作ります", manual: false },
  glink_config: { reason: "選択肢のボタンの並べ方と出方は CSS で決めます", manual: false },
  cursor: { reason: "マウスカーソルの見た目は CSS で決めます", manual: false },
  wt: { reason: "トランジションの終わりは、トランジションの命令の wait=true で待ちます", manual: false },
  wa: { reason: "アニメーションの終わりは、アニメーションの命令の wait=true で待ちます", manual: false },
  wb: { reason: "イベントを待つ仕組みは持ちません", manual: false },
  wait_cancel: { reason: "@wait を外から止める仕組みは持ちません", manual: false },
  trace: { reason: "開発用の出力です。流れは lim trace で見ます", manual: false },
  erasemacro: { reason: "マクロは @define になり、消せません。消したあとに同じ名前のタグを別の意味で使っているなら、呼び出しを直してください", manual: true },
  graph: { reason: "本文の中に画像は置けません。記号は文字（絵文字）で書くか、@image で置いてください", manual: true },
  html: { reason: "JS（<script>・on… の属性・javascript:）や、ほかのタグ・埋め込みを含む HTML は @html にできません。JS を除いて @html で書き直すか、プラグインの命令と描画（@liminalia/sdk・@liminalia/web）で作ってください", manual: true },
  loadjs: { reason: "JS は読み込みません。同じ働きをプラグインの命令と描画（@liminalia/sdk・@liminalia/web）で作ってください", manual: true },
  loadcss: { reason: "CSS はプラグインの描画側（WebPlugin.setup）で読み込んでください", manual: true },
  speak_on: { reason: "本文の読み上げは、遊ぶ人がコンフィグの「テキスト読み上げ」で切り替えます（シナリオからは切り替えません）", manual: false },
  speak_off: { reason: "本文の読み上げは、遊ぶ人がコンフィグの「テキスト読み上げ」で切り替えます（シナリオからは切り替えません）", manual: false },
  tb_replay_image_button: { reason: "回想の鑑賞のボタンはシステム画面で作ります（@replay-unlock で見られるようにしたものを並べる）", manual: true },
  tb_cg_image_button: { reason: "CG の鑑賞のボタンはシステム画面で作ります（@cg-unlock で見られるようにしたものを並べる）", manual: true },
  tb_replay_start: { reason: "回想の始めの片付けは、システム画面が回想を始めるときに行います", manual: false },
};

/** TyranoScript のタグの名前（同じ名前のマクロは TyranoScript でも呼ばれない）。 */
const TYRANO_TAGS: ReadonlySet<string> = new Set(
  (
    "anim autoconfig autoload autosave autostart autostop awakegame backlay bg bg2 bgcamera bgmopt bgmovie body breakgame button call camera " +
    "cancelskip changevol chara_config chara_delete chara_face chara_hide chara_hide_all chara_layer chara_layer_mod chara_mod chara_move chara_new " +
    "chara_part chara_part_reset chara_ptext chara_show checkpoint clear_checkpoint clearfix clearstack clearsysvar clearvar clickable close " +
    "closeconfirm_off closeconfirm_on cm commit configdelay ct current cursor deffont delay dialog dialog_config edit else elsif emb endhtml endif " +
    "endignore endkeyframe endlink endmacro endmark endnolog endnowait endscript er erasemacro eval fadeinbgm fadeinse fadeoutbgm fadeoutse filter " +
    "font frame free free_filter free_layermode freeimage freelayer fuki_chara fuki_start fuki_stop glink glink_config glyph glyph_auto glyph_skip " +
    "graph hidemenubutton hidemessage html if ignore image iscript jump kanim keyframe l label layermode layermode_movie layopt link loadcss loadjs " +
    "locate macro mark mask mask_off message_config mode_effect movie mtext nolog nowait p pausebgm pausese playbgm playse plugin popopo position " +
    "preload ptext pushlog quake quake2 r reset_camera resetdelay resetfont resumebgm resumese return rollback ruby s save_img savesnap screen_full " +
    "seopt showload showlog showmenu showmenubutton showsave skipstart skipstop sleepgame speak_off speak_on start_keyconfig stop_bgcamera " +
    "stop_bgmovie stop_kanim stop_keyconfig stop_xanim stopanim stopbgm stopse sysview text title trace trans unload vibrate vibrate_stop voconfig " +
    "vostart vostop wa wait wait_bgmovie wait_camera wait_cancel wait_preload wb wbgm web wse wt xanim xchgbgm"
  ).split(" "),
);
