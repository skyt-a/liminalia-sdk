import { createHash } from "node:crypto";
import type { LineOrigin } from "./convert.ts";

/**
 * 取り込みの対応表（ソースマップ）。書き出した .lim の各行が、.ks のどのファイル・どの行から来たか。
 * lim import が import-sourcemap.json に書き出し、書き戻し（lim backport）が .lim の変更を .ks の位置に当てるのに使う。
 *
 * - files のキーは書き出した .lim（シナリオの出力先からのパス）
 * - lines[i] は .lim の i+1 行目の出どころ。空行・@use など .ks に対応しない行は null
 * - 出どころの from / to は .ks の行の範囲（1 始まり、両端を含む）、tags は compile の命令の位置（本文の行では省く）
 */
export interface ImportSourceMap {
  version: 1;
  files: Record<string, SourceMapFile>;
}

export interface SourceMapFile {
  /** 取り込み元の .ks（data/scenario からのパス）。マクロを集めたファイルは null（行の対応を持たない）。 */
  source: string | null;
  /** 取り込み元の .ks の SHA-256。書き戻しで、基準の .ks が取り込んだときのものと同じかを確かめる。 */
  sourceHash: string | null;
  /** 書き出した .lim の SHA-256。 */
  limHash: string;
  lines: (LineOrigin | null)[];
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 対応表を JSON にする。行ごとの出どころは一行ずつ（差分が読めるように）。 */
export function formatSourceMap(map: ImportSourceMap): string {
  const files = Object.entries(map.files).map(([name, f]) => {
    const head = `    ${JSON.stringify(name)}: {\n      "source": ${JSON.stringify(f.source)},\n      "sourceHash": ${JSON.stringify(f.sourceHash)},\n      "limHash": ${JSON.stringify(f.limHash)},\n`;
    const lines = f.lines.length === 0 ? `      "lines": []` : `      "lines": [\n${f.lines.map((l) => `        ${JSON.stringify(l)}`).join(",\n")}\n      ]`;
    return `${head}${lines}\n    }`;
  });
  return `{\n  "version": ${map.version},\n  "files": {\n${files.join(",\n")}\n  }\n}\n`;
}

export function parseSourceMap(text: string): ImportSourceMap {
  const map = JSON.parse(text) as ImportSourceMap;
  if (map.version !== 1 || typeof map.files !== "object") throw new Error("対応表の形が違います（version 1 の import-sourcemap.json ではありません）");
  return map;
}
