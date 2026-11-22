import { clipStoryText, plainText, type Flow, type FlowScene } from "@liminalia/lang";
import type { Translator } from "@liminalia/runtime";
import type { FlowchartScreenApi } from "../plugin.ts";
import { TEXT } from "./strings.ts";
import { button, el, header, swallow } from "./ui.ts";

/** 場面の箱の大きさと間（px）。 */
const BOX_W = 210;
const BOX_H = 58;
const GAP_X = 70;
const GAP_Y = 22;
const SVG_NS = "http://www.w3.org/2000/svg";

/** 最後に開いていたタブ。 */
let lastTab: "flow" | "endings" = "flow";

/**
 * 場面の置き場所。はじめの場面から矢印をたどった深さを列（左から右）にし、同じ列の中は台本の順に上から並べる。
 * 戻る矢印（深さが浅くなる先）は列を決めるのに使わない。
 */
export function layoutFlow(flow: Flow): Map<string, { col: number; row: number }> {
  const out = new Map<string, string[]>();
  for (const l of flow.links) (out.get(l.from) ?? out.set(l.from, []).get(l.from)!).push(l.to);
  const depth = new Map<string, number>([[flow.entry, 0]]);
  const queue = [flow.entry];
  let last = 0;
  for (const id of queue) {
    const d = depth.get(id)!;
    last = d;
    for (const to of out.get(id) ?? []) {
      if (depth.has(to)) continue;
      depth.set(to, d + 1);
      queue.push(to);
    }
  }
  // はじめから矢印で届かない場面（命令だけで移る先など）は最後の列の次に
  const rows = new Map<number, number>();
  const pos = new Map<string, { col: number; row: number }>();
  for (const s of flow.scenes) {
    const col = depth.get(s.id) ?? last + 1;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    pos.set(s.id, { col, row });
  }
  return pos;
}

/**
 * フローチャートの場面の題（最初の本文）と選択肢の文を、遊んでいる言語の訳にしたもの（訳の無いものと、訳を引く元の無い古い flow.json は原文のまま）。
 * 題は原文と同じく、話者名を頭に付けて同じ長さに切る。
 */
export function localizeFlow(flow: Flow, tr: Translator | null): Flow {
  if (!tr) return flow;
  const scenes = flow.scenes.map((s) => {
    const k = s.titleKey;
    const content = k ? tr.line(k.file, k.source, k.context, k.id) : null;
    if (!k || !content) return s;
    const speaker = k.speaker ? (tr.speaker(k.speaker) ?? k.speaker) : "";
    return { ...s, title: clipStoryText(speaker ? `${speaker}${plainText(content)}` : plainText(content).trim()) };
  });
  const links = flow.links.map((l) => {
    const k = l.choiceKey;
    const content = k ? tr.option(k.file, k.source, k.context, k.id) : null;
    return k && content ? { ...l, choice: clipStoryText(plainText(content)) } : l;
  });
  return { ...flow, scenes, links };
}

