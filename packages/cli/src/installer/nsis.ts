import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, join, relative, sep } from "node:path";
import type { WindowsInstallerConfig } from "@liminalia/project";

/**
 * Windows 版のインストーラー（build.windows.installer）。NSIS（makensis）で一つの exe にする。
 *
 * - 日本語と英語の画面（Windows の表示の言語で選ぶ）。インストール先を選べる
 * - スタートメニューのショートカット、デスクトップのショートカット（終わりの画面のチェックで選ぶ）、終わったら起動する
 * - 「アプリと機能」に出し、アンインストーラーを入れる。アンインストールは入れたファイルだけを消す（セーブデータは残す）
 * - 前の版が入っていれば、その版のアンインストーラーで消してから入れる（古いファイルが残らない）
 * - 既定は自分だけに入れる（管理者の権限が要らない。%LOCALAPPDATA%\Programs）。perMachine なら全員に（Program Files）
 */

type Env = Record<string, string | undefined>;

export type InstallerConfig = WindowsInstallerConfig;

export interface NsisOptions {
  /** 作品のタイトル（画面とショートカットの名前）。 */
  title: string;
  /** プロジェクト ID（アンインストールの登録の鍵）。 */
  id: string;
  version: string;
  publisher?: string;
  /** 入れるフォルダの名前（インストール先の末尾）と、実行ファイルの名前（拡張子なし）。 */
  folderName: string;
  exeName: string;
  /** 入れるもの（書き出した Windows 版のフォルダ）。 */
  sourceDir: string;
  /** 作るインストーラーのパス。 */
  outFile: string;
  /** アイコン（.ico）。 */
  icon?: string | null;
  config: InstallerConfig;
  /**
   * インストール先の直下で、アプリ自身が更新で入れ替えるもの（制作アプリ。packages/studio-desktop の scripts/package.ts）。
   * 入れたあとで中身が変わるので、アンインストールでは dirs を中ごと、files をそのまま消す（インストール先の外には触れない）。
   */
  owned?: { dirs: string[]; files: string[] };
}

/** makensis を探す（環境変数 LIMINALIA_MAKENSIS → PATH → よくある場所）。 */
export function findMakensis(env: Env = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (env.LIMINALIA_MAKENSIS) return existsSync(env.LIMINALIA_MAKENSIS) ? env.LIMINALIA_MAKENSIS : null;
  const exe = platform === "win32" ? "makensis.exe" : "makensis";
  const candidates = (env.PATH ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean).map((d) => join(d, exe));
  if (platform === "darwin") candidates.push("/opt/homebrew/bin/makensis", "/usr/local/bin/makensis");
  if (platform === "linux") candidates.push("/usr/bin/makensis", "/usr/local/bin/makensis");
  if (platform === "win32") candidates.push(join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "NSIS", "makensis.exe"), join(env.ProgramFiles ?? "C:\\Program Files", "NSIS", "makensis.exe"));
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** makensis が無いときの入れ方。 */
export function makensisHowTo(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "brew install makensis で入れてください";
  if (platform === "linux") return "apt install nsis（Debian、Ubuntu）や dnf install mingw32-nsis（Fedora）などで入れてください";
  return "https://nsis.sourceforge.io/Download から NSIS を入れてください";
}

/** NSIS の文字列の中身。$ と " と改行を逃がす。 */
function nsisEscape(s: string): string {
  return s.replace(/\$/g, "$$$$").replace(/"/g, '$\\"').replace(/\r?\n/g, "$\\n");
}

/** NSIS の文字列（"…"）。 */
export function nsisString(s: string): string {
  return `"${nsisEscape(s)}"`;
}

/** NSIS の変数（$INSTDIR など）の下のパス（"$INSTDIR\…"）。後ろは逃がす。 */
export function nsisPath(variable: string, rest: string): string {
  return `"${variable}\\${nsisEscape(rest)}"`;
}

/** Windows のファイルの版（x.x.x.x の数字だけ）。 */
export function fileVersion(version: string): string {
  const parts = version
    .split(/[.+-]/)
    .map((x) => Number.parseInt(x, 10))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .slice(0, 4);
  while (parts.length < 4) parts.push(0);
  return parts.map((n) => Math.min(n, 65535)).join(".");
}

/** フォルダの中のファイルとフォルダ（/ 区切りの相対パス。フォルダは浅いものから）。 */
export function listInstallFiles(dir: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const full = join(d, e);
      const rel = relative(dir, full).split(sep).join("/");
      if (lstatSync(full).isDirectory()) {
        dirs.push(rel);
        walk(full);
      } else files.push(rel);
    }
  };
  walk(dir);
  return { dirs, files };
}

