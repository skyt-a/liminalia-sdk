import type { CastVariant } from "@liminalia/lang";

/**
 * 立ち絵に重ねて動かす部品。組み込みは口パクとまばたき（差分の lip・blink の重ね画像）で、
 * プラグインは Live2D・Spine などの立ち絵を同じ形で足す（差分の model.type に対応する WebPlugin の extensions.spriteParts）。
 * DomHost が立ち絵ごとに一つ作り、差分が替わったら update、毎フレーム tick（mouth はその人物の口の開き 0〜1）を呼ぶ。
 */
export interface SpritePart {
  /** 同じ立ち絵の差分が替わった。at は替わった先の差分の名前と立ち絵セット（Live2D の表情や Spine の動きを名前で選ぶ）。 */
  update(variant: CastVariant, at?: SpritePartVariant): void;
  /** 毎フレーム。now はミリ秒、mouth はその人物の口の開き（0〜1。話していなければ 0）。 */
  tick?(now: number, mouth: number): void;
  dispose(): void;
  /** true なら立ち絵の画像（image）を隠す（画像の代わりに自分で描く部品）。 */
  readonly coversImage?: boolean;
}

/** 差分の名前と立ち絵セット。 */
export interface SpritePartVariant {
  /** 差分の名前（cast.json の variants の鍵。@chara の「smile+blush」なら smile、書かなければ基準の差分）。 */
  name: string;
  /** 立ち絵セットの名前。 */
  appearance: string;
}

export interface SpritePartContext extends Partial<SpritePartVariant> {
  /** キャスト名。 */
  who: string;
  variant: CastVariant;
  /** 立ち絵の要素（枠の位置と大きさ。中に足した要素は立ち絵と一緒に動き・消える）。 */
  el: HTMLElement;
  /** fgimage などの素材の URL。 */
  asset(kind: "fgimage" | "image" | "others", path: string): string;
  /** 早送り（スキップ）中か。表情や動きの切り替えを、動かさずに終わった姿にするのに使う。 */
  skipping?(): boolean;
  /**
   * 撮影（lim shot、書き出したあとの確かめ）を、返した関数を呼ぶまで待たせる。モデルを読み込んで最初の一枚を描くまで止めておくのに使う。
   */
  holdShot?(): () => void;
}

export type SpritePartFactory = (ctx: SpritePartContext) => SpritePart;

/** まばたきの間隔（ミリ秒）の幅と、一回のまばたきの一コマの長さ。 */
const BLINK_GAP: [number, number] = [2200, 6000];
const BLINK_FRAME = 55;

/** 差分に口パクかまばたきの重ね画像があるか。 */
export function hasFace(variant: CastVariant): boolean {
  return (variant.lip?.length ?? 0) > 0 || (variant.blink?.length ?? 0) > 0;
}

/** 口パクとまばたき。重ね画像は立ち絵の画像と同じ大きさで、上に重ねて一枚だけ見せる。 */
export function createFace(ctx: SpritePartContext): SpritePart {
  const root = document.createElement("div");
  root.className = "sprite-face";
  Object.assign(root.style, { position: "absolute", inset: "0", pointerEvents: "none" });
  const lipImg = layer();
  const blinkImg = layer();
  root.append(blinkImg, lipImg);
  ctx.el.append(root);
  let lip: string[] = [];
  let blink: string[] = [];
  let nextBlink = performance.now() + gap();
  let blinkStart = -1;
  /** いま見せている重ね画像の番号（-1 は見せない）。 */
  let lipShown = -1;
  let blinkShown = -1;

  function layer(): HTMLImageElement {
    const img = document.createElement("img");
    img.draggable = false;
    img.alt = "";
    Object.assign(img.style, { position: "absolute", inset: "0", width: "100%", height: "100%", visibility: "hidden" });
    return img;
  }
  function gap(): number {
    return BLINK_GAP[0] + Math.random() * (BLINK_GAP[1] - BLINK_GAP[0]);
  }
  function preload(paths: string[]): string[] {
    const urls = paths.map((p) => ctx.asset("fgimage", p));
    for (const u of urls) new Image().src = u;
    return urls;
  }
  function show(img: HTMLImageElement, frames: string[], i: number, current: number): number {
    if (i === current) return current;
    if (i < 0 || !frames[i]) img.style.visibility = "hidden";
    else {
      img.src = frames[i]!;
      img.style.visibility = "visible";
    }
    return i;
  }
  function update(variant: CastVariant): void {
    lip = preload(variant.lip ?? []);
    blink = preload(variant.blink ?? []);
    lipShown = show(lipImg, lip, -1, 0);
    blinkShown = show(blinkImg, blink, -1, 0);
  }
  update(ctx.variant);

  return {
    update,
    tick(now, mouth) {
      // 口: 開き具合を重ね画像の段に分ける（0 は閉じた口＝立ち絵の画像のまま）
      if (lip.length > 0) {
        const step = mouth < 0.12 ? -1 : Math.min(lip.length - 1, Math.floor(mouth * lip.length));
        lipShown = show(lipImg, lip, step, lipShown);
      }
      // まばたき: 半目 → 閉じた目 → 半目 → 開いた目
      if (blink.length > 0) {
        if (blinkStart < 0 && now >= nextBlink) blinkStart = now;
        if (blinkStart >= 0) {
          const seq = [...blink.keys(), ...[...blink.keys()].reverse().slice(1)];
          const i = Math.floor((now - blinkStart) / BLINK_FRAME);
          if (i >= seq.length) {
            blinkStart = -1;
            nextBlink = now + gap();
            blinkShown = show(blinkImg, blink, -1, blinkShown);
          } else blinkShown = show(blinkImg, blink, seq[i]!, blinkShown);
        }
      }
    },
    dispose() {
      root.remove();
    },
  };
}
