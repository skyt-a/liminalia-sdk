import type { VariableInitial } from "@liminalia/project";
import { convertExpr, type ExprEnv } from "./expr.ts";
import { exprKind, truncateIntDivision, type Kind } from "./int-division.ts";
import { englishStory, escapeText, lower, quote, renderFlat, type ChoiceNode, type Node, type Section, type Target } from "./ir.ts";
import { convertedHeader, labelName, limFileName, Session, splitSpeaker, type StoryImportOptions, type StoryImportResult } from "./session.ts";

/**
 * Ink（inkle の .ink）を .lim にする。
 *
 * 変換するもの: ノット（`=== 名前 ===`）とステッチ（`= 名前`）はラベル、ダイバート（`-> 名前`）はジャンプ、トンネル（`-> 名前 ->` と `->->`）は
 * @call と @return、END と DONE は終わり。選択肢（`*` 一度だけ・`+` 何度でも、`[ ]` の出し分け、`{条件}`、`(ラベル)`、入れ子、ギャザー `-`、
 * 文の無い選択肢）、VAR・CONST・temp と `~` の代入、本文の `{変数}`・`{条件: A|B}`・`{A|B|C}`（`&` `~` `!` の付いたものも）、
 * 複数行の条件分岐・場合分け・順番（stopping・cycle・shuffle・once）、グルー `<>`、`#タグ`（対応表）、INCLUDE、`名前: 台詞` の台詞。
 * 関数は戻り値のあるマクロ（@define と @return (式)）、LIST は項目の名前の配列の変数、スレッド `<-` は選択肢の合流にする。
 * 変換しないもの（報告に出す）: ノットの引数、引数のあるスレッド、EXTERNAL、ジャンプ先を値にする式、TURNS などの関数、リストの大小。
 */
export interface InkImportOptions extends StoryImportOptions {
  /** 報告に出す元のファイル名。 */
  file?: string;
  /** INCLUDE のファイルを読む（無ければ null）。省くと INCLUDE は報告に出すだけ。 */
  include?: (path: string) => string | null;
}

interface SrcLine {
  text: string;
  line: number;
  file: string;
}

interface Stitch {
  name: string;
  line: number;
  body: SrcLine[];
}

interface Knot extends Stitch {
  stitches: Stitch[];
}

/** sc はスレッド（<- ノット）で取り込んだ項目の、元のノットのスコープ。 */
type Item = (
  | { k: "choice"; depth: number; sticky: boolean; label: string | null; conds: string[]; text: string; at: SrcLine }
  | { k: "gather"; depth: number; label: string | null; text: string; at: SrcLine }
  | { k: "content"; text: string; at: SrcLine }
  | { k: "logic"; text: string; at: SrcLine }
  | { k: "tag"; text: string; at: SrcLine }
  | { k: "block"; lines: SrcLine[]; at: SrcLine }
  | { k: "comment"; text: string; at: SrcLine }
  | { k: "skip"; code: string; message: string; at: SrcLine }
  /** スレッドの選択肢（itemize の終わりで、次の選択肢かジャンプの前に置き直す）。 */
  | { k: "deferred"; items: Item[]; at: SrcLine }
) & { sc?: Scope };

/** 本文の部分。text はそのままの文字、expr は値を出す .lim の式。 */
/** 本文の部品。lim は .lim の本文の書き方そのまま（順番の {seq …} など）。 */
type Piece = { t: "text"; s: string } | { t: "expr"; e: string } | { t: "lim"; s: string };

/** 部品を .lim の本文に。bar なら文字の | を \| にする（出し分けの一つ）。 */
function limText(ps: readonly Piece[], bar = false): string {
  return ps.map((p) => (p.t === "text" ? (bar ? escapeText(p.s).replace(/\|/g, "\\|") : escapeText(p.s)) : p.t === "expr" ? `{= ${p.e}}` : p.s)).join("");
}

interface Scope {
  knot: string | null;
  stitch: string | null;
  /** temp の名前（Ink の名前）。 */
  temps: Set<string>;
  /** temp の Ink の名前 → .lim の局所変数の名前（関数の引数だけ。ほかは同じ名前）。 */
  names?: Map<string, string>;
  /** 関数の中のとき、その関数（引数は temps に入り、~ return を @return にする）。 */
  fn?: InkFunction;
}

/** Ink の関数（=== function 名前(引数) ===）。.lim では @define のマクロにする。 */
interface InkFunction {
  name: string;
  /** マクロの名前（@ink-名前）。 */
  macro: string;
  /** Ink の引数名 → マクロのパラメータ名（kebab）。 */
  params: { ink: string; param: string; local: string }[];
  /** 戻り値を入れる変数のパラメータ名。 */
  result: string;
  line: number;
  file: string;
  body: SrcLine[];
  /** 呼び出しの引数の種類（パラメータの型を決める）。 */
  argKinds: Kind[][];
  /** 本文（台詞・地の文）を出すか。式の中で呼ぶと、本文は呼んだ行の前の別のページに出る。 */
  prints: boolean;
}

const KNOT = /^\s*={2,}\s*(function\s+)?([\p{L}_][\p{L}\p{N}_]*)\s*(\(([^)]*)\))?\s*=*\s*$/u;
const STITCH = /^\s*=\s*([\p{L}_][\p{L}\p{N}_]*)\s*(\(([^)]*)\))?\s*$/u;

