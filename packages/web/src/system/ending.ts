import type { EndingScreenApi } from "../plugin.ts";
import type { ScreenTemplates } from "./template.ts";

/**
 * エンディングの名前（@title-screen ending=）を、型（標準か、作品が写して直した ui.templates.ending）から作る。暗転した上に名前と終わりの表記を浮かべ、
 * どこを押しても（Enter、Space、パッドの A も）タイトルへ進む。色と書体はテーマ（--lm-title-bg、--lm-fg、--lm-accent、--lm-text-font）から取り、
 * 作品の CSS で .lm-ending を上書きできる。
 * 名前（.lm-ending-name）は title= か、無ければ種類の文言（BAD END など）。title= があれば、種類の文言を名前の上に小さく添える（.lm-ending-kind）。
 * 種類は .lm-ending の data-kind（bad など）にも書く（種類ごとに見た目を変えるなら .lm-ending[data-kind="bad"]）。
 * 作品の画面の JS（ui/screens/ending/ending.js）があれば呼ぶ。閉じるときに dispose を呼ぶ。
 */
export function createEnding(templates: ScreenTemplates, api: EndingScreenApi): { el: HTMLElement; dispose(): void } {
  const kindLabel = api.title && api.label ? api.label : "";
  const view = templates.screen("ending", {
    fields: {
      name: api.name,
      kind: api.kind,
      "kind-label": kindLabel,
      mark: api.text,
      proceed: api.proceed,
      spoken: [kindLabel, api.name, api.text, api.proceed].filter(Boolean).join(" "),
    },
    roles: { proceed: () => api.close(), close: () => api.close() },
    // 画面の JS の api.result も進む（結果の値は使わない）
    result: () => api.close(),
  });
  const first = view.autofocus;
  if (first) requestAnimationFrame(() => first.focus({ preventScroll: true }));
  return { el: view.el, dispose: view.dispose };
}
