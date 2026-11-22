import type { SaveData } from "@liminalia/runtime";
import type { PlayFrom } from "@liminalia/studio/protocol";

/**
 * 制作画面の「ここから遊ぶ」（`/?play=1&from=<id>`。開発サーバーのときだけ）。制作画面が localStorage に置いたセーブのうち、
 * id の合うものを返す（同じオリジンの制作画面とプレイヤーは localStorage を分け合う）。無い・読めなければ null。
 * 鍵は @liminalia/studio の protocol.ts の PLAY_FROM_KEY と同じ（書き出すゲームに制作画面のモジュールを入れないよう、ここに書く）。
 */
const PLAY_FROM_KEY = "liminalia.studio.playFrom";

export function readPlayFrom(id: string | null, storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): SaveData | null {
  if (!id || !storage) return null;
  try {
    const v = JSON.parse(storage.getItem(PLAY_FROM_KEY) ?? "null") as Partial<PlayFrom> | null;
    return v && v.id === id && v.save && typeof v.save === "object" ? v.save : null;
  } catch {
    return null;
  }
}
