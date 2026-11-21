import { normalizeBooleanArgs } from "./args.ts";
import type { Argument, Diagnostic, Inline, Literal, Script, Statement, Target } from "./ast.ts";
import { parseLiteral, parseTargetText } from "./args.ts";
import { commandText } from "./cg.ts";
import type { CommandSpec, Registry } from "./registry.ts";

/**
 * 音の抜けの検査（lim check と制作画面のチェック。liminalia.json の check.sound）。
 * 台本を流れ（@jump、@call、選択肢、ファイルの終わりまでの続き）に沿ってたどり、BGM とループの効果音（環境音）が
 * 鳴っているかを追う。どこから来ても同じと言えるときだけ知らせる（分岐で決まらなければ「分からない」にして黙る）。
 * - long-silence（警告）: BGM も環境音も鳴らないまま、本文（台詞と地の文）が check.sound.silence 行（既定 30）以上続く
 * - redundant-stop（情報）: 鳴っていないのに止める（@stop-bgm、@scene-change stop-bgm=true、@stop-se）
 * - loop-across-files（情報）: ほかのファイルで鳴らしたループの効果音が、@jump や選択肢で移ったファイルでも鳴り続けている
 *
 * はじめ（entry）と、おまけの回想と章から始める所は何も鳴っていない状態から、ロードの後の呼び出し（afterLoad）とどこからも入らない場面は
 * 分からない状態から始める。マクロ（@define）は呼んだ所で中をたどる。@call の先は、@return までに音を変えなければそのまま、
 * 変えればその音を分からないものにする。
 */

/** 外せる診断（check.sound.off）。 */
export const SOUND_CHECKS = ["long-silence", "redundant-stop", "loop-across-files"] as const;
/** 無音の区間を知らせる本文の行数の既定（check.sound.silence）。 */
export const DEFAULT_SILENCE_LINES = 30;

/** liminalia.json の check.sound。false ですべて外す。 */
export interface SoundCheckConfig {
  /** BGM も環境音も鳴らない本文がこの行数（1 以上）続いたら知らせる。既定 30。 */
  silence?: number;
  /** わざと無音にした場面（`ファイル` か `ファイル#ラベル`）。その中の本文は無音の区間に数えない。 */
  quiet?: string[];
  /** ファイルをまたいで鳴らしてよいループの効果音（sound からのパス）。 */
  carry?: string[];
  /** 知らせない診断（long-silence、redundant-stop、loop-across-files）。 */
  off?: string[];
}

export interface SoundCheckInput {
  scripts: ReadonlyMap<string, Script>;
  /** 組み込みとプラグインの命令（作品の既定値 commandDefaults を重ねたもの）。 */
  registry: Registry;
  /** liminalia.json の check.sound。 */
  config?: unknown;
  /** 「はじめから」の位置（liminalia.json の entry）。何も鳴っていない状態から始める。無ければどこも分からない状態から。 */
  entry?: string;
  /** 新しく始める位置（おまけの回想と章の target）。何も鳴っていない状態から始める。 */
  fresh?: Iterable<string>;
  /** 台本の外から呼ぶ位置（afterLoad など）。鳴っているものが分からない状態から始める。 */
  references?: Iterable<string>;
  /** プラグインの命令が飛ぶかもしれない先（`ファイル:行` → 飛び先。promisedTargets）。その命令から、その時の音で入る。 */
  promised?: ReadonlyMap<string, readonly string[]>;
  /** 式の飛び先の候補（targetCandidates）。 */
  candidates?: (target: Target, file: string) => string[] | null;
}

// ---- 音の様子 ----

type Bgm = "off" | "on" | "paused" | "unknown";
/** ループの効果音。from はそれを鳴らしたファイル（分からなければ null）、line はその行（一つに決まらなければ null）。 */
interface Loop {
  file: string | null;
  from: string | null;
  line: number | null;
}
/** チャンネルの様子。oneshot は一回きりの音を鳴らした（まだ鳴っているかもしれないが、ループではない）。 */
type Channel = Loop | "off" | "oneshot" | "unknown";
interface Silence {
  count: number;
  /** 数え始めた本文の行と、その場面（`ファイル` か `ファイル#ラベル`）。まだ数えていなければ null。 */
  start: { file: string; line: number; scene: string } | null;
}
interface State {
  bgm: Bgm;
  /** チャンネル（"0" など）→ 様子。無いチャンネルは rest。 */
  se: Map<string, Channel>;
  rest: "off" | "unknown";
  /** BGM も環境音も鳴っていないと言えるときの、続いている本文の行数。言えなければ null。 */
  silent: Silence | null;
}

const fresh = (): State => ({ bgm: "off", se: new Map(), rest: "off", silent: { count: 0, start: null } });
const unknown = (): State => ({ bgm: "unknown", se: new Map(), rest: "unknown", silent: null });
const clone = (s: State): State => ({ bgm: s.bgm, se: new Map(s.se), rest: s.rest, silent: s.silent ? { count: s.silent.count, start: s.silent.start } : null });
const channel = (s: State, c: string): Channel => s.se.get(c) ?? s.rest;
const isLoop = (c: Channel): c is Loop => typeof c === "object";

