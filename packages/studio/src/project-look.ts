/**
 * 制作アプリのはじめの画面とスマホ版の入口に出す作品の顔（表紙の絵と、台本の一行）の選び方。ファイルには触らず、読んだ中身から決める。
 * 両方が同じ読み方をするよう、ここ一か所に置く（ファイルの読み方はそれぞれ。Node のファイルと、スマホ版の手元の写し）。
 */

/** 台本から引いた一行。resume は前回開いていた場所か（false なら物語のはじまり）。 */
export interface StoryLine {
  speaker: string | null;
  text: string;
  /** シナリオのファイル（拡張子なし）。 */
  file: string;
  line: number;
  resume: boolean;
}

const QUOTE_LIMIT = 120;
const COVER_NAME = /(^|[\\/_.-])(title|cover|kv|key_?visual|タイトル)/i;
const NOT_COVER = /(button|btn|logo|icon|thumb)/i;

/** 台本で最初に出す背景（@bg の素材の名前。マクロの引数は除く）。 */
export function firstBackground(source: string): string | null {
  return /^[ \t]*@bg[ \t]+([^\s(]+)/m.exec(source)?.[1] ?? null;
}

/** assets/bgimage の中のファイル（相対パス）から表紙を選ぶ。題名の絵らしいもの（浅いフォルダを先に）、次に物語の最初の背景、無ければ並びの先頭。 */
export function chooseCover(files: readonly string[], opening: string | null = null): string | null {
  const usable = files.filter((f) => /\.(png|jpe?g|webp|avif)$/i.test(f) && !NOT_COVER.test(f));
  const depth = (f: string) => f.split(/[\\/]/).length;
  const named = usable.filter((f) => COVER_NAME.test(f)).sort((a, b) => depth(a) - depth(b));
  const first = opening ? usable.find((f) => f === opening || f.endsWith(`/${opening}`) || f.replace(/\.[^.]+$/, "") === opening) : undefined;
  return named[0] ?? first ?? usable[0] ?? null;
}

/** 本文の一行なら「話者と文」にする。命令・ラベル・注釈・選択肢・空行は null。 */
export function storyText(raw: string): { speaker: string | null; text: string } | null {
  const line = raw.trim();
  if (line === "" || /^(@|#|\/\/|- )/.test(line)) return null;
  const plain = line
    .replace(/\{r ([^|}]*)\|[^}]*\}/g, "$1")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\(.)/g, "$1")
    .trim();
  if (plain === "") return null;
  // 台詞は 名前「…」 か 名前 "…"（英語の台詞。引用符の前の半角の空白一つは本文に入れない）
  const said = /^([^「」"“”:：\s]{1,20})(?:(「.*)| ?(["“].*))$/.exec(plain);
  const [speaker, text] = said ? [said[1] ?? null, said[2] ?? said[3] ?? plain] : [null, plain];
  // 中身のまだ無い台詞は見せない
  if (/^[「」"“”\s]*$/.test(text)) return null;
  return { speaker, text: text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}…` : text };
}

/** line（1 から）か、その少し前の本文を引く。前に無ければ後ろを探す。 */
export function storyLineAt(source: string, line: number, file: string, resume: boolean): StoryLine | null {
  const lines = source.split(/\r?\n/);
  const at = Math.min(Math.max(line, 1), lines.length) - 1;
  const order = [...Array(at + 1).keys()].reverse().slice(0, 40).concat([...Array(lines.length - at - 1).keys()].map((i) => at + 1 + i).slice(0, 200));
  for (const i of order) {
    const found = storyText(lines[i] ?? "");
    if (found) return { ...found, file: file.replace(/\.lim$/, ""), line: i + 1, resume };
  }
  return null;
}

/** 表紙の無い作品の色相を題名から決める（開くたびに同じ色になる）。 */
export function titleHue(title: string): number {
  let h = 0;
  for (const c of title) h = (h * 31 + (c.codePointAt(0) ?? 0)) % 360;
  return h;
}
