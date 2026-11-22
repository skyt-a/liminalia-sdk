/** 素の DOM を短く組むための小さな道具。 */
import { truncSplit } from "../model/trunc.ts";

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || (v === false && k !== "draggable")) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k in el && k !== "list" && k !== "type") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** 選択肢などの HTML を、一覧に置ける一行の文字にする。template の中は画面に接続しない。 */
export function plainHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content;
  content.querySelectorAll("script, style, template, rt, rp").forEach((el) => el.remove());
  content.querySelectorAll("br, hr").forEach((el) => el.replaceWith(" "));
  content.querySelectorAll("img").forEach((el) => el.replaceWith(el.getAttribute("alt") ?? ""));
  content.querySelectorAll("div, p, li, tr, td, th, h1, h2, h3, h4, h5, h6").forEach((el) => {
    el.prepend(" ");
    el.append(" ");
  });
  return (content.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** 時刻を「14:05」の形に。 */
export function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/** 値を事実の欄に出す字面に。 */
export function showValue(v: unknown): string {
  if (typeof v === "string") return `"${v.length > 40 ? `${v.slice(0, 40)}…` : v}"`;
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 60)}…` : s;
  }
  return String(v);
}

/**
 * ファイル名を、幅が足りないときに真ん中で省けるよう二つに分ける（後ろは区別の付く所から残す。model/trunc.ts）。
 * chapter_001.lim と chapter_002.lim、IMG_…_v11.webp と IMG_…_v12.webp のように後ろだけが違う名前が、狭い欄で同じ「chapter_00…」にならないように。
 * siblings は同じ欄に並ぶ名前（頭のそろった名前が並ぶときは、そろった頭の後ろから残す。「e…e1_2.lim」にしない）。
 */
export function middleTruncated(name: string, siblings: readonly string[] = []): HTMLElement[] {
  const at = truncSplit(name, siblings);
  if (at === null) return [h("span", { class: "trunc-head" }, name)];
  const chars = [...name];
  return [h("span", { class: "trunc-head" }, chars.slice(0, at).join("")), h("span", { class: "trunc-tail" }, chars.slice(at).join(""))];
}
