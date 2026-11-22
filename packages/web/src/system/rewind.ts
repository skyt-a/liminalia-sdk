import type { SaveData } from "@liminalia/runtime";

/**
 * セーブに入れる巻き戻しの記録（直近のページの頭のセーブ）を小さくするための差分。
 * スロットのセーブ（基）との違いだけを、上から何段かまでたどって持つ（変数一つ、立ち絵一人だけが違えば、そこだけを書く）。
 * set は [道のり, 値]、del は基にあって無くなった道のり。配列は丸ごと一つの値として扱う。
 */
export interface SaveDelta {
  set: [string[], unknown][];
  del?: string[][];
}

/** 差分を取る深さ（save.stage.sprites.<名前> まで）。 */
const DEPTH = 4;

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function diff(base: Plain, next: Plain, path: string[], out: SaveDelta, depth: number): void {
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    const before = base[key];
    if (!(key in base) || before === undefined) out.set.push([[...path, key], value]);
    else if (same(before, value)) continue;
    else if (depth < DEPTH && isPlain(before) && isPlain(value)) diff(before, value, [...path, key], out, depth + 1);
    else out.set.push([[...path, key], value]);
  }
  for (const key of Object.keys(base)) if (base[key] !== undefined && (!(key in next) || next[key] === undefined)) (out.del ??= []).push([...path, key]);
}

/** save を base との差分にする。 */
export function packSave(base: SaveData, save: SaveData): SaveDelta {
  const out: SaveDelta = { set: [] };
  diff(base as unknown as Plain, save as unknown as Plain, [], out, 0);
  return structuredClone(out);
}

/** 差分を base に当てて、元のセーブに戻す。形が崩れていれば null。 */
export function unpackSave(base: SaveData, delta: unknown): SaveData | null {
  if (!isDelta(delta)) return null;
  const out = structuredClone(base) as unknown as Plain;
  const parent = (path: string[], make: boolean): Plain | null => {
    let o: Plain = out;
    for (const key of path.slice(0, -1)) {
      let next = o[key];
      if (!isPlain(next)) {
        if (!make) return null;
        next = o[key] = {};
      }
      o = next as Plain;
    }
    return o;
  };
  for (const path of delta.del ?? []) {
    const o = parent(path, false);
    if (o) delete o[path.at(-1)!];
  }
  for (const [path, value] of delta.set) parent(path, true)![path.at(-1)!] = structuredClone(value);
  return out as unknown as SaveData;
}

function isPath(p: unknown): p is string[] {
  return Array.isArray(p) && p.length > 0 && p.every((k) => typeof k === "string" && k !== "__proto__");
}

function isDelta(d: unknown): d is SaveDelta {
  if (!isPlain(d) || !Array.isArray(d.set)) return false;
  if (!d.set.every((e) => Array.isArray(e) && e.length === 2 && isPath(e[0]))) return false;
  return d.del === undefined || (Array.isArray(d.del) && d.del.every(isPath));
}
