import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { containedPath, within } from "./contained-path.ts";
import { mediaKindOf } from "@liminalia/lang";

/**
 * ほかのエンジンの作品（TyranoScript の data/、Ren'Py の game/）から、作品の assets/ へ素材を写す（取り込みで使う）。
 *
 * - 写すのは素材の表（@liminalia/lang の MEDIA_EXTENSIONS）にある拡張子のファイルだけ。書き出しに入らないもの（.psd、.txt など）は写さない
 * - 取り込み元のファイルは、実体（シンボリックリンクをたどった先）が取り込み元のフォルダの中にあるものだけを読む
 * - 写す先にもうあるファイルは上書きしない（大きさが同じなら同じものとみなし、違えば kept に残す）。作品で差し替えた素材を消さない
 * - APFS などでは中身を共有する写し（clone）にするので、大きな素材でも場所と時間をほとんど使わない
 */

/** 写す一つ（from は取り込み元のフォルダの中のパス、to は素材のフォルダの中のパス。どちらも / 区切りの相対パス）。 */
export interface AssetCopy {
  from: string;
  to: string;
}

export interface AssetCopyResult {
  /** 写したもの（素材のフォルダからのパス）。 */
  copied: string[];
  /** 写す先に同じ大きさのものがあったので写さなかった数。 */
  same: number;
  /** 写す先に大きさの違うものがあったので、上書きせずに残したもの（素材のフォルダからのパス）。 */
  kept: string[];
  /** 取り込み元に無かったもの（取り込み元からのパス）。 */
  missing: string[];
  /** 取り込み元のフォルダの外を指していたので読まなかったもの（取り込み元からのパス）。 */
  outside: string[];
  /** 素材の種類ではないので写さなかったもの（取り込み元からのパス）。 */
  skipped: string[];
  /** 写した大きさ（バイト）。 */
  bytes: number;
}

const emptyResult = (): AssetCopyResult => ({ copied: [], same: 0, kept: [], missing: [], outside: [], skipped: [], bytes: 0 });

function real(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    // 無いものは null（呼ぶ側が無い素材として扱う）
    return null;
  }
}

/** source の中のファイルを assets の中へ写す（上の決まり）。 */
export function copyAssets(source: string, assets: string, list: readonly AssetCopy[]): AssetCopyResult {
  const out = emptyResult();
  const root = real(source);
  const seen = new Set<string>();
  for (const { from, to } of list) {
    if (seen.has(to)) continue;
    seen.add(to);
    if (!mediaKindOf(to) || !mediaKindOf(from)) {
      out.skipped.push(from);
      continue;
    }
    const file = join(source, from);
    const target = join(assets, to);
    // 写す先が素材のフォルダの外へ出るもの（.. を含む名前）は写さない
    if (!containedPath(assets, target)) {
      out.outside.push(from);
      continue;
    }
    if (!existsSync(file)) {
      out.missing.push(from);
      continue;
    }
    const actual = real(file);
    if (root === null || actual === null || !within(root, actual) || !statSync(actual).isFile()) {
      out.outside.push(from);
      continue;
    }
    if (existsSync(target)) {
      if (lstatSync(target).isFile() && statSync(target).size === statSync(actual).size) out.same++;
      else out.kept.push(to);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(actual, target, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    const st = statSync(actual);
    // 元の更新時刻を残す（取り込み直したときに、元が新しくなったかを見分けられるように）
    utimesSync(target, st.atime, st.mtime);
    out.copied.push(to);
    out.bytes += st.size;
  }
  return out;
}

/**
 * source の中のフォルダ（folders。取り込み元からのパス）の中身を、assets の同じ名前のフォルダへそのまま写す（サブフォルダも）。
 * map でフォルダの名前を替えられる（{ "data/bgimage": "bgimage" } など）。. で始まるもの（.DS_Store など）は写さない。
 */
export function copyAssetFolders(source: string, assets: string, map: Readonly<Record<string, string>>, skip: (from: string) => boolean = () => false): AssetCopyResult {
  const list: AssetCopy[] = [];
  const root = real(source);
  for (const [from, to] of Object.entries(map)) {
    const dir = join(source, from);
    if (!existsSync(dir) || root === null) continue;
    const walk = (rel: string) => {
      let names: string[] = [];
      try {
        names = readdirSync(join(dir, rel)).sort();
      } catch {
        // 読めないフォルダは飛ばす（無い素材は lim check が知らせる）
        return;
      }
      for (const name of names) {
        if (name.startsWith(".")) continue;
        const sub = rel === "" ? name : `${rel}/${name}`;
        const path = join(dir, sub);
        const stat = lstatSync(path);
        // フォルダのシンボリックリンクはたどらない（取り込み元の外へ出ない。ファイルのリンクは copyAssets が実体を確かめる）
        if (stat.isDirectory()) walk(sub);
        else if (!skip(`${from}/${sub}`)) list.push({ from: `${from}/${sub}`, to: `${to}/${sub}` });
      }
    };
    walk("");
  }
  return copyAssets(source, assets, list);
}

/** 写した結果を一行で（取り込みの報告と lim import の出力。--lang en なら英語）。 */
export function assetCopySummary(r: AssetCopyResult, language: "ja" | "en" = "ja"): string {
  const mb = (r.bytes / 1024 / 1024).toFixed(1);
  if (language === "en") {
    const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const en = [`Copied ${n(r.copied.length, "asset")} (${mb} MB)`];
    if (r.same > 0) en.push(`${r.same} already there`);
    if (r.kept.length > 0) en.push(`${r.kept.length} not overwritten because the project's file differs`);
    if (r.missing.length > 0) en.push(`${r.missing.length} not found in the source`);
    if (r.outside.length > 0) en.push(`${r.outside.length} pointing outside the source folder`);
    return en.join(", ");
  }
  const parts = [`素材 ${r.copied.length} 件をコピーしました（${mb} MB）`];
  if (r.same > 0) parts.push(`同じものがあった ${r.same} 件`);
  if (r.kept.length > 0) parts.push(`中身の違うものがあったので上書きしなかった ${r.kept.length} 件`);
  if (r.missing.length > 0) parts.push(`取り込み元に無かった ${r.missing.length} 件`);
  if (r.outside.length > 0) parts.push(`取り込み元のフォルダの外を指していた ${r.outside.length} 件`);
  return parts.join("、");
}

/** 取り込みの報告に足す「素材」の節（Markdown）。names は名前の対応（元の名前 → 写した先）。 */
export function assetCopyReport(r: AssetCopyResult, names: readonly { name: string; to: string }[] = []): string {
  const lines = ["", "## 素材", "", `- ${assetCopySummary(r)}`];
  const list = (title: string, items: readonly string[]) => {
    if (items.length === 0) return;
    lines.push("", `### ${title}`, "", ...items.slice(0, 200).map((x) => `- ${x}`));
    if (items.length > 200) lines.push(`- ほか ${items.length - 200} 件`);
  };
  if (names.length > 0) {
    lines.push("", "### 名前の対応", "", "| 元の名前 | 素材 |", "|---|---|");
    for (const n of names.slice(0, 500)) lines.push(`| ${n.name.replace(/\|/g, "\\|")} | ${n.to.replace(/\|/g, "\\|")} |`);
    if (names.length > 500) lines.push(`| ほか ${names.length - 500} 件 | |`);
  }
  list("上書きしなかった素材（作品の素材を残しました）", r.kept);
  list("取り込み元に無かった素材", r.missing);
  list("取り込み元のフォルダの外を指していた素材（読んでいません）", r.outside);
  return `${lines.join("\n")}\n`;
}
