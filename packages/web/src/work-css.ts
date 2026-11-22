import { workCss } from "virtual:liminalia/work-css";

/**
 * 作品の CSS（liminalia.json の ui.css）を当てる。開発サーバーと書き出しが virtual:liminalia/work-css として、url() を解いた中身を渡す
 * （書き出しでは素材も束に入る。packages/web/vite.config.ts の workCssModule）。
 *
 * - テーマとプラグインの CSS のあとに効くよう、<head> の終わりに <style> を置き、あとから足された <style> と <link>
 *   （プラグインが setup で足したもの、あとから読んだ束の CSS）があれば、作品の CSS をまた終わりへ移す
 * - 開発サーバーでは、ファイルを保存したとき、ui.css を書き換えたときに、読み込み直さずに中身を差し替える（liminalia:work-css）
 * - 制作画面のゲームの画面のタブの、保存する前の CSS の行（setWorkCssDraft）は、作品の CSS のさらにあとに置く
 * - CSS の欄で保存する前のファイルの中身（setWorkCssFileDraft）は、そのファイルの中身の代わりに当てる（まだ ui.css に無いファイルは終わりに足す）
 */

/** 開発サーバーが作品の CSS を差し替えたときのイベント（detail は workCss と同じ形）。 */
export const WORK_CSS_EVENT = "liminalia:work-css";

let files: readonly { file: string; css: string }[] = workCss;
let draftText = "";
/** CSS の欄で保存する前のファイルの中身（無ければ null）。 */
let fileDraft: { file: string; css: string } | null = null;
const styles: HTMLStyleElement[] = [];
let draftStyle: HTMLStyleElement | null = null;
let installed = false;

/** 置いている <style>（作品の CSS の順に、終わりに保存する前の行）。 */
const ours = (): HTMLStyleElement[] => [...styles, ...(draftStyle ? [draftStyle] : [])];

function render(): void {
  const shown = fileDraft ? (files.some((f) => f.file === fileDraft!.file) ? files.map((f) => (f.file === fileDraft!.file ? fileDraft! : f)) : [...files, fileDraft]) : files;
  while (styles.length > shown.length) styles.pop()!.remove();
  shown.forEach((f, i) => {
    let el = styles[i];
    if (!el) {
      el = document.createElement("style");
      styles.push(el);
    }
    el.dataset.lmWorkCss = f.file;
    if (el.textContent !== f.css) el.textContent = f.css;
  });
  if (draftText !== "" && !draftStyle) {
    draftStyle = document.createElement("style");
    draftStyle.dataset.lmWorkCss = "draft";
  }
  if (draftStyle) draftStyle.textContent = draftText;
  toEnd();
}

/** 作品の CSS を <head> の終わりへ（もう終わりにあれば動かさない）。 */
function toEnd(): void {
  const list = ours();
  if (list.length === 0) return;
  const tail = [...document.head.children].slice(-list.length);
  if (tail.length === list.length && list.every((el, i) => tail[i] === el)) return;
  document.head.append(...list);
}

/** 作品の CSS を当てる（プラグインの setup のあとに一度呼ぶ）。 */
export function installWorkCss(): void {
  if (installed) return;
  installed = true;
  render();
  // あとから足された CSS より後に置き直す（自分で動かした分は数えない）
  new MutationObserver((records) => {
    const mine = new Set<Node>(ours());
    if (records.some((r) => [...r.addedNodes].some((n) => !mine.has(n) && (n instanceof HTMLStyleElement || n instanceof HTMLLinkElement)))) toEnd();
  }).observe(document.head, { childList: true });
  window.addEventListener(WORK_CSS_EVENT, (e) => {
    files = (e as CustomEvent<{ file: string; css: string }[]>).detail;
    render();
  });
}

/** CSS の欄で保存する前のファイルの中身（制作画面のゲームの画面のタブ。null なら外す）。 */
export function setWorkCssFileDraft(draft: { file: string; css: string } | null): void {
  fileDraft = draft;
  if (installed) render();
}

/** 保存する前の CSS の行（制作画面のゲームの画面のタブ。空なら外す）。 */
export function setWorkCssDraft(text: string): void {
  draftText = text;
  if (installed) render();
}
