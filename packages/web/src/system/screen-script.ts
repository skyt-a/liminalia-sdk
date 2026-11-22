/**
 * 画面の JS（作品のフォルダの ui/screens/<画面>/<画面>.js。テンプレートと同じ場所の同じ名前の .js。docs/design/screen-templates.md の「画面の JS」）。
 * テンプレートから作った画面の要素と、画面の api を受け取る小さな口。属性の働き（キー、フォーカス、読み上げなど）はテンプレートの側でそのまま付く。
 *
 * 読むのは開発サーバーと書き出し（virtual:liminalia/screen-scripts。packages/web/screen-scripts-module.ts）で、作品のプラグインと同じ扱い
 * （--restricted と LIMINALIA_RESTRICTED=1 では読まない）。ここは読んだものの置き場と、呼ぶところだけを持つ（仮想モジュールを読まない）。
 */

/** 画面の JS が受け取る api（口の版 1）。口を足したら @liminalia/lang の SCREEN_SCRIPT_API と資料を一緒に直す。 */
export interface ScreenScriptApi {
  /** 口の版。 */
  readonly version: 1;
  /** 画面の名前（ui.templates の鍵。confirm など）。 */
  readonly screen: string;
  /** 画面の値（data-field に入る値。確認の画面は message、yes、no、kind）。 */
  readonly values: Readonly<Record<string, string | number | undefined>>;
  /** data-role の働きを呼ぶ（その画面で働く値。確認の画面は ok、cancel、close）。働きが無ければ false。 */
  press(role: string): boolean;
  /** 画面を閉じる（data-role の close、無ければ cancel、back と同じ）。 */
  close(): void;
  /** 画面の結果を返して閉じる（確認の画面は true が「はい」、ほかは「いいえ」）。 */
  result(value: unknown): void;
  /** その画面のテンプレートの部品を作る（属性の働きが付いた要素。値と働きと状態を渡せる）。画面に置くのは JS の側。 */
  render(part: string, item?: { fields?: Readonly<Record<string, string | number | undefined>>; roles?: Readonly<Record<string, () => void>>; state?: Readonly<Record<string, boolean | string | undefined>> }): HTMLElement;
  /** 標準の文言（strings.ts の TEXT の鍵。WebPlugin.texts で替えたもの、遊ぶ人の言語のもの）。無ければ undefined。 */
  text(key: string): string | undefined;
}

/** 画面の JS の形（export default）。閉じるときに片付けるものがあれば、関数を返す。 */
export type ScreenScript = (screen: HTMLElement, api: ScreenScriptApi) => void | (() => void);

let scripts: Readonly<Record<string, unknown>> = {};

/** 読んだ画面の JS を入れ替える（画面の名前 → モジュールの default）。開発サーバーで保存したときも呼ぶ（次に開いた画面から効く）。 */
export function setScreenScripts(next: Readonly<Record<string, unknown>>): void {
  scripts = next;
}

/** その画面の JS（無いか、関数でなければ undefined。関数でないものは開発サーバーのコンソールに出す）。 */
export function screenScriptOf(name: string): ScreenScript | undefined {
  const s = scripts[name];
  if (s === undefined) return undefined;
  if (typeof s !== "function") {
    // 文は開発サーバーだけ（書き出しでは画面の名前だけを出す。エンジンの束の大きさのため）
    console.warn(import.meta.hot ? `画面 ${name} の JS は export default に関数を書きます` : name);
    return undefined;
  }
  return s as ScreenScript;
}

/**
 * 画面の JS を呼ぶ。要素が文書に入ってから（作った直後の microtask で）呼ぶ。返した関数は、返す dispose を呼んだときに一度だけ呼ぶ。
 * 作者の JS の誤りは画面を止めない（コンソールに出して、テンプレートの画面のまま動く）。
 */
export function runScreenScript(name: string, el: HTMLElement, api: ScreenScriptApi): () => void {
  const script = screenScriptOf(name);
  if (!script) return () => undefined;
  let cleanup: (() => void) | undefined;
  let disposed = false;
  queueMicrotask(() => {
    if (disposed) return;
    try {
      const r = script(el, api);
      if (typeof r === "function") cleanup = r;
    } catch (e) {
      console.error(import.meta.hot ? `画面 ${name} の JS で誤りが起きました` : name, e);
    }
  });
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      cleanup?.();
    } catch (e) {
      console.error(import.meta.hot ? `画面 ${name} の JS の片付けで誤りが起きました` : name, e);
    }
  };
}
