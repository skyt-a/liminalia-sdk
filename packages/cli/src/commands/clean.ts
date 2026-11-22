import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { loadProject } from "@liminalia/project";

/**
 * 日時付きで溜まる書き出し（<out>/mac/<名前>_<日時>/ など）の片付け。lim clean と、liminalia.json の build.keep（書き出しのたび）が使う。
 * 消すのは <out>/<書き出し先>/ の直下の「名前_YYYYMMDD_HHMMSS」（Android は .apk・.aab も）だけで、同じ名前（版ごとの名前も別に数える）の
 * 新しいものから keep 件を残す。ブラウザ版（<out>/browser/<id>。毎回上書き）、パッチ、アップデートの配信物には触らない。
 * ソースマップの控え（build.sourcemap: "separate" の <out>/sourcemaps/<名前>-<日時>/）も同じく名前ごとに数える（build.keepSourcemaps）。
 */

/** 日時付きで書き出す先。 */
export const STAMPED_TARGETS = ["mac", "windows", "linux", "android", "ios"] as const;
export type StampedTarget = (typeof STAMPED_TARGETS)[number];

const STAMPED = /^(.+)_(\d{8}_\d{6})(\.apk|\.aab)?$/;

/** ソースマップの控えを置くフォルダ（<out>/sourcemaps）。lim clean の --target の名前にもなる。 */
export const SOURCEMAPS = "sourcemaps";
/** ソースマップの控えのフォルダの名前（<ブラウザ版の名前>-<書き出した日時の ISO の : と . を - にしたもの>。build.ts）。 */
const SOURCEMAP_STAMPED = /^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/;

export interface OldBuild {
  target: StampedTarget | typeof SOURCEMAPS;
  /** 名前（日時の前。版ごとの名前を含む）。 */
  name: string;
  stamp: string;
  path: string;
  bytes: number;
}

function sizeOf(path: string): number {
  const s = statSync(path, { throwIfNoEntry: false });
  if (!s) return 0;
  if (!s.isDirectory()) return s.size;
  let n = 0;
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    if (e.isSymbolicLink()) continue;
    n += e.isDirectory() ? sizeOf(p) : statSync(p).size;
  }
  return n;
}

/** out の中の、keep 件より古い書き出し。protect のパス（今回書き出したもの）は数えるが消さない。 */
export function oldBuilds(out: string, keep: number, targets: readonly StampedTarget[] = STAMPED_TARGETS, protect: readonly string[] = []): OldBuild[] {
  if (!Number.isInteger(keep) || keep < 0) throw new Error(`残す数は 0 以上の整数で指定してください: ${keep}`);
  const found: OldBuild[] = [];
  for (const target of targets) {
    const dir = join(out, target);
    if (!existsSync(dir)) continue;
    const groups = new Map<string, { name: string; stamp: string; path: string }[]>();
    for (const entry of readdirSync(dir)) {
      const m = STAMPED.exec(entry);
      if (!m) continue;
      // Android は .apk と .aab を別に数える（同じ書き出しの両方を残す）
      const key = `${m[1]}${m[3] ?? ""}`;
      const list = groups.get(key) ?? [];
      list.push({ name: m[1]!, stamp: m[2]!, path: join(dir, entry) });
      groups.set(key, list);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => b.stamp.localeCompare(a.stamp));
      for (const b of list.slice(keep)) if (!protect.includes(b.path)) found.push({ target, ...b, bytes: sizeOf(b.path) });
    }
  }
  return found;
}

/** ソースマップの控えのうち、名前ごとに新しい keep 件より古いもの。protect のパス（今回残したもの）は数えるが消さない。 */
export function oldSourceMaps(out: string, keep: number, protect: readonly string[] = []): OldBuild[] {
  if (!Number.isInteger(keep) || keep < 0) throw new Error(`残す数は 0 以上の整数で指定してください: ${keep}`);
  const dir = join(out, SOURCEMAPS);
  if (!existsSync(dir)) return [];
  const groups = new Map<string, { name: string; stamp: string; path: string }[]>();
  for (const entry of readdirSync(dir)) {
    const m = SOURCEMAP_STAMPED.exec(entry);
    if (!m) continue;
    const list = groups.get(m[1]!) ?? [];
    list.push({ name: m[1]!, stamp: m[2]!, path: join(dir, entry) });
    groups.set(m[1]!, list);
  }
  const found: OldBuild[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.stamp.localeCompare(a.stamp));
    for (const b of list.slice(keep)) if (!protect.includes(b.path)) found.push({ target: SOURCEMAPS, ...b, bytes: sizeOf(b.path) });
  }
  return found;
}

