import { castPositionCheck, shownPositions, type AutoLayoutContext, type Cast } from "@liminalia/lang";
import type { Sprite } from "@liminalia/runtime";

/**
 * 舞台の立ち絵それぞれが今いる立ち位置の名前（制作画面の持続の帯とシーンの情報）。描画（packages/web の layoutSprites）と同じ見方にする:
 * cast から差分を引けない立ち絵も人数に数え（描画は出さないが数える）、autoLayout の byCount の読み替え先がその差分の枠に無ければ
 * 読み替えない（引けない立ち絵は書いた立ち位置のまま）。cast を渡さなければ、どの枠にも読み替え先があるものとする。
 */
export function stagePositions(sprites: Readonly<Record<string, Sprite>>, layout?: AutoLayoutContext, cast?: Readonly<Cast>): Map<string, string> {
  return shownPositions(Object.entries(sprites), layout, castPositionCheck(sprites, cast));
}
