/**
 * Ink と Yarn Spinner に共通の、変換の途中の形と、それを .lim の行にする処理。
 *
 * 読み手（ink.ts・yarn.ts）は、ノット・ノードごとに Node の並びを作る。本文と式はこの時点で .lim の書き方になっている。
 * ここでは次のことをする。
 * - 選択肢の後ろの続き・選んだ後の中身を、それぞれラベルで始まるまとまり（ブロック）に分ける。
 *   .lim の選択肢はジャンプ先へ飛ぶだけで、ラベルは @if の中に置けないため
 * - 選択肢やラベルを中に持つ条件分岐は、枝ごとのブロックへのジャンプにする
 * - Ink の一度だけの選択肢（`*`）は、同じ選択肢に戻ってくる作りのときだけ、選んだかどうかの変数で隠す
 * - 訪れた回数を式で使うノット・ノードは、ラベルの直後で回数の変数を増やす
 * - 中身がジャンプだけの、名前を作ったブロックは、ジャンプ先へまとめる
 */
import { SPEECH_CLOSE, speechLine } from "@liminalia/lang";

/** 取り込みの結果の分類（TyranoScript の取り込みの報告と同じ）。 */
export type Outcome = "mapped" | "dropped" | "generic" | "manual";

export interface Issue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  file: string;
  /** 1 始まり。元のファイルの行。 */
  line: number;
}

/** ジャンプ先。label は .lim のラベル名（読み手が決めたもの）。file は別のファイルのとき。expr は実行時に決める式。 */
export type Target = { label: string; file?: string } | { expr: string; candidates?: string[] };

export type Node =
  /** 本文の一行。text は .lim の本文の書き方（{ } \ は逃がしてある）。 */
  | { k: "text"; speaker: string | null; text: string; line: number }
  /** そのまま出す .lim の行（対応表で変換したコマンドなど）。 */
  | { k: "raw"; text: string }
  | { k: "comment"; text: string }
  | { k: "set"; target: string; op: "=" | "+=" | "-=" | "*=" | "/="; value: string }
  | { k: "let"; name: string; value: string }
  | { k: "if"; branches: { cond: string | null; body: Node[] }[] }
  | { k: "choice"; options: ChoiceNode[]; fallback: Target | null; line: number }
  /** ここから先をこの名前のラベルにする（Ink のギャザーのラベルなど）。 */
  | { k: "label"; name: string }
  | { k: "jump"; target: Target }
  | { k: "call"; target: Target }
  /** value はマクロ（@define）の戻り値（.lim の式）。マクロの中身（renderFlat）でだけ使う。 */
  | { k: "return"; value?: string }
  | { k: "end" };

export interface ChoiceNode {
  /** 選択肢の文（.lim の本文の書き方）。 */
  text: string;
  /** 出す条件（.lim の式）。 */
  cond: string | null;
  /** Ink の `*`（一度選んだら出さない）。 */
  once: boolean;
  /** 選んだ後の中身の始まりに付けるラベル（Ink の `* (名前)`）。 */
  label: string | null;
  body: Node[];
  line: number;
}

/** 一つのノット・ノード（ラベルで始まるまとまり）。label が null のものはファイルの先頭。 */
export interface Section {
  label: string | null;
  body: Node[];
}

/** ブロックの終わりに来たとき（ジャンプも終わりも書いていない）にどうするか。 */
export type EndMode = "title" | "stop" | "return";

export interface LowerOptions {
  file: string;
  end: EndMode;
  /** 訪れた回数を数えるラベル（ラベル名 → 変数）。 */
  counted: ReadonlyMap<string, string>;
  /** 一度だけの選択肢を隠すのに使う変数の名前を作る（同じ名前を返さない）。 */
  onceVariable(label: string): string;
  issue(i: Omit<Issue, "file">): void;
  /** 英語の作品か（englishStory）。括弧の無い台詞を「」ではなく "" で囲む。 */
  english?: boolean;
}

type Ref = Target;

