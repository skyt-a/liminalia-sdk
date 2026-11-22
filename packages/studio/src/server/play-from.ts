import { PLAY_FROM_KEY, type PlayFrom, type PlayFromOffer } from "../protocol.ts";

/**
 * 開発サーバーの外（VS Code の拡張機能）で組み立てた「ここからテストプレイ」のセーブを預かり、ブラウザのプレイヤーへ渡す
 * （protocol.ts の PLAY_FROM_ROUTE）。ブラウザの localStorage には外から書けないので、開発サーバーの小さなページが置いてから
 * プレイヤーへ移る。預かったものは覚えておくだけ（ファイルには書かない）で、古いものから捨てる。
 */

/** 覚えておく数。 */
const KEEP = 8;

export class PlayFromStore {
  private readonly entries = new Map<string, PlayFrom>();

  /** 預かって id を返す。形が合わなければ null。 */
  put(offer: unknown): string | null {
    const o = offer as Partial<PlayFromOffer> | null;
    if (!o || typeof o !== "object" || !o.save || typeof o.save !== "object" || typeof o.file !== "string" || !Number.isInteger(o.line)) return null;
    const id = Math.random().toString(36).slice(2, 10);
    this.entries.set(id, { id, save: o.save, file: o.file, line: o.line! });
    while (this.entries.size > KEEP) this.entries.delete(this.entries.keys().next().value!);
    return id;
  }

  get(id: string | null): PlayFrom | null {
    return (id && this.entries.get(id)) || null;
  }
}

/** script の中に置く JSON（</script> で閉じないように、< と行の区切りの文字を書き換える）。 */
const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/[<\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * localStorage に置いてプレイヤーへ移るページ。entry が無ければ、シーンの頭から skip ページ目まで早送りするプレイヤーへ移る。
 * start はそのシーン（`ファイル#ラベル`）。
 */
export function playFromPage(entry: PlayFrom | null, start: string | null, skip: string | null): string {
  const q = new URLSearchParams();
  if (entry) {
    q.set("play", "1");
    q.set("from", entry.id);
    q.set("start", start ?? entry.file);
  } else if (start) {
    q.set("start", start);
    if (skip && /^\d+$/.test(skip)) q.set("skip", skip);
  }
  const query = q.toString();
  const target = `/${query ? `?${query}` : ""}`;
  const put = entry ? `try { localStorage.setItem(${scriptJson(PLAY_FROM_KEY)}, ${scriptJson(JSON.stringify(entry))}); } catch {}\n` : "";
  return `<!doctype html>\n<meta charset="utf-8">\n<title>Liminalia</title>\n<script>\n${put}location.replace(${scriptJson(target)});\n</script>\n`;
}
