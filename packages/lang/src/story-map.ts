import { normalizeBooleanArgs } from "./args.ts";
import type { Inline, Script, Statement, Target } from "./ast.ts";
import { endingKinds, endingRef, type EndingRef } from "./endings.ts";
import { scanHtml } from "./html.ts";
import { speechLine } from "./speech.ts";
import { plainText, printInline } from "./inline.ts";
import { targetCandidates } from "./project.ts";
import type { CommandSpec, Registry } from "./registry.ts";

/**
 * 台本から作る分岐の俯瞰。場面（ファイルの頭と、ラベルから次のラベルまで）を箱、移り方を矢印にする。
 * 矢印の種類: next（次のラベルへそのまま進む）・jump・call・choice（選択肢。label が選択肢の文）・
 * command（飛び先を持つ命令。label が命令名。プラグインの命令が targets で教えた見込みも含む）。
 * cond は @if・@elif・@else の中の移り方のときの条件（else は "else"）。
 */
export interface StoryMap {
  /** 「はじめから」の場面。 */
  entry: string;
  nodes: MapNode[];
  edges: MapEdge[];
}

export interface MapNode {
  /** "ファイル" か "ファイル#ラベル"。 */
  id: string;
  file: string;
  label: string | null;
  /** 場面の始まり（ラベルの行。ファイルの頭なら最初の文の行）と終わりの行。 */
  line: number;
  end: number;
  /** 本文のページの数。 */
  pages: number;
  /** 最初の本文（話者つき、ルビは親文字だけ。長ければ切る）。本文が無ければ空。 */
  text: string;
  /** 最初の本文の訳を引く元（printInline で書き直した本文と話者）。本文が無ければ無い。 */
  textKey?: { source: string; speaker?: string; id?: string };
  /** 最初の本文の行（無ければ line）。網羅の通った・通らないはこの行で見る。 */
  anchor: number;
  /**
   * 場面の終わり方。end（ファイルの終わりで止まる）・return（@return）・stop（@stop）・exit（プレイを終える命令。
   * CommandSpec の ends。命令の名前は endCommand）。ほかへ移るなら無い。
   */
  ends?: "end" | "return" | "stop" | "exit";
  endCommand?: string;
  /**
   * エンディング（プレイを終える命令の ending= と title=。endings.ts）。kind は種類（bad など）、title はその結末の名前（原文）、
   * legacy は前の書き方で ending= に書いた文言（移していない作品だけ）。地図の終わりの印に出す。
   */
  ending?: EndingRef;
}

export interface MapEdge {
  from: string;
  to: string;
  kind: "next" | "jump" | "call" | "choice" | "command";
  /** 選択肢の文・命令名。 */
  label?: string;
  /** 選択肢の文の訳を引く元（printInline で書き直した選択肢の文）。 */
  labelSource?: string;
  /** 選択肢の行の固定の行 ID（#line:ID。あれば訳は ID で引く）。 */
  labelId?: string;
  cond?: string;
  /** 移り方を書いた行。 */
  line: number;
  /** 飛び先の場面が無い（検査のエラーと同じもの）。to は書いたままの飛び先。 */
  missing?: true;
}

/** プラグインの命令が教える飛び先（sdk の CommandDefinition.targets）。 */
export type TargetHook = (args: Readonly<Record<string, string>>, data: (name: string) => unknown) => { targets: string[]; leaves?: boolean };

export interface StoryMapInput {
  /** ファイル名 → 読んだシナリオと本文（条件の書き方を本文から取る）。並びはファイル名順。 */
  scripts: ReadonlyMap<string, { script: Script; text: string }>;
  registry: Registry;
  /** liminalia.json の entry（`ファイル` か `ファイル#ラベル`）。 */
  entry: string;
  hooks: ReadonlyMap<string, TargetHook>;
  data: (name: string) => unknown;
  /** liminalia.json の variables（式の飛び先の候補を割り出すのに使う）。 */
  variables?: Readonly<Record<string, unknown>>;
  /** liminalia.json の endingKinds（作品が足したエンディングの種類。ending= を種類として読むのに使う）。 */
  endingKinds?: unknown;
}

/** 最初の本文の長さの上限。 */
const TEXT_LIMIT = 48;

/**
 * 台本から分岐の俯瞰（StoryMap）を作る。場面はファイルの頭（最初のラベルより前に文があるとき）と、ラベルから次のラベルまで。
 * 場面の中の @jump・@call・選択肢・飛び先を持つ命令（@if の中も。そのときは条件を付ける）を矢印にし、場面の終わりで
 * ほかへ移らなければ次のラベルへの矢印（next）にする。@define の中は部品なので見ない。
 */
