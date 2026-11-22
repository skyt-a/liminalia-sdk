import type { Inline, Registry } from "@liminalia/lang";
import { speakerName, type CharaDefs } from "../chara.ts";
import type { LineOrigin } from "../convert.ts";
import { lex, parseTag } from "../lexer.ts";
import type { RawCommand } from "../types.ts";
import { jsExpression, linesDistance, optionCond, targetEdits, type TagInverter } from "./inverse.ts";
import { editTagBody, guardKsLine, scanKsLine, tagBody, wrapTag } from "./ks-line.ts";
import { diffLines } from "./line-diff.ts";
import { readLimLines, type LimLine } from "./lim-line.ts";
import { endsWithNoclick, inlineToKs, type RubyStyle } from "./text.ts";

/**
 * 一つのファイルの書き戻し。基準の .lim と今の .lim の行の差分を、対応表で基準の .ks の位置に当てて新しい .ks を作る。
 *
 * 1. 基準の .lim と今の .lim を行ごとに比べ（字下げは見ない）、変わったところを「書き換え・追加・削除」に分ける
 *    （同じ塊の中で消えた行と足した行は、種類が同じで似ているものを書き換えの組にする）
 * 2. 対応表で、基準の .lim の行を .ks の行の範囲（単位）にまとめる。範囲の重なる行は一つの単位にし、本文の単位には
 *    直前の話者の行（`#名前`）を含める。どの単位にも入らない .ks の行（[tb_start_text] などの囲み・書き出さないタグ・空行・
 *    コメント）はそのまま残す
 * 3. .ks を前から書き直す。変わらない単位はそのまま、書き換えた単位は本文なら本文だけ・命令ならそのタグだけを差し替え、
 *    足した行は前後の書き方（TyranoBuilder のテキストブロックの囲み・話者の行）に合わせて置く。書き直しながら
 *    テキストブロックの中か外か・今の話者を追い、基準の .ks がその位置で前提にしている状態と食い違えば囲みや話者の行を足す
 */

export interface BackportIssue {
  severity: "error" | "warning" | "info";
  /** 今の .lim の行（1 始まり）。 */
  limLine: number | null;
  /** 基準の .ks の行（1 始まり）。 */
  ksLine: number | null;
  message: string;
}

/** プロジェクト全体の書き方（ファイルの中に手本が無いときに使う）。 */
export interface ProjectStyle {
  ruby: RubyStyle;
  /** 話者名 → `#…` の行。"" は地の文に戻す行。 */
  speakerLines: ReadonlyMap<string, string>;
  /** TyranoBuilder のテキストブロックの囲み（使っていなければ null）。 */
  block: { open: string; close: string } | null;
  /** 命令名 → ほかのファイルの手本のタグ。 */
  templates: ReadonlyMap<string, readonly string[]>;
}

export interface FileInput {
  /** .ks（data/scenario からのパス）。 */
  file: string;
  baseKs: string;
  baseLim: string;
  map: readonly (LineOrigin | null)[];
  curLim: string;
  inverter: TagInverter;
  registry: Registry;
  speakers: ReadonlySet<string>;
  charas: CharaDefs;
  project: ProjectStyle;
  /** 差分が無くても書き直す（書き直しが変わらない単位を一字一句保つかを確かめるため）。 */
  rewriteAll?: boolean;
}

export interface FileResult {
  ks: string;
  issues: BackportIssue[];
  stats: { modified: number; inserted: number; deleted: number; failed: number };
}

interface Unit {
  /** 話者の行を含めた最初の .ks の行。 */
  head: number;
  from: number;
  to: number;
  /** 基準の .lim の行（0 始まり）。 */
  members: number[];
  /** 出どころの命令（compile の位置）。 */
  tags: number[];
}

type Status = { op: "keep"; cur: number } | { op: "delete" } | { op: "modify"; cur: number };

interface State {
  inBlock: boolean;
  speaker: string;
}

