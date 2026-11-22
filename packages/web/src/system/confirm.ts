import { TEXT } from "./strings.ts";
import type { ScreenTemplates } from "./template.ts";
import { swallow } from "./ui.ts";

let messageId = 0;

/**
 * はい／いいえの確認を、画面の型（標準か、作品が写して直した ui.templates.confirm）から作る。返す el を画面に置くと、答えが出たら自分で外れる。
 * close() で外から閉じる（答えは false。Esc、右クリック、パッドの B はシステム側がこれを呼ぶ）。
 * 型に role の dialog と alertdialog が無ければ、いちばん外の要素を alertdialog にする。尋ねる文（data-field="message"）を説明（aria-describedby）にする。
 */
export function confirmScreen(templates: ScreenTemplates, message: string, kind: string): { el: HTMLElement; answer: Promise<boolean>; close(): void } {
  let settle: (ok: boolean) => void = () => undefined;
  const answer = new Promise<boolean>((resolve) => (settle = resolve));
  let done = false;
  const finish = (ok: boolean) => {
    if (done) return;
    done = true;
    view.dispose();
    view.el.remove();
    settle(ok);
  };
  // 作品の画面の JS（ui/screens/confirm/confirm.js）があれば、要素と api を渡す（api.result(true) が「はい」）
  const view = templates.screen("confirm", {
    fields: { message, yes: TEXT.confirm.yes, no: TEXT.confirm.no, kind },
    roles: { ok: () => finish(true), cancel: () => finish(false), close: () => finish(false) },
    result: (value) => finish(value === true),
  });
  const root = view.el;
  if (!root.matches("[role=dialog], [role=alertdialog]") && !root.querySelector("[role=dialog], [role=alertdialog]")) root.setAttribute("role", "alertdialog");
  // 尋ねる文を説明にする（名前は見出しから。見出しの無い型は尋ねる文を名前にする。名前の無いダイアログにしない）
  const dialog = root.matches("[role=dialog], [role=alertdialog]") ? root : root.querySelector<HTMLElement>("[role=dialog], [role=alertdialog]")!;
  const text = root.querySelector<HTMLElement>('[data-field="message"]');
  if (text) {
    text.id ||= `lm-confirm-message-${++messageId}`;
    if (!dialog.hasAttribute("aria-describedby")) dialog.setAttribute("aria-describedby", text.id);
    if (!root.querySelector(".lm-screen-title, h1, h2") && !dialog.hasAttribute("aria-label") && !dialog.hasAttribute("aria-labelledby")) dialog.setAttribute("aria-labelledby", text.id);
  }
  swallow(root);
  const first = view.autofocus;
  if (first) requestAnimationFrame(() => first.focus({ preventScroll: true }));
  return { el: root, answer, close: () => finish(false) };
}
