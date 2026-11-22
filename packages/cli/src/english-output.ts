import { format } from "node:util";
import { translateDiagnosticText } from "@liminalia/lang/diagnostics-en";
import type { CatalogEntry } from "@liminalia/lang/message-catalog";
import { englishBuildLine } from "@liminalia/project/build-lines-en";
import { LIM_MESSAGES_EN } from "./messages-en.ts";

/**
 * lim の出力を英語にする（出力の言語が英語のとき。output-language.ts）。文を作る場所（命令ごとの console.log や throw）には手を入れず、
 * 出す直前に一行ずつ、文言の表（messages-en.ts。書き出しの経過は @liminalia/project の build-lines-en.ts）で読み替える。
 * 表に無い行（作品の本文、外の道具の出力、英語で作った行）はそのまま出す。
 * 表と原文が合っていることは test/english-output.test.ts が確かめる（日本語の文を足して英語を書き忘れると落ちる）。
 */

interface Compiled {
  re: RegExp;
  /** 英語の形。\u0000n\u0000 が差し込む所（n は正規表現の組の番号）、\u0000n\u0001単数\u0001複数\u0000 は数と名詞。 */
  en: string;
  /** 文字の部分の長さ（長いものほど特定の形なので先に試す）。 */
  literal: number;
}

/** 日本語の字と、日本語の括弧と句読点（「dist/game（1 MB）」のように、字が無くても括弧は英語の形にする）。 */
const JAPANESE = /[぀-ヿ㐀-鿿（）「」『』、。]/;

function compile([ja, en]: CatalogEntry): Compiled {
  const parts = ja.split(/\{\d+\}/);
  const names = [...ja.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let source = escape(parts[0]!);
  const order: number[] = [];
  // 差し込む所は空でもよい（「（3 ページ、5 秒{3}）」の {3} のように、続きの文が無いときがある）
  names.forEach((n, i) => {
    order[n] = i + 1;
    source += `(.*?)${escape(parts[i + 1]!)}`;
  });
  const mapped = en.replace(/\{(\d+)(?:\|([^|}]+)(?:\|([^}]+))?)?\}/g, (_m, n: string, one?: string, many?: string) =>
    one === undefined ? `\u0000${order[Number(n)] ?? 0}\u0000` : `\u0000${order[Number(n)] ?? 0}\u0001${one}\u0001${many ?? `${one}s`}\u0000`,
  );
  return { re: new RegExp(`^${source}$`, "su"), en: mapped, literal: parts.join("").length };
}

let table: Compiled[] | null = null;

/**
 * 一つの文を表で訳す（当てはまる形が無ければ null）。当てはまる形が二つ以上あれば、日本語が残らないものを選ぶ
 * （「{0} がありません」のような短い形は、長い文の一部にも当てはまるため）。
 */
function translate(text: string, depth: number): string | null {
  table ??= LIM_MESSAGES_EN.map(compile).sort((a, b) => b.literal - a.literal);
  let first: string | null = null;
  for (const c of table) {
    const m = c.re.exec(text);
    if (!m) continue;
    const done = c.en.replace(/\u0000(\d+)(?:\u0001([^\u0000\u0001]*)\u0001([^\u0000]*))?\u0000/g, (_s, i: string, one?: string, many?: string) => {
      const value = part(m[Number(i)] ?? "", depth);
      return one === undefined ? value : `${value} ${value.trim() === "1" ? one : many}`;
    });
    if (!JAPANESE.test(done)) return done;
    first ??= done;
  }
  // 書き出しの経過と、途中の lim check の行（制作アプリの書き出しの画面と同じ表）
  const built = englishBuildLine(text);
  if (built !== text && !JAPANESE.test(built)) return built;
  // 差し込んだ診断の文（「構文エラーがあります（3 行目: …）」の … など。@liminalia/lang の診断の表）
  const diagnostic = translateDiagnosticText(text);
  if (diagnostic !== null && !JAPANESE.test(diagnostic)) return diagnostic;
  return first ?? (built !== text ? built : diagnostic);
}

