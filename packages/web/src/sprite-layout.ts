import { AUTO_POSITION, autoLayoutPosition, autoLayoutSlots, byCountPosition, byCountTarget, framePosition, frameSize, isPortrait, layoutPercent, positionCenters, type AutoLayoutContext, type CastVariant } from "@liminalia/lang";
import type { Sprite } from "@liminalia/runtime";

export interface Size {
  width: number;
  height: number;
}

export interface Box extends Size {
  /** 左上の座標（px）。 */
  x: number;
  y: number;
}

/** 立ち絵一枚の配置に要るもの。natural は画像の実寸（枠のない差分の大きさに使う）。 */
export interface SpriteLayoutInput {
  sprite: Sprite;
  variant: CastVariant;
  natural: Size;
}

/** 差分の表示する大きさ。枠があれば枠の大きさ（既定 632×843）、なければ画像の実寸。 */
export function spriteSize(variant: CastVariant, natural: Size): Size {
  return variant.frame ? frameSize(variant.frame) : natural;
}

/**
 * 表示中の立ち絵の位置と大きさを、状態だけから決める（ロードしても同じ画面になるように、前の画面には頼らない）。
 * sprites は表示した順（状態の sprites の並び）に渡す。
 *
 * - at が auto の立ち絵は、auto のものどうしで横に並べる。後から出したものほど左で、画面の幅を（数 + 1）で
 *   等分した位置に中心を置き、下端を画面の下端にそろえる（TyranoScript の pos_mode と同じ並べ方）
 * - それ以外の at は、枠のある差分なら枠の positions のその名前（無ければ center、それも無ければ (0, 0)）、
 *   枠のない差分なら画面下の中央
 * - 位置を名前で明示した立ち絵は、表示中の立ち絵がちょうどその人数のとき、autoLayout の byCount の読み替え先の位置に置く
 *   （その差分の枠に読み替え先が無ければ書いた名前のまま。x を書いた立ち絵は読み替えない）
 * - 縦長の作品で、枠にその名前も center も無いときは、(0, 0) ではなく画面下の left / center / right の既定の位置（positionCenters）
 * - x / y があれば、その軸は at より優先する
 */
export function layoutSprites(sprites: ReadonlyArray<readonly [string, SpriteLayoutInput]>, screen: Size, layout?: AutoLayoutContext): Map<string, Box> {
  const out = new Map<string, Box>();
  // @chara の width・height があれば、差分の大きさより優先する
  const sizes = new Map(sprites.map(([who, s]) => {
    const size = spriteSize(s.variant, s.natural);
    return [who, { width: s.sprite.width ?? size.width, height: s.sprite.height ?? size.height }] as const;
  }));
  const auto = sprites.filter(([, s]) => s.sprite.at === AUTO_POSITION).reverse();
  const space = Math.floor(screen.width / (auto.length + 1));
  const autoX = new Map(auto.map(([who], i) => [who, (i + 1) * space - Math.floor(sizes.get(who)!.width / 2)]));

  // 新しい自動配置は、位置を明示した人物を固定したまま、空いた位置へ登場順で置く。
  // 従来の at=auto は互換用の別グループとして扱う。
  const slots = autoLayoutSlots(sprites.map(([who, s]) => [who, s.sprite] as const), layout);
  const layoutRules = layout?.rules;

  for (const [who, { sprite, variant }] of sprites) {
    const size = sizes.get(who)!;
    let x = (screen.width - size.width) / 2;
    let y = screen.height - size.height;
    const layout = slots.get(who);
    const slot = layout?.index;
    const rules = layoutRules;
    const count = layout?.count ?? 0;
    // 自動配置の枠の位置（規則の名前か画面の幅の割合。規則に無い四人からは、左右の間を等分する）
    const position = slot === undefined ? sprite.at : autoLayoutPosition(layout!, rules);
    const percent = slot === undefined ? null : layoutPercent(position);
    const spread = slot !== undefined && position === AUTO_POSITION;
    const named = slot === undefined
      ? (byCountTarget(sprite) ? byCountPosition(sprite.at, sprites.length, rules, (name) => !!variant.frame?.positions?.[name]) : sprite.at)
      : spread || percent !== null ? "center" : position;
    if (variant.frame && sprite.at !== AUTO_POSITION) {
      if (isPortrait(screen) && !variant.frame.positions?.[named] && !variant.frame.positions?.center) {
        const centers = positionCenters(screen);
        x = screen.width * (centers[named as keyof typeof centers] ?? centers.center) - size.width / 2;
      } else ({ left: x, top: y } = framePosition(variant.frame, named));
      if (spread) {
        const left = framePosition(variant.frame, "left");
        const right = framePosition(variant.frame, "right");
        const ratio = slot / (count - 1);
        x = left.left + (right.left - left.left) * ratio;
        y = left.top + (right.top - left.top) * ratio;
      }
    } else if (slot !== undefined && sprite.at !== AUTO_POSITION && percent === null) {
      x = screen.width * (slot + 1) / (count + 1) - size.width / 2;
    }
    if (percent !== null) x = screen.width * percent - size.width / 2;
    x = sprite.x ?? autoX.get(who) ?? x;
    y = sprite.y ?? y;
    out.set(who, { x, y, width: size.width, height: size.height });
  }
  return out;
}
