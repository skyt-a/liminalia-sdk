import type { Diagnostic, DiagnosticFix, Script } from "./ast.ts";
import { assetReferences, castAssetReferences, dynamicAssetReferences } from "./assets.ts";
import { extraAssetReferences, type ExtraConfig } from "./extra.ts";
import { itemAssetReferences } from "./items.ts";
import { extensionOf, MEDIA_EXTENSIONS, mediaKindOf } from "./media.ts";
import type { CommandSpec, Registry } from "./registry.ts";
import { defineSpec } from "./check.ts";
import { uiAssetReferences, type UiConfig } from "./ui.ts";

/** 素材を参照するもの（シナリオ・キャストの定義・liminalia.json）。 */
export interface AssetSources {
  /** ファイル名（.lim を除く） → 解析した台本。診断の file はこの名前になる。 */
  scripts: ReadonlyMap<string, Script>;
  registry: Registry;
  /** cast.json の中身（形の崩れたキャストは飛ばす）と、診断に書くそのファイルの名前。 */
  cast: Readonly<Record<string, unknown>>;
  castFile: string;
  /** liminalia.json の extra・items・ui。 */
  extra?: ExtraConfig | undefined;
  items?: unknown;
  ui?: UiConfig | undefined;
}

export interface MissingAssetSources extends AssetSources {
  /** 素材のフォルダ（bgimage など）の中にそのパスがあるか。同じ素材は一度だけ聞く。 */
  exists: (folder: string, path: string) => boolean;
  /** 素材のフォルダの中のファイル（修正案の候補。分からなければ undefined）。 */
  files?: (folder: string) => readonly string[] | undefined;
  /**
   * 大文字と小文字を問わずに探した、ファイルの本当の名前（素材のフォルダからのパス。無ければ null）。あれば exists より先に使い、
   * 書いた名前と大文字か小文字だけが違えば asset-case-mismatch にする（Mac と Windows では読めても、Linux のサーバーやスマホでは読めない）。
   */
  actual?: (folder: string, path: string) => string | null | undefined;
  /**
   * 素材のファイルの頭の LFS_HEAD_BYTES バイト（読めなければ null）。あれば、Git LFS のポインタのまま中身を取り込んでいない素材を
   * lfs-pointer にする（git lfs pull をしていない、CI の checkout に lfs: true が無い）。
   */
  head?: (folder: string, path: string) => Uint8Array | null | undefined;
}

/** Git LFS のポインタのファイルの頭（https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md）。 */
const LFS_POINTER = "version https://git-lfs.github.com/spec/";
/** 素材のファイルの頭として読むバイト数（MissingAssetSources の head）。 */
export const LFS_HEAD_BYTES = LFS_POINTER.length;

/** ファイルの頭が Git LFS のポインタの文字か。 */
export function isLfsPointer(head: Uint8Array): boolean {
  if (head.length < LFS_POINTER.length) return false;
  for (let i = 0; i < LFS_POINTER.length; i++) if (head[i] !== LFS_POINTER.charCodeAt(i)) return false;
  return true;
}

/**
 * 大文字と小文字を問わずに素材を探す関数（MissingAssetSources の actual）を作る。list は素材のフォルダの中のフォルダ
 * （[素材の種類のフォルダ, …途中のフォルダ]）にある名前（無ければ null）。同じフォルダは一度だけ聞く。
 * 返すのはファイルの本当の名前で書いたパス（書いた名前と同じ名前があればそれ）、無ければ null。. や .. を含むパスは分からない（undefined）。
 */
export function assetNameResolver(list: (segments: readonly string[]) => readonly string[] | null): (folder: string, path: string) => string | null | undefined {
  const cache = new Map<string, readonly string[] | null>();
  const names = (segments: readonly string[]) => {
    const key = segments.join("/");
    if (!cache.has(key)) cache.set(key, list(segments));
    return cache.get(key)!;
  };
  return (folder, path) => {
    const parts = path.split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..")) return undefined;
    const done: string[] = [];
    for (const part of parts) {
      const here = names([folder, ...done]);
      if (here === null) return null;
      // 同じ名前（濁点などの合成の違いは同じとみなす）が無ければ、大文字と小文字だけが違うもの
      const nfc = part.normalize("NFC");
      const lower = nfc.toLowerCase();
      const found = here.find((n) => n === part) ?? here.find((n) => n.normalize("NFC") === nfc) ?? here.find((n) => n.normalize("NFC").toLowerCase() === lower);
      if (found === undefined) return null;
      done.push(found.normalize("NFC") === nfc ? part : found);
    }
    return done.join("/");
  };
}

