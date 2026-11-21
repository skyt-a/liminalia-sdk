/**
 * スタッフロール（@staff-roll）の中身。@staff-roll の行と @end の行のあいだに書くか、data/ の JSON（文字列の配列）に同じ書き方で書く。
 *
 * - `# 見出し` は見出し（役職やまとまりの名前）
 * - 空の行は間をあける
 * - `{img パス}` `{img パス 高さ}` だけの行は画像（image フォルダ。高さは px）
 * - それ以外の行は名前などの文字をそのまま出す（行頭の `\#` は # の文字）
 */
export type CreditLine = { kind: "heading"; text: string } | { kind: "text"; text: string } | { kind: "gap" } | { kind: "image"; path: string; height?: number };

/** 中身を一行ずつ読む。 */
export function parseCredits(lines: readonly string[]): CreditLine[] {
  const out: CreditLine[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      out.push({ kind: "gap" });
      continue;
    }
    const heading = /^# (.+)$/.exec(line);
    if (heading) {
      out.push({ kind: "heading", text: heading[1]!.trim() });
      continue;
    }
    const image = /^\{img ([^\s{}]+)(?: (\d+(?:\.\d+)?))?\}$/.exec(line);
    if (image) {
      out.push({ kind: "image", path: image[1]!, ...(image[2] !== undefined ? { height: Number(image[2]) } : {}) });
      continue;
    }
    out.push({ kind: "text", text: line.startsWith("\\#") ? line.slice(1) : line });
  }
  return out;
}

/**
 * 行のあとに、@end までの行をそのまま中身として持つコマンドか（@html と、file= の無い @staff-roll）。
 * rest はコマンド名の後ろ（パラメータ）。構文木を作るところ、整形、色分け、ブロック表示が同じ決まりで見る。
 */
export function opensBody(name: string, rest: string): boolean {
  return name === "html" || (name === "staff-roll" && !/(^|\s)file=/.test(rest));
}
