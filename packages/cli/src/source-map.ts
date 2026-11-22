/**
 * ソースマップ（版 3）を読み、縮めた束の位置を元のファイルと行と桁に戻す（lim crash。道具を足さずに、mappings の VLQ をここで読む）。
 * 行と桁は 1 から数える（ブラウザの例外の行と桁と同じ）。ソースマップの中の桁は 0 から。
 */

export interface SourceMap {
  sources: string[];
  names: string[];
  /** 生成した行ごとの区切り（生成した桁、元のファイルの番号、元の行、元の桁、名前の番号。どれも 0 から。桁の小さい順）。 */
  lines: number[][][];
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Map([...BASE64].map((c, i) => [c, i]));

/** 一つの区切りの VLQ を数の並びにする。読めない字があれば null。 */
function decodeSegment(text: string): number[] | null {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const c of text) {
    const d = DIGIT.get(c);
    if (d === undefined) return null;
    value += (d & 31) << shift;
    if (d & 32) {
      shift += 5;
      continue;
    }
    out.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return out;
}

/** ソースマップの JSON を読む（sections のある索引の形は扱わない）。読めなければ例外。 */
export function parseSourceMap(json: string): SourceMap {
  const raw = JSON.parse(json) as { version?: number; sources?: unknown; names?: unknown; mappings?: unknown; sourceRoot?: unknown };
  if (typeof raw.mappings !== "string" || !Array.isArray(raw.sources)) throw new Error("ソースマップとして読めません（mappings と sources がありません）");
  const root = typeof raw.sourceRoot === "string" && raw.sourceRoot !== "" ? raw.sourceRoot.replace(/\/?$/, "/") : "";
  const sources = raw.sources.map((s) => `${root}${typeof s === "string" ? s : ""}`);
  const names = Array.isArray(raw.names) ? raw.names.map((n) => (typeof n === "string" ? n : "")) : [];
  const lines: number[][][] = [];
  let source = 0;
  let line = 0;
  let column = 0;
  let name = 0;
  for (const row of raw.mappings.split(";")) {
    const segments: number[][] = [];
    let generated = 0;
    for (const part of row.split(",")) {
      if (part === "") continue;
      const v = decodeSegment(part);
      if (!v || v.length === 0) continue;
      generated += v[0]!;
      if (v.length >= 4) {
        source += v[1]!;
        line += v[2]!;
        column += v[3]!;
        if (v.length >= 5) name += v[4]!;
        segments.push(v.length >= 5 ? [generated, source, line, column, name] : [generated, source, line, column]);
      }
    }
    segments.sort((a, b) => a[0]! - b[0]!);
    lines.push(segments);
  }
  return { sources, names, lines };
}

/** 元の位置（行と桁は 1 から）。 */
export interface OriginalPosition {
  source: string;
  line: number;
  column: number;
  name?: string;
}

/** 束の位置（行と桁は 1 から）を元の位置にする。その行に当たる区切りが無ければ null。 */
export function originalPosition(map: SourceMap, line: number, column: number): OriginalPosition | null {
  const segments = map.lines[line - 1];
  if (!segments || segments.length === 0) return null;
  const col = column - 1;
  // 桁がその位置より前のうち、いちばん近い区切り（無ければその行の最初の区切り）
  let found = segments[0]!;
  for (const s of segments) {
    if (s[0]! > col) break;
    found = s;
  }
  const source = map.sources[found[1]!];
  if (source === undefined) return null;
  const name = found[4] !== undefined ? map.names[found[4]] : undefined;
  return { source, line: found[2]! + 1, column: found[3]! + 1, ...(name ? { name } : {}) };
}
