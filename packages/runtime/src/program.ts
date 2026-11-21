import { pageKeys, voiceLines, type Argument, type ChoiceOption, type Expr, type Inline, type Param, type Script, type Statement, type Target } from "@liminalia/lang";

/**
 * 実行単位。ファイル本体と、各 @define の本体がそれぞれ一つの Unit になる。
 * 制御構文は条件ジャンプに展開してあり、実行位置は (unit, index) の二つの値で表せる。
 * そのためセーブデータに実行位置をそのまま書ける。
 */
export interface Unit {
  /** "chapter1" または "chapter1::title-card"。 */
  id: string;
  file: string;
  instructions: Instruction[];
  /** ラベル名 → 位置（ファイル本体の Unit だけが持つ）。 */
  labels: Record<string, number>;
  /** @if の中にあるラベル（飛び込めない。検査ではエラー）。 */
  nestedLabels?: Set<string>;
  /** @define の Unit だけが持つ。 */
  params?: Param[];
}

export type Instruction =
  /** name はこの行だけ名前欄に出す名前（話者{name …}）。id は行末の固定の行 ID（#line:ID。訳の鍵）。 */
  | { op: "say"; speaker: string | null; name?: Inline[]; content: Inline[]; line: number; id?: string }
  /** body は @end までの行をそのまま持つ命令（@html）の中身。content は @with で渡す中身の実行単位の id。 */
  | { op: "command"; name: string; args: Argument[]; body?: string; content?: string; line: number }
  | { op: "branch"; condition: Expr; /** 偽のときの飛び先 */ otherwise: number; line: number }
  | { op: "goto"; to: number; line: number }
  | { op: "choice"; options: ChoiceOption[]; args?: Argument[]; line: number }
  | { op: "set"; target: Expr; operator: "=" | "+=" | "-=" | "*=" | "/="; value: Expr; line: number }
  | { op: "let"; name: string; value: Expr; line: number }
  | { op: "jump" | "call"; target: Target; line: number }
  /** value はマクロの戻り値（@return (式)）。 */
  | { op: "return"; value?: Expr; line: number }
  /** @with で渡された中身を実行する（@define の中の @content）。 */
  | { op: "content"; line: number }
  | { op: "script"; code: string; line: number }
  | { op: "label"; name: string; line: number };

export interface Program {
  file: string;
  main: Unit;
  defines: Map<string, Unit>;
  /** @use したファイル（ここにある @define を呼べる）。 */
  uses: string[];
  /** 台詞の行 → ボイスの番号の固定の鍵（voice-lock.json）。 */
  voiceKeys: Map<number, string>;
  /** 本文の行 → ページの鍵（既読を覚えるのに使う。@liminalia/lang の pageKeys）。 */
  pageKeys: Map<number, string>;
  /** @function で作った式の関数（名前 → 引数と中身）。 */
  functions: Map<string, UserFunction>;
}

/** @function で作った式の関数。file は書いたファイル（中から呼ぶ関数はそのファイルから探す）。 */
export interface UserFunction {
  file: string;
  params: string[];
  body: Expr;
}

export function buildProgram(script: Script): Program {
  const main: Unit = { id: script.file, file: script.file, instructions: [], labels: {} };
  const defines = new Map<string, Unit>();
  emitBlock(script.body, main, defines, false, { withs: 0, loops: 0 });
  const uses = script.body.flatMap((s) => (s.kind === "use" ? [s.file] : []));
  const functions = new Map<string, UserFunction>();
  for (const s of script.body) if (s.kind === "function" && !functions.has(s.name)) functions.set(s.name, { file: script.file, params: s.params, body: s.body });
  return { file: script.file, main, defines, uses, voiceKeys: new Map(voiceLines(script).map((l) => [l.line, l.key])), pageKeys: pageKeys(script), functions };
}

/**
 * withs は @with の中身に振る番号（ファイルの中で書いた順。中身の実行単位は `ファイル::@with:番号` で、defines に置く）。
 */
