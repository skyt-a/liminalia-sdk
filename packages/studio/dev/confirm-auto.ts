import type { BrowserContext, Page } from "playwright-core";

/**
 * 確かめの道具が、制作画面の確認のダイアログ（client/confirm-dialog.ts の askConfirm）に答える。
 * ブラウザ標準の confirm() と違って Playwright の "dialog" の知らせが来ないので、ダイアログが出たら decide に文を渡し、
 * true なら「はい」、false なら「キャンセル」を押す。page か context に一度呼ぶ（読み込み直しても効く）。
 */
export async function autoConfirm(target: Page | BrowserContext, decide: (message: string) => boolean | Promise<boolean>): Promise<void> {
  await target.exposeBinding("__studioConfirmAnswer", async (_source, message: string) => decide(message));
  await target.addInitScript(() => {
    const seen = new WeakSet<Element>();
    new MutationObserver(() => {
      for (const d of document.querySelectorAll("dialog.confirm-dialog")) {
        if (seen.has(d)) continue;
        seen.add(d);
        const text = d.querySelector(".confirm-dialog-text")?.textContent ?? "";
        void (window as unknown as { __studioConfirmAnswer(m: string): Promise<boolean> }).__studioConfirmAnswer(text).then((yes) => {
          d.querySelector<HTMLButtonElement>(yes ? "footer .primary" : "footer .ghost")?.click();
        });
      }
    }).observe(document, { childList: true, subtree: true });
  });
}