/**
 * 無い素材の名前に近い、あるファイル（修正案）。拡張子だけが違うもの（大文字と小文字も問わない）を先に、
 * 無ければ綴りの近いもの（違う字が 2 字か、長さの 4 分の 1 まで）。見つからなければ null。
 */
export function nearestAsset(path: string, files: readonly string[]): string | null {
  const stem = (p: string) => p.replace(/\.[^./]+$/, "").toLowerCase();
  const sameStem = files.find((f) => stem(f) === stem(path));
  if (sameStem !== undefined) return sameStem;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const f of files) {
    const d = editDistance(path.toLowerCase(), f.toLowerCase());
    if (d < bestDistance) {
      best = f;
      bestDistance = d;
    }
  }
  return best !== null && bestDistance <= Math.max(2, Math.floor(path.length / 4)) ? best : null;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 8) return Infinity;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** 無い素材の修正案（シナリオの行なら、置き換える直し方も）。 */
export function missingAssetHint(path: string, files: readonly string[] | undefined, inScript: boolean): { hint?: string; fix?: DiagnosticFix } {
  const near = files ? nearestAsset(path, files) : null;
  if (near === null) return {};
  return { hint: `${near} のことですか？`, ...(inScript ? { fix: { kind: "replace" as const, find: path, with: near } } : {}) };
}

/** 参照されている素材と、診断を出す場所。owner は文の頭（"キャラクター ユイ の立ち絵" など。シナリオなら null）。 */
interface Referenced {
  folder: string;
  path: string;
  file: string;
  line: number;
  column?: number;
  owner: { kind: "cast"; who: string } | { kind: "config"; where: string } | null;
}

/** シナリオの命令・キャストの定義・liminalia.json のおまけ・持ち物・ゲームの設定が参照する素材（同じものも参照ごとに）。 */
function referencedAssets(src: AssetSources): Referenced[] {
  const out: Referenced[] = [];
  // マクロの素材の型（asset(フォルダ)）の引数も見る
  const macros = projectMacros(src.scripts);
  for (const [file, script] of src.scripts) {
    for (const r of assetReferences(script, src.registry, macros)) out.push({ folder: r.folder, path: r.path, file, line: r.line, column: r.column, owner: null });
  }
  for (const r of castAssetReferences(src.cast)) out.push({ folder: r.folder ?? "fgimage", path: r.path, file: src.castFile, line: 1, owner: { kind: "cast", who: r.who } });
  for (const r of [...extraAssetReferences(src.extra), ...itemAssetReferences(src.items), ...uiAssetReferences(src.ui)]) {
    out.push({ folder: r.folder, path: r.path, file: "liminalia.json", line: 1, owner: { kind: "config", where: r.where } });
  }
  return out;
}

/** 参照されている素材の "フォルダ/パス"（lim unused が、どこからも参照されない素材を探すのに使う）。 */
export function referencedAssetKeys(src: AssetSources): Set<string> {
  return new Set(referencedAssets(src).map((r) => `${r.folder}/${r.path}`));
}

/** 作品の @define の仕様（素材の型 asset(フォルダ) の引数を持つマクロも、命令と同じに見るため）。 */
function projectMacros(scripts: ReadonlyMap<string, Script>): Map<string, CommandSpec> {
  const macros = new Map<string, CommandSpec>();
  for (const script of scripts.values()) {
    for (const s of script.body) if (s.kind === "define" && s.name !== "" && !macros.has(s.name)) macros.set(s.name, defineSpec(s)!);
  }
  return macros;
}

/**
 * 素材の型の引数を式で書いた命令（どの素材を使うか台本から分からないもの）。file はファイル名（.lim を除く）。
 * lim build の「使っている素材だけ」は、ここに出たフォルダの素材を外さない。
 */
export function dynamicAssetUses(src: Pick<AssetSources, "scripts" | "registry">): { file: string; folder: string; line: number; source: string }[] {
  const macros = projectMacros(src.scripts);
  const out: { file: string; folder: string; line: number; source: string }[] = [];
  for (const [file, script] of src.scripts) for (const r of dynamicAssetReferences(script, src.registry, macros)) out.push({ file, folder: r.folder, line: r.line, source: r.source });
  return out;
}

/** 診断の場所。キャラクターの立ち絵なら、その人物も添える（設定の行を移す placeConfigLines がその人物の行へ移し、制作画面がキャラクターの画面を開く）。 */
const at = (r: Referenced) => ({ file: r.file, line: r.line, ...(r.column !== undefined ? { column: r.column } : {}), ...(r.owner?.kind === "cast" ? { cast: { who: r.owner.who } } : {}) });