function emitBlock(body: Statement[], unit: Unit, defines: Map<string, Unit>, inIf: boolean, counter: { withs: number; loops: number }): void {
  const out = unit.instructions;
  for (const s of body) {
    switch (s.kind) {
      case "prose":
        out.push({ op: "say", speaker: null, content: s.content, line: s.line, ...(s.id ? { id: s.id } : {}) });
        break;
      case "say":
        out.push({ op: "say", speaker: s.speaker, ...(s.name ? { name: s.name } : {}), content: s.content, line: s.line, ...(s.id ? { id: s.id } : {}) });
        break;
      case "label":
        unit.labels[s.name] ??= out.length;
        if (inIf) (unit.nestedLabels ??= new Set()).add(s.name);
        out.push({ op: "label", name: s.name, line: s.line });
        break;
      case "command":
        out.push({ op: "command", name: s.name, args: s.args, ...(s.body ? { body: s.body.text } : {}), line: s.line });
        break;
      case "if": {
        if (s.with) {
          // @with: 中身を別の実行単位にして、マクロの呼び出しに渡す（マクロの中の @content がそこへ入る）
          const key = `@with:${++counter.withs}`;
          const child: Unit = { id: `${unit.file}::${key}`, file: unit.file, instructions: [], labels: {} };
          emitBlock(s.branches[0]?.body ?? [], child, defines, true, counter);
          child.instructions.push({ op: "return", line: s.line });
          defines.set(key, child);
          out.push({ op: "command", name: s.with.name, args: s.with.args, content: child.id, line: s.line });
          break;
        }
        if (s.each) {
          // @for 名前 in 式: 配列（辞書ならキーの並び）を一度だけ求めて隠れた局所変数に置き、番号を進めながら要素を名前に入れてくり返す。
          // 隠れた名前は @ で始まるので、式からは書けない（台本の変数とぶつからない）
          const b = s.branches[0]!;
          const n = ++counter.loops;
          const list: Expr = { kind: "name", name: `@for${n}:list` };
          const index: Expr = { kind: "name", name: `@for${n}:i` };
          out.push({ op: "let", name: `@for${n}:list`, value: { kind: "call", callee: EACH_FUNCTION, args: [s.each.list] }, line: s.line });
          out.push({ op: "let", name: `@for${n}:i`, value: { kind: "literal", value: 0 }, line: s.line });
          const start = out.length;
          const branch: Extract<Instruction, { op: "branch" }> = { op: "branch", condition: { kind: "binary", op: "<", left: index, right: { kind: "call", callee: "len", args: [list] } }, otherwise: -1, line: s.line };
          out.push(branch);
          out.push({ op: "let", name: s.each.name, value: { kind: "index", object: list, index }, line: s.line });
          out.push({ op: "let", name: `@for${n}:i`, value: { kind: "binary", op: "+", left: index, right: { kind: "literal", value: 1 } }, line: s.line });
          emitBlock(b.body, unit, defines, true, counter);
          out.push({ op: "goto", to: start, line: s.line });
          branch.otherwise = out.length;
          break;
        }
        if (s.loop) {
          // @while: 条件が偽なら @end の後ろへ。中を終えたら条件へ戻る
          const start = out.length;
          const b = s.branches[0]!;
          const branch: Extract<Instruction, { op: "branch" }> = { op: "branch", condition: b.condition!, otherwise: -1, line: b.line };
          out.push(branch);
          emitBlock(b.body, unit, defines, true, counter);
          out.push({ op: "goto", to: start, line: b.line });
          branch.otherwise = out.length;
          break;
        }
        const exits: { op: "goto"; to: number; line: number }[] = [];
        for (const b of s.branches) {
          let branch: Extract<Instruction, { op: "branch" }> | null = null;
          if (b.condition) {
            branch = { op: "branch", condition: b.condition, otherwise: -1, line: b.line };
            out.push(branch);
          }
          emitBlock(b.body, unit, defines, true, counter);
          const exit = { op: "goto" as const, to: -1, line: b.line };
          out.push(exit);
          exits.push(exit);
          if (branch) branch.otherwise = out.length;
        }
        for (const e of exits) e.to = out.length;
        break;
      }
      case "choice":
        out.push({ op: "choice", options: s.options, ...(s.args ? { args: s.args } : {}), line: s.line });
        break;
      case "define": {
        const id = `${unit.file}::${s.name}`;
        const child: Unit = { id, file: unit.file, instructions: [], labels: {}, params: s.params };
        emitBlock(s.body, child, defines, false, counter);
        child.instructions.push({ op: "return", line: s.line });
        defines.set(s.name, child);
        break;
      }
      case "script":
        out.push({ op: "script", code: s.code, line: s.line });
        break;
      case "set":
        out.push({ op: "set", target: s.target, operator: s.op, value: s.value, line: s.line });
        break;
      case "let":
        out.push({ op: "let", name: s.name, value: s.value, line: s.line });
        break;
      case "jump":
      case "call":
        out.push({ op: s.kind, target: s.target, line: s.line });
        break;
      case "return":
        out.push({ op: "return", ...(s.value ? { value: s.value } : {}), line: s.line });
        break;
      case "content":
        out.push({ op: "content", line: s.line });
        break;
      case "use":
      case "function":
        break;
    }
  }
}

/** @for が回すものを配列にする式の関数（実行器だけが呼ぶ。名前は式からは書けない。value.ts）。 */
export const EACH_FUNCTION = "@each";
