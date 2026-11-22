/** 読み込み中か読み終えた外部のスクリプト（URL → 読み終わり）。 */
const scripts = new Map<string, Promise<void>>();

/**
 * 外部のスクリプト（作者が自分で入手して素材に置いたランタイム。Live2D の Cubism Core、Spine のランタイムなど）を、
 * 文書に <script> を足して一度だけ読む。同じ URL は二度読まない。読めなければ（無い、CSP で止められた）失敗し、次に呼べば読み直す。
 * 書き出したゲームの CSP はゲームと同じ場所のスクリプトだけを許すので、素材（asset("others", …)）の URL を渡す。
 */
export function loadScript(url: string): Promise<void> {
  let loading = scripts.get(url);
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = url;
    el.async = true;
    el.addEventListener("load", () => resolve());
    el.addEventListener("error", () => {
      el.remove();
      scripts.delete(url);
      reject(new Error(`スクリプトを読み込めません: ${url}`));
    });
    document.head.append(el);
  });
  scripts.set(url, loading);
  return loading;
}