type Stmt =
  | { k: "line"; text: string }
  | { k: "if"; branches: { cond: string | null; body: Stmt[] }[] }
  | { k: "choice"; options: { text: string; cond: string | null; once: boolean; target: Ref; line: number }[]; fallback: Ref | null; line: number }
  | { k: "jump"; target: Ref }
  | { k: "call"; target: Ref }
  | { k: "return" }
  | { k: "end" };

interface Block {
  label: string | null;
  /** 読み手が付けた名前（ノット・ノード・ラベル）か。作った名前のブロックだけをまとめる。 */
  named: boolean;
  pre: string[];
  stmts: Stmt[];
}

/** 続きを書かない（@end の後ろへそのまま進む）ことを表す。 */
const FALL = Symbol("fall");
type Cont = string | null | typeof FALL;

/** Section の並びを .lim の行にする。used はファイルの中で使われているラベル名（作る名前と重ねない）。 */
export function lower(sections: readonly Section[], o: LowerOptions, used: Set<string>): string[] {
  const blocks: Block[] = [];
  const fresh = (base: string, kind: string): string => {
    for (let n = 1; ; n++) {
      const name = `${base}-${kind}${n}`;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  };
  const has = (nodes: readonly Node[]): boolean =>
    nodes.some((n) => n.k === "choice" || n.k === "label" || (n.k === "if" && n.branches.some((b) => has(b.body))));

  /** 新しいブロックを足して、nodes をそこに書く。 */
  const addBlock = (label: string | null, named: boolean, nodes: readonly Node[], cont: Cont, base: string) => {
    const b: Block = { label, named, pre: [], stmts: [] };
    blocks.push(b);
    compile(nodes, cont, b.stmts, base);
  };

  const compile = (nodes: readonly Node[], cont: Cont, out: Stmt[], base: string): void => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      const rest = nodes.slice(i + 1);
      switch (n.k) {
        case "text":
          out.push({ k: "line", text: textLine(n.speaker, n.text, o.english === true) });
          break;
        case "raw":
          out.push({ k: "line", text: n.text });
          break;
        case "comment":
          out.push({ k: "line", text: `// ${n.text}` });
          break;
        case "set":
          out.push({ k: "line", text: `@set ${n.target} ${n.op} ${n.value}` });
          break;
        case "let":
          out.push({ k: "line", text: `@let ${n.name} = ${n.value}` });
          break;
        case "call":
          out.push({ k: "call", target: n.target });
          break;
        case "label": {
          if (cont === FALL) throw new Error("条件分岐の中のラベル");
          out.push({ k: "jump", target: { label: n.name } });
          addBlock(n.name, true, rest, cont, base);
          return;
        }
        case "jump":
        case "return":
        case "end":
          out.push(n.k === "jump" ? { k: "jump", target: n.target } : { k: n.k });
          return skipUnreachable(rest, cont, base);
        case "choice": {
          if (cont === FALL) throw new Error("条件分岐の中の選択肢");
          const after = rest.length > 0 ? fresh(base, "g") : cont;
          const options = n.options.map((opt) => {
            const label = opt.label ?? fresh(base, "c");
            if (opt.label) used.add(opt.label);
            addBlock(label, opt.label !== null, opt.body, after, base);
            return { text: opt.text, cond: opt.cond, once: opt.once, target: { label } as Ref, line: opt.line };
          });
          out.push({ k: "choice", options, fallback: n.fallback, line: n.line });
          if (rest.length > 0) addBlock(after as string, false, rest, cont, base);
          return;
        }
        case "if": {
          if (!has(n.branches.flatMap((b) => b.body))) {
            const branches = n.branches.map((b) => {
              const body: Stmt[] = [];
              compile(b.body, FALL, body, base);
              return { cond: b.cond, body };
            });
            out.push({ k: "if", branches });
            break;
          }
          if (cont === FALL) throw new Error("条件分岐の中の条件分岐");
          // 選択肢やラベルを中に持つ: 枝ごとのブロックへジャンプし、どの枝もその後ろ（after）へ続ける
          const after = rest.length > 0 ? fresh(base, "g") : cont;
          const branches = n.branches.map((b) => {
            const label = fresh(base, "b");
            return { cond: b.cond, label, body: b.body };
          });
          out.push({ k: "if", branches: branches.map((b) => ({ cond: b.cond, body: [{ k: "jump", target: { label: b.label } }] })) });
          if (n.branches.at(-1)?.cond !== null) out.push(after === null ? { k: "end" } : { k: "jump", target: { label: after } });
          for (const b of branches) addBlock(b.label, false, b.body, after, base);
          if (rest.length > 0) addBlock(after as string, false, rest, cont, base);
          return;
        }
      }
    }
    if (cont === FALL) return;
    out.push(cont === null ? { k: "end" } : { k: "jump", target: { label: cont } });
  };

  /** 終わりの後ろの行。ラベルがあればそこから続け、無ければ届かない行として知らせて捨てる。 */
  const skipUnreachable = (rest: readonly Node[], cont: Cont, base: string): void => {
    const at = rest.findIndex((n) => n.k === "label");
    const dead = at < 0 ? rest : rest.slice(0, at);
    const line = dead.find((n): n is Extract<Node, { line: number }> => "line" in n);
    if (dead.some((n) => n.k !== "comment")) o.issue({ severity: "info", code: "unreachable", message: "ジャンプや終わりの後ろの行は届かないので書き出しません", line: line?.line ?? 0 });
    if (at < 0 || cont === FALL) return;
    const label = (rest[at] as Extract<Node, { k: "label" }>).name;
    addBlock(label, true, rest.slice(at + 1), cont, base);
  };

  for (const s of sections) addBlock(s.label, s.label !== null, s.body, null, s.label ?? "start");

  // 訪れた回数
  for (const b of blocks) {
    const v = b.label === null ? undefined : o.counted.get(b.label);
    if (v) b.pre.push(`@set ${v} += 1`);
  }
  // 一度だけの選択肢: 選択肢のあるブロックが自分へ戻ってこられるときだけ隠す
  const cyclic = cyclicBlocks(blocks);
  const byLabel = new Map(blocks.flatMap((b) => (b.label === null ? [] : [[b.label, b] as const])));
  for (const b of blocks) {
    if (!cyclic.has(b)) continue;
    eachChoice(b.stmts, (c) => {
      for (const opt of c.options) {
        if (!opt.once || !("label" in opt.target)) continue;
        const target = byLabel.get(opt.target.label);
        if (!target) continue;
        const v = o.onceVariable(opt.target.label);
        opt.cond = opt.cond ? `!${v} && (${opt.cond})` : `!${v}`;
        target.pre.unshift(`@set ${v} = true`);
      }
    });
  }
  // 中身がジャンプだけの作った名前のブロックをまとめる
  const alias = new Map<string, Ref>();
  for (const b of blocks) {
    const only = b.stmts[0];
    if (b.label === null || b.named || b.pre.length > 0 || b.stmts.length !== 1 || !only || only.k !== "jump") continue;
    alias.set(b.label, only.target);
  }
  const resolve = (r: Ref): Ref => {
    let cur = r;
    for (let guard = 0; guard < 100 && "label" in cur && cur.file === undefined && alias.has(cur.label); guard++) cur = alias.get(cur.label)!;
    return cur;
  };
  const kept = blocks.filter((b) => b.label === null || !alias.has(b.label));
  for (const b of kept) mapRefs(b.stmts, resolve);

  // 書き出す
  const lines: string[] = [];
  const endLine = o.end === "title" ? "@title-screen" : o.end === "stop" ? "@stop" : "@return";
  kept.forEach((b, i) => {
    if (b.label !== null) {
      if (lines.length > 0) lines.push("");
      lines.push(`# ${b.label}`);
    }
    lines.push(...b.pre);
    const stmts = [...b.stmts];
    const last = stmts.at(-1);
    const next = kept[i + 1];
    // 次のブロックへのジャンプはそのまま進むのと同じなので書かない
    if (last?.k === "jump" && "label" in last.target && last.target.file === undefined && next?.label === last.target.label) stmts.pop();
    render(stmts, "", lines, endLine);
  });
  return lines;
}

