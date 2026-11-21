/**
 * 作品の画面の大きさ（liminalia.json の screen）と、そこから決まるもの。プレイヤーの舞台・ひな形・制作画面が同じ規則を使う。
 *
 * - 舞台の座標（背景・立ち絵・@image などの px）は、いつも作品の screen の座標
 * - 文字と枠（メッセージ枠・選択肢・システム画面と ui の px）は、基準の大きさ（横長 1280×720、縦長 720×1280）で決めてあり、
 *   screen がそれと違えば同じ割合で拡大・縮小する（uiScale。1920×1080 なら 1.5 倍で、1280×720 と同じ見え方になる）
 */
export interface ScreenSize {
  width: number;
  height: number;
}

/** screen を書いていない作品の大きさ。 */
export const DEFAULT_SCREEN: Readonly<ScreenSize> = { width: 1280, height: 720 };

/** 縦長の作品の、文字と枠の基準の大きさ。 */
export const PORTRAIT_SCREEN: Readonly<ScreenSize> = { width: 720, height: 1280 };

/** 縦長か（正方形は横長として扱う）。 */
export function isPortrait(screen: ScreenSize): boolean {
  return screen.height > screen.width;
}

/** 文字と枠の基準の大きさ。 */
export function uiBaseSize(screen: ScreenSize): Readonly<ScreenSize> {
  return isPortrait(screen) ? PORTRAIT_SCREEN : DEFAULT_SCREEN;
}

/** 文字と枠の拡大率。基準の大きさと同じ作品は 1。 */
export function uiScale(screen: ScreenSize): number {
  const base = uiBaseSize(screen);
  return Math.round(Math.min(screen.width / base.width, screen.height / base.height) * 10000) / 10000;
}

/** 文字と枠の座標（ui の px）で測った舞台の大きさ。 */
export function uiSpace(screen: ScreenSize): ScreenSize {
  const scale = uiScale(screen);
  return { width: screen.width / scale, height: screen.height / scale };
}

/** CSS の aspect-ratio に書く形（"720 / 1280"）。 */
export function screenAspect(screen: ScreenSize): string {
  return `${screen.width} / ${screen.height}`;
}

/** 立ち位置 left / center / right の中心の、画面の幅に対する割合。縦長は並べる幅が無いので、寄せて重ねる。 */
export function positionCenters(screen: ScreenSize): { left: number; center: number; right: number } {
  return isPortrait(screen) ? { left: 0.3, center: 0.5, right: 0.7 } : { left: 0.25, center: 0.5, right: 0.75 };
}

/** 縦長の作品の立ち絵の高さの上限（画面の高さに対する割合）。下の枠の上に顔が出るようにする。 */
const PORTRAIT_SPRITE_HEIGHT = 0.72;
/** 縦長の作品の立ち絵の幅の上限（画面の幅に対する割合）。 */
const PORTRAIT_SPRITE_WIDTH = 0.92;

/** 縦長の作品で、幅 width・高さ height の立ち絵を画面に収める倍率（画面の縦に余りがあるので、1 を超えることがある）。 */
export function portraitSpriteScale(size: ScreenSize, screen: ScreenSize): number {
  return Math.min((screen.height * PORTRAIT_SPRITE_HEIGHT) / size.height, (screen.width * PORTRAIT_SPRITE_WIDTH) / size.width);
}