export function backportFile(input: FileInput): FileResult {
  const issues: BackportIssue[] = [];
  const stats = { modified: 0, inserted: 0, deleted: 0, failed: 0 };
  const B = splitLines(input.baseLim);
  const C = splitLines(input.curLim);
  const key = (l: string) => l.replace(/^[ \t]+/, "").replace(/[ \t\r]+$/, "");
  const ops = diffLines(B.map(key), C.map(key));
  if (ops.every((o) => o.op === "equal") && !input.rewriteAll) return { ks: input.baseKs, issues, stats };
  if (input.map.length !== B.length) {
    issues.push({ severity: "error", limLine: null, ksLine: null, message: "対応表の行数が基準の .lim と合いません（基準の .lim と対応表が同じ取り込みのものか確かめてください）" });
    return { ks: input.baseKs, issues, stats: { ...stats, failed: 1 } };
  }
  const speakers = [...input.speakers];
  const Bl = readLimLines(input.baseLim, speakers);
  const Cl = readLimLines(input.curLim, speakers);

  // ---- 基準の .ks ----
  const trailingNewline = input.baseKs === "" || input.baseKs.endsWith("\n");
  const K = input.baseKs === "" ? [] : input.baseKs.split("\n");
  if (input.baseKs.endsWith("\n")) K.pop();
  const eol = K.some((l) => l.endsWith("\r")) ? "\r" : "";
  const commands = lex(input.baseKs, input.file).commands;
  const byLine = new Map<number, number[]>();
  commands.forEach((c, i) => {
    const list = byLine.get(c.line) ?? [];
    list.push(i);
    byLine.set(c.line, list);
  });
  /** 行 k（1 始まり）を書く前の状態。 */
  const before: State[] = [];
  const speakerRaw = new Map<string, string>();
  let blockOpen: string | null = null;
  let blockClose: string | null = null;
  {
    let s: State = { inBlock: false, speaker: "" };
    for (let k = 1; k <= K.length + 1; k++) {
      before[k] = s;
      s = applyLine(s, k);
    }
  }
  function applyLine(s: State, k: number): State {
    const next = { ...s };
    for (const i of byLine.get(k) ?? []) {
      const c = commands[i]!;
      if (c.name === "chara_ptext") {
        next.speaker = speakerName(c.pm.name?.trim() ?? "", input.charas);
        if (!c.pm.face && !speakerRaw.has(next.speaker)) speakerRaw.set(next.speaker, K[k - 1]!.trim());
      } else if (c.name === "tb_start_text") {
        next.inBlock = true;
        blockOpen ??= K[k - 1]!.trim();
      } else if (c.name === "_tb_end_text") {
        next.inBlock = false;
        blockClose ??= K[k - 1]!.trim();
      }
    }
    return next;
  }
  // テキストブロックの囲みは、ファイルが使っていればそれ、本文があって使っていなければ無し、新しいファイルならプロジェクトのもの
  const block = blockOpen && blockClose ? { open: blockOpen, close: blockClose } : Bl.some((l) => l.kind === "text") ? null : input.project.block;
  const pageEnd = mostCommon(K.flatMap((l) => l.match(/\[p\s*\]\s*$/)?.[0].trim() ?? [])) ?? "[p]";
  const fileRuby = rubyStyleOf(K.join("\n")) ?? input.project.ruby;

  // ---- 単位 ----
  const units: Unit[] = [];
  const unitOf: (Unit | undefined)[] = [];
  {
    const entries = input.map.flatMap((o, i) => (o ? [{ o, i }] : [])).sort((a, b) => a.o.from - b.o.from || a.i - b.i);
    for (const { o, i } of entries) {
      const last = units.at(-1);
      if (last && o.from <= last.to) {
        last.to = Math.max(last.to, o.to);
        last.members.push(i);
        last.tags.push(...(o.tags ?? []));
      } else units.push({ head: o.from, from: o.from, to: o.to, members: [i], tags: [...(o.tags ?? [])] });
    }
    const covered = new Set<number>();
    for (const u of units) {
      u.members.sort((a, b) => a - b);
      for (let k = u.from; k <= u.to; k++) covered.add(k);
      for (const m of u.members) unitOf[m] = u;
    }
    // 本文の単位には、直前の話者の行（表情なしの `#名前`）を含める
    for (const u of units) {
      if (!u.members.every((m) => input.map[m]!.kind === "text")) continue;
      while (u.head > 1 && !covered.has(u.head - 1) && isSpeakerLine(u.head - 1)) {
        u.head--;
        covered.add(u.head);
      }
    }
  }
  function isSpeakerLine(k: number): boolean {
    const list = byLine.get(k) ?? [];
    return list.length === 1 && commands[list[0]!]!.name === "chara_ptext" && !commands[list[0]!]!.pm.face;
  }

  // ---- 差分を、書き換え・追加・削除に分ける ----
  const status: Status[] = B.map(() => ({ op: "keep", cur: -1 }) as Status);
  /** 追加した行（今の .lim の行）を、その前の基準の .lim の行（無ければ -1）ごとに。 */
  const insertsAfter = new Map<number, number[]>();
  {
    let lastBase = -1;
    const addInsert = (c: number) => {
      const list = insertsAfter.get(lastBase) ?? [];
      list.push(c);
      insertsAfter.set(lastBase, list);
    };
    let i = 0;
    while (i < ops.length) {
      const op = ops[i]!;
      if (op.op === "equal") {
        status[op.a] = { op: "keep", cur: op.b };
        lastBase = op.a;
        i++;
        continue;
      }
      const dels: number[] = [];
      const ins: number[] = [];
      while (i < ops.length && ops[i]!.op !== "equal") {
        const o = ops[i]!;
        if (o.op === "delete") dels.push(o.a);
        else if (o.op === "insert") ins.push(o.b);
        i++;
      }
      const pairs = pairLines(dels, ins);
      let di = 0;
      let ci = 0;
      for (const [d, c] of [...pairs, [Infinity, Infinity] as const]) {
        while (di < dels.length && dels[di]! < d) {
          status[dels[di]!] = { op: "delete" };
          lastBase = dels[di]!;
          di++;
        }
        while (ci < ins.length && ins[ci]! < c) addInsert(ins[ci++]!);
        if (d === Infinity) break;
        status[d] = { op: "modify", cur: c };
        lastBase = d;
        di++;
        ci++;
      }
    }
  }

  function pairLines(dels: number[], ins: number[]): [number, number][] {
    const sim = (d: number, c: number): number => {
      const a = Bl[d]!;
      const b = Cl[c]!;
      if (a.kind !== b.kind) return -1;
      if (a.kind === "blank") return -1;
      if (a.kind === "command" && b.kind === "command") return a.name === b.name ? 1 : -1;
      if (a.kind === "jump" && b.kind === "jump") return a.name === b.name ? 1 : -1;
      if (a.kind === "text" && b.kind === "text") return dice(a.body, b.body);
      if (a.kind === "option" && b.kind === "option") return 0.7 * dice(a.body, b.body) + (a.target === b.target ? 0.3 : 0);
      if (a.kind === "label" && b.kind === "label") return 0.3 + 0.7 * dice(a.name, b.name);
      return 0.6;
    };
    // 順を保った組み合わせで、似ている度合いの和が最大になるもの（数が同じなら種類が合う限り順に組む）
    const n = dels.length;
    const m = ins.length;
    const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const threshold = n === m ? 0 : 0.25;
    for (let x = 1; x <= n; x++) {
      for (let y = 1; y <= m; y++) {
        const s = sim(dels[x - 1]!, ins[y - 1]!);
        const diag = s >= threshold && s >= 0 ? score[x - 1]![y - 1]! + 0.5 + s : -Infinity;
        score[x]![y] = Math.max(score[x - 1]![y]!, score[x]![y - 1]!, diag);
      }
    }
    const pairs: [number, number][] = [];
    let x = n;
    let y = m;
    while (x > 0 && y > 0) {
      const s = sim(dels[x - 1]!, ins[y - 1]!);
      if (s >= threshold && s >= 0 && score[x]![y] === score[x - 1]![y - 1]! + 0.5 + s) {
        pairs.push([dels[x - 1]!, ins[y - 1]!]);
        x--;
        y--;
      } else if (score[x]![y] === score[x - 1]![y]) x--;
      else y--;
    }
    return pairs.reverse();
  }

  // ---- 追加した行を置く位置 ----
  /** .ks の行 k の前に置く、追加した行の塊。 */
  const placed = new Map<number, number[][]>();
  /** 単位の中の行のあとに足した行（単位ごと）。 */
  const inside = new Map<Unit, Map<number, number[]>>();
  const sortedUnits = [...units].sort((a, b) => a.head - b.head);
  const place = (k: number, group: number[]) => {
    const list = placed.get(k) ?? [];
    list.push(group);
    placed.set(k, list);
  };
  // 出どころのある基準の行までさかのぼる。同じ行に行き着く塊（あいだに基準の空行だけが挟まるもの）は、一つの塊にまとめる。
  // 別々に置くと、塊の先頭の行の種類（本文かどうか）で置き場所が変わり、足した順が入れ替わる（[endif] が [if] より前に出る）
  const anchored: { a: number; group: number[] }[] = [];
  for (const [anchor, group] of insertsAfter) {
    let a = anchor;
    while (a >= 0 && !input.map[a]) a--;
    const last = anchored.at(-1);
    if (last && last.a === a) last.group.push(...group);
    else anchored.push({ a, group: [...group] });
  }
  for (const { a, group } of anchored) {
    if (a < 0) {
      const first = sortedUnits[0];
      place(first ? glueSpot(0, first.head, Cl[group[0]!]!) : K.length + 1, group);
      continue;
    }
    const u = unitOf[a]!;
    const kind = input.map[a]!.kind;
    if (kind === "choice") {
      // @choice の直後（最初の選択肢の前）
      const next = input.map.findIndex((o, i) => i > a && o !== null && unitOf[i] !== u);
      place(next >= 0 ? unitOf[next]!.head : u.head, group);
      continue;
    }
    const later = u.members.filter((m) => m > a);
    if (later.length > 0 && !(kind === "choice-end")) {
      const map = inside.get(u) ?? new Map<number, number[]>();
      map.set(a, [...(map.get(a) ?? []), ...group]);
      inside.set(u, map);
      continue;
    }
    const next = sortedUnits[sortedUnits.indexOf(u) + 1];
    place(glueSpot(u.to, next ? next.head : K.length + 1, Cl[group[0]!]!), group);
  }

  /**
   * 単位の終わり（行 end）と次の単位（行 nextHead）の間で、追加した行を置く位置（その行の前に置く）。
   * 本文はテキストブロックの中（前の本文の直後か、次のブロックの [tb_start_text] の直後）、命令はブロックの外。
   */
  function glueSpot(end: number, nextHead: number, first: LimLine): number {
    const after = before[end + 1]!;
    const glue: number[] = [];
    for (let k = end + 1; k < nextHead; k++) glue.push(k);
    const opener = glue.find((k) => (byLine.get(k) ?? []).some((i) => commands[i]!.name === "tb_start_text"));
    const closer = glue.find((k) => (byLine.get(k) ?? []).some((i) => commands[i]!.name === "_tb_end_text"));
    if (first.kind === "text") {
      if (after.inBlock) return end + 1;
      if (opener !== undefined) return opener + 1;
      return end + 1;
    }
    if (first.kind === "option") return end + 1;
    if (!after.inBlock) return end + 1;
    if (closer !== undefined) return closer + 1;
    return end + 1;
  }

  // ---- 書き直し ----
  const out: string[] = [];
  const state: State = { inBlock: false, speaker: "" };
  /** 基準の行 k をそのまま（または text に替えて）書く。書く前に、基準がその行で前提にしている囲みの状態に合わせる。 */
  const writeBase = (k: number, text: string = K[k - 1]!) => {
    const want = before[k]!;
    const names = (byLine.get(k) ?? []).map((i) => commands[i]!.name);
    if (state.inBlock !== want.inBlock) {
      if (!state.inBlock && names.includes("_tb_end_text")) {
        // もう閉じている
        state.inBlock = false;
        return;
      }
      if (state.inBlock && names.includes("tb_start_text")) return;
      if (block) {
        pushRaw(want.inBlock ? block.open : block.close);
        state.inBlock = want.inBlock;
      }
    }
    out.push(text);
    const s = applyLine(state, k);
    state.inBlock = s.inBlock;
    state.speaker = s.speaker;
  };
  const pushRaw = (text: string) => out.push(text + eol);
  const speakerLine = (name: string) =>
    speakerRaw.get(name) ?? input.project.speakerLines.get(name) ?? (name === "" ? "#" : `#${[...speakerRaw.values()].some((r) => r.startsWith("# ")) ? " " : ""}${name}`);
  const ensureOutside = () => {
    if (state.inBlock && block) {
      pushRaw(block.close);
      state.inBlock = false;
    }
  };
  const ensureSpeaker = (name: string) => {
    if (state.speaker === name) return;
    pushRaw(speakerLine(name));
    state.speaker = name;
  };

  const pieceOf = (tag: number) => pieceAt(K, commands, byLine, tag);
  const pieceText = (tag: number) => {
    const p = pieceOf(tag);
    return p ? K[p.line - 1]!.slice(p.start, p.end) : null;
  };
  /** 単位の主なタグ（まとめて書き出すために書き出さなかったタグを除いた最後のもの）。 */
  const mainTag = (u: Unit) => u.tags.at(-1);
  const curLineNo = (c: number) => c + 1;
  const issue = (severity: BackportIssue["severity"], message: string, cur: number | null, ks: number | null) =>
    issues.push({ severity, limLine: cur === null ? null : curLineNo(cur), ksLine: ks, message });

  /** 今の .lim の本文の行を .ks の地の文にする。 */
  const ksText = (line: Extract<LimLine, { kind: "text" }>, ruby: RubyStyle, local: readonly string[], cur: number, ks: number | null) => {
    // この行だけの名前欄の名前（{name …}）は TyranoScript に無いので、話者のまま書き戻して知らせる
    if (line.name !== undefined) issue("warning", `台詞の表示名 {name ${line.name}} は .ks に戻せないため、話者 ${line.speaker} のまま書き戻します`, cur, ks);
    return inlineToKs(line.content, {
      ruby,
      inlineCommand: (node) => invertInline(node, local),
      problem: (m) => issue("error", m, cur, ks),
    });
  };
  const invertInline = (node: Extract<Inline, { kind: "command" }>, local: readonly string[]): string | null => {
    const text = `@${node.name}${node.args.map((a) => ` ${a.key === null ? "" : `${a.key}=`}${printArg(a.value)}`).join("")}`;
    const target = readLimLines(text, []);
    const templates = [...local.filter((p) => sameCommand(p, node.name)), ...templatesFor(node.name, null)];
    const piece = input.inverter.invert(templates, target);
    return piece === null ? null : piece.trim().startsWith("@") ? `[${tagBody(piece)}]` : piece;
  };
  const sameCommand = (piece: string, name: string) => {
    const l = input.inverter.convertPiece(piece).find((x) => x.kind === "command");
    return l?.kind === "command" && l.name === name;
  };
  /** 命令 name の手本のタグ（このファイルの近いものから。ks は置く位置）。 */
  function templatesFor(name: string, ks: number | null): string[] {
    const local: { piece: string; at: number }[] = [];
    for (const u of units) {
      if (u.members.length !== 1) continue;
      const l = Bl[u.members[0]!]!;
      const n = l.kind === "command" ? l.name : l.kind === "jump" ? l.name : l.kind === "set" ? "set" : l.kind === "option" ? "option" : null;
      if (n !== name) continue;
      const tag = mainTag(u);
      const piece = tag === undefined ? null : pieceText(tag);
      if (piece) local.push({ piece, at: u.from });
    }
    if (ks !== null) local.sort((a, b) => Math.abs(a.at - ks) + (a.at > ks ? 0.5 : 0) - (Math.abs(b.at - ks) + (b.at > ks ? 0.5 : 0)));
    return [...new Set([...local.slice(0, 4).map((x) => x.piece), ...(input.project.templates.get(name) ?? [])])].slice(0, 6);
  }

  /** 基準の本文の行のルビの書き方（無ければファイル・プロジェクトのもの）。 */
  const rubyOf = (lines: readonly string[]) => rubyStyleOf(lines.join("\n")) ?? fileRuby;

  /**
   * 書き換えた本文の .ks の行（元の行の字下げ・行の分け方・末尾の [p] を保つ）。行の最後に {noclick} があれば [p] を付けず、
   * 基準の行の最後にあった {noclick} を外したなら [p] を付ける（was は基準の行）。
   */
  const rewriteText = (u: Unit, cur: number, was?: Extract<LimLine, { kind: "text" }>): string[] => {
    const line = Cl[cur] as Extract<LimLine, { kind: "text" }>;
    const original = K.slice(u.from - 1, u.to);
    const local = original.flatMap((raw) => scanKsLine(raw).flatMap((p) => (p.kind === "tag" ? [raw.slice(p.start, p.end)] : [])));
    let body = ksText(line, rubyOf(original), local, cur, u.from);
    // TyranoBuilder の [lr]（[l][r]）を使っていれば、それに戻す
    if (original.some((l) => l.includes("[lr]"))) body = body.replaceAll("[l][r]", "[lr]");
    const last = original.at(-1)!;
    const lastPieces = scanKsLine(last);
    const tail = lastPieces.at(-1);
    const ended = tail && tail.kind === "tag" && /^\[p\s*\]$/.test(last.slice(tail.start, tail.end)) ? last.slice(tail.start, tail.end) : "";
    const pTag = endsWithNoclick(line.content) ? "" : ended === "" && was && endsWithNoclick(was.content) ? pageEnd : ended;
    const indent = /^[ \t]*/.exec(original[0]!)![0];
    const cr = original[0]!.endsWith("\r") ? "\r" : "";
    // 元が複数の行に分かれていれば（[r] などで改行していれば）、同じタグのあとで分ける
    const parts: string[] = [];
    if (original.length > 1) {
      let rest = body;
      for (const raw of original.slice(0, -1)) {
        const pieces = scanKsLine(raw);
        const endTag = pieces.at(-1)?.kind === "tag" ? raw.slice(pieces.at(-1)!.start, pieces.at(-1)!.end) : null;
        const at = endTag ? rest.indexOf(endTag) : -1;
        if (at < 0) break;
        parts.push(rest.slice(0, at + endTag!.length));
        rest = rest.slice(at + endTag!.length);
      }
      if (parts.length === original.length - 1) parts.push(rest);
      else parts.length = 0;
    }
    if (parts.length === 0) parts.push(body);
    return parts.map((p, i) => `${i === 0 ? indent + guardKsLine(p) : guardKsLine(p)}${i === parts.length - 1 ? pTag : ""}${cr}`);
  };

  /** 単位をそのまま書く（本文なら、話者の行のあとで今の話者を基準に合わせる）。 */
  const writeUnitAsIs = (u: Unit) => {
    const isText = u.members.every((m) => input.map[m]!.kind === "text");
    for (let k = u.head; k <= u.to; k++) {
      if (isText && k === u.from) {
        // 囲みを先に合わせてから話者を合わせる
        if (state.inBlock !== before[k]!.inBlock && block) {
          pushRaw(before[k]!.inBlock ? block.open : block.close);
          state.inBlock = before[k]!.inBlock;
        }
        ensureSpeaker(before[k]!.speaker);
      }
      writeBase(k);
    }
  };

  /** タグを消す（行がタグだけなら行ごと）。 */
  const removeTags = (u: Unit, tags: readonly number[]) => {
    const cuts = new Map<number, { start: number; end: number }[]>();
    for (const t of tags) {
      const p = pieceOf(t);
      if (!p) continue;
      const list = cuts.get(p.line) ?? [];
      list.push(p);
      cuts.set(p.line, list);
    }
    for (let k = u.head; k <= u.to; k++) {
      const list = cuts.get(k);
      if (!list) {
        if (k >= u.from && u.members.every((m) => input.map[m]!.kind === "text")) continue; // 本文の行は消す
        if (k < u.from) continue; // 本文の単位の話者の行
        writeBase(k);
        continue;
      }
      let raw = K[k - 1]!;
      for (const c of [...list].sort((a, b) => b.start - a.start)) raw = raw.slice(0, c.start) + raw.slice(c.end);
      if (raw.trim() === "") continue;
      writeBase(k, raw);
    }
  };

  /** 単位の中のタグ tag を piece に差し替えて書く。 */
  const replaceTag = (u: Unit, tag: number, piece: string) => {
    const p = pieceOf(tag);
    for (let k = u.head; k <= u.to; k++) {
      if (p && k === p.line) {
        const raw = K[k - 1]!;
        writeBase(k, raw.slice(0, p.start) + piece + raw.slice(p.end));
      } else writeBase(k);
    }
  };

  /** 書き換えた・足した行を含む単位の、今の .lim の行の並び。 */
  const targetOf = (u: Unit): number[] => {
    const lines: number[] = [];
    const extra = inside.get(u);
    for (const m of u.members) {
      const s = status[m]!;
      if (s.op !== "delete") lines.push(s.cur);
      for (const c of extra?.get(m) ?? []) lines.push(c);
    }
    return lines;
  };

  /** [link]〜[endlink] の選択肢の単位なら、その行と範囲（同じ行にあるものだけ）。 */
  const linkSpan = (u: Unit) => {
    if (u.tags.length !== 2 || commands[u.tags[0]!]!.name !== "link" || commands[u.tags[1]!]!.name !== "endlink") return null;
    const a = pieceOf(u.tags[0]!);
    const b = pieceOf(u.tags[1]!);
    if (!a || !b || a.line !== b.line) return null;
    return { line: a.line, start: a.start, linkEnd: a.end, endStart: b.start, end: b.end };
  };
  /** [link] の選択肢の行 raw（span はその中の [link]〜[endlink]）を、今の選択肢の行に合わせて作る。 */
  const makeLinkOption = (raw: string, span: NonNullable<ReturnType<typeof linkSpan>>, option: Extract<LimLine, { kind: "option" }>, cur: number): string | null => {
    const linkPiece = raw.slice(span.start, span.linkEnd);
    const endPiece = raw.slice(span.endStart, span.end);
    const text = inlineToKs(option.content, { ruby: rubyOf([raw]), inlineCommand: () => null, problem: (m) => issue("error", m, cur, span.line) });
    const pm = parseTag(tagBody(linkPiece), 0).pm;
    // 出す条件（if=）は [link] の cond
    const cond = optionCond(option);
    for (const edits of targetEdits(option.target, pm, input.file)) {
      const link = wrapTag(editTagBody(tagBody(linkPiece), { ...edits, cond: cond ?? null }), false);
      const check = input.inverter.convertPiece(`${link}${text}${endPiece}[s]`);
      if (linesDistance(check, [{ kind: "choice" }, option, { kind: "end", closes: "choice" }], input.registry) === 0) {
        return raw.slice(0, span.start) + link + text + endPiece + raw.slice(span.end);
      }
    }
    return null;
  };
  /** 選択肢の行から [link]〜[endlink] を除いた行（改行のタグだけが残れば null）。 */
  const withoutLink = (raw: string, span: NonNullable<ReturnType<typeof linkSpan>>) => {
    const rest = raw.slice(0, span.start) + raw.slice(span.end);
    return /^\s*(\[[lr]\]\s*)*$/.test(rest) ? null : rest;
  };

  const writeUnit = (u: Unit) => {
    const changed = u.members.some((m) => status[m]!.op !== "keep") || inside.has(u);
    if (!changed) {
      writeUnitAsIs(u);
      return;
    }
    const kinds = u.members.map((m) => input.map[m]!.kind);
    const allDeleted = u.members.every((m) => status[m]!.op === "delete") && !inside.has(u);
    if (allDeleted) {
      stats.deleted += u.members.length;
      if (kinds.every((k) => k === "text")) return;
      const span = linkSpan(u);
      if (span) {
        const rest = withoutLink(K[span.line - 1]!, span);
        if (rest !== null) writeBase(span.line, rest);
        return;
      }
      removeTags(u, u.tags);
      return;
    }
    // 本文の行一つ
    if (u.members.length === 1 && kinds[0] === "text") {
      const s = status[u.members[0]!]!;
      if (s.op !== "modify") return writeUnitAsIs(u);
      stats.modified++;
      const was = Bl[u.members[0]!] as Extract<LimLine, { kind: "text" }>;
      const now = Cl[s.cur]!;
      if (now.kind !== "text") return writeUnitAsIs(u);
      const lines = rewriteText(u, s.cur, was);
      if (was.speaker === now.speaker) for (let k = u.head; k < u.from; k++) writeBase(k);
      // 囲みは基準に合わせる
      if (state.inBlock !== before[u.from]!.inBlock && block) {
        pushRaw(before[u.from]!.inBlock ? block.open : block.close);
        state.inBlock = before[u.from]!.inBlock;
      }
      ensureSpeaker(now.speaker);
      out.push(...lines);
      return;
    }
    const target = targetOf(u);
    const targetLines = target.map((c) => Cl[c]!);
    stats.modified += u.members.filter((m) => status[m]!.op === "modify").length;
    stats.deleted += u.members.filter((m) => status[m]!.op === "delete").length;
    stats.inserted += target.length - u.members.filter((m) => status[m]!.op !== "delete").length;
    const fail = (message: string) => {
      stats.failed++;
      issue("error", `${message}（元の .ks のまま残しました）`, target[0] ?? null, u.from);
      writeUnitAsIs(u);
    };
    // ラベル
    if (u.members.length === 1 && kinds[0] === "label") {
      const now = targetLines[0];
      if (targetLines.length !== 1 || now?.kind !== "label") return fail("ラベルの行を書き戻せません");
      const raw = K[u.from - 1]!;
      return writeBase(u.from, raw.replace(/^(\s*\*)[^|\r]*/, `$1${now.name}`));
    }
    // [if] [elsif] [ignore] の条件
    if (u.members.length === 1 && (kinds[0] === "if" || kinds[0] === "elif") && targetLines.length === 1) {
      const now = targetLines[0]!;
      const tag = mainTag(u);
      const piece = tag === undefined ? null : pieceText(tag);
      if (piece && (now.kind === "if" || now.kind === "elif")) {
        const body = tagBody(piece);
        const ignore = /^\s*ignore\b/.test(body);
        const expr = ignore ? /^!\((.*)\)$/.exec(now.expr)?.[1] : now.expr;
        if (expr !== undefined) {
          const made = wrapTag(editTagBody(body, { exp: jsExpression(expr) }), piece.trim().startsWith("@"));
          if (linesDistance(input.inverter.convertPiece(made), [now], input.registry) === 0) return replaceTag(u, tag!, made);
        }
      }
      return fail("条件の式を .ks の式に戻せません");
    }
    // [link]〜[endlink] の選択肢
    const span = u.members.length === 1 && kinds[0] === "option" ? linkSpan(u) : null;
    if (span) {
      const now = targetLines[0];
      if (targetLines.length !== 1 || now?.kind !== "option") return fail("選択肢を書き戻せません");
      const made = makeLinkOption(K[span.line - 1]!, span, now, target[0]!);
      if (made === null) return fail("[link] の選択肢を書き戻せません");
      for (let k = u.head; k <= u.to; k++) writeBase(k, k === span.line ? made : K[k - 1]!);
      return;
    }
    // 一つのタグから出た行（命令・選択肢・cond 付きのタグ・代入の並び）
    const ownTags = u.tags.filter((t) => commands[t]!.name !== "chara_ptext" || commands[t]!.pm.face);
    const tag = mainTag(u);
    if (tag !== undefined && new Set(ownTags).size === 1 && !kinds.includes("text") && !kinds.includes("script")) {
      const piece = pieceText(tag);
      if (piece === null) return fail("タグの位置が分かりません");
      if (targetLines.length === 0) return removeTags(u, [tag]);
      // 選択肢の行は、一つのタグを変換すると @choice 〜 @end の中に出る
      const lines = [...targetLines];
      const firstOption = lines.findIndex((l) => l.kind === "option");
      if (firstOption >= 0 && !lines.some((l) => l.kind === "choice")) {
        lines.splice(firstOption, 0, { kind: "choice" });
        lines.push({ kind: "end", closes: "choice" });
      }
      const made = input.inverter.invert([piece], lines, piece);
      if (made === null) return fail(`${describe(targetLines[0]!)} を .ks のタグに戻せません`);
      return replaceTag(u, tag, made);
    }
    if (u.tags.some((t) => commands[t]!.name === "iscript")) return fail("取り込み設定が [iscript] を置き換えた行の書き換えは書き戻せません");
    return fail("一つの .ks の行から出た複数の行の書き換えは書き戻せません");
  };

  /** 消した本文の行（一行だけの単位）。同じ行を別の場所に足したときに、元の .ks の行を使う。 */
  const movedText = new Map<string, Unit[]>();
  for (const u of units) {
    const m = u.members[0]!;
    if (u.members.length !== 1 || input.map[m]!.kind !== "text" || status[m]!.op !== "delete") continue;
    // 行の中に本文以外のタグが無いものだけ
    if (K.slice(u.from - 1, u.to).some((raw) => scanKsLine(raw).some((p) => p.kind === "tag" && !/^\[(p|l|r|lr|srb|erb|ruby|font|resetfont|mark|endmark)\b/.test(raw.slice(p.start, p.end))))) continue;
    const list = movedText.get(key(B[m]!)) ?? [];
    list.push(u);
    movedText.set(key(B[m]!), list);
  }

  /** .ks の行 k に近い選択肢の単位（前にあるものを先に）。 */
  const nearestOption = (k: number) =>
    units
      .filter((u) => u.members.length === 1 && input.map[u.members[0]!]!.kind === "option")
      .sort((a, b) => Math.abs(a.from - k) + (a.from > k ? 0.5 : 0) - (Math.abs(b.from - k) + (b.from > k ? 0.5 : 0)))[0];

  /** 足した行の塊を書く。 */
  const writeGroup = (group: readonly number[], near: number) => {
    for (const c of group) {
      const line = Cl[c]!;
      switch (line.kind) {
        case "blank":
        case "use":
          continue;
        case "comment":
          pushRaw(`;${line.text}`);
          continue;
        case "label":
          ensureOutside();
          pushRaw(`*${line.name}`);
          stats.inserted++;
          continue;
        case "text": {
          if (block && !state.inBlock) {
            pushRaw(block.open);
            state.inBlock = true;
          }
          ensureSpeaker(line.speaker);
          stats.inserted++;
          // 動かしただけの本文（同じ行を消している）は、元の .ks の行をそのまま使う
          const moved = movedText.get(key(C[c]!))?.shift();
          if (moved) out.push(...K.slice(moved.from - 1, moved.to));
          // 行の最後に {noclick} があれば [p] を付けない（クリックを待たずに次へ進む）
          else pushRaw(guardKsLine(ksText(line, fileRuby, [], c, null)) + (endsWithNoclick(line.content) ? "" : pageEnd));
          continue;
        }
        case "if":
        case "elif": {
          ensureOutside();
          const made = `[${line.kind === "if" ? "if" : "elsif"} exp="${jsExpression(line.expr)}"]`;
          if (linesDistance(input.inverter.convertPiece(made), [line], input.registry) !== 0) issue("error", `条件の式 ${line.expr} を .ks の式に戻せません`, c, null);
          pushRaw(made);
          stats.inserted++;
          continue;
        }
        case "else":
          ensureOutside();
          pushRaw("[else]");
          continue;
        case "end":
          ensureOutside();
          if (line.closes === "if") pushRaw("[endif]");
          else if (line.closes === "choice") pushRaw(mostCommon(K.flatMap((l) => l.match(/^\s*\[s\s*\]\s*$/)?.[0].trim() ?? [])) ?? "[s]");
          else if (line.closes === "script") pushRaw("[endscript]");
          else if (line.closes === "html") pushRaw("[endhtml]");
          else if (line.closes === "while" || line.closes === "for" || line.closes === "with" || line.closes === "body") issue("error", `@${line.closes === "body" ? "staff-roll" : line.closes} は TyranoScript に無いため書き戻せません`, c, null);
          else issue("error", "対応するブロックの無い @end を書き戻せません", c, null);
          continue;
        case "choice":
          ensureOutside();
          continue;
        case "script":
          if (line.open) {
            ensureOutside();
            pushRaw("[iscript]");
          } else pushRaw(line.code.replace(/^ {2}/, ""));
          continue;
        case "define":
          issue("error", "@define（マクロ）の追加は書き戻せません", c, null);
          stats.failed++;
          continue;
        case "option":
        case "command":
        case "set":
        case "jump": {
          // [link] の選択肢の隣には [link] の選択肢を（改行で終わる [link] の行を手本に）
          if (line.kind === "option") {
            const neighbor = nearestOption(near);
            const links = neighbor && linkSpan(neighbor) ? units.filter((u) => u.members.length === 1 && input.map[u.members[0]!]!.kind === "option" && linkSpan(u)) : [];
            const model = links.find((u) => /\[r\]\s*$/.test(K[u.from - 1]!) && Math.abs(u.from - neighbor!.from) < 20) ?? neighbor;
            const span = model ? linkSpan(model) : null;
            if (span) {
              stats.inserted++;
              // 前の選択肢が改行で終わっていなければ、手本に合わせて改行する
              const prev = out.at(-1);
              if (prev !== undefined && prev.includes("[endlink]") && !/\[r\]\s*$/.test(prev) && /\[r\]\s*$/.test(K[span.line - 1]!)) out[out.length - 1] = prev.replace(/(\r?)$/, "[r]$1");
              const made = makeLinkOption(K[span.line - 1]!, span, line, c);
              if (made === null) {
                stats.failed++;
                issue("error", "[link] の選択肢を書き戻せません（.ks にはコメントとして残しました）", c, null);
                pushRaw(`; lim backport: ${C[c]!.trim()}`);
              } else pushRaw(made.replace(/\r$/, ""));
              continue;
            }
          }
          ensureOutside();
          if (line.kind === "command" && line.name === "html") {
            // @html 名前 x= y= → [html name= left= top=]（中身の行と [endhtml] は続く行が書く）
            const value = (key: string, position?: number) => {
              const a = line.args.find((x) => x.key === key) ?? (position === undefined ? undefined : line.args.filter((x) => x.key === null)[position]);
              return a && (a.value.kind === "string" || a.value.kind === "number") ? String(a.value.value) : null;
            };
            const attrs = [["name", value("name", 0)], ["left", value("x")], ["top", value("y")]].filter(([, v]) => v !== null).map(([k, v]) => ` ${k}="${v}"`);
            pushRaw(`[html${attrs.join("")}]`);
            stats.inserted++;
            continue;
          }
          const name = line.kind === "command" ? line.name : line.kind === "jump" ? line.name : line.kind === "set" ? "set" : "option";
          // 行の if=(式) は外して戻し、できたタグに cond= を付ける（タグが二つ以上になる命令は [if] 〜 [endif] で囲む）
          const cond = line.kind !== "option" ? line.cond : undefined;
          const plain: LimLine = line.kind !== "option" && cond !== undefined ? (({ cond: _c, ...rest }) => rest as LimLine)(line) : line;
          const target: LimLine[] = plain.kind === "option" ? [{ kind: "choice" }, plain, { kind: "end", closes: "choice" }] : [plain];
          const inverted = input.inverter.invert(templatesFor(name, near), target);
          const made = inverted === null || cond === undefined ? inverted : withCond(inverted, jsExpression(cond));
          stats.inserted++;
          if (made === null) {
            stats.failed++;
            issue("error", `${describe(line)} を .ks のタグに戻せません（.ks にはコメントとして残しました）`, c, null);
            pushRaw(`; lim backport: ${C[c]!.trim()}`);
          } else pushRaw(made);
          continue;
        }
      }
    }
  };

  const flushPlaced = (k: number) => {
    for (const group of placed.get(k) ?? []) writeGroup(group, k);
    placed.delete(k);
  };

  let k = 1;
  for (const u of sortedUnits) {
    while (k < u.head) {
      flushPlaced(k);
      writeBase(k);
      k++;
    }
    flushPlaced(u.head);
    writeUnit(u);
    k = u.to + 1;
  }
  while (k <= K.length) {
    flushPlaced(k);
    writeBase(k);
    k++;
  }
  flushPlaced(K.length + 1);
  for (const [, groups] of placed) for (const g of groups) writeGroup(g, K.length);
  if (state.inBlock && !before[K.length + 1]!.inBlock && block) pushRaw(block.close);

  return { ks: tidy(out).join("\n") + (trailingNewline ? "\n" : ""), issues, stats };

  function describe(l: LimLine): string {
    switch (l.kind) {
      case "command":
        return `@${l.name}`;
      case "jump":
        return `@${l.name}`;
      case "set":
        return "@set";
      case "option":
        return "選択肢";
      default:
        return l.kind;
    }
  }
  /** 書き直しで生まれた空のテキストブロック（開いてすぐ閉じる）を除く。 */
  function tidy(lines: string[]): string[] {
    if (!block) return lines;
    const result: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() === block.open && lines[i + 1]?.trim() === block.close && !K.some((l, j) => l.trim() === block.open && K[j + 1]?.trim() === block.close)) {
        i++;
        continue;
      }
      result.push(lines[i]!);
    }
    return result;
  }
}