export function importInk(source: string, o: InkImportOptions = {}): StoryImportResult {
  const s = new Session(o);
  const mainFile = o.file ?? "story.ink";
  s.file = mainFile;
  const name = o.name ?? limFileName(mainFile);

  // ---- 読み込み（INCLUDE をつなぎ、コメントを除く） ----
  const all: SrcLine[] = [];
  const seen = new Set<string>();
  // INCLUDE のファイルは、始まりのファイルの後ろに順につなぐ（ノットは共通の名前になる）
  const queue: { text: string; file: string }[] = [{ text: source, file: mainFile }];
  /** 読み込んだファイルの中身（英語の作品かを決める）。 */
  const texts = [source];
  seen.add(mainFile);
  while (queue.length > 0) {
    const { text, file } = queue.shift()!;
    stripComments(text)
      .split("\n")
      .forEach((t, i) => {
        const inc = /^\s*INCLUDE\s+(.+?)\s*$/.exec(t);
        if (!inc) {
          all.push({ text: t.replace(/\s+$/, ""), line: i + 1, file });
          return;
        }
        const path = inc[1]!;
        s.file = file;
        if (seen.has(path)) return;
        seen.add(path);
        const src = o.include?.(path) ?? null;
        if (src === null) {
          s.unsupportedSyntax("include-missing", `INCLUDE ${path} を読み込めません（そのファイルは別に取り込んでください）`, i + 1);
          return;
        }
        s.count("mapped");
        queue.push({ text: src, file: path });
        texts.push(src);
      });
  }
  // 英語の作品なら、括弧の無い台詞を "" で囲む（INCLUDE したファイルも合わせて見る。始まりのファイルが INCLUDE だけでも決められる）
  const english = englishStory(...texts);

  /** 関数の見出しから、マクロの名前とパラメータを決める。ref の引数は変換しない。 */
  const inkFunction = (name: string, params: string, at: SrcLine): InkFunction | null => {
    s.file = at.file;
    const macro = uniqueMacro(`ink-${kebab(name) ?? "f"}`);
    const list: InkFunction["params"] = [];
    for (const raw of params.split(",").map((p) => p.trim()).filter((p) => p !== "")) {
      if (/^ref\s/.test(raw) || raw.startsWith("->")) {
        s.unsupportedSyntax("ink-function", `関数 ${name} の引数 ${raw}（ref・ダイバート）は変換できません（値として渡します）`, at.line);
      }
      const ink = raw.replace(/^ref\s+/, "").replace(/^->\s*/, "");
      let param = kebab(ink) ?? `p${list.length + 1}`;
      while (list.some((p) => p.param === param) || param === "ink-result") param = `${param}-${list.length + 1}`;
      list.push({ ink, param, local: param.replace(/-/g, "_") });
    }
    s.count("mapped");
    return { name, macro, params: list, result: "ink-result", line: at.line, file: at.file, body: [], argKinds: [], prints: false };
  };
  const uniqueMacro = (base: string): string => {
    let n = base;
    for (let i = 2; macroNames.has(n); i++) n = `${base}-${i}`;
    macroNames.add(n);
    return n;
  };

  /**
   * LIST は、入っている項目の名前の配列の変数（game.名前）にする。初期値は ( ) で囲んだ項目。項目の名前は式の中では文字列。
   * 項目の値（a = 5）は LIST_VALUE で使う。
   */
  const lists = new Map<string, { variable: string; items: { name: string; value: number }[] }>();
  const listItems = new Map<string, string>();
  const declareList = (name: string, body: string, line: number) => {
    const items: { name: string; value: number }[] = [];
    const initial: string[] = [];
    let next = 1;
    for (const part of body.split(",").map((p) => p.trim()).filter((p) => p !== "")) {
      const m = /^(\()?\s*([\p{L}_][\p{L}\p{N}_]*)\s*(?:=\s*(-?\d+))?\s*(\))?$/u.exec(part);
      if (!m) {
        s.unsupportedSyntax("ink-list", `LIST ${name} の項目 ${part} を読めません`, line);
        continue;
      }
      const value = m[3] !== undefined ? Number(m[3]) : next;
      next = value + 1;
      items.push({ name: m[2]!, value });
      if (m[1]) initial.push(m[2]!);
      if (!listItems.has(m[2]!)) listItems.set(m[2]!, name);
      else s.issue("warning", "ink-list", `LIST の項目 ${m[2]} が二つの LIST にあります（どちらも同じ文字列 "${m[2]}" になります）`, line);
    }
    lists.set(name, { variable: s.declare(name, initial), items });
    globals.set(name, lists.get(name)!.variable);
    s.count("mapped");
  };

  // ---- 全体の宣言と、ノット・ステッチの区切り ----
  const consts = new Map<string, string>();
  const globals = new Map<string, string>();
  const root: SrcLine[] = [];
  const knots: Knot[] = [];
  const functions = new Map<string, InkFunction>();
  const macroNames = new Set<string>();
  let currentFunction: InkFunction | null = null;
  for (const l of all) {
    s.file = l.file;
    const t = l.text.trim();
    const decl = /^(VAR|CONST)\s+([\p{L}_][\p{L}\p{N}_]*)\s*=\s*(.+)$/u.exec(t);
    if (decl) {
      const value = literal(decl[3]!);
      if (value === undefined) {
        s.unsupportedSyntax("ink-var", `${decl[1]} ${decl[2]} の初期値 ${decl[3]} は変換できません（数・文字列・真偽だけ）`, l.line);
        continue;
      }
      if (decl[1] === "CONST") consts.set(decl[2]!, typeof value === "string" ? quote(value) : String(value));
      else globals.set(decl[2]!, s.declare(decl[2]!, value));
      s.count("mapped");
      continue;
    }
    const list = /^LIST\s+([\p{L}_][\p{L}\p{N}_]*)\s*=\s*(.+)$/u.exec(t);
    if (list) {
      declareList(list[1]!, list[2]!, l.line);
      continue;
    }
    if (/^(LIST|EXTERNAL)\b/.test(t)) {
      s.unsupportedSyntax(t.startsWith("LIST") ? "ink-list" : "ink-external", `${t.split(/\s/)[0]} は変換できません: ${t}`, l.line);
      continue;
    }
    const k = KNOT.exec(l.text);
    if (k) {
      currentFunction = null;
      if (k[1]) {
        currentFunction = inkFunction(k[2]!, k[4] ?? "", l);
        if (currentFunction) functions.set(currentFunction.name, currentFunction);
        continue;
      }
      if (k[3]) s.unsupportedSyntax("ink-knot-params", `ノット ${k[2]} の引数（${k[4]}）は変換できません`, l.line);
      knots.push({ name: k[2]!, line: l.line, body: [], stitches: [] });
      continue;
    }
    if (currentFunction) {
      currentFunction.body.push(l);
      continue;
    }
    const st = STITCH.exec(l.text);
    if (st && knots.length > 0) {
      if (st[2]) s.unsupportedSyntax("ink-knot-params", `ステッチ ${st[1]} の引数（${st[3]}）は変換できません`, l.line);
      knots.at(-1)!.stitches.push({ name: st[1]!, line: l.line, body: [] });
      continue;
    }
    const knot = knots.at(-1);
    (knot ? (knot.stitches.at(-1) ?? knot).body : root).push(l);
  }

  // ---- ラベルの名前 ----
  const used = new Set<string>();
  const knotLabel = new Map<string, string>();
  const stitchLabel = new Map<string, string>();
  /** スコープ（"" / "knot" / "knot.stitch"）→ その中のラベル（Ink の名前 → .lim のラベル）。 */
  const pointLabels = new Map<string, Map<string, string>>();
  const unique = (base: string) => {
    let n = labelName(base);
    for (let i = 2; used.has(n); i++) n = `${labelName(base)}_${i}`;
    used.add(n);
    return n;
  };
  for (const k of knots) knotLabel.set(k.name, unique(k.name));
  for (const k of knots) for (const st of k.stitches) stitchLabel.set(`${k.name}.${st.name}`, unique(`${knotLabel.get(k.name)}-${st.name}`));
  const collectPoints = (key: string, prefix: string, lines: readonly SrcLine[]) => {
    const map = new Map<string, string>();
    for (const l of lines) {
      const m = /^\s*(?:[*+-]\s*)+\(([\p{L}_][\p{L}\p{N}_]*)\)/u.exec(l.text);
      if (m && !/^\s*->/.test(l.text)) map.set(m[1]!, unique(prefix ? `${prefix}-${m[1]}` : m[1]!));
    }
    pointLabels.set(key, map);
  };
  collectPoints("", "", root);
  for (const k of knots) {
    collectPoints(k.name, knotLabel.get(k.name)!, k.body);
    for (const st of k.stitches) collectPoints(`${k.name}.${st.name}`, stitchLabel.get(`${k.name}.${st.name}`)!, st.body);
  }

  /** Ink の名前（a / a.b / a.b.c）を、今いるスコープから .lim のラベルにする。 */
  const resolve = (path: string, sc: Scope): string | null => {
    const parts = path.split(".");
    const knot = sc.knot;
    const stitchKey = knot && sc.stitch ? `${knot}.${sc.stitch}` : null;
    if (parts.length === 1) {
      const p = parts[0]!;
      return (
        (stitchKey ? pointLabels.get(stitchKey)?.get(p) : undefined) ??
        (knot ? pointLabels.get(knot)?.get(p) : undefined) ??
        (knot ? stitchLabel.get(`${knot}.${p}`) : undefined) ??
        knotLabel.get(p) ??
        pointLabels.get("")?.get(p) ??
        null
      );
    }
    if (parts.length === 2) {
      const [a, b] = parts as [string, string];
      if (knotLabel.has(a)) return stitchLabel.get(`${a}.${b}`) ?? pointLabels.get(a)?.get(b) ?? null;
      if (knot && stitchLabel.has(`${knot}.${a}`)) return pointLabels.get(`${knot}.${a}`)?.get(b) ?? null;
      return null;
    }
    if (parts.length === 3) return pointLabels.get(`${parts[0]}.${parts[1]}`)?.get(parts[2]!) ?? null;
    return null;
  };

  const counted = new Map<string, string>();
  const visitVar = (label: string) => {
    let v = counted.get(label);
    if (!v) {
      v = s.gameVariable(`seen_${label}`, 0);
      counted.set(label, v);
    }
    return v;
  };

  /** temp の .lim の名前。 */
  const local = (sc: Scope, n: string) => sc.names?.get(n) ?? n;
  /**
   * 関数の呼び出しは、その文の前に置くマクロの呼び出し（hoisted）にし、式の中は戻り値を入れた局所変数にする。
   * 文を書き出すところ（drain）で、文の前に出す。
   */
  const hoisted: Node[] = [];
  let callCount = 0;
  const drain = (): Node[] => hoisted.splice(0);
  const callFunction = (f: InkFunction, args: string[], sc: Scope, line: number): string => {
    if (args.length !== f.params.length) s.issue("warning", "ink-function", `関数 ${f.name} の引数の数が違います（${f.params.length} 個のところ ${args.length} 個）`, line);
    f.argKinds.push(args.map((a) => exprKind(a, kindOf(sc))));
    const name = `ink_r${++callCount}`;
    hoisted.push({ k: "raw", text: `@${f.macro}${f.params.map((p, i) => ` ${p.param}=(${args[i] ?? "null"})`).join("")} ${f.result}=temp.ink_ret` });
    hoisted.push({ k: "let", name, value: "temp.ink_ret" });
    s.count("mapped");
    return name;
  };
  const exprEnv = (sc: Scope, line: number): ExprEnv => ({
    lang: "ink",
    variable: (n) => (sc.temps.has(n) ? local(sc, n) : (consts.get(n) ?? globals.get(n) ?? listItem(n))),
    visits: (path) => {
      const label = resolve(path, sc);
      return label ? visitVar(label) : null;
    },
    fail: (m) => s.unsupportedSyntax("ink-expression", m, line),
    call: (name, args, raw) => {
      const f = functions.get(name);
      if (f) return callFunction(f, args, sc, line);
      return listCall(name, args, raw, line);
    },
  });
  /** LIST の項目の名前（a か リスト.a）を文字列に。項目でなければ null。 */
  const listItem = (n: string): string | null => {
    const dot = n.lastIndexOf(".");
    const item = dot >= 0 ? n.slice(dot + 1) : n;
    if (dot >= 0 && !lists.get(n.slice(0, dot))?.items.some((i) => i.name === item)) return null;
    return listItems.has(item) ? quote(item) : null;
  };
  /** LIST の道具（前処理の __LIST_… と、LIST_COUNT などの Ink の関数）。 */
  const listCall = (name: string, args: string[], raw: string[], line: number): string | undefined => {
    const items = args.slice(1);
    const listArg = (i: number) => lists.has(raw[i]?.trim() ?? "");
    switch (name) {
      case "__LIST_HAS":
        if (raw.slice(1).some((_, i) => listArg(i + 1))) break;
        s.count("mapped");
        return items.length === 0 ? "true" : `(${items.map((i) => `includes(${args[0]}, ${i})`).join(" && ")})`;
      case "__LIST_EQ":
      case "__LIST_NE": {
        if (raw.slice(1).some((_, i) => listArg(i + 1))) {
          // リストどうし: 同じ項目を持つか（並びは問わない）
          if (args.length !== 2) break;
          const eq = `(len(${args[0]}) == len(${args[1]}) && sort(${args[0]}) == sort(${args[1]}))`;
          s.count("mapped");
          return name === "__LIST_EQ" ? eq : `!${eq}`;
        }
        const eq = `(len(${args[0]}) == ${items.length}${items.map((i) => ` && includes(${args[0]}, ${i})`).join("")})`;
        s.count("mapped");
        return name === "__LIST_EQ" ? eq : `!${eq}`;
      }
      case "__LIST_ANY":
        return `len(${args[0]}) > 0`;
      case "__LIST_JOIN":
        return `join(${args[0]}, ", ")`;
      case "LIST_COUNT":
        s.count("mapped");
        return `len(${args[0]})`;
      case "LIST_RANDOM":
        s.count("mapped");
        return `(len(${args[0]}) > 0 ? [pick(${args[0]})] : [])`;
      case "LIST_VALUE": {
        const item = (raw[0] ?? "").trim().split(".").at(-1) ?? "";
        const owner = lists.get(listItems.get(item) ?? "");
        const v = owner?.items.find((i) => i.name === item)?.value;
        if (v === undefined) break;
        s.count("mapped");
        return String(v);
      }
    }
    if (name.startsWith("__LIST") || name.startsWith("LIST_")) {
      s.unsupportedSyntax("ink-list", `LIST の ${name.startsWith("__") ? "リストどうしの演算" : name} は変換できません`, line);
      return "null";
    }
    return undefined;
  };
  /** temp に入れた値の種類（整数どうしの割り算を見分けるのに使う）。スコープの temp の集まりごと。 */
  const tempKinds = new WeakMap<Set<string>, Map<string, Kind>>();
  const kindOf = (sc: Scope) => (name: string): Kind => {
    // 関数の引数は .lim の名前から Ink の名前に戻して引く
    const ink = [...(sc.names ?? [])].find(([, v]) => v === name)?.[0] ?? name;
    if (sc.temps.has(ink)) return tempKinds.get(sc.temps)?.get(ink) ?? "unknown";
    const v = s.variables.get(name);
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    return typeof v === "string" ? "string" : typeof v === "boolean" ? "bool" : "unknown";
  };
  /** Ink の式を .lim の式に。整数どうしの割り算は切り捨て（floor）にし、整数どうしか分からない割り算は知らせる。 */
  const expr = (src: string, sc: Scope, line: number, mode: "cond" | "value" = "cond") => {
    const listed = lists.size > 0 ? rewriteLists(src, mode, (n) => lists.has(n) && !sc.temps.has(n)) : src;
    if (listed === null) {
      s.unsupportedSyntax("ink-list", `LIST の変数の比べ方・計算（<、>、+ など）は変換できません: ${src}`, line);
      return null;
    }
    const e = convertExpr(listed, exprEnv(sc, line));
    if (e === null) return null;
    const d = truncateIntDivision(e, kindOf(sc));
    for (const u of d.unknown) s.issue("info", "ink-division", `割り算 ${u} は整数どうしか分からないので、小数の割り算のままにしました（Ink では整数どうしなら切り捨て）`, line);
    return d.expr;
  };

  // ---- 本文 ----

  /**
   * 本文の文字列を部品に。{…} の書き方を式にする。post はこの行の後ろで増やす順番の変数。
   * inText なら（本文と選択肢の文の一番外側）、順番 {A|B} は本文の出し分け（{seq …}）にする。式の中（条件の枝）では式にする。
   */
  const pieces = (raw: string, sc: Scope, line: number, post: Node[], inText = true): Piece[] | null => {
    const out: Piece[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push({ t: "text", s: text });
      text = "";
    };
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]!;
      if (c === "\\" && i + 1 < raw.length) {
        text += raw[++i];
        continue;
      }
      if (c !== "{") {
        text += c;
        continue;
      }
      const end = matching(raw, i);
      if (end < 0) {
        s.unsupportedSyntax("ink-brace", `{ が閉じていません: ${raw}`, line);
        return null;
      }
      flush();
      const e = construct(raw.slice(i + 1, end), sc, line, post, inText);
      if (e === null) return null;
      if (typeof e !== "string") out.push(e);
      else if (e !== "") out.push({ t: "expr", e });
      i = end;
    }
    flush();
    return out;
  };

  /** 部品を文字列の式に。 */
  const asExpr = (ps: readonly Piece[]): string => {
    if (ps.length === 0) return '""';
    const parts = ps.map((p) => (p.t === "text" ? quote(p.s) : p.t === "expr" ? `(${p.e})` : quote(p.s)));
    return ps[0]!.t === "text" ? parts.join(" + ") : `"" + ${parts.join(" + ")}`;
  };

  /** {…} の中身を値の式に（空なら ""、変換できなければ null）。inText の順番は本文の出し分けの部品にする。 */
  const construct = (inner: string, sc: Scope, line: number, post: Node[], inText = false): string | Piece | null => {
    const trimmed = inner.trim();
    if (trimmed === "") return "";
    const kind = /^[&~!]/.test(trimmed) ? trimmed[0]! : "";
    const body = kind ? trimmed.slice(1) : inner;
    const colon = kind ? -1 : topLevel(body, ":");
    const bars = splitTop(body, "|");
    if (colon >= 0) {
      const cond = expr(body.slice(0, colon), sc, line);
      if (cond === null) return null;
      const branches = splitTop(body.slice(colon + 1), "|");
      if (branches.length > 2) {
        s.unsupportedSyntax("ink-conditional", `条件の後ろに | が二つ以上あります: {${inner}}`, line);
        return null;
      }
      const a = pieces(branches[0]!.trim(), sc, line, post, false);
      const b = branches[1] === undefined ? [] : pieces(branches[1].trim(), sc, line, post, false);
      if (a === null || b === null) return null;
      s.count("mapped");
      return `${cond} ? ${asExpr(a)} : ${asExpr(b)}`;
    }
    if (bars.length === 1 && !kind) {
      const e = expr(trimmed, sc, line, "value");
      if (e !== null) s.count("mapped");
      return e;
    }
    // 本文の中の順番は、.lim の本文の出し分けにする（stopping は seq、& は cycle、! は once、~ は shuffle）
    if (inText) {
      const parts: string[] = [];
      for (const b of bars) {
        const p = pieces(b.trim(), sc, line, post, true);
        if (p === null) return null;
        parts.push(limText(p, true));
      }
      s.count("mapped");
      const mode = kind === "~" ? "shuffle" : kind === "&" ? "cycle" : kind === "!" ? "once" : "seq";
      return { t: "lim", s: `{${mode} ${parts.join("|")}}` };
    }
    const items: string[] = [];
    for (const b of bars) {
      const p = pieces(b.trim(), sc, line, post, false);
      if (p === null) return null;
      items.push(asExpr(p));
    }
    const list = `[${items.join(", ")}]`;
    s.count("mapped");
    if (kind === "~") return `${list}[random(${items.length})]`;
    const v = s.gameVariable("ink_seq", 0);
    post.push({ k: "set", target: v, op: "+=", value: "1" });
    if (kind === "&") return `${list}[${v} % ${items.length}]`;
    if (kind === "!") return `${v} < ${items.length} ? ${list}[${v}] : ""`;
    return `${list}[min(${v}, ${items.length - 1})]`;
  };

  /** 本文の一行（話者・タグ・ダイバート・グルーを含む）を Node に。 */
  const contentNodes = (raw: string, sc: Scope, at: SrcLine): Node[] => {
    s.file = at.file;
    const line = at.line;
    // {条件: -> a | -> b} のようにダイバートを含む書き方は、行ごとの条件分岐にする
    const dc = divertConstruct(raw);
    if (dc) {
      const inner = dc.inner.trim();
      const colon = /^[&~!]/.test(inner) ? -1 : topLevel(inner, ":");
      const br = colon >= 0 ? splitTop(inner.slice(colon + 1), "|") : [];
      const cond = colon >= 0 && br.length <= 2 ? expr(inner.slice(0, colon), sc, line) : null;
      const pre = drain();
      if (cond === null) {
        if (colon < 0 || br.length > 2) s.unsupportedSyntax("ink-divert", `ダイバートを含む {…} は条件の形（{条件: -> a | -> b}）だけ変換します`, line);
        return [{ k: "comment", text: raw.trim() }];
      }
      s.count("mapped");
      const yes = contentNodes(`${dc.before}${br[0]}${dc.after}`, sc, at);
      const no = contentNodes(`${dc.before}${br[1] ?? ""}${dc.after}`, sc, at);
      return [...pre, { k: "if", branches: [{ cond, body: yes }, ...(no.length > 0 ? [{ cond: null, body: no }] : [])] }];
    }
    const { text, tags, divert } = splitLine(raw);
    const out: Node[] = [];
    let speaker: string | null = null;
    for (const tag of tags) {
      const sp = /^(speaker|name)\s*[:：]\s*(.+)$/i.exec(tag);
      if (sp) {
        speaker = sp[2]!.trim();
        s.count("mapped");
        continue;
      }
      out.push(...s.command(tag, line, "タグ"));
    }
    let body = text.replace(/^\s*<>\s*/, "").replace(/\s*<>\s*$/, "").trim();
    if (body !== "") {
      if (speaker === null) {
        const sp = splitSpeaker(body);
        if (sp) {
          speaker = sp.name;
          body = sp.body;
        }
      }
      if (speaker !== null) body = body.replace(/^"(.*)"$/s, "$1").replace(/^“(.*)”$/s, "$1");
      const post: Node[] = [];
      const ps = pieces(body, sc, line, post);
      if (ps === null) out.push({ k: "comment", text: raw.trim() });
      else {
        const lim = limText(ps);
        if (speaker !== null) {
          s.speaker(speaker);
          s.stats.says++;
        } else s.stats.prose++;
        if (sc.fn) sc.fn.prints = true;
        out.push(...drain(), { k: "text", speaker, text: lim, line }, ...post);
      }
    }
    if (divert !== null) out.push(...divertNodes(divert, sc, line));
    return [...drain(), ...out];
  };

  /** `-> a`、`-> a ->`、`->->`、`-> a -> b` を Node に。 */
  const divertNodes = (raw: string, sc: Scope, line: number): Node[] => {
    const out: Node[] = [];
    const t = raw.trim();
    if (t === "->->") return [{ k: "return" }];
    const parts = t.split("->").map((p) => p.trim());
    // 先頭は空（-> で始まる）。末尾が空ならトンネル
    parts.shift();
    const tunnelEnd = parts.at(-1) === "";
    if (tunnelEnd) parts.pop();
    parts.forEach((p, i) => {
      const isCall = i < parts.length - 1 || tunnelEnd;
      const m = /^([\p{L}_][\p{L}\p{N}_.]*)\s*(\(.*\))?$/u.exec(p);
      if (!m) {
        s.unsupportedSyntax("ink-divert", `ダイバート -> ${p} は変換できません`, line);
        return;
      }
      if (m[2]) s.unsupportedSyntax("ink-knot-params", `ノットの引数 ${m[2]} は変換できません（引数なしでジャンプします）`, line);
      if (m[1] === "END" || m[1] === "DONE") {
        s.count("mapped");
        out.push({ k: "end" });
        return;
      }
      const label = resolve(m[1]!, sc);
      if (label === null) {
        const v = !m[1]!.includes(".") ? (globals.get(m[1]!) ?? (sc.temps.has(m[1]!) ? m[1]! : null)) : null;
        if (v) s.unsupportedSyntax("ink-divert-variable", `変数 ${m[1]} へのダイバートは変換できません（ジャンプ先を書いてください）`, line);
        else s.unsupportedSyntax("ink-divert", `ジャンプ先 ${m[1]} がありません`, line);
        return;
      }
      s.count("mapped");
      const target: Target = { label };
      out.push(isCall ? { k: "call", target } : { k: "jump", target });
    });
    return out;
  };

  /** `~` の行。 */
  const logicNodes = (raw: string, sc: Scope, line: number): Node[] => {
    const t = raw.trim();
    let m = /^temp\s+([\p{L}_][\p{L}\p{N}_]*)\s*=\s*(.+)$/u.exec(t);
    if (m) {
      const v = expr(m[2]!, sc, line);
      const pre = drain();
      sc.temps.add(m[1]!);
      if (!tempKinds.has(sc.temps)) tempKinds.set(sc.temps, new Map());
      tempKinds.get(sc.temps)!.set(m[1]!, v === null ? "unknown" : exprKind(v, kindOf(sc)));
      if (v === null) return [{ k: "comment", text: `~ ${t}` }];
      s.count("mapped");
      return [...pre, { k: "let", name: local(sc, m[1]!), value: v }];
    }
    m = /^([\p{L}_][\p{L}\p{N}_]*)\s*(\+\+|--)$/u.exec(t);
    const inc = m ? { name: m[1]!, op: m[2] === "++" ? "+=" : "-=", value: "1" } : null;
    m = /^([\p{L}_][\p{L}\p{N}_]*)\s*(=|\+=|-=|\*=|\/=)\s*(.+)$/u.exec(t);
    const asg = inc ?? (m ? { name: m[1]!, op: m[2]!, value: m[3]! } : null);
    if (asg && lists.has(asg.name) && !sc.temps.has(asg.name)) return listAssign(asg.name, asg.op, asg.value, t, line);
    if (asg) {
      const value = inc ? "1" : expr(asg.value, sc, line);
      const pre = drain();
      if (value === null) return [{ k: "comment", text: `~ ${t}` }];
      const op = asg.op as "=" | "+=" | "-=" | "*=" | "/=";
      if (sc.temps.has(asg.name)) {
        s.count("mapped");
        const name = local(sc, asg.name);
        return [...pre, { k: "let", name, value: op === "=" ? value : `${name} ${op[0]} (${value})` }];
      }
      const g = globals.get(asg.name);
      if (!g) {
        s.unsupportedSyntax("ink-assign", `${asg.name} は VAR で宣言されていません`, line);
        return [{ k: "comment", text: `~ ${t}` }];
      }
      s.count("mapped");
      return [...pre, { k: "set", target: g, op, value }];
    }
    const ret = /^return\b\s*(.*)$/.exec(t);
    if (ret && sc.fn) {
      // 関数の ~ return は、マクロの @return（値があれば戻り値を入れる変数に入れる）
      if (ret[1]!.trim() === "") {
        s.count("mapped");
        return [{ k: "return" }];
      }
      const value = expr(ret[1]!, sc, line);
      const pre = drain();
      if (value === null) return [{ k: "comment", text: `~ ${t}` }];
      s.count("mapped");
      return [...pre, { k: "return", value }];
    }
    const call = /^([\p{L}_][\p{L}\p{N}_]*)\s*\(/u.exec(t);
    if (call && functions.has(call[1]!)) {
      // 値を使わない関数の呼び出しは、マクロの呼び出しだけにする
      const v = expr(t, sc, line);
      const pre = drain().filter((n) => !(n.k === "let" && n.name === v));
      return v === null ? [{ k: "comment", text: `~ ${t}` }] : pre;
    }
    drain();
    if (ret) s.unsupportedSyntax("ink-function", `関数の外の ~ return は変換できません`, line);
    else s.unsupportedSyntax("ink-logic", `~ ${t} は変換できません（関数の呼び出しなど）`, line);
    return [{ k: "comment", text: `~ ${t}` }];
  };

  /**
   * LIST の変数への代入。`= a`・`= (a, b)`・`= ()`・`= M`、`+= a`・`-= (a, b)`、`= L + a`・`= L - a`。
   * 別のリストの項目をまとめて足す・除く（`+= M`）は @while で一つずつ。
   */
  let loopCount = 0;
  const listAssign = (name: string, op: string, rhs: string, t: string, line: number): Node[] => {
    const v = lists.get(name)!.variable;
    let src = rhs.trim();
    const self = new RegExp(`^${name}\\s*([+-])\\s*(.+)$`, "u").exec(src);
    if (op === "=" && self) {
      op = `${self[1]}=`;
      src = self[2]!.trim();
    }
    const fail = () => {
      s.unsupportedSyntax("ink-list", `LIST の代入 ~ ${t} は変換できません`, line);
      return [{ k: "comment", text: `~ ${t}` } as Node];
    };
    // 右辺: () か (a, b) か a（項目）、または LIST の変数
    let items: string[] | null = null;
    let other: string | null = null;
    const group = /^\((.*)\)$/s.exec(src);
    const names = (group ? group[1]!.split(",") : [src]).map((x) => x.trim()).filter((x) => x !== "");
    if (names.length === 1 && lists.has(names[0]!)) other = lists.get(names[0]!)!.variable;
    else if (names.every((n) => listItem(n) !== null)) items = names.map((n) => listItem(n)!);
    if (items === null && other === null) return fail();
    s.count("mapped");
    if (op === "=") return [{ k: "set", target: v, op: "=", value: other ?? `[${items!.join(", ")}]` }];
    if (op !== "+=" && op !== "-=") return fail();
    if (items !== null) {
      const value = items.reduce((acc, i) => (op === "+=" ? `push(${acc}, ${i})` : `remove(${acc}, ${i})`), v);
      return [{ k: "set", target: v, op: "=", value: op === "+=" ? `unique(${value})` : value }];
    }
    const i = `ink_i${++loopCount}`;
    return [
      { k: "let", name: i, value: "0" },
      { k: "raw", text: `@while ${i} < len(${other})` },
      { k: "raw", text: `  @set ${v} = ${op === "+=" ? `unique(push(${v}, ${other}[${i}]))` : `remove(${v}, ${other}[${i}])`}` },
      { k: "raw", text: `  @let ${i} = ${i} + 1` },
      { k: "raw", text: "@end" },
    ];
  };

  // ---- 行を項目に ----

  /**
   * スレッド `<- ノット`。そのノットの中身（本文と選択肢）をここに取り込み、選択肢は続く選択肢と一緒に出す
   * （Ink のスレッドは、ノットの選択肢を今の選択肢に足す）。ジャンプ先などはそのノットのスコープで読む。
   * 変換できなければ理由の文字列。
   */
  const threading = new Set<string>();
  const threaded = new Set<string>();
  const threadItems = (name: string, at: SrcLine): Item[] | string => {
    const m = /^([\p{L}_][\p{L}\p{N}_]*)(?:\.([\p{L}_][\p{L}\p{N}_]*))?\s*$/u.exec(name);
    if (!m) return "引数のあるスレッドと、式のスレッドは変換できません";
    const knot = knots.find((k) => k.name === m[1]);
    let stitch = knot && m[2] ? knot.stitches.find((x) => x.name === m[2]) : undefined;
    if (!knot || (m[2] && !stitch)) return `${name} というノットがありません`;
    if (!stitch && knot.body.every((l) => l.text.trim() === "") && knot.stitches[0]) stitch = knot.stitches[0];
    const body = stitch ? stitch.body : knot.body;
    const key = `${knot.name}.${stitch?.name ?? ""}`;
    if (threading.has(key)) return "自分を取り込むスレッドです";
    // ラベルの付いた選択肢・ギャザーのあるノットは、二度取り込むとラベルが重なる
    if (threaded.has(key) && body.some((l) => /^\s*(?:[*+-]\s*)+\(/.test(l.text))) return "ラベルの付いた選択肢のあるノットを二度取り込めません";
    threading.add(key);
    const inner = itemize(body);
    threading.delete(key);
    threaded.add(key);
    s.file = at.file;
    s.count("mapped");
    const sc: Scope = { knot: knot.name, stitch: stitch?.name ?? null, temps: new Set() };
    return inner.map((it) => (it.sc ? it : { ...it, sc }));
  };

  const itemize = (lines: readonly SrcLine[]): Item[] => {
    const items: Item[] = [];
    for (let i = 0; i < lines.length; i++) {
      const at = lines[i]!;
      const raw = at.text;
      const t = raw.trim();
      if (t === "") continue;
      if (/^TODO\s*:/.test(t)) {
        items.push({ k: "comment", text: t, at });
        continue;
      }
      if (t.startsWith("~")) {
        items.push({ k: "logic", text: t.slice(1), at });
        continue;
      }
      if (t.startsWith("<-")) {
        const thread = threadItems(t.slice(2).trim(), at);
        if (typeof thread === "string") items.push({ k: "skip", code: "ink-thread", message: `スレッド ${t} は変換できません（${thread}）`, at });
        else {
          // 選択肢より前の本文はここで出し、選択肢は今の流れの選択肢と一緒に出す
          const first = thread.findIndex((x) => x.k === "choice" || x.k === "gather");
          items.push(...(first < 0 ? thread : thread.slice(0, first)));
          if (first >= 0) items.push({ k: "deferred", items: thread.slice(first), at });
        }
        continue;
      }
      if (t.startsWith("#")) {
        items.push({ k: "tag", text: t, at });
        continue;
      }
      // 複数行の { … }
      if (t.startsWith("{") && matching(t, 0) < 0) {
        const block: SrcLine[] = [{ ...at, text: t.slice(1) }];
        let depth = braceDepth(t);
        let closed = false;
        while (i + 1 < lines.length) {
          const next = lines[++i]!;
          const d = braceDepth(next.text);
          if (depth + d <= 0) {
            const close = closeIndex(next.text, depth);
            block.push({ ...next, text: next.text.slice(0, close) });
            items.push({ k: "block", lines: block, at });
            const after = next.text.slice(close + 1).trim();
            if (after) items.push({ k: "content", text: after, at: next });
            closed = true;
            break;
          }
          depth += d;
          block.push(next);
        }
        if (!closed) items.push({ k: "skip", code: "ink-brace", message: "{ が閉じていません", at });
        continue;
      }
      const choice = /^((?:[*+]\s*)+)(.*)$/.exec(t);
      if (choice) {
        const bullets = choice[1]!.replace(/\s/g, "");
        let rest = choice[2]!;
        let label: string | null = null;
        const lm = /^\(([\p{L}_][\p{L}\p{N}_]*)\)\s*/u.exec(rest);
        if (lm) {
          label = lm[1]!;
          rest = rest.slice(lm[0].length);
        }
        const conds: string[] = [];
        while (rest.startsWith("{")) {
          const end = matching(rest, 0);
          if (end < 0) break;
          conds.push(rest.slice(1, end));
          rest = rest.slice(end + 1).trimStart();
        }
        items.push({ k: "choice", depth: bullets.length, sticky: bullets.startsWith("+"), label, conds, text: rest, at });
        continue;
      }
      const gather = /^((?:-(?!>)\s*)+)(.*)$/.exec(t);
      if (gather) {
        let rest = gather[2]!;
        let label: string | null = null;
        const lm = /^\(([\p{L}_][\p{L}\p{N}_]*)\)\s*/u.exec(rest);
        if (lm) {
          label = lm[1]!;
          rest = rest.slice(lm[0].length);
        }
        items.push({ k: "gather", depth: gather[1]!.replace(/\s/g, "").length, label, text: rest, at });
        continue;
      }
      items.push({ k: "content", text: raw, at });
    }
    // スレッドの選択肢は、次の選択肢・ギャザー・ジャンプだけの行の前（無ければ終わり）に置く
    if (items.some((x) => x.k === "deferred")) {
      const placed: Item[] = [];
      let pending: Item[] = [];
      for (const it of items) {
        if (it.k === "deferred") {
          pending.push(...it.items);
          continue;
        }
        if (pending.length > 0 && (it.k === "choice" || it.k === "gather" || (it.k === "content" && /^\s*->/.test(it.text)))) {
          placed.push(...pending);
          pending = [];
        }
        placed.push(it);
      }
      placed.push(...pending);
      items.splice(0, items.length, ...placed);
    }
    // グルー: 行末か次の行頭の <> で次の本文の行とつなぐ
    for (let i = 0; i + 1 < items.length; i++) {
      const a = items[i]!;
      const b = items[i + 1]!;
      if (a.k !== "content" || b.k !== "content") continue;
      if (/<>\s*$/.test(splitLine(a.text).text) || /^\s*<>/.test(b.text)) {
        items.splice(i, 2, { k: "content", text: `${a.text.replace(/\s*<>\s*$/, "")}${b.text.replace(/^\s*<>\s*/, "")}`, at: a.at });
        s.count("mapped");
        i--;
      }
    }
    return items;
  };

  const pointLabel = (sc: Scope, name: string) => {
    const key = sc.knot ? (sc.stitch ? `${sc.knot}.${sc.stitch}` : sc.knot) : "";
    return pointLabels.get(key)?.get(name) ?? unique(name);
  };

  const itemNodes = (it: Item, sc: Scope): Node[] => {
    s.file = it.at.file;
    switch (it.k) {
      case "content":
        return contentNodes(it.text, sc, it.at);
      case "logic":
        return logicNodes(it.text, sc, it.at.line);
      case "tag":
        return it.text
          .split("#")
          .map((x) => x.trim())
          .filter((x) => x !== "")
          .flatMap((x) => s.command(x, it.at.line, "タグ"));
      case "comment":
        s.count("dropped");
        return [{ k: "comment", text: it.text }];
      case "skip":
        s.unsupportedSyntax(it.code, it.message, it.at.line);
        return [{ k: "comment", text: it.at.text.trim() }];
      case "block":
        return blockNodes(it.lines, sc, it.at);
      case "choice":
      case "gather":
      case "deferred":
        return [];
    }
  };

  /** 選択肢とギャザーを組み立てる。level より浅い選択肢・ギャザーで止まる。 */
  const weave = (items: readonly Item[], pos: { i: number }, level: number, sc: Scope): Node[] => {
    const out: Node[] = [];
    while (pos.i < items.length) {
      const it = items[pos.i]!;
      if ((it.k === "choice" || it.k === "gather") && it.depth <= level) return out;
      if (it.k === "choice") {
        const depth = it.depth;
        const gsc = it.sc ?? sc;
        const options: ChoiceNode[] = [];
        /** 選択肢の条件と文の中の関数の呼び出し（選択肢の前に置く）。 */
        const pre: Node[] = [];
        let fallback: Target | null = null;
        while (pos.i < items.length) {
          const c = items[pos.i]!;
          if (c.k !== "choice" || c.depth !== depth) break;
          pos.i++;
          const csc = c.sc ?? sc;
          const body = weave(items, pos, depth, csc);
          const opt = choiceOption(c, body, csc);
          pre.push(...drain());
          if (opt === null) continue;
          if ("fallback" in opt) fallback = opt.fallback;
          else {
            pre.push(...opt.pre);
            const { pre: _, ...option } = opt;
            options.push(option);
          }
        }
        s.stats.choices++;
        out.push(...pre, { k: "choice", options, fallback, line: it.at.line });
        const g = items[pos.i];
        if (g && g.k === "gather" && g.depth === depth) {
          pos.i++;
          const isc = g.sc ?? gsc;
          if (g.label) out.push({ k: "label", name: pointLabel(isc, g.label) });
          if (g.text.trim()) out.push(...contentNodes(g.text, isc, g.at));
        }
        continue;
      }
      pos.i++;
      const isc = it.sc ?? sc;
      if (it.k === "gather") {
        if (it.label) out.push({ k: "label", name: pointLabel(isc, it.label) });
        if (it.text.trim()) out.push(...contentNodes(it.text, isc, it.at));
        continue;
      }
      out.push(...itemNodes(it, isc));
    }
    return out;
  };

  const choiceOption = (c: Extract<Item, { k: "choice" }>, body: Node[], sc: Scope): (ChoiceNode & { pre: Node[] }) | { fallback: Target } | null => {
    s.file = c.at.file;
    const line = c.at.line;
    const conds: string[] = [];
    for (const src of c.conds) {
      const e = expr(src, sc, line);
      if (e === null) return null;
      conds.push(conds.length === 0 && c.conds.length === 1 ? e : `(${e})`);
    }
    // 条件の中の関数の呼び出しは選択肢の前に（選んだ後の中身の前ではなく）
    const pre = drain();
    const { text, tags, divert } = splitLine(c.text);
    const open = topLevel(text, "[", false);
    const close = open >= 0 ? text.indexOf("]", open) : -1;
    const before = open >= 0 ? text.slice(0, open) : text;
    const inside = open >= 0 && close >= 0 ? text.slice(open + 1, close) : "";
    const after = open >= 0 && close >= 0 ? text.slice(close + 1) : open >= 0 ? text.slice(open + 1) : "";
    const display = open >= 0 ? `${before}${inside}` : text;
    const output = open >= 0 ? `${before}${after}` : text;
    const nodes: Node[] = [];
    for (const tag of tags) nodes.push(...s.command(tag, line, "タグ"));
    if (output.trim()) nodes.push(...contentNodes(output.trim(), sc, c.at));
    if (divert !== null) nodes.push(...divertNodes(divert, sc, line));
    nodes.push(...body);
    if (display.trim() === "") {
      const jump = nodes.find((n): n is Extract<Node, { k: "jump" }> => n.k === "jump");
      if (nodes.length === 1 && jump) {
        s.count("mapped");
        return { fallback: jump.target };
      }
      s.unsupportedSyntax("ink-empty-choice", "文の無い選択肢はダイバートだけのときに変換します", line);
      return null;
    }
    const post: Node[] = [];
    const ps = pieces(display.trim(), sc, line, post);
    pre.push(...drain());
    if (ps === null) return null;
    if (post.length > 0) s.issue("info", "ink-choice-sequence", "選択肢の文の中の順番（{A|B}）は進めません（いつも同じ回の文を出します）", line);
    s.count("mapped");
    const label = c.label ? pointLabel(sc, c.label) : null;
    return { text: limText(ps), cond: conds.length ? conds.join(" && ") : null, once: !c.sticky, label, body: nodes, line, pre };
  };

  /** 複数行の { … }。 */
  const blockNodes = (lines: readonly SrcLine[], sc: Scope, at: SrcLine): Node[] => {
    const line = at.line;
    const head = lines[0]!.text.trim();
    /** 条件の中の関数の呼び出し（条件分岐の前に置く）。 */
    const pre: Node[] = [];
    const cexpr = (src: string) => {
      const e = expr(src, sc, line);
      pre.push(...drain());
      return e;
    };
    // 枝の区切り（深さ 0 の - で始まる行。-> は除く）
    const branches: { marker: string | null; lines: SrcLine[] }[] = [{ marker: null, lines: [] }];
    let depth = 0;
    const headColon = topLevel(head, ":");
    const header = headColon >= 0 ? head.slice(0, headColon).trim() : null;
    const headRest = headColon >= 0 ? head.slice(headColon + 1).trim() : head;
    if (headRest) branches[0]!.lines.push({ ...lines[0]!, text: headRest });
    for (const l of lines.slice(1)) {
      const t = l.text.trim();
      const m = depth === 0 ? /^-(?!>)\s*(.*)$/.exec(t) : null;
      if (m) branches.push({ marker: m[1]!, lines: [] });
      else branches.at(-1)!.lines.push(l);
      depth += braceDepth(l.text);
    }
    const seqKind = header === null ? null : /^(stopping|cycle|shuffle(\s+(once|stopping|cycle))?|once)$/.exec(header)?.[1] ?? null;
    const bodyOf = (b: { lines: SrcLine[] }, first: string) => {
      const ls = first ? [{ ...at, text: first }, ...b.lines] : b.lines;
      return weave(itemize(ls), { i: 0 }, 0, sc);
    };
    /** `- 条件: 本文` の条件と本文（: の無い行は条件が無い）。 */
    const splitMarker = (marker: string) => {
      const colon = topLevel(marker, ":");
      return colon < 0 ? { cond: null, rest: marker } : { cond: marker.slice(0, colon).trim(), rest: marker.slice(colon + 1).trim() };
    };

    if (seqKind) {
      const items = branches.slice(1);
      const n = items.length;
      if (n === 0) return [];
      s.count("mapped");
      if (seqKind.startsWith("shuffle")) {
        if (seqKind !== "shuffle") s.issue("info", "ink-shuffle", `${seqKind} は shuffle（毎回ばらばら）として変換します`, line);
        const r = "temp.ink_shuffle";
        return [
          { k: "set", target: r, op: "=", value: `random(${n})` },
          { k: "if", branches: items.map((b, i) => ({ cond: `${r} == ${i}`, body: bodyOf(b, b.marker ?? "") })) },
        ];
      }
      const v = s.gameVariable("ink_seq", 0);
      const cond = (i: number) => (seqKind === "cycle" ? `(${v} - 1) % ${n} == ${i}` : `${v} == ${i + 1}`);
      return [
        { k: "set", target: v, op: "+=", value: "1" },
        {
          k: "if",
          branches: items.map((b, i) => ({ cond: seqKind === "stopping" && i === n - 1 && n > 1 ? null : cond(i), body: bodyOf(b, b.marker ?? "") })),
        },
      ];
    }

    const out: { cond: string | null; body: Node[] }[] = [];
    if (header !== null && branches.length > 1 && branches[0]!.lines.every((l) => l.text.trim() === "")) {
      // 場合分け: { x: - 0: … - 1: … - else: … }
      const subject = cexpr(header);
      if (subject === null) return [{ k: "comment", text: `{${head}` }];
      for (const b of branches.slice(1)) {
        const { cond, rest } = splitMarker(b.marker ?? "");
        if (cond === null || cond === "else") out.push({ cond: null, body: bodyOf(b, rest) });
        else {
          const value = cexpr(cond);
          if (value === null) return [{ k: "comment", text: `{${head}` }];
          out.push({ cond: `${subject} == ${value}`, body: bodyOf(b, rest) });
        }
      }
    } else if (header !== null) {
      // { 条件: … - else: … }
      const cond = cexpr(header);
      if (cond === null) return [{ k: "comment", text: `{${head}` }];
      out.push({ cond, body: bodyOf(branches[0]!, "") });
      for (const b of branches.slice(1)) {
        const m = splitMarker(b.marker ?? "");
        if (m.cond !== "else") {
          s.unsupportedSyntax("ink-conditional", `条件分岐の枝 - ${b.marker} を読めません（- else: だけ書けます）`, line);
          continue;
        }
        out.push({ cond: null, body: bodyOf(b, m.rest) });
      }
    } else {
      // { - 条件: … - 条件: … - else: … }
      for (const b of branches.slice(1)) {
        const { cond, rest } = splitMarker(b.marker ?? "");
        if (cond === null) {
          s.unsupportedSyntax("ink-conditional", `条件分岐の枝 - ${b.marker} に条件がありません`, line);
          continue;
        }
        if (cond === "else") out.push({ cond: null, body: bodyOf(b, rest) });
        else {
          const e = cexpr(cond);
          if (e === null) continue;
          out.push({ cond: e, body: bodyOf(b, rest) });
        }
      }
    }
    // else は最後に
    const elseAt = out.findIndex((b) => b.cond === null);
    if (elseAt >= 0 && elseAt !== out.length - 1) out.push(...out.splice(elseAt, 1));
    if (out.length === 0) return [];
    if (out[0]!.cond === null) return [...pre, ...out[0]!.body];
    s.count("mapped");
    return [...pre, { k: "if", branches: out }];
  };

  // ---- 組み立て ----
  const sections: Section[] = [];
  const sectionOf = (label: string | null, lines: readonly SrcLine[], sc: Scope, first: string | null) => {
    const body = weave(itemize(lines), { i: 0 }, 0, sc);
    if (body.length === 0 && first) body.push({ k: "jump", target: { label: first } });
    // 先頭に本文が無ければ（Ink ではすぐ終わる）、最初のノットから始める
    if (label === null && body.length === 0 && knots.length > 0) {
      s.issue("info", "ink-empty-root", `先頭に本文が無いので、最初のノット ${knots[0]!.name} から始めます`, 1);
      return;
    }
    sections.push({ label, body });
  };
  sectionOf(null, root, { knot: null, stitch: null, temps: new Set() }, null);
  for (const k of knots) {
    const temps = new Set<string>();
    const first = k.stitches[0] ? stitchLabel.get(`${k.name}.${k.stitches[0].name}`)! : null;
    sectionOf(knotLabel.get(k.name)!, k.body, { knot: k.name, stitch: null, temps }, first);
    for (const st of k.stitches) {
      const copy = new Set(temps);
      tempKinds.set(copy, new Map(tempKinds.get(temps)));
      sectionOf(stitchLabel.get(`${k.name}.${st.name}`)!, st.body, { knot: k.name, stitch: st.name, temps: copy }, null);
    }
  }

  // 関数は @define のマクロに（ノットの訪れた回数を数える変数を lower の前に決めるため、ここで変換する）
  const defineLines: string[] = [];
  for (const f of functions.values()) {
    s.file = f.file;
    const names = new Map<string, string>();
    const prologue: Node[] = [];
    for (const p of f.params) {
      // 引数に代入する関数は、引数を写した局所変数を使う（@let はパラメータと同じ名前にできない）
      const assigned = f.body.some((l) => new RegExp(`^\\s*~\\s*(temp\\s+)?${p.ink}\\s*(=(?!=)|\\+=|-=|\\*=|/=|\\+\\+|--)`, "u").test(l.text));
      names.set(p.ink, assigned ? `v_${p.local}` : p.local);
      if (assigned) prologue.push({ k: "let", name: `v_${p.local}`, value: p.local });
    }
    const sc: Scope = { knot: null, stitch: null, temps: new Set(f.params.map((p) => p.ink)), names, fn: f };
    // 引数の種類は、どの呼び出しでも同じならその種類（整数どうしの割り算を見分けるのに使う）
    const argKind = (i: number): Kind => {
      const ks = new Set(f.argKinds.map((k) => k[i] ?? "unknown"));
      return ks.size === 1 ? [...ks][0]! : "unknown";
    };
    tempKinds.set(sc.temps, new Map(f.params.map((p, i) => [p.ink, argKind(i)])));
    const body = weave(itemize(f.body), { i: 0 }, 0, sc);
    const types = f.params.map((_, i) => paramType(f.argKinds.map((k) => k[i] ?? "unknown")));
    defineLines.push("", `@define ${f.macro}(${[...f.params.map((p, i) => `${p.param}: ${types[i]}`), `${f.result}: variable`].join(", ")})`);
    defineLines.push(...renderFlat([...prologue, ...body], "  ", (what) => s.unsupportedSyntax("ink-function", `関数 ${f.name} の中の${what}は変換できません`, f.line), english));
    defineLines.push("@end");
    if (f.prints) s.issue("info", "ink-function-text", `関数 ${f.name} の本文（台詞・地の文）は、呼んだ行の前に別のページとして出します`, f.line);
  }

  s.file = mainFile;
  const lines = lower(
    sections,
    {
      file: name,
      end: o.end ?? "title",
      counted,
      onceVariable: (label) => s.gameVariable(`once_${label}`, false),
      issue: (i) => s.issue(i.severity, i.code, i.message, i.line),
      english,
    },
    used,
  );
  s.stats.labels = lines.filter((l) => l.startsWith("# ")).length;
  const head = [convertedHeader(mainFile, "ink", o.language)];
  if (s.options.variables === "set" && s.variables.size > 0) head.push(...s.variableLines());
  return s.result([{ name, source: mainFile, text: [...head, "", ...lines, ...defineLines].join("\n").replace(/\n{3,}/g, "\n\n") + "\n" }]);
}

/** Ink の名前をマクロとパラメータの名前（小文字の英数字と -）に。できなければ null。 */
function kebab(name: string): string | null {
  const k = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return /^[a-z][a-z0-9-]*$/.test(k) ? k : null;
}

/** 呼び出しの引数の種類から、マクロのパラメータの型（値はいつも (式) で渡すので、読みやすさのため）。 */
function paramType(kinds: readonly Kind[]): string {
  if (kinds.length > 0 && kinds.every((k) => k === "string")) return "string";
  if (kinds.length > 0 && kinds.every((k) => k === "bool")) return "bool";
  return "number";
}

// ---- 文字列の道具 ----

const LIST_TOKEN = /\s+|"(?:[^"\\]|\\.)*"|[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*|\d+(?:\.\d+)?|!\?|==|!=|<=|>=|&&|\|\||->|[\s\S]/gu;

