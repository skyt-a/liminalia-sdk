import type { ScreenTemplates } from "./template.ts";

/** タイトル画面の項目の働き（null は今は使えない項目で、型に書いてあっても外す）。 */
export type TitleRoles = Record<"start" | "load" | "extra" | "flowchart" | "config" | "help" | "exit", (() => void) | null>;

export interface TitleOptions {
  /** 作品の題（遊んでいる言語の訳）。 */
  name: string;
  /** ロゴの絵の URL（ui.title.logo。無ければ空）。 */
  logo: string;
  /** 題を文字で出すか（ui.title.showName が false なら出さない。ロゴがあれば出さない）。 */
  showName: boolean;
  roles: TitleRoles;
  /** 「つづきから」を押せるか（セーブがあるか）。 */
  canLoad: boolean;
}

/**
 * 標準のタイトル画面（題名かロゴと、ボタンの並び）を、型（標準か、作品が写して直した ui.templates.title。screens/title.ts）から作る。
 * 並びと出す項目は型に書いた順と項目。書いた項目でも今は使えないもの（roles が null）は外す。開いたときはどこも選ばない。
 * 作品の画面の JS（ui/screens/title/title.js）があれば呼ぶ。タイトルを外すとき（作り直すときも）に dispose を呼ぶ。
 */
export function createTitle(templates: ScreenTemplates, o: TitleOptions): { el: HTMLElement; dispose(): void } {
  const view = templates.screen("title", {
    fields: { name: o.name, logo: o.logo },
    show: { heading: !o.logo && o.showName },
    roles: o.roles,
    disabled: { load: !o.canLoad },
  });
  return { el: view.el, dispose: view.dispose };
}
