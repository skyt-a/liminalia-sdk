import type { Diagnostic } from "./ast.ts";

/** UTF-8 の BOM（U+FEFF）。Windows のメモ帳などが台本と JSON の頭に付ける。 */
export const BOM = "\uFEFF";

/**
 * 頭の BOM を一つ外した中身と、外した BOM（無ければ ""）。台本と設定の JSON の頭の BOM は、ここだけで外す
 * （parse、下書きの見分け、整形、設定の JSON。ブラウザの fetch の text() も外すので、遊ぶ側と同じ読み方になる）。
 * 書き戻すときは bom を頭に付け直す。
 */
export function splitBom(text: string): { bom: string; text: string } {
  return text.startsWith(BOM) ? { bom: BOM, text: text.slice(1) } : { bom: "", text };
}

/** 頭の BOM を一つ外した中身（splitBom）。 */
export function stripBom(text: string): string {
  return splitBom(text).text;
}

/**
 * 台本のバイト列が UTF-8 として読めるか。読めなければ、ありそうな文字コードの名前（UTF-16・Shift_JIS・EUC-JP。分からなければ "?"）を返す。
 * 読めれば null。Shift_JIS で保存した .lim を化けたまま読まないために使う（lim check・lim trace・lim coverage・作品の台本の読み込み）。
 */
export function scenarioEncoding(bytes: Uint8Array): string | null {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return "UTF-16";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return null;
  } catch {
    // UTF-8 ではない。ありそうな文字コードを当てる
  }
  for (const [label, name] of [
    ["shift_jis", "Shift_JIS"],
    ["euc-jp", "EUC-JP"],
  ] as const) {
    try {
      new TextDecoder(label, { fatal: true }).decode(bytes);
      return name;
    } catch {
      // 次を試す
    }
  }
  return "?";
}

/** UTF-8 で読めない台本の診断（bad-encoding）。encoding は scenarioEncoding の返した名前。 */
export function encodingDiagnostic(file: string, encoding: string): Diagnostic {
  return {
    severity: "error",
    code: "bad-encoding",
    message: encoding === "?" ? "このファイルは UTF-8 で読めません（文字コードが分かりません）" : `このファイルは UTF-8 で読めません（${encoding} で保存されているようです）`,
    file,
    line: 1,
    hint: "エディタで文字コードを UTF-8 にして保存し直します",
  };
}

/**
 * 作品を書き換える命令（名前の変更、整形、lim migrate、lim i18n、lim prose など）が、UTF-8 で読めないシナリオファイルを見つけて
 * 何も書かずに止めるときの文。files はシナリオファイルの名前（拡張子なし）。化けたまま書き戻すと元に戻せないので、書く前に止める。
 */
export function notUtf8StopMessage(files: readonly string[], language: "ja" | "en" = "ja"): string {
  if (language === "en") {
    const one = files.length === 1;
    return `Nothing was rewritten because ${one ? "a script file isn't" : "some script files aren't"} UTF-8: ${files.map((f) => `${f}.lim`).join(", ")}. Save ${one ? "it" : "them"} as UTF-8 in an editor, then run this again`;
  }
  return `UTF-8 で読めないシナリオファイルがあるため、何も書き換えませんでした: ${files.map((f) => `${f}.lim`).join("、")}。エディタで UTF-8 で保存し直してから、もう一度実行します`;
}