/**
 * 差し込む部分。日本語の文や言葉（「なし」など）なら、それも訳す。「、」と「 / 」で並べたものは、どれも訳せるか日本語を含まないときだけ一つずつ訳す
 * （作品の本文や名前の日本語は、そのまま残す）。
 */
function part(value: string, depth: number): string {
  if (!JAPANESE.test(value) && !value.includes("、")) return value;
  const trimmed = value.trim();
  if (depth < 4) {
    const whole = translate(trimmed, depth + 1);
    if (whole !== null) return value.replace(trimmed, whole);
    // 並べたもの（「a、b」と「a / b」）は、一つずつ訳す
    for (const [sep, en] of [["、", ", "], [" / ", " / "]] as const) {
      if (!trimmed.includes(sep)) continue;
      const items = trimmed.split(sep).map((item) => (JAPANESE.test(item) ? translate(item.trim(), depth + 1) : item));
      if (items.every((item) => item !== null)) return value.replace(trimmed, items.join(en));
    }
  }
  return value;
}

/** 頭の空白と印（「● 」「- 」「→ 」「lim: 」「lim 命令: 」、GitHub Actions の注釈の「::error …::」、「\r」）を分ける。 */
const HEAD = /^(\r?\s*(?:(?:● |- |→ )|lim(?: [A-Za-z][A-Za-z0-9-]*)?: |::(?:error|warning|notice)[^:]*::)?\s*)(.*?)(\s*)$/su;

/** 一行を英語にする。訳せなければそのまま。 */
export function englishLine(line: string): string {
  if (!JAPANESE.test(line)) return line;
  const m = HEAD.exec(line);
  const head = m?.[1] ?? "";
  const body = m?.[2] ?? line;
  const tail = m?.[3] ?? "";
  if (body === "") return line;
  const done = translate(body, 0);
  return done === null ? line : `${head}${done}${tail}`;
}

/** JSON の文字（--json の出力）か。 */
function isJson(text: string): boolean {
  if (!/^\s*[{[]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    // JSON として読めなければ、ふつうの文として訳す（「[プラグイン] …」など）
    return false;
  }
}

/** 文（複数の行でもよい）を英語にする。まとまりで表にあればそれ、無ければ一行ずつ。JSON（--json の出力）は変えない。 */
export function englishText(text: string): string {
  if (!JAPANESE.test(text)) return text;
  if (isJson(text)) return text;
  if (!text.includes("\n")) return englishLine(text);
  // 複数の行の形が表にあればそれ（日本語が残らないときだけ）、無ければ一行ずつ。前後の空白と空けた行（console.log(`\n…`)）は残す
  const trimmed = text.trim();
  const whole = translate(trimmed, 0);
  if (whole !== null && !JAPANESE.test(whole)) {
    const start = text.indexOf(trimmed);
    return `${text.slice(0, start)}${whole}${text.slice(start + trimmed.length)}`;
  }
  return text.split("\n").map(englishLine).join("\n");
}

/** 出力を英語にしているか（installEnglishOutput を lim の console に当てたあと）。 */
let english = false;

/** 同じ行を書き換えて進める経過（「\r撮影 3 / 10 …」）。console を通らないので、ここで英語にする。 */
export function writeProgress(text: string): void {
  process.stdout.write(`\r${english ? englishLine(text) : text}`);
}

/**
 * これから出す console の文（log、info、warn、error、debug）を英語にする。作品の中身を標準出力へそのまま書く命令
 * （process.stdout.write を使う lim prose extract、lim reference など）は変えない。
 */
export function installEnglishOutput(target: Pick<Console, "log" | "info" | "warn" | "error" | "debug"> = console): void {
  if (target === console) english = true;
  for (const name of ["log", "info", "warn", "error", "debug"] as const) {
    const original = target[name].bind(target);
    target[name] = (...args: unknown[]) => {
      if (args.length === 0) return original();
      // 文字だけのときに限って読み替える（オブジェクトを渡したときは、整えた形をそのまま）
      if (args.every((a) => typeof a === "string" || typeof a === "number")) return original(englishText(format(...args)));
      return original(...args);
    };
  }
}