function eachChoice(stmts: readonly Stmt[], f: (c: Extract<Stmt, { k: "choice" }>) => void): void {
  for (const s of stmts) {
    if (s.k === "choice") f(s);
    else if (s.k === "if") for (const b of s.branches) eachChoice(b.body, f);
  }
}

function mapRefs(stmts: Stmt[], f: (r: Ref) => Ref): void {
  for (const s of stmts) {
    if (s.k === "jump" || s.k === "call") s.target = f(s.target);
    else if (s.k === "choice") {
      for (const o of s.options) o.target = f(o.target);
      if (s.fallback) s.fallback = f(s.fallback);
    } else if (s.k === "if") for (const b of s.branches) mapRefs(b.body, f);
  }
}

function refsOf(stmts: readonly Stmt[], out: Ref[] = []): Ref[] {
  for (const s of stmts) {
    if (s.k === "jump" || s.k === "call") out.push(s.target);
    else if (s.k === "choice") {
      for (const o of s.options) out.push(o.target);
      if (s.fallback) out.push(s.fallback);
    } else if (s.k === "if") for (const b of s.branches) refsOf(b.body, out);
  }
  return out;
}

/** 自分へ戻ってこられるブロック（強連結成分が二つ以上か、自分へのジャンプがある）。 */
function cyclicBlocks(blocks: readonly Block[]): Set<Block> {
  const index = new Map(blocks.flatMap((b, i) => (b.label === null ? [] : [[b.label, i] as const])));
  const edges = blocks.map((b) => refsOf(b.stmts).flatMap((r) => ("label" in r && r.file === undefined && index.has(r.label) ? [index.get(r.label)!] : [])));
  const out = new Set<Block>();
  let counter = 0;
  const num = new Array<number>(blocks.length).fill(-1);
  const low = new Array<number>(blocks.length).fill(0);
  const stack: number[] = [];
  const onStack = new Array<boolean>(blocks.length).fill(false);
  const visit = (v: number) => {
    num[v] = low[v] = counter++;
    stack.push(v);
    onStack[v] = true;
    for (const w of edges[v]!) {
      if (num[w] === -1) {
        visit(w);
        low[v] = Math.min(low[v]!, low[w]!);
      } else if (onStack[w]) low[v] = Math.min(low[v]!, num[w]!);
    }
    if (low[v] === num[v]) {
      const scc: number[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack[w] = false;
        scc.push(w);
        if (w === v) break;
      }
      if (scc.length > 1 || edges[v]!.includes(v)) for (const w of scc) out.add(blocks[w]!);
    }
  };
  for (let v = 0; v < blocks.length; v++) if (num[v] === -1) visit(v);
  return out;
}