/**
 * Ink の式の LIST の書き方を、変換できる形（__LIST_… の関数）に書き直す。isList は LIST の変数の名前か。
 * - `L ? a`・`L has (a, b)` は __LIST_HAS(L, a, b)、`L !? a`・`hasnt` はその否定
 * - `L == a`・`L == (a, b)`・`L == M` は __LIST_EQ（並びを問わず同じ項目か）、`!=` は __LIST_NE
 * - 残ったリストの変数は、式がそれだけで値を出すところ（mode が value。本文の {L}）なら __LIST_JOIN（項目を , でつなぐ）、
 *   ほかは __LIST_ANY（空でないか）。関数の引数（LIST_COUNT(L) など）はそのまま
 * リストの大小の比べ方と + - などの計算は変換できないので null。
 */
function rewriteLists(src: string, mode: "cond" | "value", isList: (name: string) => boolean): string | null {
  const toks = src.match(LIST_TOKEN) ?? [];
  const sig = (i: number, dir: 1 | -1) => {
    for (let j = i + dir; j >= 0 && j < toks.length; j += dir) if (!/^\s+$/.test(toks[j]!)) return j;
    return -1;
  };
  const isName = (t: string | undefined) => t !== undefined && /^[\p{L}_]/u.test(t);
  // 右の項（名前一つか、( 名前, … ) か ()）の終わりと、中の名前
  const operand = (i: number): { end: number; names: string[] } | null => {
    if (i < 0) return null;
    if (isName(toks[i]) && toks[sig(i, 1)] !== "(") return { end: i, names: [toks[i]!] };
    if (toks[i] !== "(") return null;
    const names: string[] = [];
    let j = sig(i, 1);
    while (j >= 0 && toks[j] !== ")") {
      if (isName(toks[j])) names.push(toks[j]!);
      else if (toks[j] !== ",") return null;
      j = sig(j, 1);
    }
    return j < 0 ? null : { end: j, names };
  };
  const out: string[] = [];
  const stack: ("call" | "group")[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t === "(") {
      stack.push(isName(toks[sig(i, -1)]) ? "call" : "group");
      out.push(t);
      continue;
    }
    if (t === ")") {
      stack.pop();
      out.push(t);
      continue;
    }
    if (!isName(t) || !isList(t) || toks[sig(i, 1)] === "(") {
      out.push(t);
      continue;
    }
    const opAt = sig(i, 1);
    const op = toks[opAt];
    if (op === "?" || op === "!?" || op === "has" || op === "hasnt" || op === "==" || op === "!=") {
      const right = operand(sig(opAt, 1));
      if (right) {
        const fn = op === "==" ? "__LIST_EQ" : op === "!=" ? "__LIST_NE" : "__LIST_HAS";
        out.push(`${op === "!?" || op === "hasnt" ? "not " : ""}${fn}(${[t, ...right.names].join(", ")})`);
        i = right.end;
        continue;
      }
    }
    const prev = toks[sig(i, -1)];
    if ([op, prev].some((x) => x !== undefined && /^(<|>|<=|>=|\+|-|\*|\/|%|\?|!\?|has|hasnt|==|!=)$/.test(x))) return null;
    if (stack.at(-1) === "call") out.push(t);
    else if (mode === "value" && src.trim() === t) out.push(`__LIST_JOIN(${t})`);
    else out.push(`__LIST_ANY(${t})`);
  }
  return out.join("");
}

