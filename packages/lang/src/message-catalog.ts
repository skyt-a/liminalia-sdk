/**
 * 日本語の文を英語にする小さな表（gettext と同じく、原文の形を鍵にする）。`{0}` `{1}` は名前やパスが入る場所で、英語の側で順番を替えてよい。
 * 文を作る場所（数百か所）に手を入れず、英語を読む画面（制作画面・デスクトップ版の書き出し）だけがこの表を読む。ゲームには入らない。
 * 原文を書き換えたのに表を直し忘れると訳せなくなるので、表と原文が合っていることはテストが確かめる（test/diagnostics-en.test.ts）。
 */

/**
 * [日本語の形, 英語の形]。英語の形では、数の入る場所を `{0|file}` と書くと、数と名詞を並べ、数が 1 なら単数、ほかは複数にする
 * （"1 file"、"2 files"。不規則な複数は `{0|entry|entries}`）。数の後ろに or more などが付いていても（"1 or more"）、1 ちょうどでなければ複数。
 */
export type CatalogEntry = readonly [ja: string, en: string];

interface Compiled {
  re: RegExp;
  en: string;
  /** 文字の部分の長さ（長いものほど特定の形なので先に試す）。 */
  literal: number;
}

const JAPANESE = /[぀-ヿ㐀-鿿]/;

/** 日本語の文字を含むか。 */
export const hasJapanese = (text: string): boolean => JAPANESE.test(text);

function compile([ja, en]: CatalogEntry): Compiled {
  const parts = ja.split(/\{\d+\}/);
  const names = [...ja.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let source = escape(parts[0]!);
  // 訳の側の {n} は、原文に現れた順の番号ではなく原文に書いた番号で引く
  const order: number[] = [];
  names.forEach((n, i) => {
    order[n] = i + 1;
    source += `(.+?)${escape(parts[i + 1]!)}`;
  });
  const mapped = en.replace(/\{(\d+)(?:\|([^|}]+)(?:\|([^}]+))?)?\}/g, (_m, n: string, one?: string, many?: string) =>
    one === undefined ? `\u0000${order[Number(n)] ?? 0}\u0000` : `\u0000${order[Number(n)] ?? 0}\u0001${one}\u0001${many ?? `${one}s`}\u0000`,
  );
  return { re: new RegExp(`^${source}$`, "su"), en: mapped, literal: parts.join("").length };
}

/** 表から、文を訳す関数を作る（当てはまる形が無ければ null）。表は使うときに初めて組み立てる。 */
export function createTranslator(entries: readonly CatalogEntry[]): (text: string) => string | null {
  let table: Compiled[] | null = null;
  const translate = (text: string, depth: number): string | null => {
    table ??= entries.map(compile).sort((a, b) => b.literal - a.literal);
    for (const c of table) {
      const m = c.re.exec(text);
      if (!m) continue;
      return c.en.replace(/\u0000(\d+)(?:\u0001([^\u0000\u0001]*)\u0001([^\u0000]*))?\u0000/g, (_s, i: string, one?: string, many?: string) => {
        const value = part(m[Number(i)] ?? "", depth);
        return one === undefined ? value : `${value} ${value.trim() === "1" ? one : many}`;
      });
    }
    // 複数行の文は一行ずつ（「～できませんでした\n理由」の理由の行は、そのまま残る）
    if (text.includes("\n")) {
      const lines = text.split("\n");
      const done = lines.map((l) => translate(l, depth));
      return done.some((l) => l !== null) ? done.map((l, i) => l ?? lines[i]!).join("\n") : null;
    }
    return null;
  };
  /** 差し込む部分。文や言葉（「数値」など）が入っていれば、それも訳す。名前はそのまま。読点の並びは英語の区切りにする。 */
  const part = (value: string, depth: number): string => {
    const trimmed = value.trim();
    if (!hasJapanese(trimmed) && !/[、・]/.test(trimmed)) return value;
    const done = depth < 4 ? translate(trimmed, depth + 1) : null;
    return (done ?? trimmed).replace(/[、・]/g, ", ");
  };
  return (text) => translate(text, 0);
}