/**
 * 書き戻したタグに cond="式" を付ける（.lim の行の if=(式)）。一つのタグ（[tag …] か @tag …）ならその中に、
 * 二つ以上なら [if exp="式"] 〜 [endif] で囲む。
 */
export function withCond(made: string, js: string): string {
  const trimmed = made.trim();
  // 手本のタグの書き方（TyranoBuilder の「  key="v"  ]」）の空白に合わせる
  if (/^\[[^\[\]]*\]$/.test(trimmed)) return made.replace(/(\s*)\]\s*$/, (_m, sp: string) => `${sp || " "}cond="${js}"${sp}]`);
  if (/^@\S+/.test(trimmed) && !made.includes("\n")) return `${made.replace(/\s+$/, "")} cond="${js}"`;
  return `[if exp="${js}"]${made}[endif]`;
}

/** compile の命令 tag の、.ks の行の中の範囲。`#` `*` `@` の行は行全体。分からなければ null。 */
function pieceAt(K: readonly string[], commands: readonly RawCommand[], byLine: ReadonlyMap<number, number[]>, tag: number): { line: number; start: number; end: number } | null {
  const c = commands[tag];
  if (!c) return null;
  const raw = K[c.line - 1];
  if (raw === undefined) return null;
  const onLine = byLine.get(c.line) ?? [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("@")) {
    if (onLine.length !== 1) return null;
    const start = raw.indexOf(trimmed);
    return { line: c.line, start, end: start + trimmed.length };
  }
  const pieces = scanKsLine(raw);
  if (pieces.length !== onLine.length) return null;
  const p = pieces[onLine.indexOf(tag)]!;
  return { line: c.line, start: p.start, end: p.end };
}

