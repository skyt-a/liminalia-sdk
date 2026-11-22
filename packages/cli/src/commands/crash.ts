import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadProject } from "@liminalia/project";
import { originalPosition, parseSourceMap, type OriginalPosition, type SourceMap } from "../source-map.ts";
import { SOURCEMAPS } from "./clean.ts";

/**
 * lim crash [プロジェクト] <記録.json> [--maps フォルダ] [--json] [--lang en]
 * 書き出したゲームの止まったときの記録（packages/web/src/crash.ts の CrashRecord。build.crashReport.url で受けたものか、デスクトップ版の logs/ のファイル）の
 * プログラムの位置（source と stack）を、書き出しのソースマップ（build.sourcemap: "separate" の <書き出し先>/sourcemaps/<名前>-<日時>/）で元のファイルと行に戻し、
 * 台本の位置（最後に出したページ、実行中の命令、止まる前のページ、実行時の診断）と並べて出す。
 * ソースマップの控えは記録の build（書き出した日時）で選ぶ（フォルダの名前の日時は、ISO の日時の : と . を - にしたもの）。--maps で控えのフォルダを指定できる。
 * 位置を戻せたら true、合う控えが無いか一つも戻せなければ false（台本の位置はどちらでも出す）。
 */

/** 記録のうち、ここで読むもの。 */
interface CrashRecordLike {
  message?: unknown;
  stack?: unknown;
  kind?: unknown;
  source?: unknown;
  at?: unknown;
  step?: unknown;
  trail?: unknown;
  diagnostics?: unknown;
  version?: unknown;
  build?: unknown;
  engine?: unknown;
  platform?: unknown;
  date?: unknown;
}

/** 束の中の位置（file は書き出したフォルダからのパス。engine/index-abc.js など）。 */
export interface BundlePosition {
  file: string;
  line: number;
  column: number;
}

/** 文の中の、束の位置（URL か パス:行:桁）。 */
const POSITION = /([^\s()@]+?\.m?js):(\d+):(\d+)/g;

