import { PLAY_FROM_ROUTE, STUDIO_API, type PlayFromOffer } from "@liminalia/editor/protocol";
import type { PlayFromResult } from "./play-from.ts";

/**
 * 「ここからテストプレイ」で開くプレイヤーの URL（VS Code に触らない部分）。言語サーバーが組み立てたセーブ（PlayFromResult）を
 * 開発サーバーに預け（POST STUDIO_API/play-from）、そのページ（localStorage に置いてから `/?play=1&from=<id>&start=<シーン>` へ移る）を開く。
 * 預けられない（その口を持たない古い開発サーバーなど）・セーブが無いときは、シーンの頭から変数を初期値にしてカーソルの行のページまで
 * 早送りするプレイヤー（`?start=&skip=`）を開く。
 */

/** カーソルの行から遊ぶ位置（言語サーバーの liminalia/playTarget の答え）。 */
export interface PlayAt {
  root: string;
  /** シナリオの名前。 */
  file: string;
  /** シーン（`ファイル#ラベル`。ラベルより前ならファイル）。 */
  start: string;
  /** シーンの頭からカーソルの行までのページの数。 */
  skip: number;
}

/** シーンの頭から始めて、カーソルの行のページまで早送りするプレイヤーの URL。 */
export function playerUrl(studio: { url: string }, at: Pick<PlayAt, "start" | "skip">): string {
  return `${studio.url}/?start=${encodeURIComponent(at.start)}&skip=${at.skip}`;
}

/** 開くプレイヤーの URL と、組み立てたセーブを渡せたか。 */
export async function playUrl(studio: { url: string }, at: PlayAt, built: PlayFromResult | null, fetchImpl: typeof fetch = fetch): Promise<{ url: string; handedOver: boolean }> {
  if (built) {
    try {
      const offer: PlayFromOffer = { save: built.save, file: at.file, line: built.line };
      const res = await fetchImpl(`${studio.url}${STUDIO_API}${PLAY_FROM_ROUTE}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(offer) });
      const id = res.ok ? ((await res.json()) as { id?: unknown }).id : undefined;
      if (typeof id === "string") {
        const q = new URLSearchParams({ id, start: at.start, skip: String(at.skip) });
        return { url: `${studio.url}${STUDIO_API}${PLAY_FROM_ROUTE}?${q}`, handedOver: true };
      }
    } catch {
      // 開発サーバーが答えない。早送りで始める
    }
  }
  return { url: playerUrl(studio, at), handedOver: false };
}