/**
 * 基準のファイルから、命令ごとの手本のタグ（一つのタグから一行の命令になったもの）を集める。
 * ほかのファイルで同じ命令を足したときの手本に使う。
 */
export function collectTemplates(file: string, baseKs: string, baseLim: string, map: readonly (LineOrigin | null)[], speakers: Iterable<string>, into: Map<string, string[]>, limit = 3): void {
  const K = baseKs.split("\n");
  const commands = lex(baseKs, file).commands;
  const byLine = new Map<number, number[]>();
  commands.forEach((c, i) => byLine.set(c.line, [...(byLine.get(c.line) ?? []), i]));
  const lines = readLimLines(baseLim, speakers);
  map.forEach((o, i) => {
    if (!o?.tags || o.tags.length !== 1 || (o.kind !== "command" && o.kind !== "option")) return;
    const l = lines[i];
    const name = l?.kind === "command" ? l.name : l?.kind === "jump" ? l.name : l?.kind === "set" ? "set" : l?.kind === "option" ? "option" : null;
    if (!name) return;
    const list = into.get(name) ?? [];
    if (list.length >= limit) return;
    const p = pieceAt(K, commands, byLine, o.tags[0]!);
    if (!p) return;
    const piece = K[p.line - 1]!.slice(p.start, p.end);
    if (!list.includes(piece)) list.push(piece);
    into.set(name, list);
  });
}

