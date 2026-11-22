/**
 * 解像度を下げて書き出した画像（liminalia.json の build.mobile.images.scale など。project/assets-scale.json）を、元の大きさの絵として出す。
 * 書き出しが縦横を縮めた絵は、そのままでは画素の数が減った分だけ小さく出て、立ち絵の並べ方や @image の大きさが変わってしまう。
 * そこで、その絵の URL を <img> に入れるとき、srcset の幅の書き方（縮めた幅 w）と sizes（元の幅 px）を添え、ブラウザに元の大きさの絵として
 * 扱わせる（naturalWidth、表示の大きさ、canvas に drawImage(絵, x, y) で描く大きさが元のものになる）。
 * canvas の drawImage で絵の一部を切り出すとき（顔の窓、@image の切り出し、セーブの縮小画像）の切り出しの座標は、元の絵の画素で書くので、
 * 縮めた倍率を掛けて渡す。プラグインのコードも同じに扱えるよう、HTMLImageElement の src と drawImage を包む（縮めた絵が無ければ包まない）。
 * CSS の url() で出す絵（タイトルの背景など）は、画面いっぱいに引き伸ばして出すので、そのままでよい。
 */

/** 元の名前 → [元の幅, 元の高さ, 縮めた幅, 縮めた高さ]（書き出しの project/assets-scale.json）。 */
export type AssetScaleTable = Record<string, [number, number, number, number]>;

interface Scaled {
  width: number;
  height: number;
  scaledWidth: number;
  scaledHeight: number;
}

/** URL → 縮めた絵の大きさ。 */
const byUrl = new Map<string, Scaled>();
/** 画像の要素の、縮めた倍率（横、縦）。要素の data-lm-scale に書く（cloneNode で写した要素も同じに扱う）。 */
const factorsOf = (img: HTMLImageElement): [number, number] | undefined => {
  const v = img.dataset.lmScale?.split(",").map(Number);
  return v && v.length === 2 && v.every((n) => n > 0) ? [v[0]!, v[1]!] : undefined;
};
let installed = false;

/** 素材の URL を、縮めた絵として覚える（素材の URL を作るところが呼ぶ）。 */
export function registerScaledAsset(url: string, size: AssetScaleTable[string]): void {
  const [width, height, scaledWidth, scaledHeight] = size;
  if (!(width > 0 && height > 0 && scaledWidth > 0 && scaledHeight > 0)) return;
  byUrl.set(url, { width, height, scaledWidth, scaledHeight });
  // ページから見た絶対の URL でも引けるように（img.src を読み直して入れ直すコードのため）
  try {
    byUrl.set(new URL(url, document.baseURI).href, { width, height, scaledWidth, scaledHeight });
  } catch {
    // 読めない URL はそのまま
  }
}

/** 縮めた絵を元の大きさで扱う仕組みを入れる（縮めた絵のある書き出しで一度だけ）。 */
export function installAssetScale(): void {
  if (installed || typeof HTMLImageElement === "undefined") return;
  installed = true;
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  if (src?.set && src.get) {
    const set = src.set;
    const get = src.get;
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true,
      enumerable: src.enumerable ?? true,
      get(this: HTMLImageElement) {
        return get.call(this) as string;
      },
      set(this: HTMLImageElement, value: string) {
        const s = byUrl.get(String(value));
        if (s) {
          // 幅の書き方の srcset では、src は選ぶ先に入らない（元の幅を sizes で渡し、元の大きさの絵になる）
          this.sizes = `${s.width}px`;
          this.srcset = `${String(value)} ${s.scaledWidth}w`;
          this.dataset.lmScale = `${s.scaledWidth / s.width},${s.scaledHeight / s.height}`;
        } else if (this.dataset.lmScale !== undefined) {
          this.removeAttribute("srcset");
          this.removeAttribute("sizes");
          delete this.dataset.lmScale;
        }
        set.call(this, value);
      },
    });
  }
  // 切り出し（drawImage の 9 個の引数の形）の座標は、元の絵の画素で書くので、縮めた倍率を掛ける
  const wrap = (proto: { drawImage: (...args: never[]) => void } | undefined) => {
    if (!proto) return;
    const draw = proto.drawImage;
    proto.drawImage = function (this: unknown, ...args: unknown[]) {
      const f = args.length === 9 && args[0] instanceof HTMLImageElement ? factorsOf(args[0]) : undefined;
      if (f) {
        args[1] = (args[1] as number) * f[0];
        args[2] = (args[2] as number) * f[1];
        args[3] = (args[3] as number) * f[0];
        args[4] = (args[4] as number) * f[1];
      }
      return (draw as (...a: unknown[]) => void).apply(this, args);
    } as never;
  };
  wrap(typeof CanvasRenderingContext2D === "undefined" ? undefined : (CanvasRenderingContext2D.prototype as unknown as { drawImage: (...args: never[]) => void }));
  wrap(typeof OffscreenCanvasRenderingContext2D === "undefined" ? undefined : (OffscreenCanvasRenderingContext2D.prototype as unknown as { drawImage: (...args: never[]) => void }));
}
