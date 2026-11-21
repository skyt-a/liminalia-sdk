import type { HeadMark } from "./head-fit.ts";

/**
 * 立ち絵の顔の位置を、肌の色のかたまりから推し量る（立ち絵を揺らす部品が、首の軸と顔の範囲を決めるのに使う）。
 * estimateHead は不透明な部分の幅の変わり方で顎を探すので、長い髪が顔の横を覆う絵では顎が目の高さに上がる。
 * こちらは顔そのもの（頭の上のほうにある、いちばん大きな肌のかたまり）を見つけ、頬から下へ幅が細っていく先を顎とする。
 *
 * 返す HeadMark の top は髪を含む頭頂、width は顔の幅から見積もった頭の幅。肌が見つからない絵（仮面、後ろ姿、肌色でない肌）は null。
 */
export function estimateFace(pixels: ArrayLike<number>, width: number, height: number): HeadMark | null {
  const solid = (x: number, y: number) => pixels[(y * width + x) * 4 + 3]! >= 32;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!solid(x, y)) continue;
      if (top < 0) top = y;
      bottom = y;
      break;
    }
  }
  if (top < 0) return null;
  const body = bottom - top + 1;
  // 頭頂の中心 X（顔の候補が二つあるとき、こちらに近いほうを選ぶ）
  let sum = 0;
  let count = 0;
  for (let y = top; y < top + Math.max(3, Math.round(body * 0.02)); y++) for (let x = 0; x < width; x++) if (solid(x, y)) (sum += x), count++;
  const crownX = sum / Math.max(1, count);

  // 顔を探すのは上から体の高さの半分まで
  const limit = Math.min(bottom, top + Math.round(body * 0.5));
  const rows = limit - top + 1;
  const skin = new Uint8Array(width * rows);
  for (let y = top; y <= limit; y++) for (let x = 0; x < width; x++) if (isSkin(pixels, (y * width + x) * 4)) skin[(y - top) * width + x] = 1;

  // 肌のかたまり（上下左右でつながった画素）
  type Blob = { area: number; minY: number; maxY: number; sumX: number; pixels: number[] };
  const label = new Int32Array(width * rows).fill(-1);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let i = 0; i < skin.length; i++) {
    if (!skin[i] || label[i]! >= 0) continue;
    const blob: Blob = { area: 0, minY: rows, maxY: 0, sumX: 0, pixels: [] };
    label[i] = blobs.length;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % width;
      const y = (j - x) / width;
      blob.area++;
      blob.sumX += x;
      blob.minY = Math.min(blob.minY, y);
      blob.maxY = Math.max(blob.maxY, y);
      blob.pixels.push(j);
      for (const k of [x > 0 ? j - 1 : -1, x < width - 1 ? j + 1 : -1, y > 0 ? j - width : -1, y < rows - 1 ? j + width : -1]) {
        if (k >= 0 && skin[k] && label[k]! < 0) {
          label[k] = blobs.length;
          stack.push(k);
        }
      }
    }
    blobs.push(blob);
  }
  // 顔の候補: 小さすぎない（手の指や耳ではない）かたまり。上にあって頭頂の真下に近いものほど顔らしい
  const minArea = Math.max(12, body * body * 0.0012);
  const candidates = blobs.filter((b) => b.area >= minArea);
  if (candidates.length === 0) return null;
  const largest = Math.max(...candidates.map((b) => b.area));
  const score = (b: Blob) => b.minY + Math.abs(b.sumX / b.area - crownX) * 0.6 - (b.area / largest) * body * 0.05;
  const face = candidates.filter((b) => b.area >= largest * 0.25).sort((a, b) => score(a) - score(b))[0]!;
  const id = blobs.indexOf(face);

  // 行ごとの顔の幅。頬（いちばん広い行）から下へ、幅が 6 割を切ってからいちばん細くなる所が顎（その下は首か襟）
  const spans: { width: number; center: number }[] = [];
  for (let y = face.minY; y <= face.maxY; y++) {
    let l = width;
    let r = -1;
    for (let x = 0; x < width; x++) if (label[y * width + x] === id) (l = Math.min(l, x), (r = Math.max(r, x)));
    spans.push(r >= l ? { width: r - l + 1, center: (l + r) / 2 } : { width: 0, center: crownX });
  }
  const faceHeight = spans.length;
  if (faceHeight < body * 0.03) return null;
  // 頬: 顔の上から 7 割までのうち、いちばん広い行（首・肩の肌まで続いているかたまりでも、肩を拾わないように）
  let cheek = 0;
  for (let i = 0; i < Math.max(1, Math.round(Math.min(faceHeight, body * 0.18) * 0.9)); i++) if (spans[i]!.width > spans[cheek]!.width) cheek = i;
  const cheekWidth = spans[cheek]!.width;
  // 肌のかたまりの上端（前髪の下、目のあたり）から顎までは、顔の幅とほぼ同じ。首や胸元の肌まで続いているかたまりでも、ここより下には置かない
  const longest = Math.round(cheekWidth * 1.15);
  let chin = Math.min(faceHeight - 1, Math.round(cheekWidth * 0.95));
  const narrow = spans.findIndex((s, i) => i > cheek && s.width <= cheekWidth * 0.6);
  if (narrow >= 0 && narrow <= longest) {
    // 細くなりはじめてから少し下までで、いちばん細い行（その下は首）
    const reach = Math.min(faceHeight - 1, longest, narrow + Math.max(2, Math.round(cheekWidth * 0.2)));
    chin = narrow;
    for (let i = narrow; i <= reach; i++) if (spans[i]!.width < spans[chin]!.width) chin = i;
  }
  let cx = 0;
  let n = 0;
  for (let i = cheek; i <= chin; i++) (cx += spans[i]!.center), n++;
  const chinY = top + face.minY + chin;
  if (chinY <= top) return null;
  return {
    chinX: cx / Math.max(1, n),
    chinY,
    top,
    // 頭の幅は顔の幅に髪の分を足した目安
    width: Math.min(width, cheekWidth * 1.55),
    imageWidth: width,
    imageHeight: height,
  };
}

/**
 * 肌の色（赤みから橙の色相で、彩度がほどほど、ある程度明るい）。白い服・灰色の髪は彩度が足りず、金髪は色相が黄に寄るので外れる。
 * 日焼けした肌や陰の肌も入るよう、明るさの下限は低めにしてある。
 */
function isSkin(pixels: ArrayLike<number>, i: number): boolean {
  if (pixels[i + 3]! < 200) return false;
  const r = pixels[i]! / 255;
  const g = pixels[i + 1]! / 255;
  const b = pixels[i + 2]! / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max !== r || max < 0.42) return false;
  const sat = (max - min) / max;
  // 色白の肌は彩度がとても低いので、明るいところだけ下限を下げる
  if (sat < (max > 0.88 ? 0.045 : 0.07) || sat > 0.62) return false;
  // 色相（度）。赤が最大なので -60〜60 の範囲
  const hue = (60 * (g - b)) / (max - min);
  return hue >= -8 && hue <= 33;
}
