import { parseTargetText } from "./args.ts";
import type { Inline, Script, Statement, Target } from "./ast.ts";
import { pageKeys } from "./page-keys.ts";
import { targetCandidates } from "./project.ts";
import type { MapEdge, MapNode, StoryMap } from "./story-map.ts";

/**
 * 遊ぶ人に見せるフローチャート（おまけ・メニューから開く）。地図（buildStoryMap）を、選択肢と分かれ目で区切った場面にまとめたもの。
 * 一本道でつながるラベルは一つの場面にまとめ、選択肢の飛び先・合流するところ・@if などで分かれた先・はじめの場面を、それぞれ場面の頭にする。
 * @call の先（共通の部品）と、はじめから届かない場面は入れない。
 */
export interface Flow {
  /** はじめの場面の id。 */
  entry: string;
  scenes: FlowScene[];
  links: FlowLink[];
  /** 本文のページの位置（ファイル → 行。既読率の分母）。 */
  pages: Record<string, number[]>;
  /** pages と同じ並びの、ページの鍵（pageKeys。既読はこの鍵で見る）。 */
  keys?: Record<string, string[]>;
}

export interface FlowScene {
  /** 頭の地図の場面の id（"ファイル" か "ファイル#ラベル"）。 */
  id: string;
  /** 最初の本文（長ければ切る）。 */
  title: string;
  /**
   * title の訳を引く元（本文の行の訳の鍵の、ファイルと原文と場面。話者があれば話者名）。遊んでいる言語の訳があれば、
   * 標準の画面はそれを title と同じ長さに切って出す。
   */
  titleKey?: { file: string; source: string; context?: string; speaker?: string; id?: string };
  /** 最初の本文の位置（読んだかどうかと、ここから読むときの控えをこの位置で見る）。key はそのページの鍵（pageKeys）。本文の無い場面は null。 */
  anchor: { file: string; line: number; key?: string } | null;
  /** まとめた地図の場面の id。 */
  nodes: string[];
  /** 本文のページの数。 */
  pages: number;
  /**
   * プレイが終わる場面か。ending はエンディングの種類（@title-screen ending= の bad など。無ければ空）、title はその結末の名前（title= の原文）、
   * legacy は前の書き方で ending= に書いた文言（移していない作品だけ。画面にはこれを出す）。
   */
  end?: { ending: string; title?: string; legacy?: string };
}

export interface FlowLink {
  from: string;
  to: string;
  /** 選択肢の文（選択肢で移るとき）。 */
  choice?: string;
  /** choice の訳を引く元（選択肢の文の訳の鍵の、ファイルと原文と場面）。 */
  choiceKey?: { file: string; source: string; context?: string; id?: string };
}