function refText(r: Ref): string {
  if ("expr" in r) return `(${r.expr})${r.candidates?.length ? ` to=${r.candidates.join(",")}` : ""}`;
  return r.file === undefined ? `#${r.label}` : `${r.file}#${r.label}`;
}

function render(stmts: readonly Stmt[], indent: string, lines: string[], endLine: string): void {
  for (const s of stmts) {
    switch (s.k) {
      case "line":
        lines.push(indent + s.text);
        break;
      case "jump":
        lines.push(`${indent}@jump ${refText(s.target)}`);
        break;
      case "call":
        lines.push(`${indent}@call ${refText(s.target)}`);
        break;
      case "return":
        lines.push(`${indent}@return`);
        break;
      case "end":
        lines.push(indent + endLine);
        break;
      case "if": {
        s.branches.forEach((b, i) => {
          lines.push(`${indent}${i === 0 ? `@if ${b.cond}` : b.cond === null ? "@else" : `@elif ${b.cond}`}`);
          render(b.body, `${indent}  `, lines, endLine);
        });
        lines.push(`${indent}@end`);
        break;
      }
      case "choice": {
        if (s.fallback) {
          // 出せる選択肢が一つも無いときだけ進む先（Ink の、文の無い選択肢）
          const avail = s.options.map((o) => o.cond);
          if (avail.every((c) => c !== null)) {
            lines.push(`${indent}@if ${avail.map((c) => `!(${c})`).join(" && ")}`);
            lines.push(`${indent}  @jump ${refText(s.fallback)}`);
            lines.push(`${indent}@end`);
          }
        }
        if (s.options.length === 0) {
          if (s.fallback) lines.push(`${indent}@jump ${refText(s.fallback)}`);
          else lines.push(indent + endLine);
          break;
        }
        lines.push(`${indent}@choice`);
        for (const o of s.options) lines.push(`${indent}  - ${o.text} -> ${refText(o.target)}${o.cond ? ` if=(${o.cond})` : ""}`);
        lines.push(`${indent}@end`);
        break;
      }
    }
  }
}

