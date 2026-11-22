/**
 * キャンバスの描く細かさ。舞台はゲーム画面の px（1280×720 など）で組んで画面に合わせて拡大するので、ゲーム画面の px の大きさで描くと、
 * 高解像度の画面や大きいウィンドウでは引き伸ばされてぼやける。表示される大きさ（拡大と devicePixelRatio を掛けたもの）に合わせる。
 * el は表示しているキャンバス（か、それを置く要素）、width はその要素のゲーム画面での幅（px）。重くなりすぎないよう max 倍まで、1 倍より下げない。
 */
export function backingScale(el: Element, width: number, max = 2): number {
  const shown = el.getBoundingClientRect().width;
  if (!(shown > 0) || !(width > 0)) return 1;
  const k = (shown / width) * (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  // 端数で毎回作り直さないよう、0.25 倍刻みにする
  return Math.max(1, Math.min(max, Math.round(k * 4) / 4));
}
