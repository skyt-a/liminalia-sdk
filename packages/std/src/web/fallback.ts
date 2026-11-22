/**
 * 絵を、いくつかの置き場所から順に探して出す（置き場所を替えた欄で、前の場所に置いた素材も読めるように）。
 * 図鑑の地図と地図の選択の地図（bgimage、無ければ前の置き場所の image。データの形の宣言の d.asset の also と同じ順）が使う。
 * - 書き出したゲーム: 一つ目の URL を src にし、読めなければ（404）次の URL にする。どれも読めなければ最後の URL のまま
 * - 開発サーバー: 無い画像には素材の名前を書いた札（SVG）を返すので、先に HEAD で尋ね、札でない（中身の種類が SVG でないか、SVG の絵を頼んだ）ものを使う
 */
export function srcWithFallback(img: HTMLImageElement, urls: readonly string[]): void {
  if (urls.length === 0) return;
  if (import.meta.hot) {
    void (async () => {
      for (const u of urls.slice(0, -1)) {
        // 尋ねられなければ（開発サーバーが止まったなど）その置き場所は無いものとして次を見る
        const r = await fetch(u, { method: "HEAD", cache: "no-store" }).catch(() => null);
        if (r?.ok && !placeholder(r, u)) {
          img.src = u;
          return;
        }
      }
      img.src = urls.at(-1)!;
    })();
    return;
  }
  let i = 0;
  const next = () => {
    if (i >= urls.length - 1) {
      img.removeEventListener("error", next);
      return;
    }
    i++;
    img.src = urls[i]!;
  };
  img.addEventListener("error", next);
  img.src = urls[0]!;
}

/** 開発サーバーの、無い画像の札か（SVG でない絵を頼んで SVG が返った）。 */
function placeholder(r: Response, url: string): boolean {
  return (r.headers.get("content-type") ?? "").startsWith("image/svg") && !/\.svg(?:[?#]|$)/i.test(url);
}