export function buildStoryMap(input: StoryMapInput): StoryMap {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  /** "ファイル"（頭に文が無いファイル）→ 最初のラベルの場面。 */
  const alias = new Map<string, string>();
  const pending: { from: string; target: Target | string; file: string; edge: Omit<MapEdge, "from" | "to"> }[] = [];
  const candidatesOf = targetCandidates(new Map([...input.scripts].map(([f, s]) => [f, s.script])), { registry: input.registry, ...(input.variables ? { variables: input.variables } : {}) });
  const kinds = endingKinds(input.endingKinds);

  for (const [file, { script, text }] of input.scripts) {
    const lines = text.split("\n");
    // 一番外側の文を、ラベルごとの場面に分ける
    const sections: { id: string; label: string | null; line: number; body: Statement[] }[] = [];
    let current: (typeof sections)[number] = { id: file, label: null, line: 1, body: [] };
    for (const s of script.body) {
      if (s.kind === "label") {
        sections.push(current);
        current = { id: `${file}#${s.name}`, label: s.name, line: s.line, body: [] };
      } else current.body.push(s);
    }
    sections.push(current);
    const head = sections[0]!;
    const meaningful = (body: Statement[]) => body.some((s) => s.kind !== "use" && s.kind !== "define" && s.kind !== "function");
    if (!meaningful(head.body)) {
      sections.shift();
      if (sections[0]) alias.set(file, sections[0].id);
    } else head.line = head.body.find((s) => s.kind !== "use" && s.kind !== "define" && s.kind !== "function")?.line ?? 1;

    sections.forEach((sec, i) => {
      const next = sections[i + 1];
      const end = next ? next.line - 1 : lines.length;
      const stats: { pages: number; text: string; anchor: number; textKey?: { source: string; speaker?: string; id?: string } } = { pages: 0, text: "", anchor: 0 };
      // 飛び先を実行時に決める式（`@jump (game.next)`）は、割り出した候補（か to= の候補）すべてへ矢印を引く
      const add = (edge: Omit<MapEdge, "from" | "to">, target: Target | string) => {
        if (typeof target !== "string" && target.expr) {
          for (const c of candidatesOf(target, file) ?? []) pending.push({ from: sec.id, target: c, file, edge });
          return;
        }
        pending.push({ from: sec.id, target, file, edge });
      };
      const visit = (body: Statement[], cond: string | undefined) => {
        for (const s of body) {
          switch (s.kind) {
            case "say":
            case "prose":
              stats.pages++;
              if (!stats.text) {
                stats.text = clip(s.kind === "say" ? speechLine(s.speaker, plainText(s.content)) : plainText(s.content).trim());
                stats.anchor = s.line;
                stats.textKey = { source: printInline(s.content), ...(s.kind === "say" && s.speaker ? { speaker: s.speaker } : {}), ...(s.id ? { id: s.id } : {}) };
              }
              break;
            case "jump":
            case "call":
              add({ kind: s.kind, line: s.line, ...(cond ? { cond } : {}) }, s.target);
              break;
            case "choice":
              for (const o of s.options) add({ kind: "choice", label: clip(plainText(o.content as Inline[])), labelSource: printInline(o.content as Inline[]), ...(o.id ? { labelId: o.id } : {}), line: o.line, ...(cond ? { cond } : {}) }, o.target);
              break;
            case "if":
              for (const b of s.branches) {
                // 行の if=(式) はその式、@for はその行（中を通るのは並びが空でないとき）
                const own = s.guard !== undefined ? s.guard : s.each ? condText(lines[b.line - 1] ?? "") : b.condition === null ? "else" : condText(lines[b.line - 1] ?? "");
                visit(b.body, cond ? `${cond} かつ ${own}` : own);
              }
              break;
            case "command":
              for (const t of commandTargets(s, input.registry.get(s.name), input.hooks.get(s.name), input.data).targets) add({ kind: "command", label: s.name, line: s.line, ...(cond ? { cond } : {}) }, t);
              break;
            default:
              break;
          }
        }
      };
      visit(sec.body, undefined);
      // 場面の終わり方（一番外側の最後の文）
      const last = [...sec.body].reverse().find((s) => s.kind !== "use" && s.kind !== "define" && s.kind !== "function");
      let ends: MapNode["ends"];
      let endCommand: string | undefined;
      let ending: EndingRef | undefined;
      let falls = true;
      if (last?.kind === "jump" || last?.kind === "choice") falls = false;
      else if (last?.kind === "return") {
        falls = false;
        ends = "return";
      } else if (last?.kind === "command") {
        if (last.name === "stop") {
          falls = false;
          ends = "stop";
        } else if (input.registry.get(last.name)?.ends) {
          // プレイを終える命令（作品のプラグインの @title-screen など）。ending= と title= があれば、それをエンディングにする
          falls = false;
          ends = "exit";
          endCommand = last.name;
          const args = commandArgs(last, input.registry.get(last.name)!);
          ending = endingRef(args.ending, args.title, kinds) ?? undefined;
        } else if (commandTargets(last, input.registry.get(last.name), input.hooks.get(last.name), input.data).leaves) falls = false;
      }
      if (falls) {
        if (next) pending.push({ from: sec.id, target: next.id, file, edge: { kind: "next", line: end } });
        else ends = "end";
      }
      nodes.push({ id: sec.id, file, label: sec.label, line: sec.line, end, pages: stats.pages, text: stats.text, ...(stats.textKey ? { textKey: stats.textKey } : {}), anchor: stats.anchor || sec.line, ...(ends ? { ends } : {}), ...(endCommand ? { endCommand } : {}), ...(ending ? { ending } : {}) });
    });
  }

  const ids = new Set(nodes.map((n) => n.id));
  // ほかへ移る矢印がある場面は「止まる」としない（飛び先を自分で決める命令のあとの @stop など）
  const leaving = new Set(pending.map((p) => p.from));
  for (const n of nodes) if (n.ends === "stop" && leaving.has(n.id)) delete n.ends;
  const resolve = (target: Target | string, file: string): { id: string; missing: boolean } => {
    let id: string;
    if (typeof target === "string") {
      const [f = "", label] = target.split("#");
      id = label === undefined ? f || file : `${f || file}#${label}`;
    } else id = target.label === null ? (target.file ?? file) : `${target.file ?? file}#${target.label}`;
    id = alias.get(id) ?? id;
    return { id, missing: !ids.has(id) };
  };
  const seen = new Set<string>();
  for (const p of pending) {
    const { id, missing } = resolve(p.target, p.file);
    const key = `${p.from}>${id}>${p.edge.kind}>${p.edge.label ?? ""}>${p.edge.cond ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: p.from, to: id, ...p.edge, ...(missing ? { missing: true as const } : {}) });
  }
  return { entry: resolve(input.entry, input.entry.split("#")[0] ?? "").id, nodes, edges };
}

/** 命令の行の文字列の引数（位置引数も名前で引ける）。 */
function commandArgs(s: Extract<Statement, { kind: "command" }>, spec: CommandSpec): Record<string, string> {
  const args: Record<string, string> = {};
  let pos = 0;
  for (const a of normalizeBooleanArgs(spec, s.args)) {
    const key = a.key ?? spec.positional[pos++];
    if (key && a.value.kind === "string") args[key] = a.value.value;
    // ending=true はエンディングの種類の true（真偽の字面に読める）
    else if (key === "ending" && spec.ends && a.value.kind === "bool" && a.value.value) args[key] = "true";
  }
  return args;
}

/**
 * プラグインの命令が targets で教えた行き先を、命令の行ごとに集める（"ファイル:行" → "ファイル#ラベル" か "ファイル"）。
 * 全ルートテストが、画面なしで流したときに選択肢に出てこなかった行き先を知らせるのに使う。@if・@define の中も見る。
 */
export function promisedTargets(input: Pick<StoryMapInput, "scripts" | "registry" | "hooks" | "data">): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [file, { script }] of input.scripts) {
    const visit = (body: Statement[]) => {
      for (const s of body) {
        if (s.kind === "if") for (const b of s.branches) visit(b.body);
        if (s.kind === "define") visit(s.body);
        if (s.kind !== "command") continue;
        const hook = input.hooks.get(s.name);
        const spec = input.registry.get(s.name);
        if (!hook || !spec) continue;
        let targets: string[];
        try {
          targets = hook(commandArgs(s, spec), input.data).targets;
        } catch {
          continue;
        }
        const own = [...new Set(targets.map((t) => (t.startsWith("#") ? `${file}${t}` : t)))];
        if (own.length > 0) out.set(`${file}:${s.line}`, own);
      }
    };
    visit(script.body);
  }
  return out;
}

/** 命令の飛び先（target 型の引数と、プラグインの命令が教える見込み）。 */
function commandTargets(s: Extract<Statement, { kind: "command" }>, spec: CommandSpec | undefined, hook: TargetHook | undefined, data: (name: string) => unknown): { targets: string[]; leaves: boolean } {
  if (!spec) return { targets: [], leaves: false };
  const args = commandArgs(s, spec);
  const targets = Object.entries(spec.params)
    .filter(([name, p]) => p.type.kind === "target" && args[name] !== undefined)
    .map(([name]) => args[name]!);
  // @html の押して飛ぶ要素（wait=true のときだけ押せる。押すまで先へ進まない）
  if (s.name === "html" && s.body && s.args.some((a) => a.key === "wait" && a.value.kind === "bool" && a.value.value)) {
    const jumps = scanHtml(s.body.text).jumps.map((j) => j.target);
    if (jumps.length > 0) return { targets: [...targets, ...jumps], leaves: true };
  }
  if (!hook) return { targets, leaves: false };
  try {
    const r = hook(args, data);
    return { targets: [...targets, ...r.targets], leaves: r.leaves === true };
  } catch {
    return { targets, leaves: false };
  }
}

/** @if・@elif の行から条件の書き方を取る。 */
function condText(line: string): string {
  return line.trim().replace(/^@(if|elif|while)\s+/, "");
}

/** 地図とフローチャートに出す本文の長さに切る（訳した本文を同じ長さにするときにも使う）。 */
export function clip(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > TEXT_LIMIT ? `${t.slice(0, TEXT_LIMIT - 1)}…` : t;
}
