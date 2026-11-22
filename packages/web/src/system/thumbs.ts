/**
 * おまけの CG 一覧に出す画像の縮小（作品が extra.cg の thumb を書いていない CG）。原寸の画像を一度だけ読み、長辺 size px の画像にして
 * blob: の URL で返す。元の画像は描き終えたら手放すので、一覧に並べても展開した原寸の画像をタブに持ち続けない
 * （2560×1440 の CG を 72 枚並べると、展開して数百 MB になり、スマホのブラウザではタブが落ちうる）。
 * 制作画面の packages/studio/src/client/thumbs.ts と同じ形（制作画面は遊ぶ側に依存しないので別に持つ）。
 * 縮小できないとき（壊れた画像、SVG、canvas が使えない）は元の URL を返す。同じ URL と大きさは一度だけ作る
 * （素材を書き換えると URL の ?v= が変わるので、作り直しは URL で分かれる）。
 * 同時に読むのは数枚まで（一覧を一度に開いても、原寸をまとめて展開しない）。
 */
const made = new Map<string, Promise<string>>();
const LIMIT = 4;
let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= LIMIT) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** 長辺 size px に縮めた画像の URL（元のほうが小さければ縮めない）。 */
export function thumbUrl(url: string, size = 256): Promise<string> {
  const key = `${size}\n${url}`;
  let task = made.get(key);
  if (!task) {
    task = /\.svg(\?|$)/i.test(url) ? Promise.resolve(url) : slot(() => shrink(url, size));
    made.set(key, task);
  }
  return task;
}

async function shrink(url: string, size: number): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) return url;
    const bitmap = await createImageBitmap(await res.blob());
    try {
      const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
      if (scale === 1) return url;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return url;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.85));
      return blob ? URL.createObjectURL(blob) : url;
    } finally {
      bitmap.close();
    }
  } catch {
    // 縮められない画像（読めない、形式が違う）は元のまま出す
    return url;
  }
}

/** CG 一覧の縮小の長辺（一覧の一枚は大きくても 400px ほど。高解像度の画面でも粗く見えない大きさ）。 */
export const THUMB_SIZE = 640;

/** img に縮小した画像を入れる。見える所に来てから作る（できるまでは空のまま。できなければ元の画像）。 */
export function lazyThumb(img: HTMLImageElement, url: string, size: number): HTMLImageElement {
  img.dataset.src = url;
  const load = () => void thumbUrl(url, size).then((src) => img.dataset.src === url && (img.src = src));
  if (typeof IntersectionObserver === "undefined") {
    load();
    return img;
  }
  const seen = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    seen.disconnect();
    load();
  }, { rootMargin: "200px" });
  seen.observe(img);
  return img;
}

