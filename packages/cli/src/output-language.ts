/**
 * lim の出力（使い方、断り、経過）の言語の決め方。どの命令もここで決める（main.ts が一度だけ呼ぶ）。
 *
 * 1. `--lang`（en か ja。ほかの言語、たとえば lim shot の遊ぶ言語の ko は、出力の言語を決めないので次へ）
 * 2. 環境変数 `LIMINALIA_LANG`（en か ja）
 * 3. 端末の言語（`LC_ALL`、`LC_MESSAGES`、`LANG` の順に、空でない最初のもの）。ja で始まれば日本語、`C` と `POSIX` は決めない、ほかは英語
 * 4. どれでも決まらなければ日本語
 */
export type OutputLanguage = "ja" | "en";

/** en か ja を表す値なら、その言語（en-US、ja_JP.UTF-8 なども）。ほかは null。 */
function named(value: string | undefined): OutputLanguage | null {
  const v = value?.trim().toLowerCase() ?? "";
  if (/^en(?:[-_.@]|$)/.test(v)) return "en";
  if (/^ja(?:[-_.@]|$)/.test(v)) return "ja";
  return null;
}

/** 端末の言語（LC_ALL、LC_MESSAGES、LANG）から。決まらなければ null。 */
function terminalLanguage(env: Readonly<Record<string, string | undefined>>): OutputLanguage | null {
  const value = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v !== undefined && v.trim() !== "")?.trim();
  if (value === undefined) return null;
  // C と POSIX（C.UTF-8 も）は言語を選んでいない
  if (/^(c|posix)(?:[.@]|$)/i.test(value)) return null;
  return named(value) ?? "en";
}

/** 出力の言語。flag は --lang の値（無ければ undefined）。 */
export function outputLanguage(flag: string | undefined, env: Readonly<Record<string, string | undefined>> = process.env): OutputLanguage {
  return named(flag) ?? named(env.LIMINALIA_LANG) ?? terminalLanguage(env) ?? "ja";
}

/** 引数の中の --lang の値（--lang=値 の形も。最後に書いたものを使う。無ければ undefined）。 */
export function langFlag(args: readonly string[]): string | undefined {
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--lang" && args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) out = args[++i];
    else if (a.startsWith("--lang=")) out = a.slice("--lang=".length);
  }
  return out;
}
