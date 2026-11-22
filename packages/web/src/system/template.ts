import { button as uiButton, type UiSoundKind } from "../ui-parts.ts";
import { TEXT } from "./strings.ts";
import { runScreenScript, type ScreenScriptApi } from "./screen-script.ts";

/**
 * 画面の型（HTML の断片）を読み、印の付いた要素に機能を付ける（docs/design/screen-templates.md）。
 * 標準の画面（system/screens/*.ts）も、作品が写して直した画面（liminalia.json の ui.templates）も、同じ形で書く。
 *
 * 型の形: 中身は <template data-part="名前" data-version="版"> を並べたもの。画面の全体は part="screen"、
 * 一覧の一行などは別の部品にし、一覧の要素が data-item="部品の名前" で呼ぶ。<style> は画面を初めて出すときに文書に入れる。
 * 印:
 *   data-role="ok|cancel|close|…"  押すと起きること（画面ごとに決まる）。ボタンにし、キーとフォーカスと効果音を付ける
 *   data-field="名前"              画面の値の文字を入れる
 *   data-text="鍵"                 標準の文言（strings.ts の TEXT の鍵。WebPlugin.texts で替えたもの）を入れる
 *   data-list="名前" data-item="部品"  並べるもの。一つずつ部品を作って中に置く（<template data-list> なら、包む要素を作らずその場所に置く）
 *   data-if="名前"                 その値が空（無い、""、0、false）なら要素ごと外す
 *   data-attr-<属性>="名前"        その値を属性に書く（aria-label、src、alt など。on で始まる属性は書かない）
 *   data-sound="select|cancel|page|choice|none"  押したときの効果音を data-role の決まりから替える
 *   data-autofocus                  開いたときにフォーカスを置く
 * 状態はエンジンが data-lm-* で書く（data-lm-disabled、data-lm-read、data-lm-selected など）。CSS から当てる。
 * 作品の HTML は安全にしてから使う: script などの要素、on* の属性、外の URL を外す（スクリプトは動かさない）。
 */

/** 読んだ型。部品の名前 → <template>、部品の版、文書に入れる見た目。 */
export interface ScreenTemplate {
  readonly parts: ReadonlyMap<string, HTMLTemplateElement>;
  /** 部品の名前 → 版（data-version。写した型では、写した元の標準の版）。 */
  readonly versions: ReadonlyMap<string, number>;
  readonly styles: readonly string[];
}

/** 部品を作るときに渡すもの（一覧の一行も同じ形）。 */
export interface TemplateData {
  /** 画面の値（data-field、data-if、data-attr-*）。 */
  fields?: Readonly<Record<string, string | number | undefined>>;
  /**
   * data-role の値 → 押したときの働き（押した要素を渡す。画面の JS の api.press からは渡さない）。
   * null は「今は使えない」で、その要素を外す（メニューの終了など）。
   */
  roles?: Readonly<Record<string, ((el?: HTMLElement) => void) | null>>;
  /** data-role の値 → 押せないか（<button> なら disabled も付ける）。 */
  disabled?: Readonly<Record<string, boolean>>;
  /** data-if の値（fields より先に見る）。 */
  show?: Readonly<Record<string, boolean>>;
  /** 要素に書く状態（true は data-lm-<名前>、文字はその値。false と undefined は外す）。 */
  state?: Readonly<Record<string, boolean | string | undefined>>;
  /** data-list の名前 → 並べるもの。 */
  lists?: Readonly<Record<string, readonly TemplateItem[]>>;
  /** 一覧の一行だけ: 使う部品（無ければ data-item）。一つの一覧に違う部品を混ぜるとき（選択肢の絵のボタンなど）。 */
  part?: string;
  /** 画面の結果を返して閉じる（画面の JS の api.result。確認の画面は true が「はい」）。 */
  result?: (value: unknown) => void;
}

/** 一覧の一つ。 */
export type TemplateItem = TemplateData;

/** 作った部品。 */
export interface TemplateView {
  readonly el: HTMLElement;
  /** data-autofocus の要素（無ければ null）。 */
  readonly autofocus: HTMLElement | null;
  /** 一覧の今の一行（作った部品のいちばん外の要素）。 */
  items(list: string): readonly HTMLElement[];
  /**
   * 一覧を作り直す（開いている間に中身が変わる画面。タブを替えた操作説明など）。一覧の中にフォーカスがあれば、同じ番目の一行へ移す
   * （無くなっていれば最後の一行）。
   */
  list(list: string, items: readonly TemplateItem[]): void;
  /**
   * 部品の値だけを書き直す（data-field と data-attr-*。一覧の一行の中は書かない）。渡した名前だけを替え、ほかは前の値のまま。
   * 開いている間に文字だけが変わる所（履歴の検索の件数など）に使う。data-if で外した要素は戻さない。
   */
  update(fields: TemplateData["fields"]): void;
}

