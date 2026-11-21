/**
 * 書き出すファイルの名前（実行ファイル、Mac のアプリ、書き出し先のフォルダ、zip・dmg・tar.gz・apk）の確かめ。
 * 名前は build.executableName、無ければタイトル（Linux 版の実行ファイルだけはプロジェクト ID）。
 * 書き出し先の OS（と、書き出すこのコンピューターの OS）で使えない名前なら、黙って置き換えずに知らせて、名前を決めてもらう。
 * Node の外（デスクトップ版の書き出しの画面）でも使うので、ほかのモジュールを読まない。
 */

export type FilePlatform = "windows" | "mac" | "linux";

export interface NameProblem {
  /** error は書き出せない。warning は書き出せるが勧めない。 */
  level: "error" | "warning";
  message: string;
}

/** 名前の長さの上限（UTF-8 のバイト数）。OS の上限（255 バイト）より手前で、日時・拡張子・版などを足しても収まるように。 */
export const MAX_FILE_NAME = 200;

const utf8 = new TextEncoder();

const WINDOWS_FORBIDDEN = /[\\/:*?"<>|]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// 制御文字（U+0000〜U+001F と U+007F）
const CONTROL = /[\u0000-\u001f\u007f]/;

const PLATFORM_NAME: Record<FilePlatform, string> = { windows: "Windows", mac: "Mac", linux: "Linux" };

/** その OS のファイル名として使えるか。使えなければ理由（空なら問題なし）。 */
export function fileNameProblems(name: string, platform: FilePlatform): NameProblem[] {
  const out: NameProblem[] = [];
  const os = PLATFORM_NAME[platform];
  if (name.trim() === "") return [{ level: "error", message: "名前が空です" }];
  if (utf8.encode(name).length > MAX_FILE_NAME) out.push({ level: "error", message: `名前が長すぎます（UTF-8 で ${MAX_FILE_NAME} バイトまで）` });
  if (CONTROL.test(name)) out.push({ level: "error", message: "制御文字はファイル名に使えません" });
  if (name === "." || name === "..") out.push({ level: "error", message: `「${name}」はファイル名に使えません` });
  if (platform === "windows") {
    const chars = [...new Set(name.match(WINDOWS_FORBIDDEN) ?? [])];
    if (chars.length > 0) out.push({ level: "error", message: `${chars.map((c) => `「${c}」`).join("")}は ${os} のファイル名に使えません` });
    if (WINDOWS_RESERVED.test(name)) out.push({ level: "error", message: `「${name.split(".")[0]}」は ${os} で予約されている名前のため使えません` });
    if (/[ .]$/.test(name)) out.push({ level: "error", message: `末尾の空白とピリオドは ${os} のファイル名に使えません` });
  } else if (platform === "mac") {
    const chars = [...new Set(name.match(/[/:]/g) ?? [])];
    if (chars.length > 0) out.push({ level: "error", message: `${chars.map((c) => `「${c}」`).join("")}は ${os} のファイル名に使えません` });
  } else {
    if (name.includes("/")) out.push({ level: "error", message: `「/」は ${os} のファイル名に使えません` });
    if (name.startsWith("-")) out.push({ level: "warning", message: "先頭の「-」は、端末から起動するときにオプションと取り違えられます" });
  }
  return out;
}

/** 使えない記号の全角の形（どの OS のファイル名にも使え、見た目がほぼ変わらない）。 */
const FULL_WIDTH: Record<string, string> = { "\\": "＼", "/": "／", ":": "：", "*": "＊", "?": "？", '"': "＂", "<": "＜", ">": "＞", "|": "｜" };

/**
 * どの OS でも使える名前に整えた案（名前を決めてもらうときの初めの値）。使えない記号は全角に替え、制御文字は除き、
 * 末尾の空白とピリオドは取り、Windows の予約名は最初のピリオドの前に「_」を足す。整えきれなければ fallback。
 */
export function suggestFileName(name: string, fallback: string): string {
  let s = [...name]
    .map((c) => (CONTROL.test(c) ? "" : (FULL_WIDTH[c] ?? c)))
    .join("")
    .replace(/[ .]+$/, "")
    .trim();
  if (WINDOWS_RESERVED.test(s)) s = s.replace(/^[^.]*/, "$&_");
  let bytes = 0;
  let prefix = "";
  for (const c of s) {
    bytes += utf8.encode(c).length;
    if (bytes > MAX_FILE_NAME) break;
    prefix += c;
  }
  s = prefix.replace(/[ .]+$/, "");
  if (s === "" || s === "." || s === "..") return fallback;
  return s.startsWith("-") ? `_${s.slice(1)}` : s;
}

/** 書き出し先。 */
export type NameTarget = "browser" | "mac" | "windows" | "linux" | "android" | "ios";

export interface NamedFile {
  /** 何の名前か（「Windows 版の実行ファイルとフォルダ」など）。 */
  what: string;
  name: string;
  /** どの OS の規則で見るか。 */
  platform: FilePlatform;
  problems: NameProblem[];
}

/** process.platform → FilePlatform。 */
export function hostPlatform(platform: string): FilePlatform {
  return platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "linux";
}

/**
 * 書き出し先ごとに、作る名前とその問題。名前を作らない書き出し先（ブラウザ。フォルダはプロジェクト ID）は入らない。
 * 書き出し先のフォルダはこのコンピューター（host）に作るので、その OS の規則でも見る。
 */
export function exportFileNames(cfg: { id: string; title: string; build?: { executableName?: string } }, targets: readonly NameTarget[], host: FilePlatform): NamedFile[] {
  const base = cfg.build?.executableName ?? cfg.title;
  const out: NamedFile[] = [];
  const add = (what: string, name: string, platform: FilePlatform) => {
    if (out.some((f) => f.name === name && f.platform === platform)) return;
    out.push({ what, name, platform, problems: fileNameProblems(name, platform) });
  };
  for (const t of targets) {
    if (t === "windows") add("Windows 版の実行ファイルとフォルダ", base, "windows");
    else if (t === "mac") add("Mac 版のアプリ", base, "mac");
    else if (t === "linux") {
      add("Linux 版のフォルダ", base, "linux");
      add("Linux 版の実行ファイル", cfg.build?.executableName ?? cfg.id, "linux");
    } else if (t === "android" || t === "ios") add(t === "android" ? "Android 版の APK" : "iOS 版のフォルダ", base, host);
    if (t !== "browser") add("書き出し先のフォルダ", base, host);
  }
  return out;
}