function sameChannel(a: Channel, b: Channel): boolean {
  if (isLoop(a) && isLoop(b)) return a.file === b.file && a.from === b.from && a.line === b.line;
  return a === b;
}

function joinChannel(a: Channel, b: Channel): Channel {
  if (sameChannel(a, b)) return a;
  if (isLoop(a) && isLoop(b)) {
    if (a.file !== b.file) return "unknown";
    return { file: a.file, from: a.from === b.from ? a.from : null, line: a.from === b.from && a.line === b.line ? a.line : null };
  }
  if ((a === "off" && b === "oneshot") || (a === "oneshot" && b === "off")) return "oneshot";
  return "unknown";
}

/** 二つの流れが合わさったところの様子（どちらでも言えることだけ残す）。 */
function join(a: State, b: State): State {
  const rest = a.rest === "off" && b.rest === "off" ? "off" : "unknown";
  const se = new Map<string, Channel>();
  for (const c of new Set([...a.se.keys(), ...b.se.keys()])) {
    const v = joinChannel(channel(a, c), channel(b, c));
    if (!sameChannel(v, rest)) se.set(c, v);
  }
  let silent: Silence | null = null;
  if (a.silent && b.silent) silent = a.silent.count <= b.silent.count ? a.silent : b.silent;
  return { bgm: a.bgm === b.bgm ? a.bgm : "unknown", se, rest, silent };
}

function same(a: State, b: State): boolean {
  if (a.bgm !== b.bgm || a.rest !== b.rest || a.se.size !== b.se.size) return false;
  for (const [c, v] of a.se) if (!sameChannel(v, channel(b, c))) return false;
  if (!a.silent || !b.silent) return a.silent === b.silent;
  const x = a.silent.start;
  const y = b.silent.start;
  return a.silent.count === b.silent.count && (x === y || (!!x && !!y && x.file === y.file && x.line === y.line));
}

/**
 * BGM も環境音も鳴っていないと言えるか。loops は作品の中でループの効果音に使うチャンネル（台本から数え切れたとき）。
 * ほかのチャンネルが分からなくても（rest が unknown）、loops のチャンネルがどれも止まっていれば環境音は鳴っていない。
 */
function quietNow(s: State, loops: ReadonlySet<string> | null): boolean {
  if (s.bgm !== "off" && s.bgm !== "paused") return false;
  for (const v of s.se.values()) if (v !== "off" && v !== "oneshot") return false;
  if (s.rest === "off") return true;
  if (!loops) return false;
  for (const c of loops) {
    const v = channel(s, c);
    if (v !== "off" && v !== "oneshot") return false;
  }
  return true;
}

/** 音を変えたあと、無音の数えを合わせる（鳴り始めたら外し、鳴りやんだら 0 から）。 */
function settle(s: State, loops: ReadonlySet<string> | null): void {
  if (!quietNow(s, loops)) s.silent = null;
  else s.silent ??= { count: 0, start: null };
}

/** チャンネルの様子を入れる（rest と同じなら外す）。 */
function setChannel(s: State, c: string, v: Channel): void {
  if (sameChannel(v, s.rest)) s.se.delete(c);
  else s.se.set(c, v);
}

/** すべてのチャンネルを分からないものにする。 */
function seUnknown(s: State): void {
  s.se.clear();
  s.rest = "unknown";
}

// ---- 台本の場面 ----

interface Segment {
  id: string;
  file: string;
  stmts: Statement[];
  /** 同じファイルの次の場面（ファイルの終わりなら null）。 */
  next: string | null;
}

/** 呼んだ先が音を変えるか（@call の先、プラグインの命令の飛び先、call=true の選択肢）。opaque は別の場所へ移るなどで分からない。 */
interface Effect {
  bgm: boolean;
  se: boolean;
  opaque: boolean;
}

/** 引数の値（書いたものと既定値。マクロの中の (パラメータ) は呼んだ側の値）。 */
type ArgValues = Map<string, { value: Literal; written: boolean }>;

interface Walk {
  /** 本文と命令の位置にするファイル（マクロの中では呼んだ側のファイル）。 */
  file: string;
  /** 飛び先を読むファイル（マクロの中ではマクロのあるファイル）。 */
  home: string;
  /** 今の場面（`ファイル` か `ファイル#ラベル`）。 */
  scene: string;
  quiet: boolean;
  report: boolean;
  /** マクロのパラメータの値。 */
  env: ReadonlyMap<string, Literal>;
  /** マクロの中なら、@return で戻るときの様子を集める。 */
  returns: State[] | null;
  /** @with で渡された中身（マクロの中の @content）。 */
  content: { body: Statement[]; walk: Walk } | null;
  /** マクロの中なら、呼んだ行（知らせる位置）。 */
  site: number | null;
  /** 中をたどっているマクロ。 */
  stack: readonly string[];
}

