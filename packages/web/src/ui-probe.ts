import type { RenderContext } from "./dom-host.ts";
import type { Replaceable } from "@liminalia/studio/protocol";
import type { WebPlugin } from "./plugin.ts";

/**
 * 制作画面の「ゲームの設定」が、作品で実際に効いているかを確かめる（見本のプレイヤー ?ui-preview= が使う）。
 * - 差し替えた画面: プラグインが宣言で差し替えた画面（タイトル・設定・セーブとロード・履歴・帯・メニューなど）と、そのプラグインの名前
 * - 効かない項目: 設定が渡す CSS 変数（と位置）を二つの値に替えてみて、本文・枠・名前の欄・選択肢の実際の見た目が変わらないもの。
 *   作品の CSS・プラグイン・キャラクターの名前の色などがその見た目を決めていると変わらない。替えたものはすぐ戻す（描かれる前に戻すので見えない）
 * どちらも作品の中身に依らず、宣言と実際の見た目から分かることだけを知らせる。
 */

/**
 * 差し替えを知らせる画面（glyph はクリック待ちの印。本文の見た目の glyph）。screens の口（plugin.ts の StandardScreens）を足したらここにも書く
 * （studio の test/replaced-screens.test.ts が、標準の画面の一覧 system/screen-catalog.ts の screens.* と突き合わせる）。
 */
const REPLACEABLE: readonly Replaceable[] = ["title", "splash", "config", "saveload", "backlog", "menuBar", "menu", "confirm", "ending", "extra", "flowchart", "indicator", "codex", "toast", "choice", "name", "dialog", "help", "items", "glyph"];

/** システム画面を丸ごと差し替えた（WebPlugin.system）ときに、そのプラグインが作る画面（ゲームの中の選択肢、名前欄、確かめの枠、通知は標準のまま）。 */
const SYSTEM_SCREENS: ReadonlySet<Replaceable> = new Set(["title", "splash", "config", "saveload", "backlog", "menuBar", "menu", "confirm", "ending", "extra", "flowchart", "indicator", "codex", "help", "items"]);

/** プラグインの宣言から、差し替えた画面を集める（後のプラグインが勝つ）。 */
export function replacedScreens(plugins: readonly WebPlugin[]): Partial<Record<Replaceable, string>> {
  const out: Partial<Record<Replaceable, string>> = {};
  for (const p of plugins) {
    // システム画面を丸ごと差し替えたら、タイトルも起動の演出もそのプラグインが作る
    if (p.system) for (const k of SYSTEM_SCREENS) out[k] = p.name;
    if (p.title) out.title = p.name;
    if (p.splash) out.splash = p.name;
    for (const k of Object.keys(p.screens ?? {})) if ((REPLACEABLE as readonly string[]).includes(k)) out[k as Replaceable] = p.name;
    if (p.extensions?.text?.glyph) out.glyph = p.name;
  }
  return out;
}

type Target = "text" | "message" | "frame" | "name" | "glyph" | "choice" | "choices";

interface Probe {
  /** ui の項目（同じ見た目を決める項目はまとめる）。 */
  fields: string[];
  target: Target;
  /** 替えるもの: 舞台の CSS 変数、枠の要素の CSS 変数、要素の style の left・top。 */
  set: { stageVar: string } | { messageVar: string } | { inline: "left" | "top" };
  values: [string, string];
  read(el: HTMLElement): string | number;
}

const css = (prop: keyof CSSStyleDeclaration) => (el: HTMLElement) => String(getComputedStyle(el)[prop]);
const RED = "#ff0000";
const GREEN = "#00ff00";

