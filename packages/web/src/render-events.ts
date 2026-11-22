import type { StageState } from "@liminalia/runtime";

/**
 * 描画側の出来事（RenderContext.on）。作品の演出が、名前の欄や立ち絵の層を MutationObserver で見張らずに、
 * ページ・話者・立ち絵・ロードの変化に合わせるためのもの。
 * - page: ページを出し始めた（本文を消した直後。speaker は話者、地の文は null。label は名前の欄に出す名前）
 * - speaker: 話者が前のページと変わった（地の文になったときも。previous は前の話者）
 * - sprites: 出ている立ち絵（stage.sprites の人物・立ち絵セット・差分）が変わった。立ち絵の要素を触るなら ctx.spriteReady(人物) を待つ
 * - restore: 状態から画面を組み立て直した（ロード・巻き戻し・制作画面の舞台。restorers を呼び終えたあと）
 * - load-end: システムのロード（スロット・履歴・前の選択肢・章・フローチャート）が済み、組み立て直した（from は load-start と同じ）
 * - screen-close: システムの画面（標準の画面・作品の画面）が閉じた。menu-close はそのうちメニュー（右クリック・Esc）が閉じたとき
 */
export type RenderEvent =
  | { type: "page"; at: { file: string; line: number }; speaker: string | null; label: string | null }
  | { type: "speaker"; speaker: string | null; previous: string | null }
  | { type: "sprites"; sprites: StageState["sprites"]; stage: StageState }
  | { type: "restore"; stage: StageState }
  | { type: "load-end"; from: "slot" | "backlog" | "choice" | "flowchart" | "chapter" }
  | { type: "screen-close"; name: string }
  | { type: "menu-close" };

export type RenderEventType = RenderEvent["type"];
export type RenderEventOf<T extends RenderEventType> = Extract<RenderEvent, { type: T }>;

/** 出来事の受け手の表。 */
export class RenderEvents {
  private readonly listeners = new Map<RenderEventType, Set<(e: RenderEvent) => void>>();

  on<T extends RenderEventType>(type: T, listener: (e: RenderEventOf<T>) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const l = listener as (e: RenderEvent) => void;
    set.add(l);
    return () => void set.delete(l);
  }

  emit(event: RenderEvent): void {
    for (const l of [...(this.listeners.get(event.type) ?? [])]) {
      try {
        l(event);
      } catch (e) {
        console.warn(`描画の出来事 ${event.type} の受け手が失敗しました`, e);
      }
    }
  }
}