/** 基準の .ks の、話者名 → `#…` の行（表情なしのもの、最初に出たもの）。 */
export function collectSpeakerLines(file: string, baseKs: string, charas: CharaDefs, into: Map<string, string>): void {
  const K = baseKs.split("\n");
  for (const c of lex(baseKs, file).commands) {
    if (c.name !== "chara_ptext" || c.pm.face) continue;
    const name = speakerName(c.pm.name?.trim() ?? "", charas);
    if (!into.has(name)) into.set(name, K[c.line - 1]!.trim());
  }
}

function printArg(v: import("@liminalia/lang").Literal): string {
  switch (v.kind) {
    case "string":
      return v.quoted ? JSON.stringify(v.value) : v.value;
    case "number":
      return String(v.value);
    case "duration":
      return v.source;
    case "bool":
      return String(v.value);
    case "color":
      return v.value;
    case "expr":
      return `(${v.source})`;
  }
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function mostCommon(items: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [i, c] of counts) if (c > n) [best, n] = [i, c];
  return best;
}

/** .ks の文字列で多く使われているルビの書き方。ルビが無ければ null。 */
export function rubyStyleOf(text: string): RubyStyle | null {
  const auto = text.match(/[｜|][^《》\n[\]]+《[^》\n]+》/g) ?? [];
  const srb = (text.match(/\[srb\b/g) ?? []).length;
  const ruby = (text.match(/\[ruby\b/g) ?? []).length;
  if (auto.length === 0 && srb === 0 && ruby === 0) return null;
  if (auto.length >= srb && auto.length >= ruby) return { kind: "auto", bar: auto.filter((a) => a.startsWith("|")).length > auto.length / 2 ? "|" : "｜" };
  return srb >= ruby ? { kind: "srb", bar: "｜" } : { kind: "ruby", bar: "｜" };
}

/** 文字の二つ組の重なり（0〜1）。書き換えの組を決めるのに使う。 */
function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      hit++;
      grams.set(g, n - 1);
    }
  }
  return (2 * hit) / (a.length + b.length - 2);
}

export type { RawCommand };
