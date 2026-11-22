import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { extractFile } from "@electron/asar";
import { decryptBuffer, keyFromServiceWorker } from "./encrypt.ts";

/**
 * 書き出したもの（ブラウザ版やデスクトップ版のフォルダ、その横の zip、dmg、インストーラーなどの配る形）が、何の書き出しか。
 * lim publish、lim update-manifest、lim patch が、テスト版（lim build --feedback）を製品と取り違えて上げないために読む。
 */

/** 書き出したゲームの project/build.json（build.ts が書く）。 */
export interface BuiltInfo {
  id?: string;
  version?: string;
  variant?: string;
  /** テスト版（指摘の口を入れた書き出し）。 */
  feedback?: boolean;
  date?: string;
}

/** 書き出しの記録の一行（build.ts の BuildRecord のうち、ここで読むもの）。 */
interface HistoryLine {
  date?: string;
  feedback?: boolean;
  outputs?: string[];
}

/** 書き出しの記録のファイル（書き出し先の直下）。 */
const HISTORY = "build-history.jsonl";

/** 読めれば JSON、読めなければ null（暗号を戻せない、形が違う）。 */
function parse(data: Buffer, key: Buffer | null): BuiltInfo | null {
  try {
    const text = (key ? decryptBuffer(data, key) : data).toString("utf8");
    const json = JSON.parse(text) as unknown;
    return json && typeof json === "object" && !Array.isArray(json) ? (json as BuiltInfo) : null;
  } catch {
    // 暗号にしたもの（鍵が無い）や壊れたものは、読めないものとして記録の方を見る
    return null;
  }
}

/** フォルダの中の書き出したゲームの build.json（ブラウザ版の project/、デスクトップ版の app.asar か resources/app の web/project/）。 */
function readFromFolder(folder: string): BuiltInfo | null {
  const browser = join(folder, "project", "build.json");
  if (existsSync(browser)) return parse(readFileSync(browser), keyFromServiceWorker(folder));
  const found: { asar?: string; web?: string } = {};
  const visit = (dir: string, depth: number) => {
    if (depth > 6 || found.asar || found.web) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // 読めないフォルダは飛ばす（書き出しのフォルダの外のもの）
      return;
    }
    for (const e of entries) {
      if (e.name === "app.asar" && e.isFile()) found.asar = join(dir, e.name);
      else if (e.name === "web" && e.isDirectory() && existsSync(join(dir, e.name, "project", "build.json")) && existsSync(join(dir, "game.json"))) found.web = join(dir, e.name);
    }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && !e.name.endsWith(".framework") && e.name !== "web") visit(join(dir, e.name), depth + 1);
  };
  visit(folder, 0);
  if (found.asar) {
    const key = gameKey(() => extractFile(found.asar!, "game.json"));
    try {
      return parse(extractFile(found.asar, "web/project/build.json"), key);
    } catch {
      // build.json の無い古い書き出し
      return null;
    }
  }
  if (found.web) return parse(readFileSync(join(found.web, "project", "build.json")), gameKey(() => readFileSync(join(dirname(found.web!), "game.json"))));
  return null;
}

/** デスクトップ版の game.json の暗号の鍵（build.encrypt）。 */
function gameKey(read: () => Buffer): Buffer | null {
  try {
    const game = JSON.parse(read().toString("utf8")) as { encrypt?: string };
    return game.encrypt ? Buffer.from(game.encrypt, "base64") : null;
  } catch {
    // game.json が読めなければ、暗号にしていないものとして読む
    return null;
  }
}

/**
 * path（書き出したフォルダか、配る形のファイル）の build.json。ファイルなら、拡張子を除いた名前のフォルダ（ブラウザ版の zip）か、
 * 同じフォルダ（デスクトップ版の日時のフォルダ）の中の書き出しを見る。読めなければ、書き出し先の記録（build-history.jsonl）で
 * その出力を書いた一番新しい書き出しを見る。
 */
export function builtInfo(path: string, out?: string): BuiltInfo | null {
  const abs = resolve(path);
  let info: BuiltInfo | null = null;
  if (existsSync(abs)) {
    if (statSync(abs).isDirectory()) info = readFromFolder(abs);
    else {
      const bare = abs.replace(/\.(zip|tar\.gz|dmg)$/i, "");
      info = bare !== abs && existsSync(bare) && statSync(bare).isDirectory() ? readFromFolder(bare) : readFromFolder(dirname(abs));
    }
  }
  if (info || !out) return info;
  return fromHistory(abs, resolve(out));
}

/** 書き出し先の記録で、path を書き出した（か、path を中に持つ出力を書き出した）一番新しい書き出し。 */
function fromHistory(path: string, out: string): BuiltInfo | null {
  const file = join(out, HISTORY);
  if (!existsSync(file)) return null;
  const rel = relative(out, path).split(sep).join("/");
  if (rel.startsWith("..")) return null;
  let hit: BuiltInfo | null = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r: HistoryLine;
    try {
      r = JSON.parse(line) as HistoryLine;
    } catch {
      // 壊れた行は飛ばす（ほかの行は読む）
      continue;
    }
    if ((r.outputs ?? []).some((o) => o === rel || rel.startsWith(`${o}/`) || o.startsWith(`${rel}/`))) hit = { ...(r.feedback ? { feedback: true } : {}), ...(r.date ? { date: r.date } : {}) };
  }
  return hit;
}

/** テスト版（lim build --feedback）の書き出しか。 */
export function isTestBuild(path: string, out?: string): boolean {
  return builtInfo(path, out)?.feedback === true;
}

/** テスト版を上げようとしたときの断り（--allow-test で上げられる）。 */
export function testBuildProblem(shown: string): string {
  return `${shown} はテスト版の書き出しです（lim build --feedback。フィードバック機能が入っています）。製品を上げるなら --feedback を付けずに書き出し直し、テスト版を上げるなら --allow-test を付けます`;
}
