import { CONFIRM_TEMPLATE } from "./screens/confirm.ts";
import { ScreenTemplates } from "./template.ts";
import { showChoices } from "./choice-view.ts";
import { createEnding } from "./ending.ts";
import { createHelp } from "./help.ts";
import { menuPanel } from "./menu-panel.ts";
import { createSaveLoad } from "./saveload.ts";
import { createBacklogView } from "./backlog-view.ts";
import { createTitle } from "./title-view.ts";
import { createConfig } from "./config.ts";

/**
 * 標準の画面の型の置き場（標準に作品の ui.templates を重ねたもの。システム画面と選択肢の層が同じものを使う）と、
 * 型から画面を作る部品の読み込み（docs/design/screen-templates.md の「標準のテンプレートをいつ読むか」）。
 *
 * 書き出したエンジンでは、メニュー、結末の名前、操作説明、選択肢、セーブとロード、履歴、タイトル画面、コンフィグの型（lazy-screens.ts）は、遊び始める前に読む束に入れず、
 * どれかを初めて開くときに読む（engine/lazy-screens-<鍵>.js）。型から画面を作るコードは始めに読む束に置く（分けると、束ごとに縮めるので、
 * すべての大きさが増える）。型を読み終えるまでは、その画面を作らない（lazyScreensNow が null）。確認の画面は、すぐに出す必要があり（読み込みに失敗したとき、通信が切れたとき、
 * アップデートを尋ねるときにも出す）、小さいので、始めに読む束に置く。
 * 開発サーバーは始めに読んでおく（台本を書き替えては開くので、待たせない）。スマホ版の制作画面も始めに読む（loadScreenTemplates を呼ぶ）。
 */

/** 型から画面を作るコード（始めに読む束に置き、型を読み終えてから使う）。 */
const VIEWS = { menuPanel, createHelp, createEnding, showChoices, createSaveLoad, createBacklogView, createTitle, createConfig };
export type LazyScreens = typeof VIEWS;

/** 型の置き場（初めは確認の画面だけ。部品を読んだら残りの標準の型を足す）。 */
export const screenTemplates = new ScreenTemplates({ confirm: CONFIRM_TEMPLATE });

let loaded: LazyScreens | null = null;
let loading: Promise<LazyScreens> | null = null;

/** 型から画面を作る部品（読み終えていなければ null）。 */
export function lazyScreensNow(): LazyScreens | null {
  return loaded;
}

/** 型から画面を作る部品を読む（一度だけ。読めなければ、次に呼んだときに読み直す）。 */
export function loadScreenTemplates(): Promise<LazyScreens> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= import("./lazy-screens.ts").then(
    (m) => {
      screenTemplates.addStandard(m.STANDARD_TEMPLATES);
      loaded = VIEWS;
      return VIEWS;
    },
    (e: unknown) => {
      loading = null;
      throw e;
    },
  );
  return loading;
}

// 開発サーバー（と制作画面の見本）は始めに読んでおく（import.meta.env.DEV は書き出しでも真になることがあるので、main.ts と同じく hot で見る）
if (import.meta.hot) void loadScreenTemplates().catch((e: unknown) => console.warn("標準の画面の型を読み込めません", e));
