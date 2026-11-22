import { autoSlotIds, isAutoSlot, isQuickSlot, quickSlotIds, type SlotId, type SlotRecord, type Storage } from "./storage.ts";
import { formatDate, TEXT } from "./strings.ts";
import type { ScreenTemplates, TemplateItem } from "./template.ts";

/** スロットの並び。1 ページ PAGE_SIZE 枠 × ページ。既定は PAGE_COUNT ページ（liminalia.json の ui.saveSlots で替えられる）。 */
export const PAGE_SIZE = 8;
export const PAGE_COUNT = 6;
export const SLOT_COUNT = PAGE_SIZE * PAGE_COUNT;

/** スロットの名前（確認の文などに出す）。 */
export function slotName(slot: SlotId): string {
  if (isAutoSlot(slot)) return TEXT.saveload.autoName;
  if (slot === "quick") return TEXT.saveload.quickName;
  if (isQuickSlot(slot)) return TEXT.saveload.quickSlot(Number(slot.slice(6)) + 1);
  return TEXT.saveload.slot(slot + 1);
}

/** ページ（ロードではクイックセーブとオートセーブのページもある）。 */
type Page = "quick" | "auto" | number;

export interface SaveLoadOptions {
  mode: "save" | "load";
  storage: Storage;
  /** セーブ: そのスロットに書き込む。書けたら true。 */
  save(slot: number): boolean;
  /** ロード: そのスロットから再開する（画面は呼び出し側が閉じる）。 */
  load(slot: SlotId): void;
  /** ロードの前に確かめるか（ゲーム中は今の進行が失われるので確かめる）。 */
  confirmLoad: boolean;
  /** スロットの数（PAGE_SIZE の倍数。既定 SLOT_COUNT）。 */
  slots?: number;
  /** オートセーブの枠の数（ロードでだけページを出す。0 なら出さない）。 */
  autoSlots?: number;
  /** クイックセーブの枠の数（ロードの「Q」のページに新しい順に並べる。既定 1）。 */
  quickSlots?: number;
  ask(message: string, kind?: string): Promise<boolean>;
  notify(message: string): void;
  close(): void;
}

/**
 * セーブ／ロード画面を、型（標準か、作品が写して直した ui.templates.saveload。screens/saveload.ts）から作る。
 * ページの切り替え（ロードではクイックセーブとオートセーブのページもある）と、縮小画像、日時、本文の頭、メモを出したスロット。使用中のスロットへのセーブとロードは確かめてから行う。
 * 使っている番号つきのスロットには、メモ、保護、コピー、移動、削除のボタンを付ける。保護したスロットは上書き、削除、移動先にできない。
 * コピーと移動は、押したあとに写し先のスロットを選ぶ（ほかのページへも移れる。やめるで戻る）。
 * ページを替えたり書いたりしたら、タブ、知らせ、スロットの一覧を作り直す（view.list。一覧の中のフォーカスは同じ番目の一行に残る）。
 * 作品の画面の JS（ui/screens/saveload/saveload.js）があれば呼ぶ。閉じるときに dispose を呼ぶ。
 */
