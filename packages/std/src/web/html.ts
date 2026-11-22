import { HTML_ATTRIBUTES, HTML_TAGS } from "@liminalia/lang";
import type { Value } from "@liminalia/runtime";
import { ui, type RenderContext, type Renderer } from "@liminalia/web";
import * as H from "../commands/html.ts";
import "./html.css";
import { fadeIn, fadeOutAndRemove, imageLayer, layerItems, registerLayerItem } from "./image.ts";

/**
 * @html / @html-hide の描画。状態の HTML（評価し終えたもの）を DOMParser で読み、@liminalia/lang の html.ts と同じ
 * 使えるタグと属性の一覧で掃除し直してから置く（検査を通らない台本や、手で書き換えたセーブが来ても JS を動かさない）。
 * src は作品の image フォルダの素材として読む。
 */

type Args = Record<string, Value>;

const num = (v: Value | undefined, d = 0): number => (typeof v === "number" ? v : d);
const EXTERNAL_URL = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const UNSAFE_STYLE = /url\s*\(|expression\s*\(|@import|javascript\s*:/i;

/** 評価し終えた HTML を、使えるタグと属性だけの要素にする。 */
export function sanitizeHtml(ctx: Pick<RenderContext, "asset">, html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
  const out = document.createDocumentFragment();
  const copy = (from: Node, into: Node) => {
    for (const child of from.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        into.appendChild(document.createTextNode(child.textContent ?? ""));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const source = child as Element;
      const tag = source.tagName.toLowerCase();
      // 使えないタグは中身ごと捨てる（<script> の中の文字なども出さない）
      if (!HTML_TAGS.has(tag)) continue;
      const el = document.createElement(tag);
      for (const attr of source.attributes) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || !HTML_ATTRIBUTES.has(name)) continue;
        const value = attr.value;
        if (/javascript\s*:/i.test(value)) continue;
        if (name === "src") {
          if (value.trim() === "" || EXTERNAL_URL.test(value)) continue;
          el.setAttribute("src", ctx.asset("image", value.trim()));
          continue;
        }
        if (name === "style" && UNSAFE_STYLE.test(value)) continue;
        el.setAttribute(name, value);
      }
      if (tag === "button") el.setAttribute("type", "button");
      copy(source, el);
      into.appendChild(el);
    }
  };
  copy(doc.body, out);
  return out;
}

/** 状態の HTML の項目から要素を作る。 */
export function buildHtml(ctx: RenderContext, item: H.HtmlItem): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "lim-html";
  el.style.left = `${item.x}px`;
  el.style.top = `${item.y}px`;
  if (item.width !== null) el.style.width = `${item.width}px`;
  if (item.height !== null) el.style.height = `${item.height}px`;
  if (item.name) el.dataset.name = item.name;
  // 名前の無いものを、待っている間のセーブから再開したときに見分ける目印
  el.dataset.html = item.html;
  el.append(sanitizeHtml(ctx, item.html));
  return el;
}

registerLayerItem("html", async (ctx, item) => buildHtml(ctx, item as unknown as H.HtmlItem));

/** 同じものとみなす要素（同じ名前。名前が無ければ同じ HTML）。 */
function sameItems(ctx: RenderContext, item: H.HtmlItem): HTMLElement[] {
  const all = ["fg0", "fg1", "fg2"].flatMap((l) => layerItems(ctx, l)).filter((el) => el.classList.contains("lim-html"));
  return all.filter((el) => (item.name !== "" ? el.dataset.name === item.name : el.dataset.html === item.html && el.dataset.name === undefined));
}

async function showHtml(ctx: RenderContext, a: Args, wait: boolean): Promise<Value | void> {
  const item = H.htmlItem(a, typeof a.html === "string" ? a.html : "");
  for (const old of sameItems(ctx, item)) old.remove();
  const el = buildHtml(ctx, item);
  imageLayer(ctx, typeof a.layer === "string" ? a.layer : "fg2").append(el);
  const shown = fadeIn(ctx, el, num(a.time));
  const jumps = [...el.querySelectorAll<HTMLElement>("[data-jump]")];
  if (!wait) return;
  await shown;
  if (jumps.length === 0) return;
  // 押して飛ぶ要素を押せるようにし、押したものの飛び先を返す（命令の側が飛ぶ）
  el.dataset.waiting = "";
  return new Promise<Value>((resolve) => {
    const handles = jumps.map((j) =>
      ui.button(j, {
        onPress: () => {
          for (const h of handles) h.dispose();
          delete el.dataset.waiting;
          resolve(j.dataset.jump ?? "");
        },
      }),
    );
  });
}

async function hideHtml(ctx: RenderContext, a: Args, wait: boolean): Promise<void> {
  const name = typeof a.name === "string" ? a.name : "";
  const els = ["fg0", "fg1", "fg2"].flatMap((l) => layerItems(ctx, l)).filter((el) => el.classList.contains("lim-html") && (name === "" || el.dataset.name === name));
  const done = fadeOutAndRemove(ctx, els, num(a.time));
  if (wait) await done;
}

export const renderers: Record<string, Renderer> = {
  html: (ctx, a, wait) => showHtml(ctx, a, wait),
  "html-hide": (ctx, a, wait) => hideHtml(ctx, a, wait),
};