const LANG = { ja: "Japanese", en: "English" } as const;
/** 終わりの画面のチェックの文言。 */
const DESKTOP_SHORTCUT: Record<"ja" | "en", string> = { ja: "デスクトップにショートカットを作成する", en: "Create a desktop shortcut" };

/** インストーラーの NSIS のスクリプト。 */
export function nsisScript(o: NsisOptions, list = listInstallFiles(o.sourceDir)): string {
  const perMachine = o.config.perMachine === true;
  const languages = o.config.languages && o.config.languages.length > 0 ? [...new Set(o.config.languages)] : (["ja", "en"] as const);
  const root = perMachine ? "HKLM" : "HKCU";
  const exe = `${o.exeName}.exe`;
  const win = (rel: string) => rel.split("/").join("\\");
  const src = (rel: string) => join(o.sourceDir, ...rel.split("/"));
  const shortcut = `${o.title.replace(/[\\/:*?"<>|]/g, "_")}.lnk`;
  const q = nsisString;
  const p = nsisPath;
  const key = q(`Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${o.id}`);
  const context = perMachine ? ["  SetShellVarContext all", "  SetRegView 64"] : ["  SetShellVarContext current"];
  const lines: string[] = [
    "; Liminalia の書き出し（lim build windows）が作るインストーラーのスクリプト",
    "Unicode true",
    "ManifestDPIAware true",
    "SetCompressor /SOLID lzma",
    '!include "MUI2.nsh"',
    "",
    `Name ${q(o.title)}`,
    `OutFile ${q(o.outFile)}`,
    `InstallDir ${p(perMachine ? "$PROGRAMFILES64" : "$LOCALAPPDATA\\Programs", o.folderName)}`,
    `InstallDirRegKey ${root} ${key} "InstallLocation"`,
    `RequestExecutionLevel ${perMachine ? "admin" : "user"}`,
    'BrandingText " "',
    `VIProductVersion ${q(fileVersion(o.version))}`,
    `VIAddVersionKey /LANG=0 "ProductName" ${q(o.title)}`,
    `VIAddVersionKey /LANG=0 "FileDescription" ${q(o.title)}`,
    `VIAddVersionKey /LANG=0 "ProductVersion" ${q(o.version)}`,
    `VIAddVersionKey /LANG=0 "FileVersion" ${q(o.version)}`,
    ...(o.publisher ? [`VIAddVersionKey /LANG=0 "CompanyName" ${q(o.publisher)}`, `VIAddVersionKey /LANG=0 "LegalCopyright" ${q(o.publisher)}`] : []),
    "",
    ...(o.icon ? [`!define MUI_ICON ${q(o.icon)}`, `!define MUI_UNICON ${q(o.icon)}`] : []),
    "!define MUI_ABORTWARNING",
    `!define MUI_FINISHPAGE_RUN ${p("$INSTDIR", exe)}`,
    // デスクトップのショートカットは、終わりの画面のチェック（「お読みください」の欄を借りる）で作る
    '!define MUI_FINISHPAGE_SHOWREADME ""',
    ...(o.config.desktopShortcut === false ? ["!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED"] : []),
    '!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(LiminaliaDesktopShortcut)"',
    "!define MUI_FINISHPAGE_SHOWREADME_FUNCTION LiminaliaDesktopShortcut",
    "!insertmacro MUI_PAGE_DIRECTORY",
    "!insertmacro MUI_PAGE_INSTFILES",
    "!insertmacro MUI_PAGE_FINISH",
    "!insertmacro MUI_UNPAGE_CONFIRM",
    "!insertmacro MUI_UNPAGE_INSTFILES",
    ...languages.map((l) => `!insertmacro MUI_LANGUAGE ${q(LANG[l])}`),
    ...languages.map((l) => `LangString LiminaliaDesktopShortcut \${LANG_${LANG[l].toUpperCase()}} ${q(DESKTOP_SHORTCUT[l])}`),
    "",
    "Function .onInit",
    ...context,
    "FunctionEnd",
    "",
    "Function un.onInit",
    ...context,
    "FunctionEnd",
    "",
    "Function LiminaliaDesktopShortcut",
    `  CreateShortcut ${p("$DESKTOP", shortcut)} ${p("$INSTDIR", exe)}`,
    "FunctionEnd",
    "",
    'Section "Install"',
    // 前の版が入っていれば、その版のアンインストーラーで消してから入れる（_?= で終わるまで待つ）
    '  IfFileExists "$INSTDIR\\Uninstall.exe" 0 +2',
    "    ExecWait '\"$INSTDIR\\Uninstall.exe\" /S _?=$INSTDIR'",
  ];
  // フォルダごとに SetOutPath してからファイルを入れる
  const byDir = new Map<string, string[]>();
  for (const f of list.files) {
    const d = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
    (byDir.get(d) ?? byDir.set(d, []).get(d)!).push(f);
  }
  for (const [d, files] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  SetOutPath ${d ? p("$INSTDIR", win(d)) : '"$INSTDIR"'}`);
    for (const f of files) lines.push(`  File ${q(src(f))}`);
  }
  const sizeKb = Math.ceil(list.files.reduce((n, f) => n + lstatSync(src(f)).size, 0) / 1024);
  lines.push(
    '  SetOutPath "$INSTDIR"',
    '  WriteUninstaller "$INSTDIR\\Uninstall.exe"',
    `  CreateShortcut ${p("$SMPROGRAMS", shortcut)} ${p("$INSTDIR", exe)}`,
    `  WriteRegStr ${root} ${key} "DisplayName" ${q(o.title)}`,
    `  WriteRegStr ${root} ${key} "DisplayVersion" ${q(o.version)}`,
    ...(o.publisher ? [`  WriteRegStr ${root} ${key} "Publisher" ${q(o.publisher)}`] : []),
    `  WriteRegStr ${root} ${key} "DisplayIcon" ${p("$INSTDIR", exe)}`,
    `  WriteRegStr ${root} ${key} "InstallLocation" "$INSTDIR"`,
    `  WriteRegStr ${root} ${key} "UninstallString" '"$INSTDIR\\Uninstall.exe"'`,
    `  WriteRegStr ${root} ${key} "QuietUninstallString" '"$INSTDIR\\Uninstall.exe" /S'`,
    `  WriteRegDWORD ${root} ${key} "NoModify" 1`,
    `  WriteRegDWORD ${root} ${key} "NoRepair" 1`,
    `  WriteRegDWORD ${root} ${key} "EstimatedSize" ${sizeKb}`,
    "SectionEnd",
    "",
    'Section "Uninstall"',
    // 入れたファイルだけを消す（インストール先に遊ぶ人が置いたものと、セーブデータは残す）
    ...list.files.map((f) => `  Delete ${p("$INSTDIR", win(f))}`),
    ...(o.owned?.files ?? []).map((f) => `  Delete ${p("$INSTDIR", win(f))}`),
    ...(o.owned?.dirs ?? []).map((d) => `  RMDir /r ${p("$INSTDIR", win(d))}`),
    ...[...list.dirs].reverse().map((d) => `  RMDir ${p("$INSTDIR", win(d))}`),
    '  Delete "$INSTDIR\\Uninstall.exe"',
    '  RMDir "$INSTDIR"',
    `  Delete ${p("$SMPROGRAMS", shortcut)}`,
    `  Delete ${p("$DESKTOP", shortcut)}`,
    `  DeleteRegKey ${root} ${key}`,
    "SectionEnd",
    "",
  );
  return lines.join("\r\n");
}

/** インストーラーを作る（スクリプトを UTF-8 の BOM 付きで書き、makensis で組み立てる）。作ったパスを返す。 */
export function buildInstaller(makensis: string, o: NsisOptions, scriptPath: string): string {
  writeFileSync(scriptPath, `\uFEFF${nsisScript(o)}`);
  const flag = process.platform === "win32" ? "/" : "-";
  // Mac と Linux の makensis は、ロケールが UTF-8 でないと日本語の入ったスクリプトを読めない（Bad text encoding）。
  // Finder から開いた制作アプリや CI ではロケールが空のことがあるので、UTF-8 のロケールで動かす
  const env = process.platform === "win32" ? process.env : { ...process.env, LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8" };
  execFileSync(makensis, [`${flag}V2`, `${flag}INPUTCHARSET`, "UTF8", scriptPath], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, env });
  if (!existsSync(o.outFile)) throw new Error(`インストーラーが作成されていません: ${o.outFile}`);
  return o.outFile;
}
