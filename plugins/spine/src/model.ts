import type { CastModel } from "@liminalia/sdk";

/**
 * cast.json の model（type が "spine"）の項目。人物に書いたものに、差分に書いたものが重なる（同じ type のとき。エンジンの attachPart）。
 *
 * - src: 骨格（.skel か .json。fgimage からのパス）。必須
 * - atlas: .atlas（fgimage からのパス）。省くと src の拡張子を .atlas にしたもの
 * - animation: この差分で流す動き。省くと差分と同じ名前の動き（無ければ流さない）。"" で流さない
 * - loop: 差分の動きを繰り返すか（既定 true。false なら一度流して最後の形で止める）
 * - skin: スキン。省くと差分と同じ名前のスキン（無ければ骨格の既定のスキン）
 * - idle: 待機の動き（省くと idle。"" で待機の動きなし）
 * - mouth: 口パクの動き（省くと mouth）。口の開き 0〜1 を、その動きの始め〜終わりの形に当てる（始めが閉じた口）
 * - blink: まばたきの動き（省くと blink。"" でまばたきなし）。ときどき一度流す
 * - mix: 動きを切り替えるときに混ぜる秒数（既定 0.2）
 * - scale、x、y: 枠の中での大きさ（既定 1）と、ずらす量（枠の幅と高さを 1 とした割合。右と下が正）
 * - runtime: Spine のランタイムのファイル（others からのパス。既定 spine/spine-webgl.min.js）
 */
export interface SpineOptions {
  src: string;
  atlas: string;
  animation: string | undefined;
  loop: boolean;
  skin: string | undefined;
  idle: string | undefined;
  mouth: string | undefined;
  blink: string | undefined;
  mix: number;
  scale: number;
  x: number;
  y: number;
  runtime: string;
}

export const DEFAULT_RUNTIME = "spine/spine-webgl.min.js";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** 骨格のファイルに合う .atlas（拡張子を替えたもの）。 */
export function atlasFor(src: string): string {
  return src.replace(/\.(skel|json)$/i, "") + ".atlas";
}

export function readOptions(model: CastModel | undefined): SpineOptions {
  const m = (model ?? {}) as Record<string, unknown>;
  const src = str(m.src) ?? "";
  return {
    src,
    atlas: str(m.atlas) || atlasFor(src),
    animation: str(m.animation),
    loop: m.loop !== false,
    skin: str(m.skin),
    idle: str(m.idle),
    mouth: str(m.mouth),
    blink: str(m.blink),
    mix: num(m.mix, 0.2),
    scale: num(m.scale, 1),
    x: num(m.x, 0),
    y: num(m.y, 0),
    runtime: str(m.runtime) || DEFAULT_RUNTIME,
  };
}

const same = (list: readonly string[], name: string): string | null => list.find((x) => x === name) ?? list.find((x) => x.toLowerCase() === name.toLowerCase()) ?? null;

/** 差分の名前から、動きとスキンを選ぶ。書いたものが先、無ければ差分と同じ名前のもの。 */
export function pickState(name: string, o: { animation?: string | undefined; skin?: string | undefined }, animations: readonly string[], skins: readonly string[]): { animation: string | null; skin: string | null } {
  const animation = o.animation !== undefined ? (o.animation && animations.includes(o.animation) ? o.animation : null) : name ? same(animations, name) : null;
  const skin = o.skin !== undefined ? (skins.includes(o.skin) ? o.skin : null) : name ? same(skins, name) : null;
  return { animation, skin };
}

/** 決まった役目の動き（待機・口・まばたき）。書いていなければ既定の名前、"" なら無し。無い名前も無し。 */
export function pickRole(option: string | undefined, fallback: string, animations: readonly string[]): string | null {
  if (option !== undefined) return option && animations.includes(option) ? option : null;
  return same(animations, fallback);
}

/** fgimage のパスのフォルダ（"a/b.atlas" → "a/"）。 */
export function folderOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
}

/** 枠の中に、縦横比を保って収めた範囲。scale と x・y でずらす（live2d と同じ決まり）。 */
export function fitRect(content: { width: number; height: number }, box: { x: number; y: number; width: number; height: number }, o: Pick<SpineOptions, "scale" | "x" | "y">): { x: number; y: number; width: number; height: number } {
  const s = Math.min(box.width / content.width, box.height / content.height) * o.scale;
  const width = content.width * s;
  const height = content.height * s;
  return { x: box.x + (box.width - width) / 2 + o.x * box.width, y: box.y + (box.height - height) / 2 + o.y * box.height, width, height };
}