/** 標準のフローチャートの画面（タブ: フローチャート・エンディング）。 */
export function createFlowchart(api: FlowchartScreenApi): { el: HTMLElement; back(): boolean } {
  const root = el("div", "lm-screen lm-flow");
  swallow(root);
  const body = el("div", "lm-flow-body");
  const nav = el("nav", "lm-tabs");
  const tabs = new Map<"flow" | "endings", HTMLButtonElement>();
  for (const t of ["flow", "endings"] as const) {
    const b = button("lm-tab", TEXT.flowchart.tabs[t], () => show(t));
    tabs.set(t, b);
    nav.append(b);
  }
  const reachedEndings = api.endings.filter((e) => e.reached).length;
  const summary = el("span", "lm-flow-summary", TEXT.flowchart.readRate(Math.floor(api.readRate * 100)), el("span", "lm-flow-sep"), TEXT.flowchart.endingCount(reachedEndings, api.endings.length));
  root.append(header(TEXT.flowchart.heading, api.close, nav, summary), body);

  function show(tab: "flow" | "endings"): void {
    lastTab = tab;
    for (const [t, b] of tabs) b.setAttribute("aria-pressed", String(t === tab));
    body.replaceChildren(tab === "flow" ? chart() : endingList());
  }

  function sceneButton(scene: FlowScene, cls: string): HTMLElement {
    const reached = api.reached(scene);
    const jump = reached && api.canJump(scene);
    const b = button(`${cls}${reached ? "" : " is-locked"}${scene.end ? " is-end" : ""}`, "", () => jump && api.jump(scene));
    b.disabled = !jump;
    b.title = reached ? api.title(scene) : "";
    b.append(el("span", "lm-flow-title", reached ? api.title(scene) || TEXT.flowchart.untitled : TEXT.flowchart.locked));
    // エンディングは種類の文言と名前（訳したもの。api.endings の name）
    if (scene.end) b.append(el("span", "lm-flow-badge", reached && scene.end.ending ? (api.endings.find((e) => e.scene.id === scene.id)?.name ?? scene.end.ending) : TEXT.flowchart.end));
    return b;
  }

  function chart(): HTMLElement {
    const pos = layoutFlow(api.flow);
    const cols = Math.max(0, ...[...pos.values()].map((p) => p.col)) + 1;
    const rows = Math.max(0, ...[...pos.values()].map((p) => p.row)) + 1;
    const width = cols * (BOX_W + GAP_X);
    // 戻る矢印が一番下の箱の下を回る分も取る
    const height = rows * (BOX_H + GAP_Y) + GAP_Y;
    const canvas = el("div", "lm-flow-canvas");
    Object.assign(canvas.style, { width: `${width}px`, height: `${height}px` });
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "lm-flow-lines");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    const at = (id: string) => {
      const p = pos.get(id)!;
      return { x: p.col * (BOX_W + GAP_X), y: p.row * (BOX_H + GAP_Y) };
    };
    const byId = new Map(api.flow.scenes.map((s) => [s.id, s]));
    for (const l of api.flow.links) {
      const from = byId.get(l.from);
      const to = byId.get(l.to);
      if (!from || !to || !pos.has(l.from) || !pos.has(l.to)) continue;
      const a = at(l.from);
      const b = at(l.to);
      const x1 = a.x + BOX_W;
      const y1 = a.y + BOX_H / 2;
      const x2 = b.x;
      const y2 = b.y + BOX_H / 2;
      const path = document.createElementNS(SVG_NS, "path");
      // 前へ進む矢印は横に流し、戻る矢印は箱の下から下を回して戻る
      const below = Math.max(a.y, b.y) + BOX_H + GAP_Y;
      const d = x2 > x1 ? `M${x1},${y1} C${x1 + GAP_X / 2},${y1} ${x2 - GAP_X / 2},${y2} ${x2},${y2}` : `M${a.x + BOX_W / 2},${a.y + BOX_H} C${a.x + BOX_W / 2},${below} ${b.x + BOX_W / 2},${below} ${b.x + BOX_W / 2},${b.y + BOX_H}`;
      path.setAttribute("d", d);
      const known = api.reached(from) && api.reached(to);
      path.setAttribute("class", known ? "is-known" : "");
      svg.append(path);
    }
    canvas.append(svg);
    for (const s of api.flow.scenes) {
      if (!pos.has(s.id)) continue;
      const b = sceneButton(s, "lm-flow-scene");
      const p = at(s.id);
      Object.assign(b.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${BOX_W}px`, height: `${BOX_H}px` });
      // 読んだ場面から出る選択肢の文は、箱の下に小さく出す（読む前の選択肢は伏せる）
      const choices = api.reached(s) ? api.flow.links.filter((l) => l.from === s.id && l.choice).map((l) => l.choice!) : [];
      if (choices.length > 0) b.title = `${b.title}\n${choices.map((c) => `・${c}`).join("\n")}`;
      canvas.append(b);
    }
    const scroll = el("div", "lm-flow-scroll", canvas);
    // はじめの場面が見えるように
    requestAnimationFrame(() => scroll.scrollTo({ left: 0, top: 0 }));
    return scroll;
  }

  function endingList(): HTMLElement {
    const list = el("div", "lm-extra-list lm-flow-endings");
    if (api.endings.length === 0) list.append(el("p", "lm-log-empty", TEXT.flowchart.noEndings));
    api.endings.forEach((e, i) => {
      const row = sceneButton(e.scene, "lm-extra-row lm-flow-ending");
      if (e.kind) row.dataset.kind = e.kind;
      row.replaceChildren(
        el("span", "lm-extra-no", String(i + 1).padStart(2, "0")),
        el("span", "lm-extra-name", e.reached ? e.name : TEXT.flowchart.locked),
        el("span", "lm-extra-desc", e.reached ? api.title(e.scene) : ""),
      );
      list.append(row);
    });
    return list;
  }

  show(lastTab);
  return { el: root, back: () => false };
}