const PROBES: Probe[] = [
  { fields: ["text.font", "text.fontFile"], target: "text", set: { stageVar: "--font" }, values: ["serif", "monospace"], read: css("fontFamily") },
  { fields: ["text.size"], target: "text", set: { stageVar: "--text-size" }, values: ["17px", "23px"], read: css("fontSize") },
  { fields: ["text.lineHeight"], target: "text", set: { stageVar: "--text-line" }, values: ["1.3", "2.1"], read: css("lineHeight") },
  { fields: ["text.color"], target: "text", set: { stageVar: "--message-fg" }, values: [RED, GREEN], read: css("color") },
  { fields: ["text.align"], target: "text", set: { stageVar: "--text-align" }, values: ["left", "right"], read: css("textAlign") },
  { fields: ["text.decoration", "text.decorationColor"], target: "text", set: { stageVar: "--text-shadow" }, values: ["none", `1px 1px 0 ${RED}`], read: css("textShadow") },
  { fields: ["message.background"], target: "message", set: { stageVar: "--message-bg" }, values: [RED, GREEN], read: css("backgroundColor") },
  { fields: ["message.image"], target: "frame", set: { stageVar: "--message-image" }, values: ['url("data:,a")', 'url("data:,b")'], read: css("backgroundImage") },
  { fields: ["message.borderColor"], target: "message", set: { stageVar: "--message-border" }, values: [RED, GREEN], read: css("borderTopColor") },
  { fields: ["message.radius"], target: "message", set: { stageVar: "--message-radius" }, values: ["3px", "9px"], read: css("borderTopLeftRadius") },
  { fields: ["message.padding"], target: "message", set: { stageVar: "--message-padding" }, values: ["3px", "9px"], read: css("paddingTop") },
  { fields: ["message.x"], target: "message", set: { messageVar: "--message-left" }, values: ["10px", "50px"], read: (el) => el.offsetLeft },
  { fields: ["message.y"], target: "message", set: { messageVar: "--message-top" }, values: ["10px", "50px"], read: (el) => el.offsetTop },
  { fields: ["message.width"], target: "message", set: { messageVar: "--message-width" }, values: ["300px", "700px"], read: (el) => el.offsetWidth },
  { fields: ["message.height"], target: "message", set: { messageVar: "--message-height" }, values: ["200px", "400px"], read: (el) => el.offsetHeight },
  { fields: ["name.size"], target: "name", set: { stageVar: "--name-size" }, values: ["17px", "23px"], read: css("fontSize") },
  { fields: ["name.color"], target: "name", set: { stageVar: "--name-fg" }, values: [RED, GREEN], read: css("color") },
  { fields: ["name.background"], target: "name", set: { stageVar: "--name-bg" }, values: [RED, GREEN], read: css("backgroundColor") },
  { fields: ["name.image"], target: "name", set: { stageVar: "--name-image" }, values: ['url("data:,a")', 'url("data:,b")'], read: css("backgroundImage") },
  { fields: ["name.borderColor"], target: "name", set: { stageVar: "--name-border" }, values: [RED, GREEN], read: css("borderTopColor") },
  { fields: ["name.x"], target: "name", set: { inline: "left" }, values: ["10px", "50px"], read: (el) => el.offsetLeft },
  { fields: ["name.y"], target: "name", set: { inline: "top" }, values: ["10px", "50px"], read: (el) => el.offsetTop },
  { fields: ["glyph.color"], target: "glyph", set: { stageVar: "--glyph-fg" }, values: [RED, GREEN], read: css("color") },
  { fields: ["glyph.size"], target: "glyph", set: { stageVar: "--glyph-size" }, values: ["0.4em", "1.2em"], read: css("fontSize") },
  { fields: ["choice.size"], target: "choice", set: { stageVar: "--choice-size" }, values: ["17px", "23px"], read: css("fontSize") },
  { fields: ["choice.color"], target: "choice", set: { stageVar: "--choice-fg" }, values: [RED, GREEN], read: css("color") },
  { fields: ["choice.background"], target: "choice", set: { stageVar: "--choice-bg" }, values: [RED, GREEN], read: css("backgroundColor") },
  { fields: ["choice.borderColor"], target: "choice", set: { stageVar: "--choice-border" }, values: [RED, GREEN], read: css("borderTopColor") },
  { fields: ["choice.image"], target: "choice", set: { stageVar: "--choice-image" }, values: ['url("data:,a")', 'url("data:,b")'], read: css("backgroundImage") },
  { fields: ["choice.width"], target: "choice", set: { stageVar: "--choice-width" }, values: ["300px", "900px"], read: (el) => el.offsetWidth },
  { fields: ["choice.gap"], target: "choices", set: { stageVar: "--choice-gap" }, values: ["3px", "40px"], read: css("rowGap") },
];

/** 見本の今の画面で、効かない項目を確かめる。 */
export function probeUi(ctx: RenderContext): { probed: string[]; ignored: string[] } {
  const visible = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.getClientRects().length > 0;
  const targets: Record<Target, HTMLElement | null> = {
    text: ctx.message.text,
    message: ctx.message.root,
    name: ctx.message.name,
    glyph: ctx.message.root.querySelector<HTMLElement>(".glyph"),
    frame: ctx.stage.querySelector<HTMLElement>(".message-frame"),
    choice: ctx.stage.querySelector<HTMLElement>(".choices button"),
    choices: ctx.stage.querySelector<HTMLElement>(".choices"),
  };
  const probed: string[] = [];
  const ignored: string[] = [];
  for (const p of PROBES) {
    const el = targets[p.target];
    if (!visible(el)) continue;
    const style = "inline" in p.set ? el.style : "messageVar" in p.set ? ctx.message.root.style : ctx.stage.style;
    const prop = "inline" in p.set ? p.set.inline : "messageVar" in p.set ? p.set.messageVar : p.set.stageVar;
    const before = style.getPropertyValue(prop);
    const priority = style.getPropertyPriority(prop);
    const reads = p.values.map((v) => {
      style.setProperty(prop, v);
      return p.read(el);
    });
    if (before) style.setProperty(prop, before, priority);
    else style.removeProperty(prop);
    probed.push(...p.fields);
    if (reads[0] === reads[1]) ignored.push(...p.fields);
  }
  return { probed, ignored };
}