/** 作った画面（部品 screen）。閉じるときに dispose を呼ぶ（画面の JS が返した片付けを呼ぶ）。 */
export interface ScreenView extends TemplateView {
  dispose(): void;
}

/** 押したときの効果音（戻る系は cancel、ページは page、選択肢は choice、ほかは select）。 */
const ROLE_SOUND: Readonly<Record<string, UiSoundKind>> = { cancel: "cancel", close: "cancel", back: "cancel", page: "page", "next-page": "page", "prev-page": "page", tab: "page", choose: "choice" };

// ---- 安全にする ----

/** 型の中で使えない要素（動くもの、外を読むもの、ページを移るもの）。 */
const BLOCKED = "script, iframe, frame, frameset, object, embed, applet, link, meta, base, portal, noscript";
/** URL を取る属性。 */
const URL_ATTRS = new Set(["href", "xlink:href", "src", "srcset", "action", "formaction", "poster", "background", "ping", "data", "lowsrc", "dynsrc"]);
/** リンクを書く属性（どの要素でもページの中の # だけ。<a>、<area>、SVG の <a>、MathML の href など）。 */
const LINK_ATTRS = new Set(["href", "xlink:href"]);

/**
 * URL を、ブラウザが解くときと同じ形にする（先頭と末尾の制御文字と空白を捨て、途中のタブと改行を捨てる）。
 * 判定はこの形で見る（"&#1;javascript:" や "java&#9;script:" も javascript: と読まれるため）。
 */
export function urlForm(value: string): string {
  return value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\t\n\r]/g, "");
}

/** 許す URL: 相対のパスと #、data: の絵（SVG を除く）と blob:。javascript: や http: などのスキームつき、// や \\ で始まる（外を読む）ものは外す。 */
export function safeUrl(value: string): boolean {
  const url = urlForm(value);
  // / ? # より前の : はスキームとみなす（ブラウザがスキームと読まないものも、厳しい側に倒す）
  if (/^[^/?#]*:/.test(url)) return /^data:image\/(?!svg)/i.test(url) || /^blob:/i.test(url);
  // ブラウザは \ を / と同じに読む（\\host も /\host も //host）
  return !/^[/\\]{2}/.test(url);
}

/** ページの中のリンクか（# で始まる）。 */
export function pageLink(value: string): boolean {
  return urlForm(value).startsWith("#");
}

/** data-attr-* で書く URL に使わないもの（javascript: と vbscript:、絵でない data:。絵の data: は SVG を除いて書ける）。 */
export function unsafeUrl(value: string): boolean {
  return /^(javascript|vbscript):|^data:(?!image\/(?!svg))/i.test(urlForm(value));
}

/** 見た目の文字から、外を読むもの（@import、外の url()、古いブラウザの expression と -moz-binding）を外す。 */
export function safeCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (whole, _q: string, url: string) => (safeUrl(url) ? whole : "none"))
    .replace(/expression\s*\(|-moz-binding/gi, "");
}

function sanitize(root: DocumentFragment | Element): void {
  for (const bad of root.querySelectorAll(BLOCKED)) bad.remove();
  for (const el of root.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      // ページを移るもの（フォームの送り先、別のページへのリンク）も外す。リンクはページの中の # だけ
      if (name.startsWith("on") || name === "srcdoc" || name === "formtarget" || name === "target" || name === "action" || name === "formaction") el.removeAttribute(attr.name);
      else if (LINK_ATTRS.has(name)) {
        if (!pageLink(attr.value)) el.removeAttribute(attr.name);
      } else if (URL_ATTRS.has(name) && !(name === "srcset" ? attr.value.split(",").every((s) => safeUrl(s.trim())) : safeUrl(attr.value))) el.removeAttribute(attr.name);
      else if (name === "style") el.setAttribute("style", safeCss(attr.value));
    }
    // SVG の animate と set で href を書き換えるもの
    if (/^(animate|set)$/i.test(el.localName) && /href/i.test(el.getAttribute("attributeName") ?? "")) el.remove();
  }
  for (const style of root.querySelectorAll("style")) style.textContent = safeCss(style.textContent ?? "");
  for (const t of root.querySelectorAll("template")) sanitize(t.content);
  // 字下げの改行だけの文字（要素の間の空白）は捨てる（インラインのボタンの間に隙間を作らない。pre の中は残す）
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const blank: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/^\s*\n\s*$/.test(n.nodeValue ?? "") && !n.parentElement?.closest("pre, textarea")) blank.push(n as Text);
  for (const n of blank) n.remove();
}

