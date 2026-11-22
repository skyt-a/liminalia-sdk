import { TEXT_EN } from "./strings-en.ts";

/**
 * 既定のシステム画面の文言のうち、訳のファイルの ui で上書きできるもの（文字の項目。数を入れる関数の項目は上書きできない）と、その英語。
 * lim i18n と制作画面の訳の画面が、日本語と英語以外の言語の訳のファイルに、英語の原文を添えて並べる。鍵は "title.start" のような表の中のパス。
 * 画面に関わるものを読まないので、Node から読める（@liminalia/web/ui-strings）。
 */
export function uiStringTable(): { key: string; source: string }[] {
  const out: { key: string; source: string }[] = [];
  const walk = (o: Record<string, unknown>, path: string) => {
    for (const [k, v] of Object.entries(o)) {
      const key = path ? `${path}.${k}` : k;
      if (typeof v === "string") out.push({ key, source: v });
      else if (v && typeof v === "object") walk(v as Record<string, unknown>, key);
    }
  };
  walk(TEXT_EN as unknown as Record<string, unknown>, "");
  return out;
}
