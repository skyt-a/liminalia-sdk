import { screenScripts } from "virtual:liminalia/screen-scripts";
import { setScreenScripts } from "./system/screen-script.ts";

/**
 * 作品の画面の JS（virtual:liminalia/screen-scripts。packages/web/screen-scripts-module.ts）を、画面の置き場（system/screen-script.ts）に渡す。
 * 開発サーバーで保存したら、仮想モジュールが送る出来事で入れ替える（次に開いた画面から効く）。
 */
export function installScreenScripts(): void {
  setScreenScripts(screenScripts);
  window.addEventListener("liminalia:screen-scripts", (e) => setScreenScripts((e as CustomEvent<Record<string, unknown>>).detail ?? {}));
}