/** VAR・CONST の初期値（数・文字列・真偽）。読めなければ undefined。 */
function literal(src: string): VariableInitial | undefined {
  const t = src.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(t);
  if (m) return m[1]!.replace(/\\(.)/g, "$1");
  return undefined;
}

/** // と /* … *\/ のコメントを除く（行の数は変えない）。 */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\" && i + 1 < text.length) {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const chunk = end < 0 ? text.slice(i) : text.slice(i, end + 2);
      out += chunk.replace(/[^\n]/g, "");
      i += chunk.length;
      continue;
    }
    if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    out += text[i];
    i++;
  }
  return out.replace(/\r/g, "");
}

/** text[at] の { に対応する } の位置（無ければ -1）。 */
function matching(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/** 中に -> を含む最初の {…}。 */
function divertConstruct(raw: string): { before: string; inner: string; after: string } | null {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\\") {
      i++;
      continue;
    }
    if (raw[i] !== "{") continue;
    const end = matching(raw, i);
    if (end < 0) return null;
    const inner = raw.slice(i + 1, end);
    if (inner.includes("->")) return { before: raw.slice(0, i), inner, after: raw.slice(end + 1) };
    i = end;
  }
  return null;
}

/** 行の { と } の差。 */
function braceDepth(text: string): number {
  let d = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "{") d++;
    else if (text[i] === "}") d--;
  }
  return d;
}

