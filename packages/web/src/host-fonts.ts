/**
 * 書体の読み込みを待つ口（DomHost.fonts）。作品の演出が FontFace を自分で登録して、時間切れを自作しなくてよいようにする。
 * どれも読めなくても投げない（代わりの書体で出す）。
 */
export interface HostFonts {
  /**
   * 使う書体の読み込みを待つ（document.fonts.ready と、add で足した書体）。最大 timeout ミリ秒（既定 3000）で諦めて解決する。
   * 書体を待ってから文字の大きさを測る演出（章の扉・タイプライターなど）に使う。
   */
  ready(timeout?: number): Promise<void>;
  /** 書体のファイルを family の名前で一度だけ登録して読む（同じ family と url は読み直さない）。読めたら true。 */
  add(family: string, url: string, descriptors?: FontFaceDescriptors): Promise<boolean>;
  /** CSS の font の書き方（'500 16px "Shippori Mincho"'）の字形を読む。最大 timeout ミリ秒（既定 3000）。読めたら true。 */
  load(font: string, timeout?: number): Promise<boolean>;
}

const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

export function createHostFonts(): HostFonts {
  const added = new Map<string, Promise<boolean>>();
  return {
    async ready(timeout = 3000) {
      if (typeof document === "undefined" || !document.fonts) return;
      await within(Promise.all([document.fonts.ready.then(() => true), ...added.values()]).then(() => undefined), timeout, undefined);
    },
    add(family, url, descriptors) {
      const key = `${family}\n${url}`;
      let p = added.get(key);
      if (!p) {
        if (typeof FontFace === "undefined" || typeof document === "undefined") return Promise.resolve(false);
        const face = new FontFace(family, `url("${url.replace(/"/g, "%22")}")`, { display: "swap", ...descriptors });
        document.fonts.add(face);
        p = face.load().then(
          () => true,
          () => {
            console.warn(`書体を読み込めません: ${family}（${url}）`);
            return false;
          },
        );
        added.set(key, p);
      }
      return p;
    },
    load(font, timeout = 3000) {
      if (typeof document === "undefined" || !document.fonts) return Promise.resolve(false);
      return within(
        document.fonts.load(font).then(
          (faces) => faces.length > 0,
          () => false,
        ),
        timeout,
        false,
      );
    },
  };
}