// ---- 読む ----

/** 型の文字を読む。部品と見た目を取り出し、安全にする。<template data-part> の外にある要素は捨てる（<style> は残す）。 */
export function parseTemplate(html: string): ScreenTemplate {
  const holder = document.createElement("template");
  holder.innerHTML = html;
  const parts = new Map<string, HTMLTemplateElement>();
  const versions = new Map<string, number>();
  const styles: string[] = [];
  for (const node of holder.content.children) {
    if (node instanceof HTMLTemplateElement && node.dataset.part) {
      sanitize(node.content);
      parts.set(node.dataset.part, node);
      const v = Number(node.dataset.version);
      if (Number.isFinite(v)) versions.set(node.dataset.part, v);
    } else if (node.localName === "style") styles.push(safeCss(node.textContent ?? ""));
  }
  return { parts, versions, styles };
}

/** 標準の型に作品の型を重ねる（部品ごとに作品のものが勝つ。部品一つだけを写した型は、残りを標準のまま使う）。 */
export function mergeTemplates(base: ScreenTemplate, over: ScreenTemplate | undefined): ScreenTemplate {
  if (!over) return base;
  return { parts: new Map([...base.parts, ...over.parts]), versions: new Map([...base.versions, ...over.versions]), styles: [...base.styles, ...over.styles] };
}

/**
 * 作品の型の部品のうち、写した元の標準より古いもの（部品の名前と、作品の版、今の標準の版）。
 * 作り手への知らせは lim check の template-outdated（@liminalia/lang が字面から読む）なので、遊ぶ側では呼ばない（書き出しの束に入らない）。
 */
export function staleParts(standard: ScreenTemplate, author: ScreenTemplate): { part: string; from: number | undefined; now: number }[] {
  const out: { part: string; from: number | undefined; now: number }[] = [];
  for (const part of author.parts.keys()) {
    const now = standard.versions.get(part);
    const from = author.versions.get(part);
    if (now !== undefined && (from === undefined || from < now)) out.push({ part, from, now });
  }
  return out;
}

// ---- 作る ----

