// 開発サーバー・書き出しが作る仮想モジュール（packages/web/vite.config.ts の projectModule）。
declare module "virtual:liminalia/project" {
  export const project: import("@liminalia/web").PlayerProject;
  export const commandPlugins: import("@liminalia/plugin-host").CommandPlugin[];
  export const webPlugins: import("@liminalia/web").WebPlugin[];
}

// 作品の CSS（liminalia.json の ui.css。packages/web/vite.config.ts の workCssModule）。file は作品のフォルダからのパス、css は url() を解いた中身
declare module "virtual:liminalia/work-css" {
  export const workCss: { file: string; css: string }[];
}

// 作品の画面の JS（packages/web/screen-scripts-module.ts）。画面の名前 → モジュールの default
declare module "virtual:liminalia/screen-scripts" {
  export const screenScripts: Record<string, unknown>;
}