const MAX_MACRO_DEPTH = 12;
/** たどる命令の数の上限（とても大きな作品で止まらないように。越えたら音の検査をやめる）。 */
const MAX_STEPS = 3_000_000;

/** 音の抜けを調べる。 */
export function checkSound(input: SoundCheckInput): Diagnostic[] {
  const out: Diagnostic[] = [];
  const config = readSoundConfig(input.config, input.scripts, out);
  if (!config) return out;
  const { registry } = input;
  const enabled = (code: string) => !config.off.has(code);

  // ---- 場面とマクロ ----
  const segments = new Map<string, Segment>();
  const order: string[] = [];
  const macros = new Map<string, { stmt: Extract<Statement, { kind: "define" }>; file: string }>();
  for (const [file, script] of input.scripts) {
    let current: Segment = { id: file, file, stmts: [], next: null };
    const list: Segment[] = [current];
    for (const s of script.body) {
      if (s.kind === "label") {
        current = { id: `${file}#${s.name}`, file, stmts: [], next: null };
        list.push(current);
        continue;
      }
      if (s.kind === "define") {
        if (s.name !== "" && !macros.has(s.name)) macros.set(s.name, { stmt: s, file });
        continue;
      }
      current.stmts.push(s);
    }
    list.forEach((seg, i) => {
      seg.next = list[i + 1]?.id ?? null;
      if (!segments.has(seg.id)) {
        segments.set(seg.id, seg);
        order.push(seg.id);
      }
    });
  }
  const sceneQuiet = (id: string, file: string) => config.quiet.has(id) || config.quiet.has(file);

  const nodesOf = (target: Target, file: string): string[] => {
    const list = target.expr ? (target.candidates ?? input.candidates?.(target, file) ?? []) : [null];
    const ids: string[] = [];
    for (const c of list) {
      const t = c === null ? target : parseTargetText(c.trim());
      if (!t || t.expr) continue;
      const f = t.file ?? file;
      const id = t.label === null ? f : `${f}#${t.label}`;
      if (segments.has(id)) ids.push(id);
    }
    return ids;
  };
  const nodeOfText = (text: string, file: string): string | null => {
    const t = parseTargetText(text.trim());
    if (!t || t.expr) return null;
    const f = t.file ?? file;
    const id = t.label === null ? f : `${f}#${t.label}`;
    return segments.has(id) ? id : null;
  };

  // ---- 引数 ----
  const readArgs = (spec: CommandSpec | undefined, args: readonly Argument[], env: ReadonlyMap<string, Literal>): ArgValues => {
    const values: ArgValues = new Map();
    let position = 0;
    for (const a of spec ? normalizeBooleanArgs(spec, args) : args) {
      const key = a.key ?? spec?.positional[position++];
      if (key === undefined) continue;
      let value = a.value;
      if (value.kind === "expr" && value.expr.kind === "name") value = env.get(value.expr.name) ?? value;
      values.set(key, { value, written: true });
    }
    for (const [key, p] of Object.entries(spec?.params ?? {})) {
      if (values.has(key) || p.default === undefined) continue;
      try {
        values.set(key, { value: parseLiteral(p.default), written: false });
      } catch {
        // 読めない既定値は無いものとする
      }
    }
    return values;
  };
  const boolOf = (v: ArgValues, key: string): boolean | undefined => {
    const x = v.get(key)?.value;
    return x?.kind === "bool" ? x.value : undefined;
  };
  const textOf = (v: ArgValues, key: string): string | undefined => {
    const x = v.get(key)?.value;
    return x?.kind === "string" ? x.value : x?.kind === "number" ? String(x.value) : undefined;
  };
  const has = (v: ArgValues, key: string) => v.has(key);

  /**
   * 作品の中でループの効果音に使うチャンネル（@se … loop=true の channel）。チャンネルが式やマクロのパラメータで決まるもの、
   * 効果音をループで鳴らすプラグインの命令があれば数え切れないので null（そのときは鳴っていないチャンネルを言い切らない）。
   */
  const loopChannels = ((): Set<string> | null => {
    const found = new Set<string>();
    let open = true;
    const see = (name: string, args: readonly Argument[]) => {
      if (macros.has(name)) return;
      const spec = registry.get(name);
      if (name === "se") {
        const v = readArgs(spec, args, new Map());
        if (boolOf(v, "loop") === false) return;
        const c = textOf(v, "channel");
        if (c === undefined) open = false;
        else found.add(c);
      } else if (spec && !CORE_SOUND.has(name) && pluginEffect(spec).se) open = false;
    };
    const visit = (body: readonly Statement[]) => {
      for (const st of body) {
        if (st.kind === "command") see(st.name, st.args);
        else if (st.kind === "say" || st.kind === "prose") for (const c of inlineCommands(st.content)) see(c.name, c.args);
        else if (st.kind === "if") {
          if (st.with) see(st.with.name, st.with.args);
          for (const b of st.branches) visit(b.body);
        } else if (st.kind === "define") visit(st.body);
      }
    };
    for (const script of input.scripts.values()) visit(script.body);
    return open ? found : null;
  })();

  // ---- 呼んだ先の様子 ----
  const effects = new Map<string, Effect>();
  const commandEffect = (name: string, args: readonly Argument[], seen: Set<string>): Effect => {
    const none: Effect = { bgm: false, se: false, opaque: false };
    const macro = macros.get(name);
    if (macro) {
      if (seen.has(`@${name}`)) return none;
      seen.add(`@${name}`);
      return blockEffect(macro.stmt.body, macro.file, seen);
    }
    const spec = registry.get(name);
    if (spec?.ends || name === "stop") return none;
    switch (name) {
      case "bgm":
      case "stop-bgm":
      case "pause-bgm":
      case "resume-bgm":
        return { bgm: true, se: false, opaque: false };
      case "se":
      case "stop-se":
      case "pause-se":
      case "resume-se":
        return { bgm: false, se: true, opaque: false };
      case "scene-change": {
        const v = readArgs(spec, args, new Map());
        return { bgm: has(v, "bgm") || boolOf(v, "stop-bgm") !== false, se: false, opaque: false };
      }
      case "awake-game":
      case "rollback":
      case "autoload":
        return { bgm: true, se: true, opaque: true };
    }
    if (spec && !CORE_SOUND.has(name)) {
      const e = pluginEffect(spec);
      if (e.bgm || e.se) return { ...e, opaque: false };
    }
    return none;
  };
  const blockEffect = (body: readonly Statement[], file: string, seen: Set<string>): Effect => {
    const e: Effect = { bgm: false, se: false, opaque: false };
    const add = (x: Effect) => {
      e.bgm ||= x.bgm;
      e.se ||= x.se;
      e.opaque ||= x.opaque;
    };
    for (const s of body) {
      if (s.kind === "command") add(commandEffect(s.name, s.args, seen));
      else if (s.kind === "say" || s.kind === "prose") for (const c of inlineCommands(s.content)) add(commandEffect(c.name, c.args, seen));
      else if (s.kind === "if") {
        if (s.with) add(commandEffect(s.with.name, s.with.args, seen));
        for (const b of s.branches) add(blockEffect(b.body, file, seen));
      } else if (s.kind === "jump" || s.kind === "choice") e.opaque = true;
      else if (s.kind === "call") for (const id of nodesOf(s.target, file)) add(regionEffect(id, seen));
    }
    return e;
  };
  /**
   * 呼ばれた場面から @return（かファイルの終わり）までの様子。ラベルは越えて続ける。
   * 一番外の @jump や @stop で別の所へ移って終わる場面は、その移る行を様子に入れない（呼んだ所へは戻らない。returns が false）。
   */
  const returnsOf = new Map<string, boolean>();
  const regionEffect = (id: string, seen = new Set<string>()): Effect => {
    const memo = effects.get(id);
    if (memo) return memo;
    if (seen.has(id)) return { bgm: false, se: false, opaque: false };
    seen.add(id);
    const e: Effect = { bgm: false, se: false, opaque: false };
    let returns = true;
    for (let seg = segments.get(id); seg; seg = seg.next ? segments.get(seg.next) : undefined) {
      const top = seg.stmts.findIndex((s) => s.kind === "return" || s.kind === "jump" || (s.kind === "command" && (s.name === "stop" || registry.get(s.name)?.ends === true) && !macros.has(s.name)));
      const leaves = top >= 0 && seg.stmts[top]!.kind !== "return";
      const body = top < 0 ? seg.stmts : seg.stmts.slice(0, leaves ? top : top + 1);
      const x = blockEffect(body, seg.file, seen);
      e.bgm ||= x.bgm;
      e.se ||= x.se;
      e.opaque ||= x.opaque;
      // 一番外で移って終わっても、それより前の @if の中の @return で戻ることはある
      if (leaves) returns = hasReturn(body);
      if (top >= 0) break;
    }
    effects.set(id, e);
    returnsOf.set(id, returns);
    return e;
  };
  /** 呼ばれた場面が呼んだ所へ戻ることがあるか（regionEffect を先に呼ぶ）。 */
  const regionReturns = (id: string): boolean => {
    regionEffect(id);
    return returnsOf.get(id) ?? true;
  };
  /** 呼び出す（@call、call=true の選択肢、プラグインの命令の行き先）ときの様子。呼んだ先は同じ場面の続きなので、鳴っているループはそこで鳴らしたものとみなす。 */
  const called = (s: State): State => {
    const t = clone(s);
    for (const [c, v] of t.se) if (isLoop(v)) t.se.set(c, { file: v.file, from: null, line: null });
    return t;
  };
  const applyEffect = (s: State, e: Effect): State => {
    if (e.opaque) return unknown();
    const t = clone(s);
    if (e.bgm) t.bgm = "unknown";
    if (e.se) seUnknown(t);
    settle(t, loopChannels);
    return t;
  };

  // ---- 知らせる ----
  const reported = new Set<string>();
  const report = (d: Diagnostic) => {
    if (!enabled(d.code)) return;
    const key = `${d.code}:${d.file}:${d.line}:${d.message}`;
    if (reported.has(key)) return;
    reported.add(key);
    out.push(d);
  };
  /** 無音の区間（数え始めた位置 → いちばん長く続いた行数と、その終わり）。 */
  const stretches = new Map<string, { start: NonNullable<Silence["start"]>; count: number; end: { file: string; line: number } }>();
  /** ほかのファイルから鳴り続けるループ（鳴らした所と、続いているファイル → 最初の本文の行）。 */
  const carried = new Map<string, { file: string; line: number; loop: Loop; channel: string }>();

  // ---- たどる ----
  const entries = new Map<string, State>();
  const queue: string[] = [];
  const queued = new Set<string>();
  let steps = 0;
  let gaveUp = false;
  /** 知らせる段（様子は決まっているので、飛び先へは渡さない）。 */
  let reporting = false;
  const flow = (id: string, s: State) => {
    if (reporting) return;
    const old = entries.get(id);
    const next = old ? join(old, s) : clone(s);
    if (old && same(old, next)) return;
    entries.set(id, next);
    if (!queued.has(id)) {
      queued.add(id);
      queue.push(id);
    }
  };

  const text = (s: State, w: Walk, line: number) => {
    const at = w.site ?? line;
    if (s.silent && !w.quiet) {
      if (s.silent.count === 0 || !s.silent.start) s.silent = { count: 0, start: { file: w.file, line: at, scene: w.scene } };
      s.silent = { count: s.silent.count + 1, start: s.silent.start };
      if (w.report && s.silent.start) {
        const key = `${s.silent.start.file}:${s.silent.start.line}`;
        const old = stretches.get(key);
        if (!old || old.count < s.silent.count) stretches.set(key, { start: s.silent.start, count: s.silent.count, end: { file: w.file, line: at } });
      }
    }
    if (w.report) {
      for (const [c, v] of [...s.se.entries()]) {
        if (!isLoop(v) || v.from === null || v.from === w.file || v.file === null || config.carry.has(v.file)) continue;
        const key = `${v.from}:${v.line ?? ""}:${c}>${w.file}`;
        const old = carried.get(key);
        if (!old || old.line > at) carried.set(key, { file: w.file, line: at, loop: v, channel: c });
      }
    }
  };

  /** 命令を一つ。移った先が無くなれば（プレイの終わりか、ほかへ移った）null。 */
  const command = (name: string, args: readonly Argument[], line: number, s: State, w: Walk, content?: Statement[], inText = false): State | null => {
    const macro = macros.get(name);
    if (macro) return callMacro(macro, args, line, s, w, content);
    if (content) return s;
    const spec = registry.get(name);
    if (name === "stop" || spec?.ends) return null;
    const v = readArgs(spec, args, w.env);
    const at = w.site ?? line;
    // 本文の中の命令（{@…}）は行ごと消せない
    const deleteLine = inText ? {} : { fix: { kind: "delete-line" as const, text: commandText(name, args) } };
    switch (name) {
      case "bgm": {
        const loop = boolOf(v, "loop");
        s.bgm = loop === true ? "on" : "unknown";
        break;
      }
      case "stop-bgm":
        if (w.report && w.site === null && s.bgm === "off") {
          report({
            severity: "info",
            code: "redundant-stop",
            message: "@stop-bgm の時点で BGM は鳴っていません（どの流れから来ても止める曲がありません）",
            file: w.file,
            line: at,
            hint: "要らなければこの行を消します（BGM を鳴らすつもりだったなら、前に @bgm を書きます）",
            ...deleteLine,
          });
        }
        s.bgm = "off";
        break;
      case "pause-bgm":
        if (s.bgm === "on") s.bgm = "paused";
        break;
      case "resume-bgm":
        if (s.bgm === "paused") s.bgm = "on";
        break;
      case "scene-change":
        if (has(v, "bgm")) s.bgm = "on";
        else {
          const stop = boolOf(v, "stop-bgm");
          if (stop === true) {
            if (w.report && w.site === null && s.bgm === "off" && v.get("stop-bgm")?.written) {
              report({
                severity: "info",
                code: "redundant-stop",
                message: "stop-bgm=true の時点で BGM は鳴っていません（どの流れから来ても止める曲がありません）",
                file: w.file,
                line: at,
                hint: "要らなければ stop-bgm=true を消します（BGM を鳴らすつもりだったなら、前に @bgm を書きます）",
                fix: { kind: "replace", find: " stop-bgm=true", with: "" },
              });
            }
            s.bgm = "off";
          } else if (stop === undefined) s.bgm = "unknown";
        }
        break;
      case "se": {
        const c = textOf(v, "channel");
        const loop = boolOf(v, "loop");
        if (c === undefined) seUnknown(s);
        else if (loop === true) {
          const file = textOf(v, "file");
          setChannel(s, c, { file: file ?? null, from: w.file, line: at });
        } else if (loop === false) setChannel(s, c, "oneshot");
        else setChannel(s, c, "unknown");
        break;
      }
      case "stop-se": {
        const c = textOf(v, "channel");
        if (c === undefined) break;
        if (w.report && w.site === null && channel(s, c) === "off") {
          report({
            severity: "info",
            code: "redundant-stop",
            message: `@stop-se の時点でチャンネル ${c} の効果音は鳴っていません（どの流れから来ても止める音がありません）`,
            file: w.file,
            line: at,
            hint: "要らなければこの行を消します（ループの効果音を鳴らすつもりだったなら、前に @se … loop=true を書きます）",
            ...deleteLine,
          });
        }
        setChannel(s, c, "off");
        break;
      }
      case "pause-se":
      case "resume-se": {
        // 止めている間も鳴らしている間も、鳴っていなかったチャンネルはそのまま
        const c = textOf(v, "channel");
        if (has(v, "channel") && c === undefined) seUnknown(s);
        for (const k of c === undefined ? [...s.se.keys()] : [c]) if (channel(s, k) !== "off") setChannel(s, k, "unknown");
        if (c === undefined && s.rest !== "off") seUnknown(s);
        break;
      }
      case "awake-game":
      case "rollback":
      case "autoload":
        return unknown();
      default:
        if (spec && !CORE_SOUND.has(name)) {
          const e = pluginEffect(spec);
          if (e.bgm) s.bgm = "unknown";
          if (e.se) seUnknown(s);
        }
    }
    // プラグインの命令が飛ぶかもしれない先（その時の音で入る。戻ってくるなら、その先が音を変えたかで決める）
    const promised = w.site === null ? input.promised?.get(`${w.file}:${line}`) : undefined;
    if (promised && promised.length > 0) {
      settle(s, loopChannels);
      let after = s;
      for (const t of promised) {
        const id = nodeOfText(t, w.home);
        if (!id) continue;
        flow(id, called(s));
        // 戻ってこない行き先（最後に @jump で別の所へ移る、など）の様子は、命令のあとに重ねない
        if (regionReturns(id)) after = applyEffect(after, regionEffect(id));
      }
      return after;
    }
    settle(s, loopChannels);
    return s;
  };

  const callMacro = (macro: { stmt: Extract<Statement, { kind: "define" }>; file: string }, args: readonly Argument[], line: number, s: State, w: Walk, content?: Statement[]): State | null => {
    const { stmt } = macro;
    if (w.stack.includes(stmt.name) || w.stack.length >= MAX_MACRO_DEPTH) return unknown();
    const env = new Map<string, Literal>();
    let position = 0;
    for (const a of args) {
      const key = a.key ?? stmt.params[position++]?.name;
      if (key === undefined) continue;
      let value = a.value;
      if (value.kind === "expr" && value.expr.kind === "name") value = w.env.get(value.expr.name) ?? value;
      env.set(key.replace(/-/g, "_"), value);
    }
    for (const p of stmt.params) if (!env.has(p.name.replace(/-/g, "_")) && p.defaultValue) env.set(p.name.replace(/-/g, "_"), p.defaultValue);
    const inner: Walk = { ...w, home: macro.file, env, returns: [], content: content ? { body: content, walk: w } : null, site: w.site ?? line, stack: [...w.stack, stmt.name] };
    const end = block(stmt.body, s, inner);
    const results = [...(end ? [end] : []), ...inner.returns!];
    if (results.length === 0) return null;
    return results.reduce((a, b) => join(a, b));
  };

  const inline = (content: readonly Inline[], s: State, w: Walk, line: number): State | null => {
    let cur: State | null = s;
    for (const c of inlineCommands(content)) {
      if (!cur) return null;
      cur = command(c.name, c.args, line, cur, w, undefined, true);
    }
    return cur;
  };

  /** 文の並びをたどる。最後まで来たときの様子（どの道もほかへ移ったなら null）。 */
  const block = (body: readonly Statement[], start: State, w: Walk): State | null => {
    let s: State | null = start;
    for (const stmt of body) {
      if (!s) return null;
      if (++steps > MAX_STEPS) {
        gaveUp = true;
        return null;
      }
      switch (stmt.kind) {
        case "say":
        case "prose":
          s = inline(stmt.content, s, w, stmt.line);
          if (s) text(s, w, stmt.line);
          break;
        case "command":
          s = command(stmt.name, stmt.args, stmt.line, s, w);
          break;
        case "if": {
          if (stmt.with) {
            s = command(stmt.with.name, stmt.with.args, stmt.line, s, w, stmt.branches[0]?.body ?? []);
            break;
          }
          if (stmt.loop) {
            // @while: 0 回以上くり返す。様子が変わらなくなるまで合わせてから、知らせるときは一度だけたどる
            const quiet = { ...w, report: false };
            let at: State = s;
            for (let i = 0; i < 8; i++) {
              const after = block(stmt.branches[0]?.body ?? [], clone(at), quiet);
              const next = after ? join(at, after) : at;
              if (same(next, at)) break;
              at = next;
            }
            if (w.report) block(stmt.branches[0]?.body ?? [], clone(at), w);
            s = at;
            break;
          }
          let merged: State | null = null;
          for (const b of stmt.branches) {
            const after = block(b.body, clone(s), w);
            if (after) merged = merged ? join(merged, after) : after;
          }
          if (!stmt.branches.some((b) => b.condition === null)) merged = merged ? join(merged, s) : s;
          s = merged;
          break;
        }
        case "choice": {
          settle(s, loopChannels);
          let rest: State = s;
          for (const o of stmt.options) {
            if (!o.args.some((a) => a.key === "call" && a.value.kind === "bool" && a.value.value)) continue;
            for (const id of nodesOf(o.target, w.home)) {
              flow(id, called(s));
              rest = applyEffect(rest, regionEffect(id));
            }
          }
          for (const o of stmt.options) {
            if (o.args.some((a) => a.key === "call" && a.value.kind === "bool" && a.value.value)) continue;
            for (const id of nodesOf(o.target, w.home)) flow(id, rest);
          }
          // 時間切れ（timeout=）で選ばなければ @end の後へ続く
          s = stmt.args?.some((a) => a.key === "timeout") ? rest : null;
          break;
        }
        case "jump":
          settle(s, loopChannels);
          for (const id of nodesOf(stmt.target, w.home)) flow(id, s);
          s = null;
          break;
        case "call": {
          settle(s, loopChannels);
          let after: State = s;
          for (const id of nodesOf(stmt.target, w.home)) {
            flow(id, called(s));
            // 戻ってこない呼び出しのあとは分からないものにする（前と同じ）
            after = regionReturns(id) ? applyEffect(after, regionEffect(id)) : unknown();
          }
          s = after;
          break;
        }
        case "return":
          if (w.returns) w.returns.push(s);
          s = null;
          break;
        case "content":
          if (w.content) s = block(w.content.body, s, { ...w.content.walk, report: w.report });
          break;
        default:
          break;
      }
    }
    return s;
  };

  const walkSegment = (id: string, report: boolean) => {
    const seg = segments.get(id)!;
    const start = entries.get(id);
    if (!start) return;
    const w: Walk = { file: seg.file, home: seg.file, scene: id, quiet: sceneQuiet(id, seg.file), report, env: new Map(), returns: null, content: null, site: null, stack: [] };
    const end = block(seg.stmts, clone(start), w);
    if (end && seg.next && !report) flow(seg.next, end);
  };
  const drain = () => {
    while (queue.length > 0 && !gaveUp) {
      const id = queue.shift()!;
      queued.delete(id);
      walkSegment(id, false);
    }
  };

  // 始める所: はじめ（何も鳴っていない）、回想と章（何も鳴っていない）、外から呼ぶ所（分からない）
  const entryId = input.entry ? nodeOfText(input.entry, "") : null;
  if (entryId) flow(entryId, fresh());
  for (const t of input.fresh ?? []) {
    const id = nodeOfText(t, "");
    if (id) flow(id, fresh());
  }
  for (const t of input.references ?? []) {
    const id = nodeOfText(t, "");
    if (id) flow(id, unknown());
  }
  drain();
  // どこからも入らないファイルの頭、そのあと場面は、分からない状態から
  for (const id of order) if (!entries.has(id) && !id.includes("#")) flow(id, unknown());
  drain();
  for (const id of order) if (!entries.has(id)) flow(id, unknown());
  drain();
  if (gaveUp) return out;

  reporting = true;
  for (const id of order) walkSegment(id, true);

  if (config.silence !== null) {
    for (const { start, count, end } of stretches.values()) {
      if (count < config.silence) continue;
      report({
        severity: "warning",
        code: "long-silence",
        message: `ここから BGM も環境音も鳴らないまま、本文が ${count} 行続きます（${end.file}:${end.line} まで）`,
        file: start.file,
        line: start.line,
        hint: `この前で @bgm か、環境音（@se … loop=true）を鳴らします。わざと音を消した場面なら、liminalia.json の check.sound.quiet に "${start.scene}" を足します（知らせる行数は check.sound.silence。既定 ${DEFAULT_SILENCE_LINES}）`,
      });
    }
  }
  for (const { file, line, loop, channel: c } of carried.values()) {
    const from = loop.line === null ? loop.from! : `${loop.from}:${loop.line}`;
    report({
      severity: "info",
      code: "loop-across-files",
      message: `${from} で鳴らしたループの効果音 ${loop.file}（チャンネル ${c}）が、${file} でも鳴り続けています`,
      file,
      line,
      hint: `場面が替わったなら、${file} へ移る前か ${file} の頭で @stop-se channel=${c} を書きます。続けて鳴らすなら liminalia.json の check.sound.carry に "${loop.file}" を足します`,
    });
  }
  return out;
}

