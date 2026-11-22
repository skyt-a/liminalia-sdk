/**
 * 遊ぶ人の操作を待つ画面が知らせる、選べるものと選び方（RenderContext.offer）。
 * 録画（lim shot --video）は画面を出したまま、読む時間のあとに、選択肢と同じ選び方（--choose、避ける選択肢とエンディング、
 * 同じ画面に戻るたびに次のもの）で一つ選び、choose を呼ぶ（押せる要素を渡したときは、その要素を押す）。
 * 自動確認（lim playtest、全ルートテスト）は画面を出さないので、こちらではなく命令の autoplay を使う。
 */

/** 選べるものの共通の項目。 */
interface OfferCommon {
  /** それぞれの飛び先（`ファイル`、`ファイル#ラベル`。わからないものは null）。避けるエンディング（--avoid-ending）に使う。 */
  targets?: readonly (string | null)[];
  /**
   * 選び方に従わず、いつもこの番号で進める（確かめの枠の OK、閉じるだけの画面など）。--choose の番号も使わない。
   * 省くと、ふつうの選択肢と同じ選び方で選ぶ。
   */
  proceed?: number;
}

/** 選べるものの文と、選ぶ関数で知らせる。 */
export interface OfferByChoice extends OfferCommon {
  /** 選べるものの文（押せないものは null）。並びが choose の番号。 */
  options: readonly (string | null)[];
  /** その番号を選ぶ（画面の中で押す、決めるまでを済ませる）。 */
  choose(index: number): void | Promise<void>;
}

/** 押せる要素で知らせる（文は要素の文字か aria-label。disabled か aria-disabled="true" の要素は押せないもの）。 */
export interface OfferByButtons extends OfferCommon {
  buttons: readonly HTMLElement[];
}

export type InputOffer = OfferByChoice | OfferByButtons;

/** 録画が読む、今の選べるもの（番号は知らせるたびに変わる）。 */
export interface OfferedInput {
  id: number;
  options: (string | null)[];
  targets: (string | null)[] | null;
  proceed: number | null;
}

/** 要素の文（文字、aria-label、画像の alt の順）。 */
export function offerLabel(el: HTMLElement): string {
  const text = (el.textContent ?? "").trim();
  if (text) return text;
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  return el.querySelector("img")?.alt ?? "";
}

/** 押せない要素か。 */
function blocked(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
}

/** 知らせを、文と選ぶ関数の形にする。 */
function normalize(o: InputOffer): { options: (string | null)[]; choose(i: number): void | Promise<void>; targets: (string | null)[] | null; proceed: number | null } {
  const targets = o.targets ? [...o.targets] : null;
  const proceed = typeof o.proceed === "number" ? o.proceed : null;
  if ("buttons" in o) {
    const buttons = [...o.buttons];
    return {
      options: buttons.map((b) => (blocked(b) ? null : offerLabel(b))),
      choose: (i) => {
        const b = buttons[i];
        if (b && b.isConnected && !blocked(b)) b.click();
      },
      targets,
      proceed,
    };
  }
  return { options: [...o.options], choose: (i) => o.choose(i), targets, proceed };
}

/**
 * 知らせの置き場（DomHost が持つ）。重ねて知らせたら新しいものが今のもの（画面の上に開いた画面）。
 * 外した知らせと、選んだあとの知らせは、録画からはもう選べない（同じ番号で二度は選ばない）。
 */
export class OfferBoard {
  private next = 1;
  private readonly stack: { id: number; offer: ReturnType<typeof normalize> }[] = [];

  /** 知らせる。返す関数で外す（画面を閉じたら外す）。 */
  add(offer: InputOffer): () => void {
    const entry = { id: this.next++, offer: normalize(offer) };
    this.stack.push(entry);
    return () => {
      const i = this.stack.indexOf(entry);
      if (i >= 0) this.stack.splice(i, 1);
    };
  }

  /** 今の知らせ（無ければ null）。 */
  current(): OfferedInput | null {
    const top = this.stack.at(-1);
    if (!top) return null;
    return { id: top.id, options: [...top.offer.options], targets: top.offer.targets ? [...top.offer.targets] : null, proceed: top.offer.proceed };
  }

  /** 今の知らせ（番号が id のもの）の index 番目を選ぶ。今のものでないか、押せないものなら false。 */
  choose(id: number, index: number): boolean {
    const top = this.stack.at(-1);
    if (!top || top.id !== id || top.offer.options[index] === null || top.offer.options[index] === undefined) return false;
    void Promise.resolve(top.offer.choose(index)).catch((e: unknown) => console.warn("録画の選び方で選べませんでした", e));
    return true;
  }

  /** すべて外す（ロードで画面を組み立て直すとき）。 */
  clear(): void {
    this.stack.length = 0;
  }
}