/** 標準の文言を鍵（"confirm.yes" のような入れ子の鍵）で引く。文字でなければ undefined。 */
export function textAt(key: string): string | undefined {
  let v: unknown = TEXT;
  for (const k of key.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
  return typeof v === "string" ? v : undefined;
}

/** 要素に状態を書く（data-lm-<名前>）。 */
export function setState(el: HTMLElement, name: string, value: boolean | string | undefined): void {
  const attr = `data-lm-${name}`;
  if (value === false || value === undefined) el.removeAttribute(attr);
  else el.setAttribute(attr, value === true ? "" : value);
}

/** el と中の要素のうち selector に合うもの。中の一覧の一行（作り終えた部品）の中は除く。 */
function own(el: HTMLElement, selector: string): HTMLElement[] {
  const inItem = (e: HTMLElement) => {
    const item = e.closest<HTMLElement>("[data-lm-item-of]");
    return item !== null && item !== el && el.contains(item);
  };
  return [el, ...el.querySelectorAll<HTMLElement>(selector)].filter((e) => e.matches(selector) && (e === el || !inItem(e)));
}

/** data-if の値が空か（無い、""、0、false）。 */
function empty(data: TemplateData, name: string): boolean {
  const v = data.show?.[name] ?? data.fields?.[name];
  return v === undefined || v === false || v === "" || v === 0;
}

/** data-attr-* で書かない属性（動くもの、ページを移るもの）。 */
const UNSAFE_ATTR = /^(on|srcdoc$|target$|formtarget$|action$|formaction$)/i;

/** 一覧の一行を作る。 */
function renderItems(t: ScreenTemplate, name: string, fallback: string | undefined, items: readonly TemplateItem[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const d of items) {
    const part = d.part ?? fallback;
    if (!part) continue;
    const v = renderPart(t, part, d);
    v.el.setAttribute("data-lm-item-of", name);
    out.push(v.el);
  }
  return out;
}

/** 一覧の置き場（一覧の要素か、<template data-list> を置き換えた印）と、今の一行。 */
interface ListSlot {
  at: HTMLElement | Comment;
  item: string | undefined;
  rows: HTMLElement[];
}

/**
 * 部品を作り、印に機能を付ける。部品の中身が要素一つでなければ、div（class は lm-template）で包む。
 * 知らない data-role は押せる見た目のまま何もしない（開発サーバーではコンソールに出す）。
 */
export function renderPart(t: ScreenTemplate, part: string, data: TemplateData = {}): TemplateView {
  const tpl = t.parts.get(part);
  // 文は開発サーバーだけ（書き出しでは部品の名前だけ。エンジンの束の大きさのため）
  if (!tpl) throw new Error(import.meta.hot ? `画面の型に部品 ${part} がありません` : part);
  const fragment = tpl.content.cloneNode(true) as DocumentFragment;
  const elements = [...fragment.children];
  let el: HTMLElement;
  if (elements.length === 1 && elements[0] instanceof HTMLElement) el = elements[0];
  else {
    el = document.createElement("div");
    el.className = "lm-template";
    el.append(fragment);
  }
  // 値の無い data-if の要素は先に外す（中の印は働かせない）
  for (const e of own(el, "[data-if]")) if (e !== el && empty(data, e.dataset.if!)) e.remove();
  // 一覧は先に作る（中の部品の印は、その部品の値で埋める）
  const slots = new Map<string, ListSlot>();
  for (const list of own(el, "[data-list]")) {
    const name = list.dataset.list!;
    const rows = renderItems(t, name, list.dataset.item, data.lists?.[name] ?? []);
    if (list instanceof HTMLTemplateElement) {
      // 包む要素を作らず、その場所に並べる（.choices > button のように、外の要素の子にしたいとき）
      const at = document.createComment(` ${name} `);
      list.replaceWith(at, ...rows);
      slots.set(name, { at, item: list.dataset.item, rows });
    } else {
      list.replaceChildren(...rows);
      slots.set(name, { at: list, item: list.dataset.item, rows });
    }
  }
  fill(el, data);
  let fields = data.fields;
  return {
    el,
    autofocus: own(el, "[data-autofocus]")[0] ?? null,
    items: (name) => slots.get(name)?.rows ?? [],
    list(name, items) {
      const slot = slots.get(name);
      if (!slot) return;
      const active = document.activeElement;
      const at = slot.rows.findIndex((r) => r.contains(active));
      const rows = renderItems(t, name, slot.item, items);
      for (const r of slot.rows) r.remove();
      if (slot.at instanceof Comment) slot.at.after(...rows);
      else slot.at.append(...rows);
      slot.rows = rows;
      const next = at >= 0 ? rows[Math.min(at, rows.length - 1)] : undefined;
      if (next) (next.matches("[data-role], [tabindex]") ? next : (next.querySelector<HTMLElement>("[data-role], [tabindex]") ?? next)).focus({ preventScroll: true });
    },
    update(more) {
      fields = { ...fields, ...more };
      values(el, fields);
    },
  };
}

/** 値を書く（data-field の文字と data-attr-* の属性）。 */
function values(el: HTMLElement, fields: TemplateData["fields"]): void {
  for (const e of own(el, "[data-field]")) {
    const v = fields?.[e.dataset.field!];
    e.textContent = v === undefined ? "" : String(v);
  }
  for (const e of own(el, "*")) {
    for (const attr of [...e.attributes]) {
      if (!attr.name.startsWith("data-attr-")) continue;
      const name = attr.name.slice("data-attr-".length);
      const v = fields?.[attr.value];
      if (!name || UNSAFE_ATTR.test(name)) continue;
      const lower = name.toLowerCase();
      // リンクは型と同じくページの中の # だけ。ほかの URL は動くもの（javascript: など）だけを断る（素材の URL はエンジンが作る）
      const bad = LINK_ATTRS.has(lower) ? !pageLink(String(v)) : URL_ATTRS.has(lower) && unsafeUrl(String(v));
      if (v === undefined || v === "" || bad) e.removeAttribute(name);
      else e.setAttribute(name, String(v));
    }
  }
}

function fill(el: HTMLElement, data: TemplateData): void {
  const mine = (selector: string) => own(el, selector);
  for (const e of mine("[data-text]")) {
    const s = textAt(e.dataset.text!);
    if (s !== undefined) e.textContent = s;
  }
  values(el, data.fields);
  for (const e of mine("[data-role]")) {
    const role = e.dataset.role!;
    const action = data.roles?.[role];
    // 今は使えない働き（メニューの終了をブラウザで、など）は要素ごと外す
    if (action === null && e !== el) {
      e.remove();
      continue;
    }
    if (e instanceof HTMLButtonElement && !e.hasAttribute("type")) e.type = "button";
    if (!action && import.meta.hot) console.warn(`画面の型の data-role="${role}" は、この画面では働きません`);
    const off = data.disabled?.[role] === true;
    if (off && e instanceof HTMLButtonElement) e.disabled = true;
    const named = e.dataset.sound;
    // 知らない名前の音は鳴らない（ui-parts.ts の playSound が飛ばす）
    const sound: UiSoundKind | false = named === "none" ? false : ((named as UiSoundKind | undefined) || (ROLE_SOUND[role] ?? "select"));
    uiButton(e, { onPress: () => action?.(e), sound, disabled: off });
  }
  for (const [name, value] of Object.entries(data.state ?? {})) setState(el, name, value);
}

// ---- 画面ごとの型 ----

/**
 * 画面の型の置き場。標準の型（画面の名前 → 型の文字）に、作品の型（liminalia.json の ui.templates を読んだ文字）を重ねる。
 * 見た目（<style>）は、その画面を初めて出すときに文書に入れる。作品の型を替えたら（開発サーバー）入れ直す。
 */
export class ScreenTemplates {
  private readonly cache = new Map<string, ScreenTemplate>();
  private readonly styled = new Set<string>();
  private author: Readonly<Record<string, string>> = {};

  private standard: Readonly<Record<string, string>>;

  constructor(standard: Readonly<Record<string, string>>) {
    this.standard = standard;
  }

  /** 標準の型を足す（書き出しでは、すぐに出す確認のほかは、初めて開くときに読んで足す。system/standard-templates.ts）。 */
  addStandard(more: Readonly<Record<string, string>>): void {
    this.standard = { ...this.standard, ...more };
    for (const name of Object.keys(more)) this.cache.delete(name);
  }

  /** 作品の型（画面の名前 → 型の文字）を入れ替える。 */
  setAuthor(templates: Readonly<Record<string, string>> | undefined): void {
    const next = templates ?? {};
    if (JSON.stringify(next) === JSON.stringify(this.author)) return;
    this.author = next;
    this.cache.clear();
    for (const s of document.querySelectorAll("style[data-lm-template]")) s.remove();
    this.styled.clear();
  }

  /** 作品の型があるか（部品一つだけでも）。 */
  hasAuthor(name: string): boolean {
    return typeof this.author[name] === "string";
  }

  /** 画面の型（標準に作品のものを重ねたもの）。どちらも無ければ undefined。 */
  get(name: string): ScreenTemplate | undefined {
    const hit = this.cache.get(name);
    if (hit) return hit;
    const std = this.standard[name];
    const mine = this.author[name];
    if (std === undefined && mine === undefined) return undefined;
    const t = mergeTemplates(std !== undefined ? parseTemplate(std) : { parts: new Map(), versions: new Map(), styles: [] }, mine !== undefined ? parseTemplate(mine) : undefined);
    this.cache.set(name, t);
    return t;
  }

  /** 画面の部品を作る（見た目をまだ入れていなければ入れる）。 */
  render(name: string, part: string, data: TemplateData = {}): TemplateView {
    const t = this.get(name);
    if (!t) throw new Error(import.meta.hot ? `画面 ${name} の型がありません` : name);
    if (!this.styled.has(name)) {
      this.styled.add(name);
      if (t.styles.length > 0) {
        const style = document.createElement("style");
        style.dataset.lmTemplate = name;
        style.textContent = t.styles.join("\n");
        document.head.append(style);
      }
    }
    return renderPart(t, part, data);
  }

  /**
   * 画面の全体（部品 screen）を作り、作品の画面の JS（system/screen-script.ts）があれば、要素と api を渡して呼ぶ。
   * テンプレートで作る画面は、render の代わりにこれで作り、閉じるときに dispose を呼ぶ（JS の片付け）。
   * host は JS に渡す要素（無ければ作った要素）。作った要素の中身を前からある要素へ移す画面（選択肢の層）が、移した先を渡す。
   */
  screen(name: string, data: TemplateData = {}, host?: HTMLElement): ScreenView {
    const view = this.render(name, "screen", data);
    const press = (role: string): boolean => {
      const action = data.roles?.[role];
      if (!action) return false;
      action();
      return true;
    };
    const api: ScreenScriptApi = {
      version: 1,
      screen: name,
      values: Object.freeze({ ...data.fields }),
      press,
      close: () => void (press("close") || press("cancel") || press("back")),
      result: (value) => (data.result ? data.result(value) : void press(value === true ? "ok" : "close")),
      render: (part, item = {}) => this.render(name, part, item).el,
      text: textAt,
    };
    return { ...view, dispose: runScreenScript(name, host ?? view.el, api) };
  }

}
