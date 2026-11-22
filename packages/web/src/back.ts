/**
 * 「戻る」（Android のアプリの戻るボタンとなぞり、スマホのブラウザの戻る。window.__liminalia.back）を、システム画面より先に受ける口。
 * 入力の枠（@text-input・@dialog）のように、システム画面の外で開くものが積む。新しく積んだものから試す。
 */
const handlers: (() => boolean)[] = [];

/** 戻るを受けるものを積む。返す関数で外す。 */
export function pushBackHandler(handler: () => boolean): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.lastIndexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** 積んだものの一番上に渡す（扱ったか。false ならシステム画面に渡す）。積んだものが無ければ null。 */
export function runBackHandler(): boolean | null {
  const top = handlers.at(-1);
  return top ? top() : null;
}

/**
 * ブラウザ版（スマホのブラウザと、ホーム画面に置いた PWA）の戻るを、ゲームの戻るに当てる。
 * 履歴に一つ積んでおき、戻られたら back() に渡す。扱ったら積み直し、扱わなければ（タイトルなど）そのまま前のページへ戻す。
 * Chrome は操作の無いうちに積んだ履歴を戻るで飛ばすので、押されたとき（click・keydown）に積む（積んであれば何もしない）。
 */
export function installHistoryBack(back: () => boolean, win: Window = window): void {
  const standalone = typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches;
  const nav = win.navigator;
  // iPadOS の Safari は Mac を名乗るので、タッチの点の数で見分ける
  const mobile = /Android|iPhone|iPad|iPod|Mobile/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
  if (!standalone && !mobile) return;
  const MARK = "liminalia-back";
  const armed = () => (win.history.state as { [MARK]?: boolean } | null)?.[MARK] === true;
  const arm = () => {
    if (!armed()) win.history.pushState({ ...(win.history.state ?? {}), [MARK]: true }, "");
  };
  win.addEventListener("click", arm, { capture: true });
  win.addEventListener("keydown", arm, { capture: true });
  win.addEventListener("popstate", () => {
    // 積んだものから戻った（今は積む前の位置）
    if (armed()) return;
    let handled = false;
    try {
      handled = back();
    } catch (e) {
      console.warn(e);
    }
    if (handled) arm();
    else win.history.back();
  });
}
