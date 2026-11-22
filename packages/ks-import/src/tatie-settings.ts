import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Cast } from "@liminalia/lang";
import { readWindowAssignments } from "./js-literal.ts";
import { realWithin } from "./safe-path.ts";
import { applyCastToTatieSettings } from "./tatie.ts";

/** 取り込み元の中の tatie の設定のパス。 */
export const TATIE_SETTINGS = "data/others/plugin/tatie/settings.js";

export interface WriteTatieOptions {
  /** 前の版を残すフォルダ。 */
  backupDir: string;
  /** 残す前の版の数（既定 20）。 */
  keep?: number;
  /** 設定のファイル（取り込み元からの相対パス）。既定は tatie の settings.js。同じ形の設定を別の場所に持つ作品のため。 */
  file?: string;
  /** 設定を入れるグローバル変数の名前。既定は TYRANO_TATIE_SETTINGS。 */
  global?: string;
}

export interface WriteTatieResult {
  file: string;
  /** 前の版の写し。 */
  backup: string;
  /** 書いた差分の数。 */
  written: number;
  /** 枠がないので書かなかった差分（キャスト / 立ち絵セット / 差分）。 */
  skipped: string[];
}

/**
 * キャストの画像と枠を、取り込み元の tatie の設定（data/others/plugin/tatie/settings.js）に書き戻す。
 * 何を書いて何を保つかは applyCastToTatieSettings。settings.js は実行せずにリテラルとして読み（readWindowAssignments）、
 * 整形した JSON を同じ形の代入文（`window.TYRANO_TATIE_SETTINGS = {…};`）にして書く。
 * 書く前に前の版を backupDir に日時付きで写し、一時ファイルから rename して書く。settings.js が無ければ null。
 */
export function writeTatieSettings(source: string, cast: Cast, o: WriteTatieOptions): WriteTatieResult | null {
  const file = join(source, o.file ?? TATIE_SETTINGS);
  const variable = o.global ?? "TYRANO_TATIE_SETTINGS";
  if (!existsSync(file)) return null;
  // シンボリックリンクや ../ でプロジェクトの外のファイルを読み書きしない
  if (!realWithin([source], file)) throw new Error(`${file} はインポート元のプロジェクトの外を指すため、読み込みません`);
  let assigned: Map<string, unknown>;
  try {
    assigned = readWindowAssignments(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`tatie の設定を読めません（${(e as Error).message}）`);
  }
  const settings = assigned.get(variable);
  if (!settings || typeof settings !== "object") throw new Error(`${file} に window.${variable} がありません`);
  const { settings: updated, written, skipped } = applyCastToTatieSettings(settings, cast);
  const backup = backupFile(file, o.backupDir, "tatie-settings", o.keep ?? 20);
  writeAtomic(file, `window.${variable} = ${JSON.stringify(updated, null, 4)};\n`);
  return { file, backup, written, skipped };
}

/** file を dir に「prefix-日時.拡張子」で写し、同じ prefix の古いものを keep 件まで減らす。 */
function backupFile(file: string, dir: string, prefix: string, keep: number): string {
  mkdirSync(dir, { recursive: true });
  const ext = file.slice(file.lastIndexOf("."));
  const out = join(dir, `${prefix}-${stamp(new Date())}${ext}`);
  copyFileSync(file, out);
  const old = readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(ext))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return out;
}

/** 20260101-093000-123（並べ替えると古い順）。 */
function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