/**
 * マクロ（@define）の中身のように、ラベルと選択肢とジャンプの無い Node の並びを .lim の行にする。
 * 書けないもの（選択肢・ラベル・ジャンプ・終わり）は unsupported に渡してコメントにする。
 */
export function renderFlat(nodes: readonly Node[], indent: string, unsupported: (what: string) => void, english = false): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    switch (n.k) {
      case "text":
        out.push(indent + textLine(n.speaker, n.text, english));
        break;
      case "raw":
        out.push(indent + n.text);
        break;
      case "comment":
        out.push(`${indent}// ${n.text}`);
        break;
      case "set":
        out.push(`${indent}@set ${n.target} ${n.op} ${n.value}`);
        break;
      case "let":
        out.push(`${indent}@let ${n.name} = ${n.value}`);
        break;
      case "return":
        out.push(n.value === undefined ? `${indent}@return` : `${indent}@return (${n.value})`);
        break;
      case "if":
        n.branches.forEach((b, i) => {
          out.push(`${indent}${i === 0 ? `@if ${b.cond}` : b.cond === null ? "@else" : `@elif ${b.cond}`}`);
          out.push(...renderFlat(b.body, `${indent}  `, unsupported, english));
        });
        out.push(`${indent}@end`);
        break;
      default: {
        const what = n.k === "choice" ? "選択肢" : n.k === "label" ? "ラベル" : n.k === "end" ? "終わり" : "ジャンプ";
        unsupported(what);
        out.push(`${indent}// （${what}は関数の中に書けません）`);
      }
    }
  }
  return out;
}

/**
 * 英語の作品か（元のファイルにひらがなとカタカナが一つも無い）。英語の作品なら、括弧の無い台詞を「」ではなく英語の引用符で囲む
 * （Ren'Py の `e "…"` や Ink の `名前: 台詞` の英語の台詞が、ゲームで「…」と出ないように）。一つの取り込みの中ではそろえる。
 */
export function englishStory(...sources: readonly string[]): boolean {
  return !sources.some((t) => /[\u3040-\u30ff]/.test(t));
}

/**
 * 本文の一行。話者があれば台詞、無ければ地の文（行頭の記号は逃がす）。台詞は、括弧か引用符で囲んでいればそのまま
 * （引用符なら話者名との間に半角の空白を入れる）、囲んでいなければ「」で囲む（english なら "" で。本文に " があれば “” で）。
 */
export function textLine(speaker: string | null, text: string, english = false): string {
  if (speaker !== null) {
    // 行の最後の {noclick} は括弧の外に置く
    const tail = text.endsWith("{noclick}") ? "{noclick}" : "";
    const body = tail ? text.slice(0, -tail.length) : text;
    const close = SPEECH_CLOSE[body[0] ?? ""];
    if (close && body.endsWith(close) && body.length >= 2) return `${speechLine(speaker, body)}${tail}`;
    if (!english) return `${speaker}「${body}」${tail}`;
    return body.includes('"') ? `${speaker} “${body}”${tail}` : `${speaker} "${body}"${tail}`;
  }
  return /^(@|#|\/\/)/.test(text) ? `\\${text}` : text;
}

/** 本文の { } \ を逃がす。 */
export const escapeText = (text: string): string => text.replace(/[\\{}]/g, (c) => `\\${c}`);

/** .lim の式の中の文字列。 */
export const quote = (text: string): string => `"${text.replace(/[\\"\n\r]/g, (c) => `\\${c === "\n" || c === "\r" ? "n" : c}`)}"`;