/** 地図と台本から、遊ぶ人に見せるフローチャートを作る。 */
export function buildFlow(map: StoryMap, scripts: ReadonlyMap<string, Script>): Flow {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const out = new Map<string, MapEdge[]>();
  const pageOut = new Map<string, MapEdge[]>();
  for (const e of map.edges) {
    if (e.missing || !byId.has(e.from) || !byId.has(e.to)) continue;
    (pageOut.get(e.from) ?? pageOut.set(e.from, []).get(e.from)!).push(e);
    if (e.kind === "call") continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
  }
  // はじめから届く場面
  const reach = new Set<string>();
  const queue = byId.has(map.entry) ? [map.entry] : [];
  for (const id of queue) {
    if (reach.has(id)) continue;
    reach.add(id);
    for (const e of out.get(id) ?? []) if (!reach.has(e.to)) queue.push(e.to);
  }
  // 場面の頭: はじめと選択肢の飛び先。そこから（ほかの頭を越えずに）たどって、二つ以上の頭から届く場面（合流するところ）も頭にする。
  // 作品の命令の飛び先（調べる箇所など）や @if で分かれた先は、来た場面にまとめる
  const headSet = new Set<string>([map.entry].filter((id) => reach.has(id)));
  for (const e of map.edges) if (e.kind === "choice" && reach.has(e.from) && reach.has(e.to)) headSet.add(e.to);
  let owner = new Map<string, string>();
  for (;;) {
    owner = new Map();
    const merges = new Set<string>();
    for (const head of headSet) {
      const queue = [head];
      for (const id of queue) {
        const own = owner.get(id);
        if (own === head) continue;
        if (own !== undefined) {
          merges.add(id);
          continue;
        }
        owner.set(id, head);
        for (const e of out.get(id) ?? []) if (!headSet.has(e.to)) queue.push(e.to);
      }
    }
    if (merges.size === 0) break;
    for (const m of merges) headSet.add(m);
  }

  const keyCache = new Map<string, Map<number, string>>();
  const keyOf = (file: string, line: number): string | undefined => {
    const script = scripts.get(file);
    if (!script) return undefined;
    let keys = keyCache.get(file);
    if (!keys) keyCache.set(file, (keys = pageKeys(script)));
    return keys.get(line);
  };
  const scenes: FlowScene[] = [];
  const order = [...owner.keys()].sort((a, b) => nodeOrder(byId.get(a)!, byId.get(b)!));
  const groups = new Map<string, string[]>();
  for (const id of order) {
    const head = owner.get(id)!;
    const nodes = groups.get(head);
    if (nodes) nodes.push(id);
    else groups.set(head, [id]);
  }
  for (const head of order) {
    if (!headSet.has(head)) continue;
    const nodes = groups.get(head)!;
    // 頭から一本道の順に並べ直す（ファイルの順と違うことがある）
    const chain = followChain(head, nodes, out);
    const members = chain.map((id) => byId.get(id)!);
    const first = members.find((n) => n.pages > 0);
    const ending = members.find((n) => n.ends === "exit" || n.ends === "end");
    const anchorKey = first ? keyOf(first.file, first.anchor) : undefined;
    scenes.push({
      id: head,
      title: first?.text ?? "",
      ...(first?.textKey ? { titleKey: { file: first.file, source: first.textKey.source, ...(first.label ? { context: first.label } : {}), ...(first.textKey.speaker ? { speaker: first.textKey.speaker } : {}), ...(first.textKey.id ? { id: first.textKey.id } : {}) } } : {}),
      anchor: first ? { file: first.file, line: first.anchor, ...(anchorKey ? { key: anchorKey } : {}) } : null,
      nodes: chain,
      pages: members.reduce((sum, n) => sum + n.pages, 0),
      ...(ending ? { end: { ending: ending.ending?.kind ?? "", ...(ending.ending?.title ? { title: ending.ending.title } : {}), ...(ending.ending?.legacy ? { legacy: ending.ending.legacy } : {}) } } : {}),
    });
  }
  const links: FlowLink[] = [];
  const seen = new Set<string>();
  for (const e of map.edges) {
    if (e.missing || e.kind === "call" || !owner.has(e.from) || !headSet.has(e.to)) continue;
    const from = owner.get(e.from)!;
    if (from === e.to && e.kind !== "choice") continue;
    const choice = e.kind === "choice" ? e.label : undefined;
    const key = `${from}>${e.to}>${choice ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = byId.get(e.from);
    // 訳の場面は、選択肢を書いた場面のラベル（ファイルの頭の場面には無い）
    const choiceKey = choice && e.labelSource !== undefined && at ? { file: at.file, source: e.labelSource, ...(at.label ? { context: at.label } : {}), ...(e.labelId ? { id: e.labelId } : {}) } : undefined;
    links.push({ from, to: e.to, ...(choice ? { choice } : {}), ...(choiceKey ? { choiceKey } : {}) });
  }
  const pageReach = new Set<string>();
  const pageQueue = byId.has(map.entry) ? [map.entry] : [];
  const macroTargets = macroPageTargets(map, scripts);
  for (const id of pageQueue) {
    if (pageReach.has(id)) continue;
    pageReach.add(id);
    for (const e of pageOut.get(id) ?? []) if (!pageReach.has(e.to)) pageQueue.push(e.to);
    for (const to of macroTargets(byId.get(id)!)) if (!pageReach.has(to)) pageQueue.push(to);
  }
  const pages = pageLines(scripts, map.nodes.filter((n) => pageReach.has(n.id)));
  const keys = Object.fromEntries(Object.entries(pages).map(([file, lines]) => [file, lines.map((line) => keyOf(file, line) ?? "")]));
  return { entry: map.entry, scenes, links, pages, keys };
}

function macroPageTargets(map: StoryMap, scripts: ReadonlyMap<string, Script>): (node: MapNode) => Set<string> {
  type Define = Extract<Statement, { kind: "define" }>;
  const defines = new Map<string, Map<string, Define>>();
  const uses = new Map<string, string[]>();
  for (const [file, script] of scripts) {
    defines.set(file, new Map(script.body.flatMap((s) => s.kind === "define" ? [[s.name, s] as const] : [])));
    uses.set(file, script.body.flatMap((s) => s.kind === "use" ? [s.file] : []));
  }
  const ids = new Set(map.nodes.map((n) => n.id));
  const first = new Map<string, MapNode>();
  for (const node of map.nodes) if (!first.has(node.file) || node.line < first.get(node.file)!.line) first.set(node.file, node);
  const candidates = targetCandidates(scripts);
  return (node) => {
    const targets = new Set<string>();
    const seen = new Set<Define>();
    const add = (target: Target, file: string) => {
      const options = target.expr ? (candidates(target, file) ?? []).flatMap((text) => {
        const t = parseTargetText(text);
        return t ? [t] : [];
      }) : [target];
      for (const t of options) {
        const f = t.file ?? file;
        const id = t.label === null ? first.get(f)?.id : `${f}#${t.label}`;
        if (id && ids.has(id)) targets.add(id);
      }
    };
    const invoke = (name: string, file: string) => {
      for (const f of [file, ...(uses.get(file) ?? [])]) {
        const define = defines.get(f)?.get(name);
        if (!define) continue;
        if (!seen.has(define)) {
          seen.add(define);
          visit(define.body, f, true);
        }
        break;
      }
    };
    const visitInline = (content: Inline[], file: string) => {
      for (const n of content) {
        if (n.kind === "command") invoke(n.name, file);
        if ("children" in n) visitInline(n.children, file);
      }
    };
    const visit = (body: Statement[], file: string, inMacro: boolean) => {
      for (const s of body) {
        if (s.kind === "command") invoke(s.name, file);
        if (s.kind === "say" || s.kind === "prose") visitInline(s.content, file);
        if (s.kind === "if") {
          if (s.with) invoke(s.with.name, file);
          for (const branch of s.branches) visit(branch.body, file, inMacro);
        }
        if (inMacro && s.kind === "call") add(s.target, file);
      }
    };
    visit(scripts.get(node.file)?.body.filter((s) => s.line >= node.line && s.line <= node.end) ?? [], node.file, false);
    return targets;
  };
}

