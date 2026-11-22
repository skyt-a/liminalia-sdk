import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileVersion, findMakensis, makensisHowTo, nsisPath, nsisScript, nsisString } from "../src/installer/nsis.ts";

describe("Windows のインストーラー（NSIS）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "liminalia-nsis-"));
    mkdirSync(join(dir, "app", "resources"), { recursive: true });
    mkdirSync(join(dir, "app", "locales"), { recursive: true });
    writeFileSync(join(dir, "app", "星を待つ丘.exe"), "exe");
    writeFileSync(join(dir, "app", "resources", "app.asar"), "asar");
    writeFileSync(join(dir, "app", "locales", "ja.pak"), "pak");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const options = (config = {}) => ({
    title: "星を待つ丘",
    id: "hoshi",
    version: "1.2.3",
    publisher: "Example",
    folderName: "星を待つ丘",
    exeName: "星を待つ丘",
    sourceDir: join(dir, "app"),
    outFile: join(dir, "Setup.exe"),
    icon: join(dir, "icon.ico"),
    config,
  });

  it("日本語と英語の画面、スタートメニューとデスクトップのショートカット、アンインストールの登録を持つ", () => {
    const s = nsisScript(options());
    expect(s).toContain("Unicode true");
    expect(s).toContain('!insertmacro MUI_LANGUAGE "Japanese"');
    expect(s).toContain('!insertmacro MUI_LANGUAGE "English"');
    expect(s).toContain('LangString LiminaliaDesktopShortcut ${LANG_JAPANESE} "デスクトップにショートカットを作成する"');
    expect(s).toContain('CreateShortcut "$SMPROGRAMS\\星を待つ丘.lnk" "$INSTDIR\\星を待つ丘.exe"');
    expect(s).toContain('CreateShortcut "$DESKTOP\\星を待つ丘.lnk" "$INSTDIR\\星を待つ丘.exe"');
    expect(s).toContain('WriteUninstaller "$INSTDIR\\Uninstall.exe"');
    expect(s).toContain('WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\hoshi" "DisplayName" "星を待つ丘"');
    expect(s).toContain('VIProductVersion "1.2.3.0"');
    expect(s).toContain(`!define MUI_ICON "${join(dir, "icon.ico")}"`);
    // 既定は自分だけに入れる（管理者の権限が要らない）
    expect(s).toContain('InstallDir "$LOCALAPPDATA\\Programs\\星を待つ丘"');
    expect(s).toContain("RequestExecutionLevel user");
  });

  it("入れたファイルを一つずつ入れ、アンインストールではそれだけを消す（深いフォルダから）", () => {
    const s = nsisScript(options());
    expect(s).toContain(`File "${join(dir, "app", "resources", "app.asar")}"`);
    expect(s).toContain('SetOutPath "$INSTDIR\\locales"');
    expect(s).toContain('Delete "$INSTDIR\\resources\\app.asar"');
    expect(s.indexOf('RMDir "$INSTDIR\\resources"')).toBeLessThan(s.indexOf('RMDir "$INSTDIR"'));
    expect(s).not.toContain("RMDir /r");
    // 前の版はそのアンインストーラーで消してから入れる
    expect(s).toContain("ExecWait '\"$INSTDIR\\Uninstall.exe\" /S _?=$INSTDIR'");
  });

  it("更新で中身の変わるもの（制作アプリ）は、アンインストールでインストール先の中だけを中ごと消す", () => {
    const s = nsisScript({ ...options(), owned: { dirs: ["resources", "locales"], files: ["ffmpeg.dll"] } });
    expect(s).toContain('RMDir /r "$INSTDIR\\resources"');
    expect(s).toContain('Delete "$INSTDIR\\ffmpeg.dll"');
    expect(s.indexOf('RMDir /r "$INSTDIR\\locales"')).toBeLessThan(s.indexOf('RMDir "$INSTDIR"'));
    expect(s).not.toContain('RMDir /r "$INSTDIR"\r');
  });

  it("全員に入れる・デスクトップのチェックを外す・言語を選ぶ", () => {
    const s = nsisScript(options({ perMachine: true, desktopShortcut: false, languages: ["en"] }));
    expect(s).toContain('InstallDir "$PROGRAMFILES64\\星を待つ丘"');
    expect(s).toContain("RequestExecutionLevel admin");
    expect(s).toContain("SetShellVarContext all");
    expect(s).toContain('WriteRegStr HKLM "Software');
    expect(s).toContain("!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED");
    expect(s).not.toContain('"Japanese"');
  });

  it("文字列の $ と \" を逃がし、版は x.x.x.x の数字にする", () => {
    expect(nsisString('a$b"c')).toBe('"a$$b$\\"c"');
    expect(nsisPath("$INSTDIR", "a$b")).toBe('"$INSTDIR\\a$$b"');
    expect(fileVersion("1.2")).toBe("1.2.0.0");
    expect(fileVersion("2.0.1-beta")).toBe("2.0.1.0");
  });

  it("makensis を探し、無ければ OS ごとの入れ方を出す", () => {
    expect(findMakensis({ PATH: dir }, "darwin")).toSatisfy((p: string | null) => p === null || p.endsWith("makensis"));
    writeFileSync(join(dir, "makensis"), "");
    expect(findMakensis({ PATH: dir }, "linux")).toBe(join(dir, "makensis"));
    expect(findMakensis({ LIMINALIA_MAKENSIS: join(dir, "nope") }, "darwin")).toBeNull();
    expect(makensisHowTo("darwin")).toContain("brew install makensis");
    expect(makensisHowTo("win32")).toContain("nsis.sourceforge.io");
  });
});