/** 深さ depth から始めて 0 になる } の位置。 */
function closeIndex(text: string, depth: number): number {
  let d = depth;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "{") d++;
    else if (text[i] === "}" && --d === 0) return i;
  }
  return text.length;
}

/** { } の外（quotes なら "…" の外も）にある最初の ch の位置。 */
function topLevel(text: string, ch: string, quotes = true): number {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (quotes && c === '"') quoted = !quoted;
    else if (!quoted && c === "{") depth++;
    else if (!quoted && c === "}") depth--;
    else if (!quoted && depth === 0 && c === ch) return i;
  }
  return -1;
}

/** { } の外の ch で分ける。 */
function splitTop(text: string, ch: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && i + 1 < text.length) {
      cur += c + text[++i];
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (depth === 0 && c === ch) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** 本文の行を、本文・タグ（# の後ろ）・ダイバート（-> の後ろ）に分ける。 */
function splitLine(raw: string): { text: string; tags: string[]; divert: string | null } {
  let depth = 0;
  let hash = -1;
  let arrow = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && c === "#" && hash < 0) hash = i;
    else if (depth === 0 && arrow < 0 && hash < 0 && raw.startsWith("->", i)) arrow = i;
  }
  const tagPart = hash >= 0 ? raw.slice(hash + 1) : "";
  const main = hash >= 0 ? raw.slice(0, hash) : raw;
  const text = arrow >= 0 ? main.slice(0, arrow) : main;
  const divert = arrow >= 0 ? main.slice(arrow) : null;
  const tags = tagPart
    .split("#")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  return { text: text.replace(/\s+$/, ""), tags, divert };
}
