import type { ChoiceLook } from "@liminalia/runtime";
import type { AssetKind } from "../dom-host.ts";
import type { ScreenTemplates, TemplateItem } from "./template.ts";

export interface ChoiceViewOptions {
  options: readonly string[];
  looks?: readonly (ChoiceLook | null)[] | undefined;
  /** 選んだ先を読んだことがあるか。 */
  read: readonly boolean[];
  /** 押せないか（locked= が真、巻き戻しで前に選んだもの以外）。 */
  locked(i: number): boolean;
  /** 制限時間（ミリ秒。0 なら無し）。 */
  time: number;
  asset(kind: AssetKind, path: string): string;
  choose(i: number): void;
}

/** 出した選択肢。buttons は一つずつの押す要素（data-role="choose"）、remove は層を元に戻す。 */
export interface ChoiceView {
  buttons: HTMLElement[];
  remove(): void;
}

/** 一つの選択肢の部品（絵、見えない押せる範囲、文字）。 */
const partOf = (look: ChoiceLook | null): string => (look?.image ? "option-image" : look?.width !== undefined && look.height !== undefined ? "option-area" : "option");

/**
 * 選択肢を、型（標準か、作品が写して直した ui.templates.choice）から作って、舞台の選択肢の層（.choices）に並べる。
 * 型の screen のいちばん外の要素は層そのものを表す: そのクラスと属性を層に付け、中身を層に入れる（remove で外す）。
 * 制限時間があれば、残り時間のバーが使う --choice-time を層に書く。remove は画面の JS の片付けも呼ぶ。
 */
export function showChoices(templates: ScreenTemplates, layer: HTMLElement, o: ChoiceViewOptions): ChoiceView {
  const items: TemplateItem[] = o.options.map((text, i) => {
    const look = o.looks?.[i] ?? null;
    return {
      part: partOf(look),
      fields: { text, image: look?.image ? o.asset("image", look.image) : "", index: i + 1 },
      roles: { choose: () => o.choose(i) },
      disabled: { choose: o.locked(i) },
      state: { read: !!o.read[i] },
    };
  });
  // 作品の画面の JS（ui/screens/choice/choice.js）には層を渡す（作った要素の中身は層へ移すので）。api.result(番号) はその番目を選ぶ（0 から）
  const view = templates.screen("choice", { fields: { timer: o.time > 0 ? o.time : "" }, lists: { options: items }, result: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < o.options.length && !o.locked(v) && o.choose(v) }, layer);
  const root = view.el;
  // いちばん外の要素のクラスと属性を層に付ける（元から付いているものは、そのままにする）
  const added: string[] = [...root.classList].filter((c) => !layer.classList.contains(c));
  layer.classList.add(...added);
  const attrs: [string, string | null][] = [];
  for (const a of root.attributes) {
    if (a.name === "class" || a.name === "id") continue;
    attrs.push([a.name, layer.getAttribute(a.name)]);
    layer.setAttribute(a.name, a.value);
  }
  if (o.time > 0) layer.style.setProperty("--choice-time", `${o.time}ms`);
  layer.append(...root.childNodes);
  const buttons = view.items("options").map((row, i) => {
    const b = row.matches("[data-role=choose]") ? row : (row.querySelector<HTMLElement>("[data-role=choose]") ?? row);
    // 前からの CSS（.choices > button.is-read、.is-locked）のためのクラス
    if (o.read[i]) b.classList.add("is-read");
    if (o.locked(i)) b.classList.add("is-locked");
    look(b, o.looks?.[i] ?? null, o.asset);
    return b;
  });
  return {
    buttons,
    remove() {
      view.dispose();
      layer.classList.remove(...added);
      for (const [name, before] of attrs) {
        if (before === null) layer.removeAttribute(name);
        else layer.setAttribute(name, before);
      }
      layer.style.removeProperty("--choice-time");
    },
  };
}

/** 作品が台本に書いた見た目（hover= の絵、x=、y=、width=、height=、cursor=、tip=）を要素に書く。 */
function look(b: HTMLElement, l: ChoiceLook | null, asset: (kind: AssetKind, path: string) => string): void {
  if (!l) return;
  const img = b.querySelector("img");
  if (l.image && l.hover && img) {
    const hover = asset("image", l.hover);
    const normal = asset("image", l.image);
    b.addEventListener("mouseenter", () => (img.src = hover));
    b.addEventListener("mouseleave", () => (img.src = normal));
  }
  if (l.x !== undefined || l.y !== undefined) Object.assign(b.style, { position: "absolute", left: `${l.x ?? 0}px`, top: `${l.y ?? 0}px` });
  if (l.width !== undefined) b.style.width = `${l.width}px`;
  if (l.height !== undefined) b.style.height = `${l.height}px`;
  // 調べる場所: 乗せたときのカーソルの画像（押す点は真ん中）と短い説明
  if (l.cursor) b.style.cursor = `url("${asset("image", l.cursor)}") 16 16, pointer`;
  if (l.tip) {
    b.dataset.tip = l.tip;
    b.classList.add("has-tip");
    if (!b.getAttribute("aria-label") && !b.textContent) b.setAttribute("aria-label", l.tip);
  }
}