export function createSaveLoad(templates: ScreenTemplates, o: SaveLoadOptions): { el: HTMLElement; dispose(): void } {
  const isSave = o.mode === "save";
  const T = TEXT.saveload;

  // ページ: ロードでは "auto"（オートセーブ）と "quick" が先頭
  const slotCount = o.slots ?? SLOT_COUNT;
  const autoCount = isSave ? 0 : (o.autoSlots ?? 0);
  const quickCount = Math.max(1, o.quickSlots ?? 1);
  const pages: Page[] = [...(autoCount > 0 ? ["auto" as const] : []), ...(isSave ? [] : ["quick" as const]), ...Array.from({ length: Math.ceil(slotCount / PAGE_SIZE) }, (_, i) => i)];
  let page: Page = initialPage();
  let busy = false;
  /** コピー、移動の写し先を選んでいるところ。 */
  let picking: { from: number; move: boolean } | null = null;

  function initialPage(): Page {
    const slot = isSave ? o.storage.lastSlot() : o.storage.latestSlot(slotCount, autoCount, quickCount);
    if (slot !== null && isQuickSlot(slot)) return "quick";
    if (slot !== null && isAutoSlot(slot)) return "auto";
    return slot !== null && slot < slotCount ? Math.floor(slot / PAGE_SIZE) : 0;
  }

  /** オートセーブとクイックセーブの枠（新しい順。空の枠は後ろ）。 */
  function newestFirst(ids: SlotId[]): SlotId[] {
    const time = (id: SlotId) => {
      const r = o.storage.loadSlot(id);
      return r ? Date.parse(r.date) || 0 : -Infinity;
    };
    return ids.sort((a, b) => time(b) - time(a));
  }

  const tabs = (): TemplateItem[] =>
    pages.map((p) => ({
      fields: { label: p === "quick" ? T.quickTab : p === "auto" ? T.autoTab : T.page(p + 1), current: String(p === page), spoken: p === "auto" ? T.autoName : undefined },
      roles: {
        page: () => {
          page = p;
          render();
        },
      },
      state: { current: p === page },
    }));

  const banner = (): TemplateItem[] =>
    picking
      ? [
          {
            fields: { message: picking.move ? T.pickMove(slotName(picking.from)) : T.pickCopy(slotName(picking.from)) },
            roles: {
              cancel: () => {
                picking = null;
                render();
              },
            },
          },
        ]
      : [];

  const slots = (): SlotId[] => (page === "quick" ? newestFirst(quickSlotIds(quickCount)) : page === "auto" ? newestFirst(autoSlotIds(autoCount)) : Array.from({ length: PAGE_SIZE }, (_, i) => (page as number) * PAGE_SIZE + i));

  /** スロットの一行の値と働き。 */
  function card(slot: SlotId): TemplateItem {
    const record = o.storage.loadSlot(slot);
    const numbered = typeof slot === "number";
    const locked = !!record?.locked;
    const tool = (run: () => void | Promise<void>) => () => {
      if (!busy) void run();
    };
    return {
      fields: {
        name: slotName(slot),
        date: record ? formatDate(record.date) : "",
        chapter: record?.chapter ?? "",
        time: record?.playTime !== undefined ? T.playTime(record.playTime) : "",
        text: record ? record.title || T.noText : T.empty,
        memo: record?.memo ?? "",
        thumb: record?.thumb ?? "",
        protect: locked ? T.unlock : T.lock,
      },
      // 章の名前とプレイ時間（前の版のセーブには無い）
      show: { sub: !!record && (!!record.chapter || record.playTime !== undefined), locked, tools: !!record && !picking },
      roles: {
        pick: () => void (picking ? place(slot as number, record) : choose(slot, record)),
        memo: numbered ? tool(() => editMemo(slot, record!)) : null,
        protect: numbered
          ? tool(() => {
              o.storage.updateSlot(slot, { locked: !locked });
              render();
            })
          : null,
        copy: numbered
          ? tool(() => {
              picking = { from: slot, move: false };
              render();
            })
          : null,
        move: numbered
          ? tool(() => {
              picking = { from: slot, move: true };
              render();
            })
          : null,
        delete: tool(async () => {
          busy = true;
          const ok = await o.ask(TEXT.confirm.delete(slotName(slot)), "delete");
          busy = false;
          if (!ok) return;
          o.storage.deleteSlot(slot);
          o.notify(TEXT.toast.deleted);
          render();
        }),
      },
      // 写し先を選んでいる間は、写し元と保護したスロットのほかはどれでも押せる（空きにも写せる）
      disabled: { pick: picking ? !numbered || slot === picking.from || locked : !isSave && !record, delete: locked },
      state: { empty: !record, protected: locked, source: !!picking && picking.from === slot },
    };
  }

  const view = templates.screen("saveload", {
    fields: { heading: isSave ? T.save : T.load },
    roles: { close: o.close },
    lists: { pages: tabs(), banner: banner(), slots: slots().map(card) },
  });
  const root = view.el;
  root.classList.add(`lm-${o.mode}`);
  let ids = slots();
  mark();

  /** 前からの CSS のためのクラス（押す要素に lm-empty、is-locked、is-source）。 */
  function mark(): void {
    view.items("slots").forEach((row, i) => {
      const record = o.storage.loadSlot(ids[i]!);
      const b = row.matches("[data-role=pick]") ? row : row.querySelector<HTMLElement>("[data-role=pick]");
      if (!b) return;
      b.classList.toggle("lm-empty", !record);
      b.classList.toggle("is-locked", !!record?.locked);
      b.classList.toggle("is-source", !!picking && picking.from === ids[i]);
    });
  }

  function render(): void {
    ids = slots();
    view.list("pages", tabs());
    view.list("banner", banner());
    view.list("slots", ids.map(card));
    mark();
  }

  /** メモを書く（ボタンの並びの場所に出す入力欄。Enter で決め、Esc でやめる）。 */
  function editMemo(slot: number, record: SlotRecord): void {
    const row = view.items("slots")[ids.indexOf(slot)];
    if (!row) return;
    const made = templates.render("saveload", "memo", { fields: { memo: record.memo ?? "", placeholder: T.memoPlaceholder, label: T.memo } }).el;
    const input = made instanceof HTMLInputElement ? made : made.querySelector("input");
    if (!input) return;
    // 入力欄のキーとクリックは、スロットを押したことにも画面の操作にもしない
    for (const type of ["click", "pointerdown", "keydown", "keyup"]) input.addEventListener(type, (e) => e.stopPropagation());
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (save) o.storage.updateSlot(slot, { memo: input.value.trim() });
      render();
    };
    input.addEventListener("keydown", (e) => {
      // 決めたら一覧を作り直してフォーカスをその一行のスロットへ移すので、同じ Enter でスロットを押さないように既定の動きを止める
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        finish(true);
      }
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    (row.querySelector("[data-if=tools]") ?? row.querySelector("[data-role=memo]"))?.replaceWith(made);
    input.focus();
  }

  /** コピー、移動の写し先を押した。使っているスロットなら上書きを確かめる。 */
  async function place(to: number, record: SlotRecord | null): Promise<void> {
    if (!picking || busy) return;
    const { from, move } = picking;
    busy = true;
    try {
      if (record && !(await o.ask(TEXT.confirm.overwrite(slotName(to)), "overwrite"))) return;
      const r = o.storage.copySlot(from, to, move);
      o.notify(r === "ok" ? (move ? TEXT.toast.moved : TEXT.toast.copied) : r === "locked" ? TEXT.toast.lockedSlot : TEXT.toast.saveFailed);
      picking = null;
      render();
    } finally {
      busy = false;
    }
  }

  async function choose(slot: SlotId, record: SlotRecord | null): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (isSave) {
        if (typeof slot !== "number") return;
        if (record?.locked) {
          o.notify(TEXT.toast.lockedSlot);
          return;
        }
        if (record && !(await o.ask(TEXT.confirm.overwrite(slotName(slot)), "overwrite"))) return;
        o.notify(o.save(slot) ? TEXT.toast.saved : TEXT.toast.saveFailed);
        render();
        return;
      }
      if (!record) return;
      if (o.confirmLoad && !(await o.ask(TEXT.confirm.load(slotName(slot)), "load"))) return;
      o.load(slot);
    } finally {
      busy = false;
    }
  }

  return { el: root, dispose: view.dispose };
}
