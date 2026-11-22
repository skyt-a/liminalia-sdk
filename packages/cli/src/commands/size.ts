import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { extractFile, listPackage, statFile } from "@electron/asar";
import { mediaKindOf } from "@liminalia/lang";
import { loadProject } from "@liminalia/project";
import { formatBytes, STAMPED_TARGETS } from "./clean.ts";

/**
 * lim size [プロジェクト] [書き出したもの] [--top 20] [--json] — 書き出しの大きさの内訳（種類別、フォルダ別、大きいファイル）。
 * 書き出したもの（ブラウザ版のフォルダ、Mac のアプリ、Windows・Linux 版のフォルダ、それらを入れた日時付きのフォルダ）を省くと、
 * 書き出し先（paths.out）の中で一番新しいもの。デスクトップ版の assets.asar は中を数える。
 */

export interface SizeEntry {
  /** 書き出しの中のパス（asar の中は assets.asar/…）。 */
  path: string;
  bytes: number;
}

export type SizeKind = "image" | "audio" | "video" | "font" | "other-asset" | "scenario" | "engine" | "runtime";

export interface SizeReport {
  root: string;
  total: number;
  kinds: Record<SizeKind, number>;
  /** 素材のフォルダ（bgimage・voice など）、エンジン、Electron などの合計。 */
  folders: { folder: string; bytes: number }[];
  largest: SizeEntry[];
}

const KIND_NAMES: Record<SizeKind, string> = { image: "画像", audio: "音", video: "動画", font: "フォント", "other-asset": "ほかの素材", scenario: "シナリオとデータ", engine: "エンジン（プレイヤー）", runtime: "アプリの実行環境（Electron など）" };

/** フォルダの中のファイル（リンクは数えない。asar（assets.asar・app.asar）は中のファイルにほどく）。 */
export function listSized(root: string): SizeEntry[] {
  const out: SizeEntry[] = [];
  const visit = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith(".asar")) {
        for (const f of listPackage(p, { isPack: false })) {
          const st = statFile(p, f.replace(/^[/\\]/, ""), false) as { size?: number; files?: unknown };
          if (typeof st.size === "number" && !st.files) out.push({ path: `${relative(root, p).split(sep).join("/")}/${f.replace(/\\/g, "/").replace(/^\//, "")}`, bytes: st.size });
        }
      } else out.push({ path: relative(root, p).split(sep).join("/"), bytes: lstatSync(p).size });
    }
  };
  if (statSync(root).isDirectory()) visit(root);
  else out.push({ path: basename(root), bytes: statSync(root).size });
  return out;
}

/** パスから、素材のフォルダ（assets の次）と種類を決める。 */
export function classify(path: string, desktop = true): { kind: SizeKind; folder: string } {
  const parts = path.split("/");
  const a = parts.findIndex((p) => p === "assets" || p === "assets.asar");
  if (a >= 0 && parts.length > a + 2) {
    const folder = parts[a + 1]!;
    const media = mediaKindOf(path);
    const kind: SizeKind = media === "image" ? "image" : media === "audio" ? "audio" : media === "video" ? "video" : media === "font" ? "font" : "other-asset";
    return { kind, folder: `assets/${folder}` };
  }
  const p = parts.findIndex((x) => x === "project");
  if (p >= 0 && parts.length > p + 1) return { kind: "scenario", folder: "project" };
  const k = parts.findIndex((x) => x === "packs");
  if (k >= 0 && parts.length > k + 2) {
    const media = mediaKindOf(path);
    return { kind: media === "image" ? "image" : media === "audio" ? "audio" : media === "video" ? "video" : media === "font" ? "font" : "scenario", folder: `packs/${parts[k + 1]}` };
  }
  // デスクトップ版の起動部分（app.asar の直下の main.cjs など）とプレイヤーは「エンジン」、Electron 本体は「実行環境」
  const inApp = parts.indexOf("app.asar");
  if (parts.includes("engine") || parts.at(-1) === "index.html" || parts.at(-1) === "lm-sw.js" || (inApp >= 0 && !parts.includes("node_modules"))) return { kind: "engine", folder: "engine" };
  if (!desktop) return { kind: "engine", folder: "engine" };
  return { kind: "runtime", folder: "Electron など" };
}

export function sizeReport(root: string, top = 20): SizeReport {
  const files = listSized(root);
  const kinds = Object.fromEntries(Object.keys(KIND_NAMES).map((k) => [k, 0])) as Record<SizeKind, number>;
  const folders = new Map<string, number>();
  // Electron のアプリ（app.asar がある）でなければ、素材とシナリオのほかはエンジン
  const desktop = files.some((f) => f.path.split("/").includes("app.asar"));
  for (const f of files) {
    const c = classify(f.path, desktop);
    kinds[c.kind] += f.bytes;
    folders.set(c.folder, (folders.get(c.folder) ?? 0) + f.bytes);
  }
  return {
    root,
    total: files.reduce((n, f) => n + f.bytes, 0),
    kinds,
    folders: [...folders].map(([folder, bytes]) => ({ folder, bytes })).sort((a, b) => b.bytes - a.bytes),
    largest: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, top),
  };
}

/** 束の大きさ（ファイルごとに gzip で縮めた大きさの合計）。 */
export interface BundleSize {
  bytes: number;
  gzip: number;
  files: number;
}

