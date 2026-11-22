/**
 * カメラの変形。TyranoScript（[camera]）と同じく scale → rotate → translate の順にする。
 * x / y はシーンの座標で、カメラの中心をそこへ動かす（寄っているほど画面上では大きく流れる）。
 */
export function cameraTransform(c: { zoom: number; x: number; y: number; rotate: number }): string {
  return `scale(${c.zoom}) rotate(${c.rotate}deg) translate(${-c.x}px, ${-c.y}px)`;
}

/**
 * 拡大 zoom のカメラの中心を、背景（舞台いっぱい）が画面を覆う範囲に収める。寄っていなければ（zoom ≤ 1）動ける余地が無いので 0。
 */
export function coverCamera(c: { zoom: number; x: number; y: number }, screen: { width: number; height: number }): { x: number; y: number } {
  const room = (size: number) => (size / 2) * Math.max(0, 1 - 1 / c.zoom);
  const clamp = (v: number, r: number) => Math.max(-r, Math.min(r, v));
  return { x: clamp(c.x, room(screen.width)), y: clamp(c.y, room(screen.height)) };
}