/** 組み込みの音の命令（プラグインの命令の見積もりから外す）。 */
const CORE_SOUND = new Set(["bgm", "stop-bgm", "se", "stop-se", "pause-bgm", "resume-bgm", "pause-se", "resume-se", "bgm-volume", "se-volume", "wait-bgm", "wait-se", "scene-change"]);

/** プラグインの命令が音を変えるかの見積もり（BGM の素材を受ける、効果音の素材と loop を受ける）。 */
function pluginEffect(spec: CommandSpec): { bgm: boolean; se: boolean } {
  const params = Object.values(spec.params);
  const bgm = params.some((p) => p.type.kind === "asset" && p.type.folder === "bgm");
  const se = params.some((p) => p.type.kind === "asset" && p.type.folder === "sound") && "loop" in spec.params;
  return { bgm, se };
}

/** 中のどこかに @return があるか（@if の枝の中も）。 */
function hasReturn(body: readonly Statement[]): boolean {
  for (const s of body) {
    if (s.kind === "return") return true;
    if (s.kind === "if" && s.branches.some((b) => hasReturn(b.body))) return true;
  }
  return false;
}

/** 本文の中の命令（{@…}）。 */
function inlineCommands(content: readonly Inline[], out: { name: string; args: Argument[] }[] = []): { name: string; args: Argument[] }[] {
  for (const n of content) {
    if (n.kind === "command") out.push({ name: n.name, args: n.args });
    else if ("children" in n) inlineCommands(n.children, out);
  }
  return out;
}