/**
 * 参照されているのに無い素材（missing-asset）。シナリオの命令・キャストの定義・liminalia.json のおまけ・持ち物・ゲームの設定を見る。
 * lim check・lim build・制作画面の点検が同じ集め方をするように、ここにまとめる。
 */
export function missingAssets(src: MissingAssetSources): Diagnostic[] {
  // 本当の名前（actual）が分かれば、それと比べる。分からなければ、あるかどうか（exists）だけ
  const known = new Map<string, string | null>();
  const real = (folder: string, path: string): string | null => {
    const key = `${folder}/${path}`;
    let found = known.get(key);
    if (found === undefined) {
      const actual = src.actual?.(folder, path);
      known.set(key, (found = actual !== undefined ? actual : src.exists(folder, path) ? path : null));
    }
    return found;
  };
  const out: Diagnostic[] = [];
  /** LFS のポインタか確かめた素材（同じ素材は最初の参照だけ知らせる）。 */
  const lfsChecked = new Set<string>();
  for (const r of referencedAssets(src)) {
    const actual = real(r.folder, r.path);
    if (actual === r.path) {
      const key = `${r.folder}/${r.path}`;
      if (!src.head || lfsChecked.has(key)) continue;
      lfsChecked.add(key);
      const head = src.head(r.folder, r.path);
      if (!head || !isLfsPointer(head)) continue;
      const message =
        r.owner === null
          ? `素材 ${key} は Git LFS のポインタのままです（中身を取り込んでいないので、表示も再生もできません）`
          : r.owner.kind === "cast"
            ? `キャラクター ${r.owner.who} の立ち絵 fgimage/${r.path} は Git LFS のポインタのままです（中身を取り込んでいないので、表示も再生もできません）`
            : `${r.owner.where} の素材 ${key} は Git LFS のポインタのままです（中身を取り込んでいないので、表示も再生もできません）`;
      out.push({
        severity: "error",
        code: "lfs-pointer",
        message,
        ...at(r),
        hint: "git lfs pull で中身を取り込みます（CI では actions/checkout に lfs: true を書きます）",
      });
      continue;
    }
    if (actual !== null) {
      // 大文字と小文字だけが違う（Mac と Windows では読めるが、Linux のサーバーやスマホでは読めない）
      const message =
        r.owner === null
          ? `素材 ${r.folder}/${r.path} は、ファイルの名前と大文字と小文字が違います（ファイルは ${actual}。Linux のサーバーやスマホでは読めません）`
          : r.owner.kind === "cast"
            ? `キャラクター ${r.owner.who} の立ち絵 fgimage/${r.path} は、ファイルの名前と大文字と小文字が違います（ファイルは ${actual}。Linux のサーバーやスマホでは読めません）`
            : `${r.owner.where} の素材 ${r.folder}/${r.path} は、ファイルの名前と大文字と小文字が違います（ファイルは ${actual}。Linux のサーバーやスマホでは読めません）`;
      out.push({
        severity: "error",
        code: "asset-case-mismatch",
        message,
        ...at(r),
        hint: `${actual} と書きます`,
        ...(r.owner === null ? { fix: { kind: "replace" as const, find: r.path, with: actual } } : {}),
      });
      continue;
    }
    const message =
      r.owner === null
        ? `素材 ${r.folder}/${r.path} がありません`
        : r.owner.kind === "cast"
          ? `キャラクター ${r.owner.who} の立ち絵 fgimage/${r.path} がありません`
          : `${r.owner.where} の素材 ${r.folder}/${r.path} がありません`;
    out.push({ severity: "error", code: "missing-asset", message, ...at(r), ...missingAssetHint(r.path, src.files?.(r.folder), r.owner === null) });
  }
  return out;
}

/**
 * 参照されている素材のうち、書き出しに入らない種類のファイル（拡張子が素材の表 MEDIA_EXTENSIONS に無いもの。asset-not-exported）。
 * 書き出しは素材の表にある拡張子のファイルだけを入れるので、これらは書き出したゲームでは見つからない。同じ素材は最初の参照だけを出す。
 */
export function unexportedAssets(src: AssetSources): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  const known = Object.values(MEDIA_EXTENSIONS).flat().join(" ");
  for (const r of referencedAssets(src)) {
    const key = `${r.folder}/${r.path}`;
    if (seen.has(key) || mediaKindOf(r.path)) continue;
    seen.add(key);
    const ext = extensionOf(r.path);
    out.push({
      severity: "warning",
      code: "asset-not-exported",
      message: ext ? `素材 ${key} は書き出しに入らない種類のファイルです（${ext}）` : `素材 ${key} は拡張子が無いため、書き出しに入りません`,
      hint: `書き出しに入るのは ${known} です`,
      ...at(r),
    });
  }
  return out;
}
