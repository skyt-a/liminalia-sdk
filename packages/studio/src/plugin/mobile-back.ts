/**
 * スマホ版で、戻る操作（Android の戻るボタンとジェスチャー、iOS の端から引く操作）で欄を閉じる。
 * 欄を開くときに履歴を一つ積み、戻ると一番上の欄を閉じる。画面のボタンで閉じたときは積んだ分を戻す（その戻りでは何も閉じない）。
 * 積まないと、戻る操作でアプリそのものが閉じたり入口へ戻ったりする。
 */
interface Entry {
  id: number;
  close: () => void;
}

const stack: Entry[] = [];
let seq = 0;
/** 自分で戻した回数（その分の popstate では閉じない）。 */
let ignoring = 0;
/** 戻している途中に開いた欄（戻り終えてから履歴を積む。先に積むと、戻る先がずれる）。 */
const waiting: Entry[] = [];
let listening = false;

const push = (entry: Entry) => history.pushState({ ...(history.state as object | null), liminaliaBack: entry.id }, "");

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("popstate", () => {
    if (ignoring > 0) {
      ignoring--;
      if (ignoring === 0) for (const e of waiting.splice(0)) push(e);
      return;
    }
    stack.pop()?.close();
  });
}

/**
 * 欄を開いた。戻る操作で close を呼ぶ。返す関数は画面のボタンで閉じたときに呼ぶ（積んだ履歴を戻す。二度呼んでもよい）。
 */
export function closeOnBack(close: () => void): () => void {
  listen();
  const entry: Entry = { id: ++seq, close };
  stack.push(entry);
  if (ignoring > 0) waiting.push(entry);
  else push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i < 0) return;
    // 上に積まれたもの（この欄から開いた欄）も一緒に外す。まだ履歴を積んでいないものは戻さない
    const removed = stack.splice(i);
    const steps = removed.filter((e) => {
      const w = waiting.indexOf(e);
      if (w < 0) return true;
      waiting.splice(w, 1);
      return false;
    }).length;
    if (steps === 0) return;
    ignoring++;
    history.go(-steps);
  };
}

/**
 * スマホ版（html.is-mobile）のときだけ closeOnBack と同じにする。ほかでは履歴を積まず、何もしない関数を返す。
 * メニュー、確かめのダイアログ、⌘K の窓、合わせ直しの欄、パーツの欄のように、どの画面からも開くものに使う。
 */
export function closeOnBackIfMobile(close: () => void): () => void {
  return typeof document !== "undefined" && document.documentElement.classList.contains("is-mobile") ? closeOnBack(close) : () => undefined;
}

/** 積んでいる欄の数（試験用）。 */
export function backDepth(): number {
  return stack.length;
}