/**
 * エンジンの束（エンジンと作品のプラグインを Vite でまとめた engine/*.js と *.css）の大きさと、gzip で縮めた大きさ。
 * root はブラウザ版のフォルダか、書き出しの web のフォルダ。デスクトップ版（中に app.asar のあるフォルダかアプリ）は app.asar の中の web/engine を読む。
 * initial は遊び始める前に読むもの: ページ（index.html）が指す束と、preload に書いた標準の命令の描画の部品（engine/<部品>-<鍵>.js）と、
 * それらが import する束。ほかの部品（作品が使わない図鑑、調べる画面など）は使うときに読むので入らない。見つからなければ null。
 */
export function engineBundle(root: string, preload: readonly string[] = []): (BundleSize & { initial: BundleSize }) | null {
  const sum = (contents: Buffer[]): BundleSize => ({ bytes: contents.reduce((n, b) => n + b.length, 0), gzip: contents.reduce((n, b) => n + gzipSync(b).length, 0), files: contents.length });
  const bundled = (name: string) => /\.(js|css)$/.test(name);
  let files: Map<string, Buffer>;
  let page = "";
  const folder = join(root, "engine");
  if (existsSync(folder) && statSync(folder).isDirectory()) {
    files = new Map(readdirSync(folder).filter(bundled).map((f) => [f, readFileSync(join(folder, f))]));
    if (existsSync(join(root, "index.html"))) page = readFileSync(join(root, "index.html"), "utf8");
  } else {
    const asar = existsSync(root) && statSync(root).isDirectory() ? findAppAsar(root) : null;
    if (!asar) return null;
    const list = listPackage(asar, { isPack: false }).map((f) => f.replace(/\\/g, "/").replace(/^\//, ""));
    files = new Map(list.filter((f) => /^web\/engine\/[^/]+$/.test(f) && bundled(f)).map((f) => [f.slice("web/engine/".length), extractFile(asar, f)]));
    if (list.includes("web/index.html")) page = extractFile(asar, "web/index.html").toString("utf8");
  }
  if (files.size === 0) return null;
  // ページが指す束と、始めに読む部品から、import でたどる（import() で読むものはたどらない）
  const initial = new Set<string>();
  const queue = [...page.matchAll(/engine\/([\w.-]+\.(?:js|css))/g)].map((m) => m[1]!);
  for (const feature of preload) for (const f of files.keys()) if (f.startsWith(`${feature}-`) && /^[\w-]+\.js$/.test(f.slice(feature.length + 1))) queue.push(f);
  while (queue.length > 0) {
    const f = queue.pop()!;
    const data = files.get(f);
    if (!data || initial.has(f)) continue;
    initial.add(f);
    if (f.endsWith(".js")) for (const m of data.toString("utf8").matchAll(/(?:\bfrom|\bimport)\s*["']\.\/([\w.-]+\.js)["']/g)) queue.push(m[1]!);
  }
  return { ...sum([...files.values()]), initial: sum([...initial].map((f) => files.get(f)!)) };
}

/** フォルダの中の app.asar（Mac のアプリの Contents/Resources、Windows・Linux の resources）。 */
function findAppAsar(dir: string, depth = 0): string | null {
  if (depth > 5) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "app.asar" && e.isFile()) return join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink() && !e.name.endsWith(".framework") && e.name !== "locales") {
      const hit = findAppAsar(join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** paths.out の中で一番新しい書き出し（日時付きのフォルダか、ブラウザ版のフォルダ）。 */
export function latestBuild(out: string): string | null {
  const candidates: string[] = [];
  for (const t of [...STAMPED_TARGETS, "browser"]) {
    const dir = join(out, t);
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir)) if (!e.startsWith(".") && !e.endsWith(".png") && !e.endsWith(".zip")) candidates.push(join(dir, e));
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

export function runSize(dir: string, o: { target?: string; top?: number; json?: boolean }): boolean {
  const project = loadProject(dir);
  const target = o.target ? resolve(o.target) : latestBuild(project.paths.out);
  if (!target || !existsSync(target)) throw new Error(o.target ? `${o.target} がありません` : `書き出したものが ${relative(process.cwd(), project.paths.out) || "."} にありません（先に lim build を）`);
  const r = sizeReport(target, o.top ?? 20);
  if (o.json) {
    console.log(JSON.stringify(r, null, 2));
    return true;
  }
  const pct = (n: number) => `${((n / Math.max(1, r.total)) * 100).toFixed(1)}%`;
  const shown = relative(process.cwd(), target);
  console.log(`${shown.startsWith("..") ? target : shown}: 合わせて ${formatBytes(r.total)}\n`);
  console.log("種類別:");
  for (const [k, n] of (Object.entries(r.kinds) as [SizeKind, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])) console.log(`  ${KIND_NAMES[k]}: ${formatBytes(n)}（${pct(n)}）`);
  console.log("\nフォルダ別:");
  for (const f of r.folders) console.log(`  ${f.folder}: ${formatBytes(f.bytes)}（${pct(f.bytes)}）`);
  console.log(`\n大きいファイル（上から ${r.largest.length} 件）:`);
  for (const f of r.largest) console.log(`  ${formatBytes(f.bytes).padStart(9)}  ${f.path}`);
  const engine = engineBundle(target);
  if (engine) console.log(`\nエンジンとプラグインの束: ${formatBytes(engine.bytes)}（gzip で ${formatBytes(engine.gzip)}）`);
  console.log("\n音と画像は build.browser.compress、build.desktop.compress で縮められます。使っていない素材の候補は lim unused で出せます");
  return true;
}