/** URL やパスを、書き出したフォルダからのパスにする（engine/ より後ろ。無ければファイルの名前）。 */
function bundleFile(url: string): string {
  const path = url.replace(/\\/g, "/").replace(/[?#].*$/, "");
  const at = path.lastIndexOf("/engine/");
  if (at >= 0) return path.slice(at + 1);
  return path.slice(path.lastIndexOf("/") + 1);
}

function positionsIn(text: string): BundlePosition[] {
  return [...text.matchAll(POSITION)].map((m) => ({ file: bundleFile(m[1]!), line: Number(m[2]), column: Number(m[3]) }));
}

/** 記録の source と stack から、束の位置を出てくる順に拾う（同じ位置は一つにする）。 */
export function crashPositions(record: { source?: unknown; stack?: unknown }): BundlePosition[] {
  const out: BundlePosition[] = [];
  const seen = new Set<string>();
  for (const p of [...(typeof record.source === "string" ? positionsIn(record.source) : []), ...(typeof record.stack === "string" ? positionsIn(record.stack) : [])]) {
    const key = `${p.file}:${p.line}:${p.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** ソースマップの控えのフォルダ（記録の書き出した日時に合うもの）。無ければ null。 */
export function mapsForBuild(out: string, build: string): string | null {
  const base = join(out, SOURCEMAPS);
  if (!existsSync(base)) return null;
  const suffix = `-${build.replace(/[:.]/g, "-")}`;
  const found = readdirSync(base)
    .filter((n) => n.endsWith(suffix) && statSync(join(base, n)).isDirectory())
    .sort();
  return found.length > 0 ? join(base, found.at(-1)!) : null;
}

/** フォルダの中のファイル（名前で）を探す。 */
function findFile(dir: string, name: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      const inner = findFile(path, name);
      if (inner) return inner;
    } else if (e.name === name) return path;
  }
  return null;
}

/** 元のファイルの見せ方（束の場所から上へたどる ../ を外す）。 */
const shownSource = (s: string) => s.replace(/^(?:webpack:\/\/\/?|\.\.?\/)+/, "").replace(/^(?:\.\.\/)+/, "");

/** 位置を戻す（その束のソースマップを読む。読めなければ null）。 */
class Mapper {
  private readonly cache = new Map<string, SourceMap | null>();
  constructor(private readonly dir: string) {}
  original(p: BundlePosition): OriginalPosition | null {
    if (!this.cache.has(p.file)) {
      const direct = join(this.dir, `${p.file}.map`);
      const path = existsSync(direct) ? direct : findFile(this.dir, `${p.file.slice(p.file.lastIndexOf("/") + 1)}.map`);
      let map: SourceMap | null = null;
      if (path) {
        try {
          map = parseSourceMap(readFileSync(path, "utf8"));
        } catch {
          // 読めないソースマップは無いものとして扱う（位置は戻さずに出す）
          map = null;
        }
      }
      this.cache.set(p.file, map);
    }
    const map = this.cache.get(p.file);
    const at = map ? originalPosition(map, p.line, p.column) : null;
    return at ? { ...at, source: shownSource(at.source) } : null;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const textOf = (v: unknown): string => (typeof v === "string" ? v : "");
const posText = (p: BundlePosition) => `${p.file}:${p.line}:${p.column}`;
const origText = (o: OriginalPosition) => `${o.source}:${o.line}:${o.column}${o.name ? ` (${o.name})` : ""}`;

export async function runCrash(dir: string, recordPath: string, o: { maps?: string; json?: boolean; language?: "ja" | "en" | string }): Promise<boolean> {
  const en = o.language === "en";
  const project = loadProject(dir);
  const path = resolve(recordPath);
  let record: CrashRecordLike;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as CrashRecordLike;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(en ? `Can't read the crash record ${recordPath} as JSON: ${why}` : `止まったときの記録 ${recordPath} を JSON として読めません: ${why}`);
  }
  const build = textOf(record.build);
  const maps = o.maps ? resolve(o.maps) : build ? mapsForBuild(project.paths.out, build) : null;
  if (o.maps && !existsSync(maps!)) throw new Error(en ? `The source map folder ${o.maps} doesn't exist` : `ソースマップのフォルダ ${o.maps} がありません`);
  const mapper = maps ? new Mapper(maps) : null;
  const sourcePos = typeof record.source === "string" ? positionsIn(record.source)[0] : undefined;
  const source = sourcePos ? { ...sourcePos, ...(mapper?.original(sourcePos) ? { original: mapper.original(sourcePos)! } : {}) } : undefined;
  const stack = textOf(record.stack)
    .split("\n")
    .map((l) => l.trim())
    .flatMap((l) => {
      const p = positionsIn(l)[0];
      if (!p) return [];
      const original = mapper?.original(p);
      return [{ text: l, ...p, ...(original ? { original } : {}) }];
    });
  const mapped = !!source?.original || stack.some((s) => s.original);
  const shownMaps = maps ? relative(project.root, maps) || maps : null;
  const script = {
    at: textOf(record.at),
    ...(typeof record.step === "string" ? { step: record.step } : {}),
    trail: strings(record.trail),
    diagnostics: strings(record.diagnostics),
  };
  if (o.json) {
    console.log(
      JSON.stringify(
        {
          ok: mapped,
          message: textOf(record.message),
          kind: textOf(record.kind),
          version: textOf(record.version),
          build,
          maps: shownMaps,
          ...(source ? { source } : {}),
          stack,
          ...script,
        },
        null,
        2,
      ),
    );
    return mapped;
  }
  const kind = record.kind === "rejection" ? (en ? "unhandled Promise rejection" : "捕まえていない Promise の拒否") : en ? "uncaught exception" : "捕まえていない例外";
  console.log(en ? `Crash record: ${textOf(record.message)} (${kind})` : `止まったときの記録: ${textOf(record.message)}（${kind}）`);
  const facts = [
    record.version ? (en ? `version ${textOf(record.version)}` : `プロジェクトのバージョン ${textOf(record.version)}`) : "",
    build ? (en ? `exported ${build}` : `書き出した日時 ${build}`) : "",
    record.engine ? (en ? `engine ${textOf(record.engine)}` : `エンジン ${textOf(record.engine)}`) : "",
    record.platform ? (en ? `on ${textOf(record.platform)}` : `遊んでいた所 ${textOf(record.platform)}`) : "",
    record.date ? (en ? `at ${textOf(record.date)}` : `日時 ${textOf(record.date)}`) : "",
  ].filter(Boolean);
  if (facts.length > 0) console.log(`  ${facts.join(en ? ", " : "、")}`);
  if (shownMaps) console.log(en ? `Source maps: ${shownMaps}` : `ソースマップ: ${shownMaps}`);
  else if (build) {
    console.log(
      en
        ? `No source map copy for the export time ${build} in ${relative(project.root, join(project.paths.out, SOURCEMAPS)) || SOURCEMAPS} (only exports with build.sourcemap set to "separate" keep one; give the folder with --maps)`
        : `書き出した日時 ${build} に合うソースマップの控えが ${relative(project.root, join(project.paths.out, SOURCEMAPS)) || SOURCEMAPS} にありません（build.sourcemap を "separate" にして書き出したものだけ残ります。--maps で控えのフォルダを指定できます）`,
    );
  } else console.log(en ? "The record has no export time (build), so give the source map folder with --maps" : "記録に書き出した日時（build）が無いので、--maps でソースマップの控えのフォルダを指定します");
  if (source) console.log(`${en ? "Where it was thrown" : "例外が出た所"}: ${posText(source)}${source.original ? ` → ${origText(source.original)}` : ""}`);
  if (stack.length > 0) {
    console.log(en ? "Stack:" : "スタック:");
    for (const s of stack) console.log(`  ${s.text}${s.original ? `\n    → ${origText(s.original)}` : ""}`);
  }
  console.log(en ? "Script position:" : "台本の位置:");
  console.log(`  ${en ? "Last page shown" : "最後に出したページ"}: ${script.at || (en ? "(unknown)" : "（分からない）")}`);
  if (script.step) console.log(`  ${en ? "Command running" : "実行中の命令"}: ${script.step}`);
  if (script.trail.length > 0) console.log(`  ${en ? "Pages before it stopped" : "止まる前のページ"}: ${script.trail.join(" → ")}`);
  if (script.diagnostics.length > 0) {
    console.log(`  ${en ? "Runtime diagnostics" : "実行時の診断"}:`);
    for (const d of script.diagnostics) console.log(`    ${d}`);
  }
  return mapped;
}
