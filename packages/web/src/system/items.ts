import type { ItemsConfig } from "@liminalia/lang";
import type { AssetKind } from "../dom-host.ts";
import { TEXT } from "./strings.ts";
import { button, el, header, swallow } from "./ui.ts";

export interface ItemsScreenOptions {
  items: ItemsConfig;
  /** 持っている数（持ち物の名前 → 数）。 */
  held: Record<string, number>;
  asset(kind: AssetKind, path: string): string;
  /** 選ばせるとき（@item-select）の見出し。無ければ見るだけ。 */
  select?: { title?: string; pick(key: string): void };
  close(): void;
}

/**
 * 持ち物の画面。持っているものを定義の順に並べ、押したものの絵と説明を右に出す。
 * 選ばせるとき（@item-select）は「使う」で決める（閉じたら選ばなかったことになる）。
 */
export function createItems(o: ItemsScreenOptions): HTMLElement {
  const root = el("div", "lm-screen lm-items");
  swallow(root);
  const keys = Object.keys(o.items).filter((k) => (o.held[k] ?? 0) > 0);
  const grid = el("div", "lm-items-grid");
  const detail = el("div", "lm-items-detail");
  const buttons = new Map<string, HTMLButtonElement>();

  const picture = (key: string, cls: string) => {
    const box = el("span", cls);
    const image = o.items[key]?.image;
    if (image) {
      const img = el("img");
      img.src = o.asset("image", image);
      img.alt = "";
      box.append(img);
    }
    return box;
  };

  function show(key: string): void {
    for (const [k, b] of buttons) b.setAttribute("aria-pressed", String(k === key));
    const item = o.items[key]!;
    const count = o.held[key] ?? 0;
    detail.replaceChildren(
      picture(key, "lm-items-picture"),
      el("h3", "lm-items-name", item.name, count > 1 ? el("span", "lm-items-count", TEXT.items.count(count)) : ""),
      el("p", "lm-items-desc", item.description ?? ""),
      ...(o.select ? [button("lm-button lm-primary lm-items-use", TEXT.items.use, () => o.select!.pick(key))] : []),
    );
  }

  for (const key of keys) {
    const item = o.items[key]!;
    const count = o.held[key] ?? 0;
    const b = button("lm-items-tile", "", () => show(key));
    b.dataset.item = key;
    b.append(picture(key, "lm-items-thumb"), el("span", "lm-items-label", item.name, count > 1 ? el("span", "lm-items-count", TEXT.items.count(count)) : ""));
    if (o.select) b.addEventListener("dblclick", () => o.select!.pick(key));
    buttons.set(key, b);
    grid.append(b);
  }
  const body = keys.length === 0 ? el("p", "lm-items-empty", TEXT.items.empty) : el("div", "lm-items-body", grid, detail);
  root.append(header(o.select ? (o.select.title ?? TEXT.items.select) : TEXT.items.heading, o.close), body);
  if (keys[0]) {
    show(keys[0]);
    requestAnimationFrame(() => buttons.get(keys[0]!)?.focus({ preventScroll: true }));
  }
  return root;
}
