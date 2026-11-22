import { SYSTEM_ACTIONS, type ScreenAction } from "../plugin.ts";
import { menuAllows, menuLabel, type MenuAction, type MenuContext, type MenuEntry } from "./menu.ts";
import type { ScreenTemplates } from "./template.ts";

const ACTION_NAMES: ReadonlySet<string> = new Set(SYSTEM_ACTIONS);

/**
 * 右クリック、Esc で開くメニューを、型（標準か、作品が写して直した ui.templates.menu）から作る。押したらメニューは閉じ、その操作をする（close はただ閉じる）。
 * 並びと出す項目は型に書いた順と項目。書いた操作でも今は使えないもの（menuAllows）は外す。screens は並べる作品の画面（defineScreen の menu）。
 * 項目には data-action（操作の名前）を書く（前からの CSS と、項目を探すテスト）。作品の画面の JS（ui/screens/menu/menu.js）があれば呼ぶ。閉じるときに dispose を呼ぶ。
 */
export function menuPanel(templates: ScreenTemplates, o: MenuContext & { auto: boolean; skip: boolean; screens?: { action: ScreenAction; label: string }[]; run(a: MenuEntry): void; close(): void }): { el: HTMLElement; dispose(): void } {
  const roles: Record<string, (() => void) | null> = { close: o.close };
  for (const action of SYSTEM_ACTIONS) roles[action] = menuAllows(action, o) ? () => o.run(action) : null;
  const view = templates.screen("menu", {
    fields: { auto: String(o.auto), skip: String(o.skip) },
    roles,
    lists: { screens: (o.screens ?? []).map((s) => ({ fields: { label: s.label }, roles: { open: () => o.run(s.action) } })) },
  });
  const root = view.el;
  for (const b of root.querySelectorAll<HTMLElement>("[data-role]")) {
    const action = b.dataset.role as MenuAction;
    if (!ACTION_NAMES.has(action)) continue;
    b.dataset.action = action;
    // 中身の空の項目には、その操作の標準の文言を入れる
    if (!b.hasChildNodes()) b.textContent = menuLabel(action);
  }
  (o.screens ?? []).forEach((s, i) => {
    const row = view.items("screens")[i];
    if (row) (row.matches("[data-role]") ? row : (row.querySelector<HTMLElement>("[data-role]") ?? row)).dataset.action = s.action;
  });
  // 枠の外（いちばん外の要素そのもの）を押したら閉じる
  root.addEventListener("click", (e) => {
    if (e.target === root) o.close();
  });
  const first = view.autofocus;
  if (first) requestAnimationFrame(() => first.focus({ preventScroll: true }));
  return { el: root, dispose: view.dispose };
}