function nodeOrder(a: MapNode, b: MapNode): number {
  return a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file, "en", { numeric: true });
}

/** 頭から、場面の中の一本道を順にたどる（たどれなかった場面は後ろに足す）。 */
function followChain(head: string, nodes: string[], out: Map<string, MapEdge[]>): string[] {
  const remaining = new Set(nodes);
  const chain: string[] = [];
  let cur: string | undefined = head;
  while (cur && remaining.delete(cur)) {
    chain.push(cur);
    cur = out.get(cur)?.find((edge) => remaining.has(edge.to))?.to;
  }
  for (const id of remaining) chain.push(id);
  return chain;
}

/** 本文のページ（台詞と地の文。@define の中は数えない）の行。 */
function pageLines(scripts: ReadonlyMap<string, Script>, nodes: MapNode[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const ranges = new Map<string, MapNode[]>();
  for (const node of nodes) (ranges.get(node.file) ?? ranges.set(node.file, []).get(node.file)!).push(node);
  const visit = (body: Statement[], lines: number[]) => {
    for (const s of body) {
      if (s.kind === "say" || s.kind === "prose") lines.push(s.line);
      if (s.kind === "if") for (const b of s.branches) visit(b.body, lines);
    }
  };
  for (const [file, script] of scripts) {
    const sections = ranges.get(file);
    if (!sections) continue;
    sections.sort((a, b) => a.line - b.line);
    const lines: number[] = [];
    visit(script.body, lines);
    let i = 0;
    const reachable = lines.filter((line) => {
      while (i < sections.length && sections[i]!.end < line) i++;
      return i < sections.length && sections[i]!.line <= line;
    });
    if (reachable.length > 0) out[file] = reachable;
  }
  return out;
}
