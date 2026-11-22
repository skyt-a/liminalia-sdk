import { button as uiButton, type UiSoundKind } from "../ui-parts.ts";
import { TEXT } from "./strings.ts";

/** 要素を作る。cls は空白区切りのクラス。 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...children);
  return e;
}

/**
 * ボタン（見た目を持たない UI 部品の button を付けたもの。押されたときのクリックは舞台へ流さない）。
 * 押したときの効果音（ui.sound.ui）は、閉じるボタン（lm-close）なら cancel、タブ（lm-tab）なら page、ほかは select。
 */
export function button(cls: string, label: string, action: () => void, sound?: UiSoundKind): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  const classes = cls.split(/\s+/);
  uiButton(b, { onPress: () => action(), sound: sound ?? (classes.includes("lm-close") ? "cancel" : classes.includes("lm-tab") ? "page" : "select") });
  return b;
}

/** システム画面の中のクリック・ホイールを舞台（本文の送り）へ流さない。右クリックは流し、システム側が画面を閉じる。 */
export function swallow(root: HTMLElement): void {
  for (const type of ["click", "wheel"] as const) root.addEventListener(type, (e) => e.stopPropagation());
}

/** 閉じるボタンつきの見出し。 */
export function header(title: string, onClose: () => void, ...extra: Node[]): HTMLElement {
  return el("header", "lm-screen-header", el("h2", "lm-screen-title", title), ...extra, button("lm-button lm-close", TEXT.close, onClose));
}

/** 画面の上に短い知らせを出す。 */
export function toast(parent: HTMLElement, message: string, ms = 1600): void {
  parent.querySelector(".lm-toast")?.remove();
  const t = el("div", "lm-toast", message);
  t.setAttribute("role", "status");
  parent.append(t);
  setTimeout(() => t.classList.add("lm-leaving"), ms);
  setTimeout(() => t.remove(), ms + 400);
}