/** 古いソースマップの控えを消し、消したものを返す。dryRun なら消さずに返す。 */
export function pruneSourceMaps(out: string, keep: number, o: { protect?: readonly string[]; dryRun?: boolean } = {}): OldBuild[] {
  const old = oldSourceMaps(out, keep, o.protect);
  if (!o.dryRun) for (const b of old) rmSync(b.path, { recursive: true, force: true });
  return old;
}

/**
 * ソースマップの控えを残す数（build.keepSourcemaps。省くと書き出しと同じ buildKeep）。0 なら片付けない（null）。
 * 配った版の止まったときの記録を読むために多めに残すなら、build.keepSourcemaps を書く。
 */
export function keepSourceMaps(keep: unknown, buildKeep: number | null): number | null {
  if (keep === undefined) return buildKeep;
  if (typeof keep !== "number" || !Number.isInteger(keep) || keep < 0) throw new Error(`残すソースマップの控えの数（build.keepSourcemaps）は 0 以上の整数で書きます（0 は片付けない）: ${String(keep)}`);
  return keep === 0 ? null : keep;
}

/** 古い書き出しを消し、消したものを返す。dryRun なら消さずに返す。 */
export function pruneBuilds(out: string, keep: number, o: { targets?: readonly StampedTarget[]; protect?: readonly string[]; dryRun?: boolean } = {}): OldBuild[] {
  const old = oldBuilds(out, keep, o.targets, o.protect);
  if (!o.dryRun) for (const b of old) rmSync(b.path, { recursive: true, force: true });
  return old;
}

export function formatBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1e3))} KB`;
}

/** 書き出しのたびに残す数の既定（build.keep を書かないとき。名前ごとに新しいものから）。 */
export const DEFAULT_KEEP = 3;

/**
 * 書き出しのたびに残す数（環境変数 LIMINALIA_KEEP、build.keep、既定 DEFAULT_KEEP の順）。0 なら片付けない（null を返す）。
 * 0 以上の整数でなければ理由を投げる。
 */
export function keepAfterBuild(keep: unknown, env: string | undefined): number | null {
  const raw = (env ?? "").trim();
  const n = raw === "" ? (keep ?? DEFAULT_KEEP) : Number(raw);
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new Error(`残す書き出しの数（build.keep か LIMINALIA_KEEP）は 0 以上の整数で書きます（0 は片付けない）: ${String(n)}`);
  return n === 0 ? null : n;
}

/**
 * lim clean [プロジェクト] [--keep N] [--target mac,windows,sourcemaps] [--dry-run]。keep は省くと build.keep（0 なら 1）、それも無ければ 1。
 * ソースマップの控え（sourcemaps）の keep は、省くと build.keepSourcemaps（0 なら 1）、無ければ書き出しと同じ数。
 */
export function runClean(dir: string, o: { keep?: number; targets?: string[]; dryRun?: boolean }): boolean {
  const project = loadProject(dir);
  const config = project.config.build;
  const keep = o.keep ?? (config?.keep || 1);
  const known = [...STAMPED_TARGETS, SOURCEMAPS] as readonly string[];
  const bad = (o.targets ?? []).filter((t) => !known.includes(t));
  if (bad.length > 0) throw new Error(`--target に ${bad.join("、")} は使えません（${known.join(" / ")}）`);
  const chosen = o.targets?.length ? o.targets : known;
  const targets = chosen.filter((t): t is StampedTarget => (STAMPED_TARGETS as readonly string[]).includes(t));
  const mapsKeep = o.keep ?? (config?.keepSourcemaps || keep);
  const maps = chosen.includes(SOURCEMAPS) && mapsKeep !== keep ? `（ソースマップの控えは ${mapsKeep} 件）` : "";
  const old = [
    ...(targets.length > 0 ? pruneBuilds(project.paths.out, keep, { targets, ...(o.dryRun ? { dryRun: true } : {}) }) : []),
    ...(chosen.includes(SOURCEMAPS) ? pruneSourceMaps(project.paths.out, mapsKeep, o.dryRun ? { dryRun: true } : {}) : []),
  ];
  if (old.length === 0) {
    console.log(`片付ける書き出しはありません（${relative(process.cwd(), project.paths.out) || "."} の中で、名前ごとに新しい ${keep} 件${maps}を残します）`);
    return true;
  }
  for (const b of old) console.log(o.dryRun ? `消すもの: ${relative(process.cwd(), b.path)}（${formatBytes(b.bytes)}）` : `消しました: ${relative(process.cwd(), b.path)}（${formatBytes(b.bytes)}）`);
  const total = old.reduce((n, b) => n + b.bytes, 0);
  console.log(o.dryRun ? `\n${old.length} 件、${formatBytes(total)} を消せます（--dry-run を外すと消します）。名前ごとに新しい ${keep} 件${maps}を残しています` : `\n${old.length} 件、${formatBytes(total)} を片付けました。名前ごとに新しい ${keep} 件${maps}を残しています`);
  return true;
}