/** check.sound を読む（形の誤りは bad-config）。false なら null（調べない）。 */
function readSoundConfig(raw: unknown, scripts: ReadonlyMap<string, Script>, out: Diagnostic[]): { silence: number | null; quiet: Set<string>; carry: Set<string>; off: Set<string> } | null {
  const FILE = "liminalia.json";
  const config = { silence: DEFAULT_SILENCE_LINES as number | null, quiet: new Set<string>(), carry: new Set<string>(), off: new Set<string>() };
  if (raw === undefined || raw === true) return config;
  if (raw === false) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    out.push({ severity: "error", code: "bad-config", message: "check.sound は { silence, quiet, carry, off } の形で書きます（false ですべて外します）", file: FILE, line: 1 });
    return config;
  }
  const r = raw as Record<string, unknown>;
  if (r.silence !== undefined) {
    if (typeof r.silence === "number" && Number.isInteger(r.silence) && r.silence >= 1) config.silence = r.silence;
    else out.push({ severity: "error", code: "bad-config", message: "check.sound.silence は 1 以上の整数で書きます", file: FILE, line: 1 });
  }
  const list = (key: "quiet" | "carry" | "off"): string[] => {
    const v = r[key];
    if (v === undefined) return [];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
    out.push({ severity: "error", code: "bad-config", message: `check.sound.${key} は文字列の並びで書きます`, file: FILE, line: 1 });
    return [];
  };
  for (const q of list("quiet")) {
    const [file = "", label] = q.split("#");
    const script = scripts.get(file);
    if (!script || (label !== undefined && !script.body.some((s) => s.kind === "label" && s.name === label))) {
      out.push({ severity: "warning", code: "bad-config", message: `check.sound.quiet の ${q} の場面がシナリオにありません`, file: FILE, line: 1 });
    }
    config.quiet.add(q);
  }
  for (const c of list("carry")) config.carry.add(c);
  for (const o of list("off")) {
    if ((SOUND_CHECKS as readonly string[]).includes(o)) config.off.add(o);
    else out.push({ severity: "error", code: "bad-config", message: `check.sound.off の ${JSON.stringify(o)} は外せる診断ではありません（${SOUND_CHECKS.join("、")}）`, file: FILE, line: 1 });
  }
  if (config.off.has("long-silence")) config.silence = null;
  return config;
}

/**
 * liminalia.json から、音の検査の始める所（checkSound の entry、fresh、references）を読む。entry は「はじめから」、
 * fresh はおまけの回想と章（新しく始める）、references はロードの後の呼び出し（afterLoad）。
 */
export function soundStarts(config: { entry?: unknown; afterLoad?: unknown; extra?: unknown }): { entry?: string; fresh: string[]; references: string[] } {
  const extra = config.extra as { replay?: unknown; chapters?: unknown } | undefined;
  const fresh: string[] = [];
  for (const list of [extra?.replay, extra?.chapters]) {
    if (!Array.isArray(list)) continue;
    for (const r of list) {
      const target = (r as { target?: unknown } | null)?.target;
      if (typeof target === "string" && target !== "") fresh.push(target);
    }
  }
  return {
    ...(typeof config.entry === "string" && config.entry !== "" ? { entry: config.entry } : {}),
    fresh,
    references: typeof config.afterLoad === "string" && config.afterLoad !== "" ? [config.afterLoad] : [],
  };
}
