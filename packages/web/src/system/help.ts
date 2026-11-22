import type { UiHelpPage } from "@liminalia/lang";
import type { AssetKind } from "../dom-host.ts";
import { TEXT } from "./strings.ts";
import type { ScreenTemplates, TemplateItem } from "./template.ts";

/** 操作の表の一行（どれも見せる文字。無い操作は ""）。 */
export interface HelpRow {
  label: string;
  keyboard: string;
  touch: string;
  pad: string;
}

export interface HelpOptions {
  rows: HelpRow[];
  /** 作品が足すページ（ui.help.pages）。 */
  pages: readonly UiHelpPage[];
  asset(kind: AssetKind, path: string): string;
  close(): void;
}

/**
 * 操作説明の画面を、型（標準か、作品が写して直した ui.templates.help）から作る。「操作」のタブは今の割り当て（遊ぶ人の割り当て、作品の ui.keys、
 * 既定、ゲームパッドの入れ替え）から作る表、ほかのタブは作品が足すページ（絵と文）。タブを押したら、本体の一覧（body）とタブの並びを作り直す。
 * 作品の画面の JS（ui/screens/help/help.js）があれば呼ぶ。閉じるときに dispose を呼ぶ。
 */
export function createHelp(templates: ScreenTemplates, o: HelpOptions): { el: HTMLElement; dispose(): void } {
  const bodies: TemplateItem[] = [
    { part: "controls", lists: { rows: o.rows.map((r) => ({ fields: { label: r.label, keyboard: r.keyboard || "—", touch: r.touch || "—", pad: r.pad || "—" } })) } },
    ...o.pages.map((page) => ({ part: "page", fields: { title: page.title, image: page.image ? o.asset("image", page.image) : "", text: page.text ?? "" } })),
  ];
  const labels = [TEXT.help.controls, ...o.pages.map((p) => p.title)];
  const tabs = (current: number): TemplateItem[] => labels.map((label, i) => ({ fields: { label, current: String(i === current) }, roles: { page: () => show(i) }, state: { current: i === current } }));
  const view = templates.screen("help", {
    show: { tabs: labels.length > 1 },
    roles: { close: o.close },
    lists: { tabs: tabs(0), body: [bodies[0]!] },
  });
  function show(i: number): void {
    view.list("tabs", tabs(i));
    view.list("body", [bodies[i]!]);
  }
  return { el: view.el, dispose: view.dispose };
}
